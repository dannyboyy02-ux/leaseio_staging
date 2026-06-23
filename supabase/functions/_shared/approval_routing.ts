// Approval Routing Logic — Phase 2 (Deno mirror of src/lib/approvalRouting.ts)
// Pure functions only. No Supabase, no React.
//
// MIRROR: keep behavior byte-equivalent with src/lib/approvalRouting.ts.
// Enforced by scripts/check-mirror-parity.mjs — update both copies in lockstep.
// This copy lets resolve-approval-chain compute the legacy submission target
// SERVER-SIDE (a submitter must never be able to supply their own target and
// self-approve).

export interface ApprovalConfig {
  /** Total cash commitment of the lease (from calculation engine) */
  totalCashCommitment: number;
  /** Workspace approval threshold in dollars (from workspace settings) */
  approvalThreshold: number | null;
  /** Whether the workspace has any manager_approver roles assigned */
  hasManagerApprovers: boolean;
  /** Whether the workspace has any financial_approver roles assigned */
  hasFinancialApprovers: boolean;
  /** Whether the submitter flagged this as a covenant-impacting commitment */
  covenantFlagged: boolean;
}

export interface LeaseApprovalRequirements {
  requiresManagerApproval: boolean;
  requiresFinancialApproval: boolean;
}

/**
 * Determine what approval steps are required for a lease.
 *
 * Manager approval: required whenever the workspace has manager_approver roles.
 *
 * Financial approval: required when ANY of the following are true:
 *   1. No approval threshold is set (safe default — always require financial review)
 *   2. Total cash commitment >= approval threshold
 *   3. Lease is covenant-flagged by the submitter
 *   4. Workspace has no financial approvers configured (returns false so it can auto-approve)
 *
 * If neither is required, the lease can be auto-approved.
 */
export function getApprovalRequirements(
  config: ApprovalConfig,
): LeaseApprovalRequirements {
  const { totalCashCommitment, approvalThreshold, hasManagerApprovers, hasFinancialApprovers, covenantFlagged } = config;

  const requiresManagerApproval = hasManagerApprovers;

  let requiresFinancialApproval: boolean;
  if (!hasFinancialApprovers) {
    // No one assigned to review — cannot require financial approval
    requiresFinancialApproval = false;
  } else if (approvalThreshold === null || approvalThreshold === undefined) {
    // No threshold configured: safe default is to always require financial approval
    requiresFinancialApproval = true;
  } else if (covenantFlagged) {
    // Covenant flag always triggers financial review
    requiresFinancialApproval = true;
  } else {
    requiresFinancialApproval = totalCashCommitment >= approvalThreshold;
  }

  return { requiresManagerApproval, requiresFinancialApproval };
}

/**
 * Determine the initial lifecycle_status after submission based on approval requirements.
 *
 * - Manager required → 'submitted' (awaiting manager)
 * - No manager, financial required → 'under_review' (awaiting financial)
 * - Neither → 'approved' (auto-approved)
 */
export function getInitialStatusAfterSubmission(
  requirements: LeaseApprovalRequirements,
): 'submitted' | 'under_review' | 'approved' {
  if (requirements.requiresManagerApproval) return 'submitted';
  if (requirements.requiresFinancialApproval) return 'under_review';
  return 'approved';
}
