// Shared Starter monetization gate (Decision 1, 2026-07-16).
//
// A workspace that has NEVER subscribed — no `subscription_status` AND no
// `stripe_subscription_id` — must start a subscription (7-day trial at checkout)
// before it can burn paid Opus tokens on extraction. This must be enforced on
// EVERY paid-AI entry point: first-pass extraction (process_lease) AND retries
// (retry_lease) — a retry hits Claude exactly like a first pass, so omitting it
// is a free-extraction bypass (security review 2026-07-16, HIGH-2).
//
// GRANDFATHER: only workspaces created on/after the enforcement cutoff are gated,
// so pre-existing free/test workspaces aren't abruptly locked. `created_at` is
// safe to trust as the grandfather key because it is immutable for non-service
// writers (20260716160000_workspaces_created_at_immutable.sql) — otherwise an
// owner could PATCH it to a pre-cutoff date and self-grandfather (HIGH-1).
//
// Exemptions: `audit` (free lead-magnet, bounded by its own document_limit) and
// `vault` (read-only offramp, blocked earlier by the liveness backstop).

export const MONETIZATION_ENFORCED_FROM = new Date('2026-07-16T00:00:00Z').getTime();

export interface MonetizationRow {
  plan?: string | null;
  subscription_status?: string | null;
  stripe_subscription_id?: string | null;
  created_at?: string | null;
}

/**
 * True when this workspace must start a subscription before any paid-AI
 * processing (first pass or retry). Callers translate a `true` into the
 * `no_subscription` response.
 */
export function requiresSubscriptionToProcess(ws: MonetizationRow | null | undefined): boolean {
  if (!ws) return false;
  if (ws.plan === 'audit' || ws.plan === 'vault') return false;
  const neverSubscribed = !ws.subscription_status && !ws.stripe_subscription_id;
  if (!neverSubscribed) return false;
  // Fail CLOSED on an absent/unparseable created_at: a missing grandfather key
  // is treated as post-cutoff (gated), never as "grandfathered → free". In
  // practice created_at is NOT NULL + immutable, so this only guards corruption.
  const createdAt = ws.created_at ? new Date(ws.created_at).getTime() : Infinity;
  if (Number.isNaN(createdAt)) return true;
  return createdAt >= MONETIZATION_ENFORCED_FROM;
}

/** The canonical user-facing copy + machine reason for the gate. */
export const NO_SUBSCRIPTION_ERROR =
  'Start your subscription to begin processing documents — your 7-day free trial starts at checkout.';
export const NO_SUBSCRIPTION_REASON = 'no_subscription';
