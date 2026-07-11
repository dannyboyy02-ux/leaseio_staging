import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Stripe price IDs per plan + interval. Monthly hardcoded (existing
// production values); annual sourced from env vars at deploy time.
//
// Operator deploy step for annual billing:
//   1. Create annual recurring Prices in the Stripe dashboard for each
//      plan's existing Product (prod_TlQhMebFLbmsbR / prod_TlQhRntCDhkxfK).
//   2. supabase secrets set STRIPE_PRICE_STARTER_ANNUAL='price_...'
//      supabase secrets set STRIPE_PRICE_BUSINESS_ANNUAL='price_...'
//
// Until step 2 is done, an annual checkout request fails closed with a
// clear error (status 503, reason 'annual_not_configured') so users
// don't get charged at the monthly rate while expecting annual.
const PRICE_IDS = {
  starter: {
    monthly: "price_1TpdTdHbcO8VqfxHIvhLsvN9",
    annual: Deno.env.get("STRIPE_PRICE_STARTER_ANNUAL") ?? null,
  },
  business: {
    monthly: "price_1TpdVWHbcO8VqfxHKTN0lyOf",
    annual: Deno.env.get("STRIPE_PRICE_BUSINESS_ANNUAL") ?? null,
  },
  // Vault retention tier (VAULT_TIER_SPEC.md V3 conversion). Yearly-only,
  // sourced from env like the annual plan prices — fails closed with reason
  // 'vault_not_configured' until the operator creates the Stripe Product/Price
  // and sets STRIPE_PRICE_VAULT_ANNUAL (OPERATOR_PLAYBOOK STOP 10). No monthly.
  vault: {
    monthly: null,
    annual: Deno.env.get("STRIPE_PRICE_VAULT_ANNUAL") ?? null,
  },
} as const;

type PlanId = keyof typeof PRICE_IDS;
type BillingInterval = "monthly" | "annual";

const VALID_PLANS: ReadonlySet<string> = new Set(Object.keys(PRICE_IDS));
const VALID_INTERVALS: ReadonlySet<string> = new Set(["monthly", "annual"]);

// 7-day free trial on every new subscription. People expect it; it
// matches industry. Stripe handles auto-conversion to active on day 8.
const TRIAL_PERIOD_DAYS = 7;

serve(async (req) => {
  // P1-02: derive CORS from the request origin per call. Module-level
  // getCorsHeaders(null) defaulted to the first allowlisted origin
  // (theleaseio.com), so legitimate calls from app.theleaseio.com or
  // localhost dev got a mismatched Access-Control-Allow-Origin and were
  // rejected by the browser before they could even reach Stripe.
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const {
      planId,
      workspaceId,
      billingInterval: rawInterval,
    } = await req.json();

    if (!planId || !VALID_PLANS.has(planId)) {
      throw new Error(`Invalid plan: ${planId}`);
    }
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }

    const isVault = planId === "vault";
    // Vault is yearly-only — ignore any requested interval and bill annually.
    const billingInterval: BillingInterval = isVault
      ? "annual"
      : rawInterval && VALID_INTERVALS.has(rawInterval)
        ? (rawInterval as BillingInterval)
        : "monthly";

    const priceId = PRICE_IDS[planId as PlanId][billingInterval];
    if (!priceId) {
      // Fail closed. Vault and annual both source their price from env; a
      // missing price must never silently fall through to a wrong charge.
      return new Response(
        JSON.stringify({
          error: isVault
            ? "Vault isn't configured yet. Please contact support."
            : "Annual billing isn't yet configured for this plan. Please contact support or choose monthly.",
          reason: isVault ? "vault_not_configured" : "annual_not_configured",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 503,
        },
      );
    }

    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");

    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, firm_id")
      .eq("id", workspaceId)
      .maybeSingle();

    if (workspaceError || !workspace) {
      throw new Error("Workspace not found");
    }

    // #103: a firm-bound workspace's plan is governed by the firm-level
    // subscription. Reject independent checkout fail-closed (else this would
    // mint a second Stripe sub and the webhook would clobber the child's
    // billing columns / double-charge). Plan changes go through firm billing.
    if ((workspace as { firm_id: string | null }).firm_id) {
      return new Response(
        JSON.stringify({
          error: "Billing for this workspace is managed at the firm level.",
          reason: "firm_managed",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 403 },
      );
    }

    let canManageBilling = workspace.owner_id === user.id;
    if (!canManageBilling) {
      const { data: membership } = await supabaseAdmin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      canManageBilling = Boolean(membership);
    }

    if (!canManageBilling) {
      throw new Error("You do not have permission to manage billing for this workspace");
    }

    // Vault conversion is OWNER-ONLY (VAULT_TIER_SPEC.md — members lose access
    // in Vault, so only the owner may take the workspace there). Admins can
    // manage other billing but cannot convert to the retention tier.
    if (isVault && workspace.owner_id !== user.id) {
      return new Response(
        JSON.stringify({
          error: "Only the workspace owner can switch to Vault.",
          reason: "vault_owner_only",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 403,
        },
      );
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Check if a Stripe customer record exists for this user. Trial
    // eligibility is per-customer in Stripe — if the customer has had
    // a prior subscription on this Price, the trial may not apply.
    // Stripe handles that natively; trial_period_days is best-effort.
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }

    const origin = req.headers.get("origin") || "http://localhost:5173";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${origin}/app/settings/account?tab=billing&checkout=success`,
      cancel_url: `${origin}/app/settings/account?tab=billing&checkout=canceled`,
      metadata: {
        // workspace_id at session level too: the webhook's C2 consent
        // override reads it here first (subscription metadata is the
        // fallback for sessions created before this stamping existed).
        workspace_id: workspaceId,
        plan_id: planId,
        billing_interval: billingInterval,
      },
      subscription_data: {
        // No trial on a Vault conversion — it's a paid retention purchase
        // that takes effect immediately, not a new-customer trial.
        ...(isVault ? {} : { trial_period_days: TRIAL_PERIOD_DAYS }),
        metadata: {
          workspace_id: workspaceId,
          plan_id: planId,
          billing_interval: billingInterval,
        },
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[CREATE-CHECKOUT] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
