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
    monthly: "price_1SntpyH03PByDjY31dGmC0E2",
    annual: Deno.env.get("STRIPE_PRICE_STARTER_ANNUAL") ?? null,
  },
  business: {
    monthly: "price_1SntqQH03PByDjY3MrvOjOsu",
    annual: Deno.env.get("STRIPE_PRICE_BUSINESS_ANNUAL") ?? null,
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

    const billingInterval: BillingInterval =
      rawInterval && VALID_INTERVALS.has(rawInterval)
        ? (rawInterval as BillingInterval)
        : "monthly";

    const priceId = PRICE_IDS[planId as PlanId][billingInterval];
    if (!priceId) {
      // Fail closed if annual isn't configured. Better than charging
      // monthly silently when the user clicked annual.
      return new Response(
        JSON.stringify({
          error:
            "Annual billing isn't yet configured for this plan. Please contact support or choose monthly.",
          reason: "annual_not_configured",
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
      .select("id, owner_id")
      .eq("id", workspaceId)
      .maybeSingle();

    if (workspaceError || !workspace) {
      throw new Error("Workspace not found");
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
      success_url: `${origin}/app/settings/account?tab=subscription&checkout=success`,
      cancel_url: `${origin}/app/settings/account?tab=subscription&checkout=canceled`,
      metadata: {
        plan_id: planId,
        billing_interval: billingInterval,
      },
      subscription_data: {
        trial_period_days: TRIAL_PERIOD_DAYS,
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
