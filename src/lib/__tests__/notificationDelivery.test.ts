import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-4 (END_TO_END_REVIEW / notifications F-2, F-3, F-4) — "finish the
// notifications". A comment row without `recipient_ids` is dropped by BOTH the
// fanout trigger (fanout_recipient_notifications WHEN details ? 'recipient_ids')
// and the dispatch cron (dispatch-notifications:59-60). So:
//  F-3: the legacy requestor-outcome writers (FinancialReview approve/return/
//       reject, ApprovalQueue reject) wrote rows with no recipient_ids → the
//       requestor was never told their request's outcome, on any channel.
//  F-2: in CHAIN mode, act-on-chain-step wrote ZERO requestor notifications —
//       the owner's headline complaint ("is the requestor told after concept
//       approval that they may proceed? — No, on no channel").
//  F-4: the next sequential approver was never told it was their turn
//       (nextAssignees was computed then thrown away).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-4 F-3 — legacy requestor-outcome writers now carry recipient_ids', () => {
  const fr = read('src/pages/app/FinancialReview.tsx');
  it('FinancialReview approve/return/reject all include recipient_ids', () => {
    // Three notify_submitter_* writers, each followed by recipient_ids.
    const approvedIdx = fr.indexOf('notify_submitter_approved');
    const returnedIdx = fr.indexOf('notify_submitter_returned');
    const rejectedIdx = fr.indexOf('notify_submitter_rejected');
    for (const i of [approvedIdx, returnedIdx, rejectedIdx]) {
      expect(i).toBeGreaterThan(-1);
      expect(fr.slice(i, i + 160)).toContain('recipient_ids');
    }
    expect(fr).toMatch(/recipient_ids: lease\.requestor_id \? \[lease\.requestor_id\] : \[\]/);
  });
  it('ApprovalQueue reject writer includes recipient_ids (gated on requestor_id)', () => {
    const q = read('src/pages/app/ApprovalQueue.tsx');
    expect(q).toContain('notify_submitter_rejected');
    expect(q).toContain('recipient_ids: [lease.requestor_id]');
    expect(q).toMatch(/if \(lease\.requestor_id\) \{/);
  });
});

describe('P1-4 F-2/F-4 — act-on-chain-step notifies requestor + next approver', () => {
  const fn = read('supabase/functions/act-on-chain-step/index.ts');
  it('has a deliverable notify() helper writing recipient_ids', () => {
    expect(fn).toMatch(/async function notify\(/);
    expect(fn).toMatch(/recipient_ids: ids/);
  });
  it('F-2: notifies the requestor on reject, send-back, and concept approval', () => {
    // Requestor is leaseRequestorId ?? leaseUserId in every requestor notice.
    const requestorNotices = (fn.match(/\[leaseRequestorId \?\? leaseUserId\]/g) || []).length;
    expect(requestorNotices).toBeGreaterThanOrEqual(3);
    expect(fn).toContain('notify_submitter_rejected');
    expect(fn).toContain('notify_submitter_returned');
    // The concept-approval "you may proceed" notice — its own type so the email
    // subject isn't the misleading "approved" (P1-4 review).
    expect(fn).toContain('notify_submitter_concept_cleared');
    expect(fn).toMatch(/cleared concept approval/);
  });
  it('F-4: notifies the next sequential approver when a level is crossed', () => {
    // The next-approver notice resolves nextAssignees (users + role cohort) and
    // sends notify_chain_step_users.
    expect(fn).toMatch(/resolveAssigneeUserIds\(step\.workspace_id, nextAssignees\)/);
    expect(fn).toContain('notify_chain_step_users');
  });
});
