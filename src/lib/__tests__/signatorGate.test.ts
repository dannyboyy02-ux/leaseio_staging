import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-2 (END_TO_END_REVIEW / j3-requestor §1.7, j4-approver §2): the signator
// (CFO) signature gate was broken end-to-end. The dedicated attestation page
// SignatorReview was ORPHANED — nothing navigated to it — while the reachable
// surface (ApprovalQueue's ChainStepCard) fired a bare `approve` that the server
// rejected 400 for missing attestation. Signator rows are also inserted 'pending'
// at submission with no frontier filter, so the CFO saw an actionable "Final
// approval" card from day 1 and could reject/send-back a not-yet-concept-approved
// lease (no server lifecycle guard). This test locks the four wires.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-2 — signator email deep-links to the attestation page', () => {
  const nd = read('supabase/functions/_shared/notify_dispatch.ts');
  it('signator_review_required links to /signator-review, not the generic lease detail', () => {
    expect(nd).toMatch(/signator_review_required[\s\S]{0,120}\/signator-review/);
  });
});

describe('P1-2 — the queue routes signator steps to SignatorReview', () => {
  const q = read('src/pages/app/ApprovalQueue.tsx');
  it('a signator step renders a Review & Sign action that navigates to /signator-review', () => {
    expect(q).toContain("step.stage === 'signator'");
    expect(q).toMatch(/navigate\(`\/app\/leases\/\$\{step\.lease_id\}\/signator-review`\)/);
    expect(q).toContain("approvals.queue.review_and_sign");
  });
  it('shows a signator card ONLY when the lease is at final_review (allowlist)', () => {
    // P1-2 review consensus: a concept-phase blocklist still surfaced retro/
    // terminal signator cards that dead-end at SignatorReview's final_review gate.
    // The queue now shows a signator card exactly at final_review.
    expect(q).toContain('calc_total_commitment, lifecycle_status');
    expect(q).toMatch(/s\.stage === 'signator'[\s\S]{0,160}lc !== 'final_review'/);
    expect(q).toMatch(/chainSteps\s*\.filter\(/);
  });
  it('clears the shared reason comment when the reject/send-back dialog closes', () => {
    // Guards the stale-comment audit-pollution bug (j4-approver §40).
    const dialogBlock = q.slice(q.indexOf('actionDialog !== null'));
    expect(dialogBlock).toMatch(/onOpenChange[\s\S]{0,120}setComment\(''\)/);
  });
});

describe('P1-2 — act-on-chain-step gates signator actions by lifecycle', () => {
  const fn = read('supabase/functions/act-on-chain-step/index.ts');
  it('rejects any action on a terminal lease', () => {
    expect(fn).toMatch(/\["rejected", "cancelled", "expired"\]\.includes\(leaseLifecycle\)/);
  });
  it('rejects signator actions while the lease is still in the concept/negotiation phase', () => {
    expect(fn).toContain('CONCEPT_PHASE_LIFECYCLES');
    expect(fn).toMatch(/step\.stage === "signator" &&[\s\S]{0,80}CONCEPT_PHASE_LIFECYCLES\.includes\(leaseLifecycle\)/);
  });
  it('still requires a non-empty attestation on signator approve', () => {
    expect(fn).toMatch(/step\.stage === "signator" && action === "approve" && !comment/);
  });
});
