import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-3 (END_TO_END_REVIEW / approval-engine §1, j4-approver §2b) — the backward
// arrows. A signator send-back marks the acted step 'sent_back' and supersedes
// its siblings, then re-advance (advance-to-final-review) only UPDATED
// pending_since on EXISTING pending signator rows — of which there are now NONE —
// so the lease reached final_review with zero actionable signator steps and
// stranded (the engine has no other path that re-creates a signator row). Plus
// the intra-stage sequential frontier (a step-2 approver saw their card before
// step-1 acted). This test locks the reactivation + frontier + the P1-2-review
// follow-ups folded into P1-3 (SignatorReview delegation auth + past-final copy).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-3 — advance-to-final-review reactivates a consumed signator stage', () => {
  const fn = read('supabase/functions/advance-to-final-review/index.ts');
  it('reactivates dormant (sent_back/superseded) signator rows when none are pending', () => {
    expect(fn).toMatch(/status === "sent_back" \|\| r\.status === "superseded"/);
    // Reactivation resets the prior action state back to a fresh pending row.
    expect(fn).toMatch(/status: "pending",[\s\S]{0,120}action_at: null,[\s\S]{0,60}action_by: null/);
    expect(fn).toContain('reactivatedSignator');
  });
  it('generation-scopes reactivation to the most recent signator round (max created_at)', () => {
    // A reroute that changed the signator leaves the prior assignee superseded
    // with an older created_at; reactivating it would resurrect a policy-removed
    // approver. Only the max-created_at generation is reactivated.
    expect(fn).toContain('created_at');
    expect(fn).toContain('const maxCreated');
    expect(fn).toMatch(/r\.created_at === maxCreated/);
    expect(fn).toContain('reactivated_signator_step_ids');
  });
  it('restores a CLEAN pending round — clears the prior delegate/OOO resolution + re-arms the timer', () => {
    // A re-negotiation can be weeks later; a stale prior-round delegate must not
    // silently own the new round, and the delegate timer must re-arm.
    expect(fn).toMatch(/delegate_activated_at: null/);
    expect(fn).toMatch(/effective_assignee_user_id: null/);
    expect(fn).toMatch(/assignee_resolution_source: null/);
  });
  it('records the reactivation in the final_review_stage_entered audit row', () => {
    expect(fn).toMatch(/reactivated_signator: reactivatedSignator/);
  });
});

describe('P1-3 — queue sequential frontier', () => {
  const q = read('src/pages/app/ApprovalQueue.tsx');
  it('holds a card until earlier required same-stage steps have acted', () => {
    expect(q).toContain('hasEarlierSameStageBlocker');
    expect(q).toMatch(/o\.stage === stage && o\.is_required && o\.status === 'pending' && o\.step_order < stepOrder/);
    // Needs every step for the lease, not just this user's.
    expect(q).toMatch(/lease_approval_chain'\)[\s\S]{0,160}\.in\('lease_id', chainLeaseIds\)/);
  });
});

describe('P1-3 — SignatorReview follow-ups (folded P1-2 review findings)', () => {
  const sr = read('src/pages/app/SignatorReview.tsx');
  it('authorizes a delegated signator via effective_assignee_user_id / voluntary delegation (HIGH)', () => {
    expect(sr).toContain('effective_assignee_user_id');
    expect(sr).toMatch(/effectiveAssignee === user!\.id/);
    expect(sr).toContain('chain_step_voluntary_delegations');
  });
  it('distinguishes not-yet-final-review from already-past-it copy (MEDIUM)', () => {
    expect(sr).toContain('preFinalReview');
    expect(sr).toContain('approvals.signator.already_resolved');
  });
});
