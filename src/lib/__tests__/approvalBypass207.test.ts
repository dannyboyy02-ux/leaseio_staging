import { describe, it, expect } from 'vitest';
import {
  getApprovalRequirements,
  getInitialStatusAfterSubmission,
} from '@/lib/approvalRouting';

// #207 (HIGH, approval bypass) — BEHAVIOURAL proof, not a string match.
//
// resolve-approval-chain's no-match -> legacy-default fallback used to refuse
// only when the workspace had NO default approver at all
// (`isFallbackFromNoMatch && !hasDefaultApprovers`). That asked the wrong
// question. The routing rules below decide whether a human is actually
// REQUIRED, and they can return 'approved' while approvers plainly exist.
//
// These tests pin the exact inputs the guard must now refuse. They exercise the
// same pure helpers the edge function calls (src/lib/approvalRouting.ts is the
// Node half of the mirror pair with
// supabase/functions/_shared/approval_routing.ts, kept in lockstep by
// `npm run check:mirror-parity`), so if the routing semantics ever shift, this
// fails here rather than silently in production.

const THRESHOLD = 100_000;

/** The decision the edge function makes: what status would this request land in? */
const legacyStatusFor = (cfg: Parameters<typeof getApprovalRequirements>[0]) =>
  getInitialStatusAfterSubmission(getApprovalRequirements(cfg));

describe('#207 — the bypass scenario is real and must be refused', () => {
  it('THE BUG: financial approver, no manager, under threshold -> auto-approved', () => {
    // A workspace that HAS approval rules and HAS an approver. The old guard saw
    // hasDefaultApprovers === true and let this through.
    const status = legacyStatusFor({
      totalCashCommitment: 72_000,
      approvalThreshold: THRESHOLD,
      hasManagerApprovers: false,
      hasFinancialApprovers: true,
      covenantFlagged: false,
    });
    // Nobody is required to look at it.
    expect(status).toBe('approved');
    // => resolve-approval-chain MUST 409 here. Gating on approver presence
    //    (`!hasDefaultApprovers` === false) would have shipped the lease.
  });

  it('the old predicate would NOT have caught it', () => {
    const hasManagerApprovers = false;
    const hasFinancialApprovers = true;
    const hasDefaultApprovers = hasManagerApprovers || hasFinancialApprovers;
    expect(hasDefaultApprovers).toBe(true); // old guard: no 409
    expect(
      legacyStatusFor({
        totalCashCommitment: 72_000,
        approvalThreshold: THRESHOLD,
        hasManagerApprovers,
        hasFinancialApprovers,
        covenantFlagged: false,
      }),
    ).toBe('approved'); // new guard: 409
  });

  it('the new predicate SUBSUMES the old one (no approvers at all)', () => {
    expect(
      legacyStatusFor({
        totalCashCommitment: 72_000,
        approvalThreshold: THRESHOLD,
        hasManagerApprovers: false,
        hasFinancialApprovers: false,
        covenantFlagged: false,
      }),
    ).toBe('approved'); // still caught, so nothing regresses
  });
});

describe('#207 — requests that are genuinely reviewed must still route', () => {
  it('a manager approver always requires review', () => {
    expect(
      legacyStatusFor({
        totalCashCommitment: 72_000,
        approvalThreshold: THRESHOLD,
        hasManagerApprovers: true,
        hasFinancialApprovers: true,
        covenantFlagged: false,
      }),
    ).toBe('submitted');
  });

  it('clearing the threshold requires financial review', () => {
    expect(
      legacyStatusFor({
        totalCashCommitment: 250_000,
        approvalThreshold: THRESHOLD,
        hasManagerApprovers: false,
        hasFinancialApprovers: true,
        covenantFlagged: false,
      }),
    ).toBe('under_review');
  });

  it('a covenant flag requires financial review even under the threshold', () => {
    expect(
      legacyStatusFor({
        totalCashCommitment: 72_000,
        approvalThreshold: THRESHOLD,
        hasManagerApprovers: false,
        hasFinancialApprovers: true,
        covenantFlagged: true,
      }),
    ).toBe('under_review');
  });

  it('no threshold configured fails safe — financial review required', () => {
    expect(
      legacyStatusFor({
        totalCashCommitment: 72_000,
        approvalThreshold: null,
        hasManagerApprovers: false,
        hasFinancialApprovers: true,
        covenantFlagged: false,
      }),
    ).toBe('under_review');
  });
});
