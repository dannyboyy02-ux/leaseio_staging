// ─────────────────────────────────────────────────────────────────────────
// Pure helper that decides the post-resolution flip for a freshly inserted
// (draft) lease, given the result of resolve-approval-chain and the legacy
// initial status that approvalRouting.ts would assign for the same lease.
//
// Why this lives outside LeaseRequestForm:
//   The four submission outcomes (chain success, legacy fallback, ambiguous
//   match, network error) are the customer-visible failure modes for every
//   new lease and must be unit-testable. The form itself is React-heavy
//   and the project has no jsdom / testing-library setup; instead the
//   decision logic is pulled into a pure function and tested directly.
//
// LIFECYCLE TRANSITION CONVENTION (CLAUDE.md)
//   This helper produces the destination lifecycle status. The form
//   applies it (UPDATE leases SET lifecycle_status = ..., status_changed_at
//   = now()) and writes the status_change activity log. This file does not
//   write — it only decides.
// ─────────────────────────────────────────────────────────────────────────

export type ChainSuccess = {
  ok: true;
  legacyFallback: false;
  policyId: string;
  policyVersion: number;
  policyName: string;
  stepsCreated: number;
  firstStepAssignees: { userId: string | null; role: string | null }[];
  // Phase 3: edge function returns the chain-vocabulary destination
  // (e.g. 'concept_submitted'). Optional in the type so an older edge
  // function deploy that hasn't been updated yet still works — the
  // `?? 'submitted'` fallback in decideSubmissionOutcome handles it.
  targetLifecycleStatus?: string;
};

export type ChainLegacyFallback = {
  ok: true;
  legacyFallback: true;
  message: string;
  // Phase: the edge function now applies the legacy flip server-side and
  // returns the authoritative destination + the requirements it computed
  // (so the caller notifies the right approvers without re-deriving them).
  finalStatus?: string;
  requiresManagerApproval?: boolean;
  requiresFinancialApproval?: boolean;
};

export type ChainFailure = {
  ok: false;
  error: string;
  reason: string;
};

export type ChainResult = ChainSuccess | ChainLegacyFallback | ChainFailure | null;

export type SubmissionOutcome =
  | {
      kind: 'proceed';
      finalStatus: string;
      routingPath: 'legacy' | 'chain';
      // Optional context the caller may want to log or pass to notification
      // helpers. Empty for the legacy branch.
      chainSuccess?: ChainSuccess;
    }
  | {
      kind: 'leave_draft';
      // The form surfaces this as a toast and leaves the lease in 'draft'
      // so the user can retry once the underlying issue is fixed.
      // The resolver is idempotent on initialResolution=true.
      errorMessage: string;
    };

const DEFAULT_FAILURE_MESSAGE =
  'Could not route this request for approval. Contact your admin.';

/**
 * Decide what to do with a freshly created (draft) lease based on the
 * resolve-approval-chain response.
 *
 * - Chain success: flip to the chain-vocabulary destination returned by the
 *   edge function (currently 'concept_submitted'); falls back to 'submitted'
 *   if a pre-Phase-3 edge function is somehow live.
 * - Legacy fallback: flip to legacyInitialStatus (one of submitted /
 *   under_review / approved per approvalRouting.ts).
 * - Ambiguous match / no_match_no_fallback / separation_violation /
 *   network error / null response: leave the lease in 'draft' and return
 *   the error message for a toast.
 *
 * `chainError` is the second value supabase.functions.invoke returns —
 * non-null when the network call itself failed. Null on success.
 */
export function decideSubmissionOutcome(
  chainResult: ChainResult,
  legacyInitialStatus: string,
  chainError: { message?: string } | null,
): SubmissionOutcome {
  // Network error or no response body → leave in draft.
  if (chainError) {
    return {
      kind: 'leave_draft',
      errorMessage: chainError.message ?? DEFAULT_FAILURE_MESSAGE,
    };
  }
  if (!chainResult) {
    return { kind: 'leave_draft', errorMessage: DEFAULT_FAILURE_MESSAGE };
  }

  // Resolver returned ok=false (ambiguous_match, no_match_no_fallback,
  // separation_violation, etc.) → leave in draft.
  if (chainResult.ok === false) {
    return {
      kind: 'leave_draft',
      errorMessage: chainResult.error || DEFAULT_FAILURE_MESSAGE,
    };
  }

  // Workspace has no policies → legacy path. The edge function now applies the
  // flip server-side and returns the authoritative finalStatus; prefer it and
  // fall back to the locally-computed status for older edge deploys.
  if (chainResult.legacyFallback === true) {
    return {
      kind: 'proceed',
      finalStatus: chainResult.finalStatus ?? legacyInitialStatus,
      routingPath: 'legacy',
    };
  }

  // Policy matched → chain path. Read targetLifecycleStatus authoritatively;
  // defensive fallback to 'submitted' for pre-Phase-3 edge function builds.
  return {
    kind: 'proceed',
    finalStatus: chainResult.targetLifecycleStatus ?? 'submitted',
    routingPath: 'chain',
    chainSuccess: chainResult,
  };
}
