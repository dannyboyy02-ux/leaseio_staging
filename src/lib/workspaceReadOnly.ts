// ─────────────────────────────────────────────────────────────────────────
// Single source of truth for "is this workspace in a read-only state?" — i.e.
// view + export only, every mutating affordance gated.
//
// Two independent causes both mean read-only:
//   1. Vault retention tier (plan-based) — isReadOnlyRetention(plan).
//   2. Cancellation grace window / soft-delete (lifecycle-based) — the plan is
//      still 'starter'/'business' but the server's V1 restrictive RLS rejects
//      every write.
//
// #136: page-level read-only gates that used isReadOnlyRetention(plan) ALONE
// missed cause (2), so grace-window users saw the full write surface and every
// write was silently rejected. Gate mutating affordances on
// `!isWorkspaceReadOnly(workspace)` to cover both.
// ─────────────────────────────────────────────────────────────────────────
import { isReadOnlyRetention, type SubscriptionPlan } from '@/config/pricing';
import { deriveLifecycleState } from '@/lib/cancellationLifecycle';

/** The minimal workspace shape needed to decide read-only-ness (matches the
 *  AppContext workspace object). */
export interface ReadOnlyWorkspaceFields {
  plan?: SubscriptionPlan | string | null;
  canceledAt?: string | null;
  graceExpiresAt?: string | null;
  softDeletedAt?: string | null;
}

/**
 * True when a workspace is read-only for ANY reason — Vault retention OR a
 * cancellation grace window / soft-delete. Both are "view + export only".
 * `purgeAfter` is irrelevant to the read-only decision (it only distinguishes
 * soft_deleted from purge_due, both non-active), so it's passed as null.
 */
export function isWorkspaceReadOnly(
  workspace: ReadOnlyWorkspaceFields | null | undefined,
): boolean {
  if (!workspace) return false;
  if (isReadOnlyRetention(workspace.plan as SubscriptionPlan | null | undefined)) return true;
  return (
    deriveLifecycleState({
      canceledAt: workspace.canceledAt ?? null,
      graceExpiresAt: workspace.graceExpiresAt ?? null,
      softDeletedAt: workspace.softDeletedAt ?? null,
      purgeAfter: null,
    }) !== 'active'
  );
}
