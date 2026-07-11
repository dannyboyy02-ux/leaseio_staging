// ─────────────────────────────────────────────────────────────────────────
// Stripe Subscription → current period end, across API versions.
//
// WHY THIS EXISTS (billing incident 2026-07-11, second-pass money-path audit)
// Every edge function pins apiVersion "2025-08-27.basil". In Stripe's Basil
// API family (2025-03-31.basil and later) `current_period_start` /
// `current_period_end` were REMOVED from the top-level Subscription object —
// they now live on each subscription ITEM (sub.items.data[n].current_period_end).
// The old top-level read `(subscription as any).current_period_end` silently
// returned undefined on EVERY webhook event, so workspaces.subscription_period_end
// was NULL for every subscription (verified live: a workspace with plan /
// status / customer / sub-id all webhook-written had period_end NULL). That
// nulled trial-end dates, renewal dates, pack renews-on dates, the scheduled-
// cancel date — and left vault-renewal-reminder permanently matching zero rows
// (it filters subscription_period_end IS NOT NULL).
//
// Resolution order:
//   1. top-level current_period_end  — pre-Basil API versions (and defensive)
//   2. items.data[0].current_period_end — Basil location (plan subs and pack
//      subs are single-item, so item[0] IS the subscription period)
//   3. trial_end — last-resort for a trialing sub if items were stripped
//
// Used by: stripe-webhook (resolvePeriodEnd + grace anchor fallback),
// cancel-subscription, get-billing-summary, manage-document-pack. Any NEW
// reader of a subscription's period end MUST use this helper — never read
// current_period_end off the subscription object directly.
// ─────────────────────────────────────────────────────────────────────────

interface SubscriptionPeriodShape {
  current_period_end?: number | null;
  trial_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null } | null> | null } | null;
}

/** Unix seconds of the subscription's current period end, or null. */
export function resolvePeriodEndSeconds(sub: unknown): number | null {
  const s = (sub ?? {}) as SubscriptionPeriodShape;
  if (typeof s.current_period_end === "number") return s.current_period_end;
  const itemEnd = s.items?.data?.[0]?.current_period_end;
  if (typeof itemEnd === "number") return itemEnd;
  if (typeof s.trial_end === "number") return s.trial_end;
  return null;
}

/** ISO-8601 string of the subscription's current period end, or null. */
export function resolvePeriodEndIso(sub: unknown): string | null {
  const seconds = resolvePeriodEndSeconds(sub);
  return seconds !== null ? new Date(seconds * 1000).toISOString() : null;
}
