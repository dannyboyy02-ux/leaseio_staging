import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";
import { describePaymentMethod } from "../_shared/payment_method.ts";
import { resolvePeriodEndIso } from "../_shared/stripe_subscription.ts";

// Read-only billing summary for the in-app Billing tab: the saved card
// (brand + last4 only — never the full PAN or a PaymentMethod secret) and the
// recent invoices. Mirrors customer-portal's auth/gating exactly; the only
// divergence is that a workspace with no Stripe customer returns 200 with empty
// data + reason:"no_customer" (a fresh trial legitimately has none — the
// Payment/Invoices sections render an empty state, not an error).
//
// COST BOUND: up to four cheap Stripe GETs + one invoices.list(limit:12). The
// frontend MUST call this once on Billing-tab open (admin-gated), never on a
// render path — do not move the invoke() into a component body.
//
// The `subscription` block (status + cancelAtPeriodEnd + currentPeriodEnd) is
// what lets the Billing tab tell "auto-renews" from "scheduled to cancel":
// Stripe leaves status='active' after a cancel is scheduled, so the persisted
// workspace.subscription_status can't distinguish the two. Sourcing the flag
// here (rather than a mirrored column + webhook change) keeps the scheduled-
// cancel signal on the one surface that needs it with no schema migration.

const INVOICE_LIMIT = 12;

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status,
    });

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header provided", reason: "no_auth" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return json({ error: "User not authenticated", reason: "invalid_auth" }, 401);
    }
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return json({ error: "workspaceId is required", reason: "bad_request" }, 400);
    }

    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, stripe_customer_id, stripe_subscription_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (wsErr || !workspace) {
      return json({ error: "Workspace not found", reason: "not_found" }, 404);
    }

    // Owner-OR-admin gating — same boundary as customer-portal. Billing data is
    // privileged; members must not read the card or invoices.
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
      return json(
        {
          error: "Only workspace owners or admins can view billing details.",
          reason: "not_authorized",
        },
        403,
      );
    }

    const customerId = (workspace as any).stripe_customer_id as string | null;
    if (!customerId) {
      // No subscription yet (e.g. a fresh trial) — not an error.
      return json({ ok: true, card: null, invoices: [], subscription: null, reason: "no_customer" }, 200);
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    try {
      // Saved payment method: prefer the customer's default PM, else the first
      // attached method of ANY type. Do NOT filter type:'card' — Checkout via
      // Stripe Link / Apple Pay / Google Pay / ACH saves a non-'card'
      // PaymentMethod, and filtering it out showed "no payment method on file"
      // for a paying customer (billing incident 2026-07-11). describePaymentMethod
      // maps every type to a labeled descriptor. Mirrors resolveCustomerAndPaymentMethod()
      // in create-workspace.
      const customer = await stripe.customers.retrieve(customerId);
      let pmId: string | null = null;
      if (customer && !("deleted" in customer && customer.deleted)) {
        const dpm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
        pmId = typeof dpm === "string" ? dpm : dpm?.id ?? null;
      }
      if (!pmId) {
        const pms = await stripe.paymentMethods.list({
          customer: customerId,
          limit: 1,
        });
        pmId = pms.data[0]?.id ?? null;
      }
      let card = null;
      if (pmId) {
        const pm = await stripe.paymentMethods.retrieve(pmId);
        card = describePaymentMethod(pm as unknown as Parameters<typeof describePaymentMethod>[0]);
      }

      const invoiceList = await stripe.invoices.list({
        customer: customerId,
        limit: INVOICE_LIMIT,
      });
      const invoices = invoiceList.data.map((i) => ({
        id: i.id,
        created: i.created, // unix seconds
        total: i.total ?? i.amount_paid ?? 0, // minor units
        currency: i.currency,
        status: i.status, // paid | open | void | uncollectible | draft
        hostedInvoiceUrl: i.hosted_invoice_url ?? null,
        invoicePdf: i.invoice_pdf ?? null,
      }));

      // Subscription state — the scheduled-cancel signal (see header note).
      // Best-effort: a missing/inaccessible sub id must not fail the whole
      // summary (card + invoices still render). Null when there is no sub.
      let subscription: {
        status: string;
        cancelAtPeriodEnd: boolean;
        currentPeriodEnd: string | null;
      } | null = null;
      const subscriptionId = (workspace as any).stripe_subscription_id as string | null;
      if (subscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          subscription = {
            status: sub.status,
            cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
            // Items-aware read — Basil removed top-level current_period_end
            // (_shared/stripe_subscription.ts).
            currentPeriodEnd: resolvePeriodEndIso(sub),
          };
        } catch (subErr) {
          console.error(
            "[GET-BILLING-SUMMARY] subscription retrieve failed (non-fatal):",
            subErr instanceof Error ? subErr.message : subErr,
          );
        }
      }

      return json({ ok: true, card, invoices, subscription }, 200);
    } catch (stripeErr) {
      const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
      console.error("[GET-BILLING-SUMMARY] Stripe error:", msg);
      return json({ error: msg, reason: "stripe_error" }, 502);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[GET-BILLING-SUMMARY] Error:", errorMessage);
    return json({ error: errorMessage }, 500);
  }
});
