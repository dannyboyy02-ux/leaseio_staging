// Pure gating logic for the locked-lease "your proposed changes were declined"
// verdict banner (H7). Extracted from LockedLeaseDetail's effect so the truth
// table is unit-testable without a DB or render harness.
//
// The banner is the ONLY signal a submitter gets that their governed edit was
// declined: after a reject the change set goes terminal and the lease stays
// locked at its prior terms. It must stay PRIVATE to the submitter (gate on
// submitted_by) and DISMISSIBLE (the caller resolves the localStorage flag and
// passes it in as `dismissed`).

/** The terminal change-set fields the gate reads. */
export interface TerminalChangeSet {
  status: string;
  submitted_by: string | null;
}

/**
 * Show the rejection verdict banner ONLY when the most-recent terminal change
 * set was (a) rejected, (b) submitted by the current user, and (c) not yet
 * dismissed. Any null/missing change set, an approved verdict, a someone-else
 * submission, or a dismissed banner all resolve to false.
 */
export function shouldShowRejectionBanner(
  top: TerminalChangeSet | null | undefined,
  currentUserId: string | null | undefined,
  dismissed: boolean,
): boolean {
  return Boolean(
    top &&
      top.status === 'rejected' &&
      currentUserId != null &&
      top.submitted_by === currentUserId &&
      !dismissed,
  );
}
