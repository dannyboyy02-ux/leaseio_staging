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
  firm_id?: string | null;
}

/**
 * True when this workspace must start a subscription before any paid-AI
 * processing (first pass or retry). Workspace-LOCAL truth only — production
 * callers go through resolveProcessingSubscriptionGate below, which
 * translates a `true` into a blocked result (`no_subscription`, or
 * `firm_subscription_required` for firm-bound children, #201).
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

/** #201 (owner decision 2026-08-14): a firm-bound child whose FIRM lacks a live
 *  subscription is still gated, but must NOT be sold the workspace trial — a
 *  firm-bound workspace's own checkout 403s `firm_managed`, so the trial CTA
 *  was a promise the workspace structurally could not keep. */
export const FIRM_SUBSCRIPTION_REQUIRED_ERROR =
  "This workspace's billing is managed by your firm, and the firm doesn't have an active subscription yet. Ask the firm owner to activate it.";
export const FIRM_SUBSCRIPTION_REQUIRED_REASON = 'firm_subscription_required';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export type SubscriptionGateResult =
  | { blocked: false }
  | { blocked: true; reason: typeof NO_SUBSCRIPTION_REASON; error: typeof NO_SUBSCRIPTION_ERROR }
  | {
      blocked: true;
      reason: typeof FIRM_SUBSCRIPTION_REQUIRED_REASON;
      error: typeof FIRM_SUBSCRIPTION_REQUIRED_ERROR;
    };

/**
 * #201 (owner decision 2026-08-14): firm-bound children INHERIT processing
 * entitlement from the firm's subscription. The firm-level "live" signal is
 * `firms.stripe_subscription_id` — the webhook's entitlement gate only ever
 * writes it for a PAID sub (active/trialing), keeps it through dunning
 * (past_due is recoverable, matching workspace-level behavior), and clears it
 * when the current sub is deleted. There is no firms.subscription_status
 * column; the pointer IS the entitlement.
 *
 * Order matters: the workspace-local gate (grandfather cutoff, plan
 * exemptions, the workspace's own past subscription) runs first — the firm is
 * consulted only when the workspace would otherwise be blocked. Fail-closed:
 * a firms lookup error keeps the block (with the firm-flavored reason, since
 * the workspace is firm-bound either way and the trial CTA would lie).
 *
 * Callers (process_lease + retry_lease — the two paid-AI entry points, kept
 * in lockstep) must include `firm_id` in the workspace select.
 */
export async function resolveProcessingSubscriptionGate(
  admin: AdminClient,
  ws: MonetizationRow | null | undefined,
): Promise<SubscriptionGateResult> {
  if (!requiresSubscriptionToProcess(ws)) return { blocked: false };
  if (ws?.firm_id) {
    const { data: firm, error } = await admin
      .from('firms')
      .select('stripe_subscription_id')
      .eq('id', ws.firm_id)
      .maybeSingle();
    if (!error && firm?.stripe_subscription_id) return { blocked: false };
    return {
      blocked: true,
      reason: FIRM_SUBSCRIPTION_REQUIRED_REASON,
      error: FIRM_SUBSCRIPTION_REQUIRED_ERROR,
    };
  }
  return { blocked: true, reason: NO_SUBSCRIPTION_REASON, error: NO_SUBSCRIPTION_ERROR };
}
