import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/pages/app/ApprovalQueue.tsx'), 'utf8');

// Fresh-eyes fix: the "All Pending" tab must surface BOTH legacy
// (submitted/under_review) AND chain-vocabulary approver-pending stages
// (concept_submitted/concept_under_review/final_review), while excluding states
// with no approver action pending (in_negotiation, pending_counter_signature).
// The "Reviewed" tab must find a chain reviewer's decisions via the
// chain_step_* activity types (chain leases never populate
// manager_approved_by / financial_approved_by), alongside legacy
// rejection/send_back.
//
// Narrow-the-window: ApprovalQueue mentions in_negotiation /
// pending_counter_signature in COMMENTS elsewhere, so a full-file toContain
// would false-positive. Slice to the exact query block first.
function windowBetween(start: string, end: string): string {
  const s = src.indexOf(start);
  expect(s, `start anchor not found: ${start}`).toBeGreaterThan(-1);
  const e = src.indexOf(end, s);
  expect(e, `end anchor not found: ${end}`).toBeGreaterThan(s);
  return src.slice(s, e);
}

describe('ApprovalQueue — All Pending lifecycle allowlist', () => {
  const block = windowBetween('const { data: allPendingData }', 'const { data: reviewedData }');

  it('includes the chain concept + signator stages', () => {
    expect(block).toContain("'concept_submitted'");
    expect(block).toContain("'concept_under_review'");
    expect(block).toContain("'final_review'");
  });

  it('includes the legacy submitted / under_review stages', () => {
    expect(block).toContain("'submitted'");
    expect(block).toContain("'under_review'");
  });

  it('excludes the no-approver-pending states', () => {
    expect(block).not.toContain('in_negotiation');
    expect(block).not.toContain('pending_counter_signature');
  });
});

describe('ApprovalQueue — Reviewed activity-type union', () => {
  const block = windowBetween('const { data: activityRows }', 'const actedLeaseIds');

  it('includes the chain-step action types', () => {
    expect(block).toContain("'chain_step_approved'");
    expect(block).toContain("'chain_step_rejected'");
    expect(block).toContain("'chain_step_sent_back'");
  });

  it('includes the legacy rejection / send_back action types', () => {
    expect(block).toContain("'rejection'");
    expect(block).toContain("'send_back'");
  });
});
