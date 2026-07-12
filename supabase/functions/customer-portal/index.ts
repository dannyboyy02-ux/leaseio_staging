import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Card-management-only portal configuration (2026-07-12, live UX walkthrough).
// The in-app Billing tab owns cancel/resume (cancel-subscription fn) and plan
// changes, each with full feedback; the portal's own duplicate cancel flow was
// a second, silent cancel path — a user canceling there returned to a neutral
// "Billing information refreshed" toast instead of the scheduled-cancel notice
// (owner report). Pin a configuration limited to payment-method update +
// invoice history so the portal can ONLY do what the app sends people there
// for. Resolved once per function instance (cached); on any failure we fall
// back to the account's default configuration — the portal stays usable, it
// just temporarily regains Stripe's default features.
let cachedPortalConfigId: string | null = null;
// deno-lint-ignore no-explicit-any
async function resolvePortalConfiguration(stripe: any): Promise<string | null> {
  if (cachedPortalConfigId) return cachedPortalConfigId;
  try {
    const existing = await stripe.billingPortal.configurations.list({ limit: 100, active: true });
    const hit = existing.data.find(
      // deno-lint-ignore no-explicit-any
      (c: any) => c.metadata?.leaseio_config === "card_management_v1" && c.active,
    );
    if (hit) {
      cachedPortalConfigId = hit.id;
      return hit.id;
    }
    const created = await stripe.billingPortal.configurations.create({
      business_profile: {},
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: false },
        customer_update: { enabled: false },
      },
      metadata: { leaseio_config: "card_management_v1" },
    });
    cachedPortalConfigId = created.id;
    return created.id;
  } catch (e) {
    console.error(
      "[CUSTOMER-PORTAL] configuration resolve failed — using account default:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

serve(async (req) => {
  // P1-02: derive CORS from request origin per call — see create-checkout for context.
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.id) throw new Error("User not authenticated");

    // P2-07: workspace-scoped lookup. Email-based stripe.customers.list
    // returned whatever the first customer for that email happened to
    // be, which in a multi-workspace account points at the wrong
    // subscription. Now the caller must pass workspaceId, we verify
    // owner/admin membership, and resolve the customer from
    // workspaces.stripe_customer_id (populated by stripe-webhook).
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return new Response(
        JSON.stringify({ error: "workspaceId is required", reason: "bad_request" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }

    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, stripe_customer_id, firm_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (wsErr || !workspace) {
      return new Response(
        JSON.stringify({ error: "Workspace not found", reason: "not_found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 },
      );
    }

    // #103: a firm-bound workspace has no own subscription (the firm sub carries
    // metadata.firm_id, not workspace_id) — its stripe_customer_id is null and
    // the firm governs billing. Reject fail-closed so we never open an empty /
    // mismatched portal for a child. Billing is managed on the firm billing page.
    if ((workspace as { firm_id: string | null }).firm_id) {
      return new Response(
        JSON.stringify({
          error: "Billing for this workspace is managed at the firm level.",
          reason: "firm_managed",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 403 },
      );
    }

    let canManageBilling = (workspace as any).owner_id === user.id;
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
      return new Response(
        JSON.stringify({
          error: "Only workspace owners or admins can open the billing portal.",
          reason: "not_authorized",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 403 },
      );
    }

    const customerId = (workspace as any).stripe_customer_id as string | null;
    if (!customerId) {
      return new Response(
        JSON.stringify({
          error: "This workspace has no Stripe customer record. Start a subscription first.",
          reason: "no_customer",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 409 },
      );
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const origin = req.headers.get("origin") || "http://localhost:5173";

    const portalConfigId = await resolvePortalConfiguration(stripe);
    const returnUrl = `${origin}/app/settings/account?tab=billing&portal=return`;
    let portalSession;
    try {
      portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        // Card-management-only configuration (see resolvePortalConfiguration) —
        // cancel/plan changes live in-app where they get proper notices.
        ...(portalConfigId ? { configuration: portalConfigId } : {}),
        // ?portal=return lets the Billing tab acknowledge the round-trip (toast +
        // refresh + re-fetch the saved card) instead of returning in silence.
        return_url: returnUrl,
      });
    } catch (sessionErr) {
      // A cached configuration id can go stale (e.g. deactivated in the Stripe
      // dashboard) and would otherwise 500 every request for this instance's
      // lifetime. Drop the cache and retry once on the account default —
      // degraded (Stripe's default features) beats a dead portal button.
      if (!portalConfigId) throw sessionErr;
      console.error(
        "[CUSTOMER-PORTAL] session create failed with pinned configuration — retrying on account default:",
        sessionErr instanceof Error ? sessionErr.message : sessionErr,
      );
      cachedPortalConfigId = null;
      portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
    }

    return new Response(JSON.stringify({ url: portalSession.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[CUSTOMER-PORTAL] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
