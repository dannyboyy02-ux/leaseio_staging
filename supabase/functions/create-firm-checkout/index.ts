import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { BUSINESS_MONTHLY_PRICE_ID } from "../_shared/workspace_limits.ts";
import { countFirmChildren } from "../_shared/firm_billing.ts";

// Phase 10 / #105-C — start firm billing via a hosted Stripe Checkout Session.
// Per-child quantity on the EXISTING Business price (quantity = bound child
// count, subscription_data.metadata.firm_id). Checkout collects the card +
// handles 3DS on Stripe's page; the stripe-webhook checkout.session.completed →
// applyFirmSubscription branch mirrors the sub onto `firms` + propagates
// 'business'. FIRM OWNER ONLY. No trial (B2B, starts immediately). The firm must
// have ≥1 bound child (the quantity). verify_jwt = false (manual auth → 401).
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: s });

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return json({ ok: false, reason: "server_error", message: "Billing not configured" }, 500);
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, reason: "no_auth" }, 401);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace(/^Bearer\s+/i, "").trim());
    if (userError || !userData?.user?.id || !userData.user.email) return json({ ok: false, reason: "invalid_auth" }, 401);
    const user = userData.user;

    const firmId = (await req.json().catch(() => ({}))).firmId;
    if (!firmId || typeof firmId !== "string") return json({ ok: false, reason: "bad_request", message: "firmId is required" }, 400);

    const { data: firm } = await supabaseAdmin
      .from("firms").select("id, owner_id, stripe_customer_id, stripe_subscription_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    if ((firm as { owner_id: string }).owner_id !== user.id)
      return json({ ok: false, reason: "not_authorized", message: "Only the firm owner can start billing" }, 403);
    if ((firm as { stripe_subscription_id: string | null }).stripe_subscription_id)
      return json({ ok: true, status: "already_subscribed" }, 200);

    const quantity = await countFirmChildren(supabaseAdmin, firmId);
    if (quantity < 1)
      return json({ ok: false, reason: "no_children", message: "Add at least one workspace to the firm before starting billing" }, 409);

    const origin = req.headers.get("origin") || "http://localhost:5173";

    // Resolve/create the owner's customer (prefer the firm's stored id → an
    // owned Business workspace's customer → CREATE-ONLY, #61-safe) and STAMP it
    // before the session. Stamping is what lets a repeat checkout (two tabs,
    // back-button) find the in-flight subscription below and short-circuit —
    // closing the double-subscription window even for a net-new owner whose
    // firms.stripe_customer_id was null on the first attempt.
    let customerId = (firm as { stripe_customer_id: string | null }).stripe_customer_id;
    if (!customerId) {
      const { data: bizWs } = await supabaseAdmin
        .from("workspaces").select("stripe_customer_id").eq("owner_id", user.id).eq("plan", "business")
        .not("stripe_customer_id", "is", null).limit(1).maybeSingle();
      customerId = (bizWs as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;
    }
    if (!customerId) {
      customerId = (await stripe.customers.create({ email: user.email, metadata: { firm_id: firmId } })).id;
    }
    await supabaseAdmin.from("firms").update({ stripe_customer_id: customerId }).eq("id", firmId);

    // Double-subscription guard (independent of payment confirmation, which is
    // when firms.stripe_subscription_id gets written): a firm must never hold
    // two subs. Scan the customer for a live sub already tagged with this firm.
    const existingSubs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    const liveStatuses = ["active", "trialing", "past_due", "incomplete", "unpaid"];
    if (existingSubs.data.some((s) => s.metadata?.firm_id === firmId && liveStatuses.includes(s.status))) {
      return json({ ok: true, status: "already_subscribed" }, 200);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: BUSINESS_MONTHLY_PRICE_ID, quantity }],
      mode: "subscription",
      success_url: `${origin}/app/firm?checkout=success`,
      cancel_url: `${origin}/app/firm/onboarding?checkout=canceled`,
      metadata: { firm_id: firmId, plan_id: "business", billing_interval: "monthly" },
      subscription_data: {
        metadata: { firm_id: firmId, plan_id: "business", billing_interval: "monthly" },
      },
    });

    return json({ ok: true, url: session.url }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[create-firm-checkout] error:", msg);
    return json({ ok: false, reason: "server_error", message: "Could not start firm billing" }, 500);
  }
});
