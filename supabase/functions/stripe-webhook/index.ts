import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import {
  ADDON_TYPE_DOCUMENT_PACK,
  ADDON_TYPE_SINGLE_LEASE,
  SINGLE_LEASE_PRICE_CENTS,
} from "../_shared/document_packs.ts";
import { GRACE_DAYS } from "../_shared/cancellation_lifecycle.ts";

const PRICE_IDS: Record<string, string> = {
  starter: "price_1SntpyH03PByDjY31dGmC0E2",
  business: "price_1SntqQH03PByDjY3MrvOjOsu",
};

// A document-pack subscription is tagged with this metadata; it must NEVER be
// run through the plan path (applySubscription), which would clobber the
// workspace's real plan/document_limit/stripe_subscription_id. Packs only
// affect workspaces.addon_document_capacity.
function isDocumentPack(subscription: Stripe.Subscription): boolean {
  return subscription.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK;
}

const DOCUMENT_LIMITS: Record<string, number> = {
  starter: 15,
  business: 50,
};

const jsonHeaders = { "Content-Type": "application/json" };

type Plan = "starter" | "business" | "vault";

function validPlan(plan: unknown): plan is Plan {
  return plan === "starter" || plan === "business" || plan === "vault";
}

// Vault retention tier (VAULT_TIER_SPEC.md V2): yearly Price ID from env —
// the operator creates the Stripe Product/Price first, same pattern as the
// annual plan prices. Metadata recognition in resolvePlan works even when
// unset (checkout-created Vault subs carry plan_id='vault'), so this is a
// second detection path, not a single point of failure; the V3 checkout
// path fails closed when it is unset.
const VAULT_PRICE_ID = Deno.env.get("STRIPE_PRICE_VAULT_ANNUAL") ?? null;

function resolvePlan(subscription: Stripe.Subscription): Plan {
  const metadataPlan = subscription.metadata?.plan_id;
  if (validPlan(metadataPlan)) return metadataPlan;

  const priceId = subscription.items.data[0]?.price?.id;
  if (VAULT_PRICE_ID && priceId === VAULT_PRICE_ID) return "vault";
  const matchedPlan = Object.entries(PRICE_IDS).find(([, id]) => id === priceId)?.[0];
  return validPlan(matchedPlan) ? matchedPlan : "starter";
}

function resolveInterval(subscription: Stripe.Subscription): "monthly" | "annual" {
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  return interval === "year" ? "annual" : "monthly";
}

function resolveCustomerId(subscription: Stripe.Subscription): string | null {
  const customer = subscription.customer;
  if (typeof customer === "string") return customer;
  return customer?.id ?? null;
}

function resolvePeriodEnd(subscription: Stripe.Subscription): string | null {
  const periodEnd = (subscription as any).current_period_end;
  return typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing Stripe signature" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Invalid signature:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Invalid Stripe signature" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  async function applySubscription(subscription: Stripe.Subscription, workspaceIdOverride?: string | null) {
    const workspaceId = workspaceIdOverride || subscription.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] Subscription event missing workspace_id", subscription.id);
      return;
    }

    const requestedPlan = resolvePlan(subscription);
    const entitled = subscription.status === "active" || subscription.status === "trialing";
    const effectivePlan = entitled ? requestedPlan : "starter";

    // C1 guard (security + integrity review 2026-06-12): Stripe does not
    // guarantee event ordering and redelivers for days. A NON-entitled
    // event must only apply when it belongs to the workspace's CURRENT
    // subscription — otherwise a late 'canceled' event for an OLD
    // subscription, arriving after the customer renewed on a NEW one,
    // would downgrade the plan and restart the deletion clock on a paying
    // customer (annual subs fire no healing event for months). Entitled
    // events always apply: a real renewal must never be skipped.
    if (!entitled) {
      const { data: wsRow } = await supabaseAdmin
        .from("workspaces")
        .select("stripe_subscription_id")
        .eq("id", workspaceId)
        .maybeSingle();
      const storedSubId = (wsRow as { stripe_subscription_id?: string | null } | null)
        ?.stripe_subscription_id;
      if (storedSubId && storedSubId !== subscription.id) {
        console.warn(
          "[stripe-webhook] ignoring non-entitled event for stale subscription",
          subscription.id,
          "current:",
          storedSubId,
        );
        return;
      }
    }

    // Cancellation lifecycle (ratified 2026-06-12): when the plan
    // subscription FULLY ends (status 'canceled' — the paid-through period
    // is over), start the 30-day read-only grace window. Renewal (any
    // entitled status) clears the whole lifecycle, restoring full access —
    // the customer can renew any time before the purge. Dunning states
    // (past_due/unpaid/incomplete) deliberately do NOT start the deletion
    // clock. canceled_at anchors to Stripe's ended_at (true period end,
    // fallback current_period_end then now), and grace_expires_at is
    // floored at now + 7 days so a webhook delivered very late can never
    // soft-delete without forward notice (integrity review 2026-06-12).
    const lifecycle: Record<string, string | null> = {};
    if (entitled) {
      lifecycle.canceled_at = null;
      lifecycle.grace_expires_at = null;
      lifecycle.soft_deleted_at = null;
      lifecycle.purge_after = null;
    } else if (subscription.status === "canceled") {
      const endedAtSec = (subscription as any).ended_at ??
        (subscription as any).current_period_end;
      const canceledAt = typeof endedAtSec === "number"
        ? new Date(endedAtSec * 1000)
        : new Date();
      lifecycle.canceled_at = canceledAt.toISOString();
      const MIN_FORWARD_NOTICE_MS = 7 * 86_400_000;
      lifecycle.grace_expires_at = new Date(Math.max(
        canceledAt.getTime() + GRACE_DAYS * 86_400_000,
        Date.now() + MIN_FORWARD_NOTICE_MS,
      )).toISOString();
    }

    // Vault (V2): document_limit is deliberately left untouched — intake is
    // frozen by the Vault V1 read-only layer regardless, and preserving the
    // prior limit keeps the workspace's shape intact for a later
    // reactivation. (DOCUMENT_LIMITS has no vault key; writing
    // DOCUMENT_LIMITS['vault'] would null the column.) An entitled Vault sub
    // clears the cancellation lifecycle via the `entitled` branch above —
    // it IS an active subscription.
    const { error } = await supabaseAdmin
      .from("workspaces")
      .update({
        plan: effectivePlan,
        ...(effectivePlan === "vault"
          ? {}
          : { document_limit: DOCUMENT_LIMITS[effectivePlan] }),
        billing_interval: resolveInterval(subscription),
        stripe_customer_id: resolveCustomerId(subscription),
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        subscription_period_end: resolvePeriodEnd(subscription),
        ...lifecycle,
      })
      .eq("id", workspaceId);

    if (error) throw new Error(`Failed to update workspace subscription: ${error.message}`);

    // Reconcile the multi-workspace creation request and log the activation
    // exactly once, on the pending -> active transition. The first/onboarding
    // workspace has no workspace_creation_requests row, so this is naturally
    // scoped to additional workspaces created via create-workspace. The webhook
    // remains the SOLE entitlement writer; this only records the activation
    // event (append-only audit) and advances the request state machine off
    // 'pending' (which nothing else does on the happy path).
    if (entitled) {
      // Best-effort audit/state reconciliation — NOT entitlement-critical (the
      // entitlement update above already committed). Wrapped so a transient
      // failure here can never 500 the webhook and force needless Stripe
      // retries of a successful entitlement write.
      try {
        const { data: reqRow } = await supabaseAdmin
          .from("workspace_creation_requests")
          .select("idempotency_key, status")
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        if (reqRow && (reqRow as { status: string }).status === "pending") {
          await supabaseAdmin
            .from("workspace_creation_requests")
            .update({ status: "active", updated_at: new Date().toISOString() })
            .eq("workspace_id", workspaceId);
          const { data: wsRow } = await supabaseAdmin
            .from("workspaces")
            .select("owner_id")
            .eq("id", workspaceId)
            .maybeSingle();
          const ownerId = (wsRow as { owner_id: string } | null)?.owner_id ?? null;
          if (!ownerId) {
            console.warn("[stripe-webhook] activated event: owner lookup missed for", workspaceId);
          }
          await supabaseAdmin.from("workspace_activity_log").insert({
            workspace_id: workspaceId,
            user_id: ownerId,
            event_type: "activated",
            details: {
              subscription_id: subscription.id,
              status: subscription.status,
              idempotency_key: (reqRow as { idempotency_key: string }).idempotency_key,
            },
          });
        }
      } catch (reconErr) {
        console.error(
          "[stripe-webhook] reconciliation (non-fatal) failed for",
          workspaceId,
          reconErr instanceof Error ? reconErr.message : reconErr,
        );
      }
    }
  }

  // Recompute a workspace's total document-pack capacity from Stripe and mirror
  // it onto workspaces.addon_document_capacity. Capacity is the SUM of the
  // sizes of the workspace's active/trialing pack subscriptions, so this is
  // idempotent and self-healing — any pack event (create/update/cancel) just
  // re-derives the total. NEVER touches plan/document_limit.
  //
  // Uses subscriptions.list (strongly consistent) rather than subscriptions.search
  // (eventually consistent — would lag the just-fired event). cancel_at_period_end
  // packs stay status='active' until the period ends, so their capacity correctly
  // persists until Stripe flips them to 'canceled' and fires another event.
  async function applyDocumentPack(subscription: Stripe.Subscription) {
    const workspaceId = subscription.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] document-pack event missing workspace_id", subscription.id);
      return;
    }
    const customerId = resolveCustomerId(subscription);
    if (!customerId) {
      console.warn("[stripe-webhook] document-pack event missing customer", subscription.id);
      return;
    }

    let total = 0;
    // Page through the customer's subscriptions (strongly consistent).
    let startingAfter: string | undefined = undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        starting_after: startingAfter,
      });
      for (const s of page.data) {
        if (
          s.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK &&
          s.metadata?.workspace_id === workspaceId &&
          (s.status === "active" || s.status === "trialing")
        ) {
          total += Number.parseInt(s.metadata?.pack_size ?? "0", 10) || 0;
        }
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    const { error } = await supabaseAdmin
      .from("workspaces")
      .update({ addon_document_capacity: total })
      .eq("id", workspaceId);
    if (error) {
      throw new Error(`Failed to update addon_document_capacity: ${error.message}`);
    }
  }

  // Grant a single-lease credit for a succeeded one-time PaymentIntent. The
  // ledger's UNIQUE(payment_intent_id) makes webhook retries idempotent — the
  // duplicate insert no-ops and the grant trigger never fires twice. The
  // workspace counter is incremented by the lease_credit_purchases AFTER
  // INSERT trigger, not here, so grant accounting has exactly one writer.
  async function applySingleLeaseCredit(pi: Stripe.PaymentIntent) {
    const workspaceId = pi.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] single-lease PI missing workspace_id", pi.id);
      return;
    }

    // Trust the money, not the metadata. The only legitimate writer
    // (manage-document-pack) stamps quantity="1" and charges
    // SINGLE_LEASE_PRICE_CENTS[plan] to the workspace's own customer — so
    // validate the grant against the workspace's billing state, not against
    // self-asserted metadata. Defends the ledger if the single_lease tag is
    // ever reused with different semantics (refund flow, dashboard PI, etc.).
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("plan, stripe_customer_id")
      .eq("id", workspaceId)
      .maybeSingle();
    const wsRow = ws as { plan?: string; stripe_customer_id?: string | null } | null;
    if (!wsRow) {
      console.warn("[stripe-webhook] single-lease PI references unknown workspace", workspaceId, pi.id);
      return;
    }
    const plan: "starter" | "business" = wsRow.plan === "business" ? "business" : "starter";
    const expectedCents = SINGLE_LEASE_PRICE_CENTS[plan];
    const paidCents = pi.amount_received ?? pi.amount ?? 0;
    const piCustomer = typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;

    // Clamp quantity to exactly 1 (the only supported single-lease purchase),
    // and require the charge to cover the price and belong to this workspace's
    // customer. Reject rather than over-grant on any mismatch.
    if (paidCents < expectedCents) {
      console.error(`[stripe-webhook] single-lease PI underpaid: ${paidCents} < ${expectedCents}`, pi.id);
      return;
    }
    if (wsRow.stripe_customer_id && piCustomer && piCustomer !== wsRow.stripe_customer_id) {
      console.error("[stripe-webhook] single-lease PI customer mismatch", pi.id);
      return;
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const purchasedBy = uuidRe.test(pi.metadata?.purchased_by ?? "") ? pi.metadata?.purchased_by : null;

    const { error } = await supabaseAdmin
      .from("lease_credit_purchases")
      .upsert(
        {
          workspace_id: workspaceId,
          payment_intent_id: pi.id,
          quantity: 1,
          amount_cents: paidCents,
          purchased_by: purchasedBy,
        },
        { onConflict: "payment_intent_id", ignoreDuplicates: true },
      );
    if (error) {
      throw new Error(`Failed to record lease credit purchase: ${error.message}`);
    }
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.addon_type === ADDON_TYPE_SINGLE_LEASE) {
          await applySingleLeaseCredit(pi);
        }
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const workspaceId = session.metadata?.workspace_id ?? null;
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
        if (!subscriptionId) break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        // Packs are created via subscriptions.create (no checkout session), but
        // guard anyway so a pack can never take the plan path.
        if (isDocumentPack(subscription)) {
          await applyDocumentPack(subscription);
        } else {
          await applySubscription(subscription, workspaceId);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        if (isDocumentPack(subscription)) {
          await applyDocumentPack(subscription);
        } else {
          await applySubscription(subscription);
        }
        break;
      }

      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error("[stripe-webhook] Handler error:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Webhook handler failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
