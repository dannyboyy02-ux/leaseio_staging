import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { BUSINESS_MONTHLY_PRICE_ID } from "../_shared/workspace_limits.ts";
import { countFirmChildren } from "../_shared/firm_billing.ts";

// Phase 10 / #105 — create the firm's Stripe subscription. Per-child quantity on
// the STANDARD Business price (reuse BUSINESS_MONTHLY_PRICE_ID; no firm Product),
// quantity = bound child count, metadata.firm_id. ON-SESSION default_incomplete
// so a 3DS card yields a completable PaymentIntent. The stripe-webhook
// applyFirmSubscription branch mirrors the sub onto `firms` + propagates
// 'business' to children once payment confirms. FIRM OWNER ONLY. verify_jwt=false
// (manual auth → structured 401). The firm must have ≥1 bound child (the
// quantity); onboarding binds/creates the first child before calling this.

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

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const firmId = (body as { firmId?: string }).firmId;
    const idempotencyKey = (body as { idempotencyKey?: string }).idempotencyKey;
    if (!firmId || typeof firmId !== "string") return json({ ok: false, reason: "bad_request", message: "firmId is required" }, 400);
    if (!idempotencyKey || typeof idempotencyKey !== "string") return json({ ok: false, reason: "bad_request", message: "idempotencyKey is required" }, 400);

    const { data: firm } = await supabaseAdmin
      .from("firms").select("id, owner_id, stripe_customer_id, stripe_subscription_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    if ((firm as { owner_id: string }).owner_id !== user.id)
      return json({ ok: false, reason: "not_authorized", message: "Only the firm owner can start the subscription" }, 403);
    if ((firm as { stripe_subscription_id: string | null }).stripe_subscription_id)
      return json({ ok: true, status: "already_subscribed" }, 200);

    const quantity = await countFirmChildren(supabaseAdmin, firmId);
    if (quantity < 1)
      return json({ ok: false, reason: "no_children", message: "Add at least one workspace to the firm before starting billing" }, 409);

    // Resolve the owner's Stripe customer (prefer the firm's stored id, then an
    // existing Business workspace's customer, then by email) + default card.
    let customerId = (firm as { stripe_customer_id: string | null }).stripe_customer_id;
    if (!customerId) {
      const { data: bizWs } = await supabaseAdmin
        .from("workspaces").select("stripe_customer_id").eq("owner_id", user.id).eq("plan", "business")
        .not("stripe_customer_id", "is", null).limit(1).maybeSingle();
      customerId = (bizWs as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;
    }
    if (!customerId) {
      // CREATE-ONLY fallback (#61 class): never adopt an arbitrary
      // customers.list({email}) hit — email is not unique in Stripe, so a list
      // match could bind this firm's N×$499 sub to ANOTHER account's customer.
      // The onboarding SetupIntent normally sets firms.stripe_customer_id first,
      // so this path is the net-new-owner case; create a fresh customer for them.
      customerId = (await stripe.customers.create({ email: user.email, metadata: { firm_id: firmId } })).id;
    }

    const customer = await stripe.customers.retrieve(customerId);
    let pmId: string | null = null;
    if (!("deleted" in customer) || !customer.deleted) {
      const dpm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
      pmId = typeof dpm === "string" ? dpm : dpm?.id ?? null;
    }
    if (!pmId) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
      pmId = pms.data[0]?.id ?? null;
    }
    if (!pmId) return json({ ok: false, reason: "no_card_on_file", message: "Add a payment method before starting firm billing" }, 409);

    // Server-side double-create guard (does NOT rely on the client-chosen
    // idempotencyKey): a firm must never hold two subscriptions. The DB
    // already_subscribed check above is null during the 3DS window (the webhook
    // writes stripe_subscription_id only on confirmation), so check Stripe
    // directly for a live sub tagged with this firm_id and, if found, return ITS
    // PaymentIntent for the client to finish rather than creating a second.
    const existingSubs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    const liveStatuses = ["active", "trialing", "past_due", "incomplete", "unpaid"];
    const dupe = existingSubs.data.find((s) => s.metadata?.firm_id === firmId && liveStatuses.includes(s.status));
    if (dupe) {
      // Basil (2025-03-31+) removed invoice.payment_intent — the invoice's
      // confirmation_secret carries the same client_secret for the
      // default_incomplete confirm flow (money-path audit 2026-07-11).
      const full = await stripe.subscriptions.retrieve(dupe.id, { expand: ["latest_invoice.confirmation_secret"] });
      const inv = full.latest_invoice as unknown as
        { status?: string | null; confirmation_secret?: { client_secret?: string | null } | null } | null;
      // Only an OPEN (unpaid) invoice is confirmable — handing out a paid
      // invoice's secret would make the client attempt a confirm Stripe
      // rejects (integrity review 2026-07-11). A paid dupe = already live
      // (webhook-lag window); report already_subscribed instead.
      if (inv?.status !== "open") {
        return json({ ok: true, status: "already_subscribed" }, 200);
      }
      const clientSecret = inv?.confirmation_secret?.client_secret ?? null;
      return json({
        ok: true,
        status: "pending",
        existing: true,
        clientSecret,
        paymentIntentStatus: clientSecret ? "requires_confirmation" : null,
        invoiceStatus: inv?.status ?? null,
      }, 200);
    }

    const subscription = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: BUSINESS_MONTHLY_PRICE_ID, quantity }],
        default_payment_method: pmId,
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        // Basil (2025-03-31+): confirmation_secret replaces the removed
        // invoice.payment_intent expand (money-path audit 2026-07-11).
        expand: ["latest_invoice.confirmation_secret"],
        metadata: { firm_id: firmId, plan_id: "business", billing_interval: "monthly" },
      },
      { idempotencyKey: `firm_sub_${firmId}_${idempotencyKey}` },
    );

    // Persist the customer id now so the webhook + future syncs resolve it even
    // before payment confirms (the subscription id is written by the webhook on
    // confirmation, to avoid recording an unpaid sub as active).
    await supabaseAdmin.from("firms").update({ stripe_customer_id: customerId }).eq("id", firmId);

    const invoice = subscription.latest_invoice as unknown as
      { status?: string | null; confirmation_secret?: { client_secret?: string | null } | null } | null;
    const clientSecret = invoice?.confirmation_secret?.client_secret ?? null;
    return json({
      ok: true,
      status: "pending",
      quantity,
      clientSecret,
      paymentIntentStatus: clientSecret ? "requires_confirmation" : null,
      invoiceStatus: invoice?.status ?? null,
    }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[create-firm-subscription] error:", msg);
    return json({ ok: false, reason: "server_error", message: "Could not start the firm subscription" }, 500);
  }
});
