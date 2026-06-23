// ─────────────────────────────────────────────────────────────────────────
// Retry approval routing for a request-workflow lease stuck in 'draft' (audit C2).
//
// When LeaseRequestForm submits, it inserts the lease as 'draft' and then calls
// resolve-approval-chain. If that resolution fails (ambiguous match,
// no_match_no_fallback, separation_violation, or a network error),
// decideSubmissionOutcome returns 'leave_draft' and the lease is left in 'draft'
// with a toast — a deliberate half-state-eliminating contract. But the detail
// page offered no way to retry, so a transient failure looked permanent and
// users re-uploaded (duplicates). This is the retry path.
//
// resolve-approval-chain is idempotent on initialResolution=true, so this is
// safe to invoke repeatedly.
//
// This mirrors the orchestration LeaseRequestForm runs inline after the draft
// insert (resolve → decideSubmissionOutcome → flip → notify → log). All the
// business logic is the SHARED helpers (getApprovalRequirements /
// getInitialStatusAfterSubmission / decideSubmissionOutcome / notify*); only the
// ~25-line orchestration SEQUENCE is repeated here, deliberately — refactoring
// the primary submission path to share this orchestration is a follow-up that
// should land only once that path has an integration-test safety net
// (KNOWN_ISSUES #132).
//
// LIFECYCLE TRANSITION CONVENTION (CLAUDE.md): the status_change log sets both
// the top-level from_status/to_status columns AND the equivalent fields inside
// details, plus routing_path.
// ─────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from '@supabase/supabase-js';
import { getApprovalRequirements, getInitialStatusAfterSubmission } from '@/lib/approvalRouting';
import { notifyChainAssignees, notifyRoleHolders, createLeaseNotification } from '@/lib/leaseNotifications';
import { decideSubmissionOutcome, type ChainResult } from '@/lib/leaseSubmissionDecision';

/** The stored lease fields the retry needs — all written at submission time, so
 *  recomputing approvalRequirements from them equals the form's original inputs. */
export interface RetryRoutingLease {
  id: string;
  calc_total_commitment: number | null;
  covenant_flagged: boolean | null;
  request_title: string | null;
}

export type RetryRoutingResult =
  | { ok: true; finalStatus: string }
  | { ok: false; errorMessage: string };

export async function retryRequestRouting(
  supabase: SupabaseClient,
  lease: RetryRoutingLease,
  workspaceId: string,
  userId: string,
): Promise<RetryRoutingResult> {
  // Recompute approval requirements from the stored lease record. These equal
  // the form's submission-time inputs (calc_total_commitment / covenant_flagged
  // were written from the same calcs/values).
  const [wsSettings, managerRoles, financialRoles] = await Promise.all([
    (supabase as any).from('workspaces').select('approval_threshold').eq('id', workspaceId).maybeSingle().then((r: any) => r.data),
    (supabase as any).from('workspace_roles').select('user_id').eq('workspace_id', workspaceId).eq('role', 'manager_approver').then((r: any) => r.data || []),
    (supabase as any).from('workspace_roles').select('user_id').eq('workspace_id', workspaceId).eq('role', 'financial_approver').then((r: any) => r.data || []),
  ]);

  const approvalRequirements = getApprovalRequirements({
    totalCashCommitment: lease.calc_total_commitment ?? 0,
    approvalThreshold: wsSettings?.approval_threshold ?? null,
    hasManagerApprovers: managerRoles.length > 0,
    hasFinancialApprovers: financialRoles.length > 0,
    covenantFlagged: lease.covenant_flagged ?? false,
  });
  const legacyInitialStatus = getInitialStatusAfterSubmission(approvalRequirements);

  const { data: chainResult, error: chainError } = await supabase.functions.invoke(
    'resolve-approval-chain',
    { body: { leaseId: lease.id, initialResolution: true } },
  );

  // Idempotent-replay recovery (audit C2, integrity CRITICAL). If a chain was
  // already written on a prior attempt but the lease never left 'draft' (the
  // flip was interrupted — tab close, dropped UPDATE), resolve-approval-chain
  // short-circuits with a bare { ok:true, alreadyResolved:true } that carries
  // NO targetLifecycleStatus / firstStepAssignees. Feeding that to
  // decideSubmissionOutcome would fabricate finalStatus:'submitted' and call
  // notifyChainAssignees(undefined) → TypeError — mis-statusing the lease and
  // skipping the audit log. Intercept it and complete the routing from the
  // existing chain rows instead.
  if (chainResult && (chainResult as any).alreadyResolved === true) {
    return completeExistingChainRouting(supabase, lease, workspaceId, userId, chainResult);
  }

  const outcome = decideSubmissionOutcome(chainResult as ChainResult, legacyInitialStatus, chainError);
  if (outcome.kind === 'leave_draft') {
    return { ok: false, errorMessage: outcome.errorMessage };
  }

  const finalStatus = outcome.finalStatus;
  const routingPath = outcome.routingPath;
  const description = lease.request_title ?? 'commitment request';

  // The lifecycle flip (draft → finalStatus) and its status_change audit row
  // are applied SERVER-SIDE by resolve-approval-chain in the same call (the
  // browser write is rejected by the governance trigger). Here we only notify
  // the right approvers for the path.
  if (routingPath === 'legacy') {
    if (finalStatus === 'submitted' && approvalRequirements.requiresManagerApproval) {
      await notifyRoleHolders(supabase, lease.id, workspaceId, 'manager_approver', `New commitment request awaiting your review: ${description}`);
    } else if (finalStatus === 'under_review' && approvalRequirements.requiresFinancialApproval) {
      await notifyRoleHolders(supabase, lease.id, workspaceId, 'financial_approver', `New commitment request awaiting financial review: ${description}`);
    }
  } else {
    await notifyChainAssignees(supabase, lease.id, workspaceId, outcome.chainSuccess!.firstStepAssignees, `New commitment request requires your approval: ${description}`);
  }

  // status_change audit row is written server-side by resolve-approval-chain
  // in the same call that performed the flip.

  await createLeaseNotification({
    leaseId: lease.id,
    eventType: 'new_request',
    description: `New commitment request: ${description}`,
  });

  return { ok: true, finalStatus };
}

/**
 * Recovery for the idempotent-replay case: a chain already exists for this lease
 * (resolve-approval-chain returned `alreadyResolved`) but the lease may still be
 * in 'draft' because an original browser flip was rejected by the governance
 * trigger or interrupted. The edge function's idempotent branch now performs the
 * draft → concept_submitted flip AND its status_change log SERVER-SIDE, and
 * returns `recovered` (whether THIS call advanced the lease), `finalStatus`, and
 * `firstStepAssignees`. So this helper only fires the approver notifications, and
 * only when this call actually completed the routing — a repeated manual retry on
 * an already-advanced lease is a clean no-op rather than a duplicate notification.
 */
async function completeExistingChainRouting(
  supabase: SupabaseClient,
  lease: RetryRoutingLease,
  workspaceId: string,
  _userId: string,
  resolveResponse: any,
): Promise<RetryRoutingResult> {
  const finalStatus = (resolveResponse?.finalStatus as string) ?? 'concept_submitted';

  // Only notify if this call actually advanced the lease out of draft.
  if (!resolveResponse?.recovered) {
    return { ok: true, finalStatus };
  }

  const firstStepAssignees =
    (resolveResponse?.firstStepAssignees as { userId: string | null; role: string | null }[]) ?? [];
  const description = lease.request_title ?? 'commitment request';

  await notifyChainAssignees(
    supabase,
    lease.id,
    workspaceId,
    firstStepAssignees,
    `New commitment request requires your approval: ${description}`,
  );

  await createLeaseNotification({
    leaseId: lease.id,
    eventType: 'new_request',
    description: `New commitment request: ${description}`,
  });

  return { ok: true, finalStatus };
}
