import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

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

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // ?portal=return lets the Billing tab acknowledge the round-trip (toast +
      // refresh + re-fetch the saved card) instead of returning in silence.
      return_url: `${origin}/app/settings/account?tab=billing&portal=return`,
    });

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
