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

// A firm-tier subscription is tagged with metadata.firm_id (stamped by the
// operator or the future firm-billing checkout). It routes to the firm, NOT a
// workspace — a firm owns its children's plan via one firm-level subscription.
// Must be checked BEFORE the workspace plan path so a firm sub never clobbers a
// workspace row.
function isFirmSubscription(subscription: Stripe.Subscription): boolean {
  return Boolean(subscription.metadata?.firm_id);
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

// Annual plan Price IDs come from env, same as create-checkout (which fails
// closed without them). Listed here so resolvePlan can recognize an annual
// sub whose metadata went missing instead of silently misclassifying it.
const ANNUAL_PRICE_IDS: Record<string, string | null> = {
  starter: Deno.env.get("STRIPE_PRICE_STARTER_ANNUAL") ?? null,
  business: Deno.env.get("STRIPE_PRICE_BUSINESS_ANNUAL") ?? null,
};

// Returns null when the subscription matches NO known identity (neither
// metadata plan_id nor any recognized price). Callers decide the failure
// shape: an ENTITLED unresolvable sub must fail loudly (security review
// 2026-06-13 — defaulting it to 'starter' silently granted write access +
// starter document_limit for unrecognized money, e.g. a hand-created Vault
// sub with the env var unset); a non-entitled one only drives the downgrade
// path where 'starter' is the correct floor.
function resolvePlan(subscription: Stripe.Subscription): Plan | null {
  const metadataPlan = subscription.metadata?.plan_id;
  if (validPlan(metadataPlan)) return metadataPlan;
  // Legacy metadata from pre-2026-05-07 subs: coerce like normalizePlanId
  // does DB-side, so an old sub's event resolves instead of 500ing forever.
  if (metadataPlan === "pro" || metadataPlan === "free") return "starter";

  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) return null;
  if (VAULT_PRICE_ID && priceId === VAULT_PRICE_ID) return "vault";
  const matchedPlan = Object.entries(PRICE_IDS).find(([, id]) => id === priceId)?.[0];
  if (validPlan(matchedPlan)) return matchedPlan;
  const matchedAnnual = Object.entries(ANNUAL_PRICE_IDS).find(([, id]) => id && id === priceId)?.[0];
  return validPlan(matchedAnnual) ? matchedAnnual : null;
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

    const resolvedPlan = resolvePlan(subscription);
    const entitled = subscription.status === "active" || subscription.status === "trialing";

    // An ENTITLED sub we cannot identify must fail loudly instead of
    // falling back — a 500 makes Stripe retry and surface in monitoring,
    // where defaulting to 'starter' would silently hand write access +
    // starter entitlements to unrecognized money (the Vault-priced-sub-with-
    // env-unset case; security review 2026-06-13).
    if (entitled && !resolvedPlan) {
      console.error(
        "[stripe-webhook] entitled subscription matches no known plan (metadata or price) — refusing to default",
        subscription.id,
        subscription.items.data[0]?.price?.id,
      );
      throw new Error(`Unresolvable entitled subscription ${subscription.id}`);
    }
    const effectivePlan: Plan = entitled ? resolvedPlan! : "starter";

    // One lookup serves the C1 + C2 guards and the plan-change audit row.
    const { data: wsRow } = await supabaseAdmin
      .from("workspaces")
      .select("plan, stripe_subscription_id")
      .eq("id", workspaceId)
      .maybeSingle();
    const priorState = wsRow as { plan?: string | null; stripe_subscription_id?: string | null } | null;
    const storedSubId = priorState?.stripe_subscription_id;

    // C1 guard (security + integrity review 2026-06-12): Stripe does not
    // guarantee event ordering and redelivers for days. A NON-entitled
    // event must only apply when it belongs to the workspace's CURRENT
    // subscription — otherwise a late 'canceled' event for an OLD
    // subscription, arriving after the customer renewed on a NEW one,
    // would downgrade the plan and restart the deletion clock on a paying
    // customer (annual subs fire no healing event for months).
    if (!entitled && storedSubId && storedSubId !== subscription.id) {
      console.warn(
        "[stripe-webhook] ignoring non-entitled event for stale subscription",
        subscription.id,
        "current:",
        storedSubId,
      );
      return;
    }

    // C2 guard (integrity review 2026-06-13, Vault V2): an ENTITLED event
    // for a DIFFERENT subscription than the stored one applies only when it
    // arrives through checkout.session.completed (workspaceIdOverride set —
    // an explicit consented purchase switching the workspace's plan sub).
    // Without this, the old plan sub's entitled `updated` event (fired
    // deterministically when V3 sets cancel_at_period_end on it) clobbers a
    // fresh Vault conversion back to the old plan AND re-stores the old sub
    // id — so its eventual `canceled` passes C1, starts the grace clock on
    // a paying Vault customer, and the purge cron ultimately cancels the
    // live Vault sub and destroys paid retention data. Same-sub renewals
    // (id matches) and first subs (no stored id) still apply.
    if (entitled && !workspaceIdOverride && storedSubId && storedSubId !== subscription.id) {
      console.warn(
        "[stripe-webhook] ignoring entitled event for non-current subscription (no checkout consent)",
        subscription.id,
        "current:",
        storedSubId,
      );
      return;
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

    // Vault (V2): DOCUMENT_LIMITS has no vault key, so document_limit is
    // left untouched on conversion. The honest invariant (integrity review
    // 2026-06-13): document_limit is MEANINGLESS while plan='vault' — its
    // value is path-dependent (50 if converted from live Business, 15 if
    // converted from lapsed grace) and every consumer must gate on plan
    // first. Intake is frozen by the Vault V1 layer before any limit is
    // read, and any reactivation rewrites the column from the new plan, so
    // nothing real depends on the stale value. The undefined-guard (not a
    // 'vault' literal) keeps a future plan value without a DOCUMENT_LIMITS
    // entry from nulling the column. An entitled Vault sub clears the
    // cancellation lifecycle via the `entitled` branch above — it IS an
    // active subscription.
    const newDocumentLimit = DOCUMENT_LIMITS[effectivePlan];
    const { error } = await supabaseAdmin
      .from("workspaces")
      .update({
        plan: effectivePlan,
        ...(newDocumentLimit !== undefined
          ? { document_limit: newDocumentLimit }
          : {}),
        billing_interval: resolveInterval(subscription),
        stripe_customer_id: resolveCustomerId(subscription),
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        subscription_period_end: resolvePeriodEnd(subscription),
        ...lifecycle,
      })
      .eq("id", workspaceId);

    if (error) throw new Error(`Failed to update workspace subscription: ${error.message}`);

    // Plan transitions are audit-relevant (a Vault conversion changes access
    // semantics; an entitled event can resurrect a soft-deleted workspace
    // whose death the lifecycle cron DID log) — record them. Best-effort,
    // like the activation reconciliation below: the entitlement write above
    // already committed and must not be retried for an audit hiccup.
    const priorPlan = priorState?.plan ?? null;
    if (priorPlan !== effectivePlan) {
      try {
        const { error: auditDbErr } = await supabaseAdmin.from("workspace_activity_log").insert({
          workspace_id: workspaceId,
          user_id: null,
          event_type: "plan_changed",
          details: {
            from_plan: priorPlan,
            to_plan: effectivePlan,
            subscription_id: subscription.id,
            subscription_status: subscription.status,
            source: "stripe_webhook",
          },
        });
        if (auditDbErr) {
          console.error("[stripe-webhook] plan_changed audit insert rejected:", auditDbErr.message);
        }
      } catch (auditErr) {
        console.error(
          "[stripe-webhook] plan_changed audit insert failed (entitlement write already committed):",
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
    }

    // Vault conversion (V3): when a workspace becomes entitled-Vault, retire
    // its document-pack subscriptions — capacity packs are meaningless on a
    // read-only retention workspace, and "packs end at period close" is the
    // ratified rule (VAULT_TIER_SPEC.md V3). cancel_at_period_end is
    // idempotent (a redelivered event re-finds already-flagged packs and
    // skips them) and webhook-safe. Best-effort: a Stripe hiccup here must
    // not 500 the webhook and undo the committed entitlement write. The plan
    // sub itself needs no action — under the convert-at-grace model the prior
    // plan sub has already ended by the time Vault activates.
    if (entitled && effectivePlan === "vault") {
      try {
        const customerId = resolveCustomerId(subscription);
        if (customerId) {
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
                (s.status === "active" || s.status === "trialing") &&
                !s.cancel_at_period_end
              ) {
                await stripe.subscriptions.update(s.id, { cancel_at_period_end: true });
                console.log("[stripe-webhook] vault conversion: retiring pack sub at period end", s.id);
              }
            }
            if (!page.has_more || page.data.length === 0) break;
            startingAfter = page.data[page.data.length - 1].id;
          }
        }
      } catch (packErr) {
        console.error(
          "[stripe-webhook] vault pack-retirement failed (entitlement write already committed):",
          packErr instanceof Error ? packErr.message : packErr,
        );
      }
    }

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
  // #65: durably record any paid event we could NOT honor, so a dropped grant
  // is forensically recoverable (and ops-surfaceable) instead of a vanished
  // console.warn. Best-effort — if even this write fails we're back to the prior
  // log-only status quo, so it logs loudly but never re-raises: an un-honorable
  // event must not loop the webhook on retries.
  async function recordBillingDeadLetter(params: {
    source: "document_pack" | "single_lease_credit";
    reason:
      | "missing_workspace_id"
      | "missing_customer"
      | "unknown_workspace"
      | "underpaid"
      | "customer_mismatch";
    stripeObjectId: string;
    eventId: string | null;
    stripeCustomerId?: string | null;
    claimedWorkspaceId?: string | null;
    amountCents?: number | null;
    purchasedBy?: string | null;
    rawMetadata?: Record<string, unknown> | null;
  }) {
    const { error } = await supabaseAdmin.rpc("record_billing_dead_letter", {
      p_source: params.source,
      p_reason: params.reason,
      p_stripe_object_id: params.stripeObjectId,
      p_stripe_event_id: params.eventId,
      p_stripe_customer_id: params.stripeCustomerId ?? null,
      p_claimed_workspace_id: params.claimedWorkspaceId ?? null,
      p_amount_cents: params.amountCents ?? null,
      p_purchased_by: params.purchasedBy ?? null,
      p_raw_metadata: params.rawMetadata ?? {},
    });
    if (error) {
      console.error(
        "[stripe-webhook] FAILED to record billing dead-letter",
        params.source,
        params.reason,
        params.stripeObjectId,
        error.message,
      );
    }
  }

  async function applyDocumentPack(subscription: Stripe.Subscription, eventId: string) {
    const workspaceId = subscription.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] document-pack event missing workspace_id", subscription.id);
      await recordBillingDeadLetter({
        source: "document_pack",
        reason: "missing_workspace_id",
        stripeObjectId: subscription.id,
        eventId,
        stripeCustomerId: resolveCustomerId(subscription),
        rawMetadata: subscription.metadata ?? {},
      });
      return;
    }
    const customerId = resolveCustomerId(subscription);
    if (!customerId) {
      console.warn("[stripe-webhook] document-pack event missing customer", subscription.id);
      await recordBillingDeadLetter({
        source: "document_pack",
        reason: "missing_customer",
        stripeObjectId: subscription.id,
        eventId,
        claimedWorkspaceId: workspaceId,
        rawMetadata: subscription.metadata ?? {},
      });
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

    // .select() so a 0-row update (workspace_id present in metadata but no such
    // workspace — deleted/unknown) is detectable: a 0-row PostgREST update is
    // NOT an error, so without this the paid pack would be silently dropped
    // (Codex PR review).
    const { data: updated, error } = await supabaseAdmin
      .from("workspaces")
      .update({ addon_document_capacity: total })
      .eq("id", workspaceId)
      .select("id");
    if (error) {
      throw new Error(`Failed to update addon_document_capacity: ${error.message}`);
    }
    if (!updated || updated.length === 0) {
      console.warn("[stripe-webhook] document-pack event references unknown workspace", workspaceId, subscription.id);
      await recordBillingDeadLetter({
        source: "document_pack",
        reason: "unknown_workspace",
        stripeObjectId: subscription.id,
        eventId,
        stripeCustomerId: customerId,
        claimedWorkspaceId: workspaceId,
        rawMetadata: subscription.metadata ?? {},
      });
      return;
    }
  }

  // Grant a single-lease credit for a succeeded one-time PaymentIntent. The
  // ledger's UNIQUE(payment_intent_id) makes webhook retries idempotent — the
  // duplicate insert no-ops and the grant trigger never fires twice. The
  // workspace counter is incremented by the lease_credit_purchases AFTER
  // INSERT trigger, not here, so grant accounting has exactly one writer.
  async function applySingleLeaseCredit(pi: Stripe.PaymentIntent, eventId: string) {
    // Derived once up front so every drop branch can attribute the dropped grant
    // (#65): who paid, how much, which customer.
    const piCustomer = typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;
    const paidCents = pi.amount_received ?? pi.amount ?? 0;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const purchasedBy = uuidRe.test(pi.metadata?.purchased_by ?? "") ? (pi.metadata?.purchased_by ?? null) : null;

    const workspaceId = pi.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] single-lease PI missing workspace_id", pi.id);
      await recordBillingDeadLetter({
        source: "single_lease_credit",
        reason: "missing_workspace_id",
        stripeObjectId: pi.id,
        eventId,
        stripeCustomerId: piCustomer,
        amountCents: paidCents,
        purchasedBy,
        rawMetadata: pi.metadata ?? {},
      });
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
      await recordBillingDeadLetter({
        source: "single_lease_credit",
        reason: "unknown_workspace",
        stripeObjectId: pi.id,
        eventId,
        stripeCustomerId: piCustomer,
        claimedWorkspaceId: workspaceId,
        amountCents: paidCents,
        purchasedBy,
        rawMetadata: pi.metadata ?? {},
      });
      return;
    }
    // Vault edge (audit review 2026-06-13): a credit legitimately purchased
    // on Business ($10) whose PI webhook lands AFTER a Vault conversion must
    // not be rejected against the Starter price ($12) — money taken, credit
    // lost. A vault workspace can't CREATE this purchase (manage-document-
    // pack blocks it), so the only way to get here on plan='vault' is that
    // delivery race; accept the lower of the two real prices. The granted
    // credit is unusable while vault (process_lease gates first) and spends
    // normally on reactivation.
    const expectedCents = wsRow.plan === "vault"
      ? Math.min(SINGLE_LEASE_PRICE_CENTS.starter, SINGLE_LEASE_PRICE_CENTS.business)
      : SINGLE_LEASE_PRICE_CENTS[wsRow.plan === "business" ? "business" : "starter"];
    // Clamp quantity to exactly 1 (the only supported single-lease purchase),
    // and require the charge to cover the price and belong to this workspace's
    // customer. Reject rather than over-grant on any mismatch — and dead-letter
    // the rejected-but-paid charge (#65: money moved, grant withheld).
    if (paidCents < expectedCents) {
      console.error(`[stripe-webhook] single-lease PI underpaid: ${paidCents} < ${expectedCents}`, pi.id);
      await recordBillingDeadLetter({
        source: "single_lease_credit",
        reason: "underpaid",
        stripeObjectId: pi.id,
        eventId,
        stripeCustomerId: piCustomer,
        claimedWorkspaceId: workspaceId,
        amountCents: paidCents,
        purchasedBy,
        rawMetadata: { ...(pi.metadata ?? {}), expected_cents: expectedCents },
      });
      return;
    }
    if (wsRow.stripe_customer_id && piCustomer && piCustomer !== wsRow.stripe_customer_id) {
      console.error("[stripe-webhook] single-lease PI customer mismatch", pi.id);
      await recordBillingDeadLetter({
        source: "single_lease_credit",
        reason: "customer_mismatch",
        stripeObjectId: pi.id,
        eventId,
        stripeCustomerId: piCustomer,
        claimedWorkspaceId: workspaceId,
        amountCents: paidCents,
        purchasedBy,
        rawMetadata: { ...(pi.metadata ?? {}), workspace_customer: wsRow.stripe_customer_id },
      });
      return;
    }

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

  // Firm-tier subscription (metadata.firm_id). One firm-level subscription
  // governs all child workspaces' plan. The firm entitlement guard is
  // service-role-bypassed (this webhook runs service_role), so the stripe_* and
  // plan-propagation writes go through. Plan stays 'business' (firms.plan is
  // CHECK-pinned). The detailed-vs-summarized INVOICE line-item construction
  // (firms.billing_summary_mode, on invoice.created) is a follow-on — recorded
  // in the audit detail here but not itemized yet.
  async function applyFirmSubscription(subscription: Stripe.Subscription, eventType: string) {
    const firmId = subscription.metadata?.firm_id;
    if (!firmId) return;

    const { data: firm } = await supabaseAdmin
      .from("firms").select("id, stripe_subscription_id, billing_summary_mode").eq("id", firmId).maybeSingle();
    if (!firm) {
      console.error(`[stripe-webhook] firm subscription for unknown firm_id=${firmId}`);
      return;
    }
    const status = subscription.status;

    if (eventType === "customer.subscription.deleted") {
      // Cancellation: record it; clear the subscription id. Children remain
      // 'business' for a 30-day grace (P9 records; grace cleanup is P11+).
      await supabaseAdmin.from("firms")
        .update({ stripe_subscription_id: null, updated_at: new Date().toISOString() })
        .eq("id", firmId);
      await supabaseAdmin.from("firm_activity_log").insert({
        firm_id: firmId, user_id: null,
        activity_type: "firm_billing_subscription_canceled",
        details: { subscription_id: subscription.id, status },
      });
      return;
    }

    // created / updated / checkout-completed: record sub + customer, propagate
    // 'business' to all children (idempotent — they are already business from
    // binding; confirms it for a freshly-subscribed firm).
    await supabaseAdmin.from("firms")
      .update({
        stripe_subscription_id: subscription.id,
        stripe_customer_id: resolveCustomerId(subscription),
        updated_at: new Date().toISOString(),
      })
      .eq("id", firmId);

    await supabaseAdmin.from("workspaces").update({ plan: "business" }).eq("firm_id", firmId);

    const isNew = !(firm as { stripe_subscription_id?: string | null }).stripe_subscription_id;
    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: firmId, user_id: null,
      activity_type: isNew ? "firm_billing_subscription_started" : "firm_billing_subscription_updated",
      details: {
        subscription_id: subscription.id,
        status,
        billing_summary_mode: (firm as { billing_summary_mode?: string }).billing_summary_mode,
      },
    });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.addon_type === ADDON_TYPE_SINGLE_LEASE) {
          await applySingleLeaseCredit(pi, event.id);
        }
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
        if (!subscriptionId) break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        // The C2 consent signal is this event TYPE — a completed Checkout is
        // an explicit purchase, and the freshly-retrieved sub is the one the
        // customer just paid for. Session-level metadata historically carried
        // only plan_id/billing_interval (workspace_id lived in
        // subscription_data.metadata), so the fallback is REQUIRED — without
        // it the override is always null, C2 skips every checkout-driven plan
        // switch on an already-subscribed/lapsed workspace, and a grace
        // renewal freezes until the purge cron destroys paid data
        // (verification round, 2026-06-13).
        const workspaceId = session.metadata?.workspace_id ??
          subscription.metadata?.workspace_id ?? null;
        // Packs are created via subscriptions.create (no checkout session), but
        // guard anyway so a pack can never take the plan path.
        if (isFirmSubscription(subscription)) {
          await applyFirmSubscription(subscription, event.type);
        } else if (isDocumentPack(subscription)) {
          await applyDocumentPack(subscription, event.id);
        } else {
          await applySubscription(subscription, workspaceId);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        if (isFirmSubscription(subscription)) {
          await applyFirmSubscription(subscription, event.type);
        } else if (isDocumentPack(subscription)) {
          await applyDocumentPack(subscription, event.id);
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
