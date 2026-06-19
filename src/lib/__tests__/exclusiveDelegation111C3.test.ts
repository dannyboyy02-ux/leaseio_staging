import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #111 C3 — delegation is EXCLUSIVE: effective_assignee_user_id is
// the precedence-resolved actor; once set, only that user can act/see the step.
// Also pins the C2 coverage (pending_since-on-advance) so it can't silently
// regress (C2 itself needs no new code — it's resolved by C1's redeploy).

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#111 C3 — act-on-chain-step authorizes the effective assignee exclusively', () => {
  const src = fn('supabase/functions/act-on-chain-step/index.ts');

  it('checks effective_assignee_user_id FIRST and only falls back to approver when it is NULL', () => {
    // The exclusive shape: branch on effective being set, else fall back.
    expect(src).toMatch(/if \(step\.effective_assignee_user_id\) \{[\s\S]*?else if \(step\.approver_user_id && step\.approver_user_id === user\.id\)/);
    expect(src).toMatch(/EXCLUSIVE/);
  });

  it('no longer authorizes the original approver before the effective assignee (the additive bug)', () => {
    // The old code's first check authorized approver_user_id unconditionally,
    // before effective_assignee. That ordering must be gone.
    expect(src).not.toMatch(/let actedAsDelegate = false;[\s\S]*?\n  if \(step\.approver_user_id && step\.approver_user_id === user\.id\) \{\n    authorized = true;\n  \}\n\n  \/\/ Phase 7: effective_assignee_user_id covers/);
  });

  it('still tags a delegated action + keeps the defensive voluntary-delegation path', () => {
    expect(src).toContain('actedAsDelegate = true');
    expect(src).toContain('chain_step_voluntary_delegations');
  });
});

describe('#111 C3 — ApprovalQueue hides a delegated step from the delegator', () => {
  const src = fn('src/pages/app/ApprovalQueue.tsx');

  it('filters by effective assignee, falling back to approver/role only when effective is NULL', () => {
    expect(src).toContain('effective_assignee_user_id.eq.${user.id}');
    expect(src).toContain('and(effective_assignee_user_id.is.null,approver_user_id.eq.${user.id})');
    expect(src).toContain('and(effective_assignee_user_id.is.null,approver_role.in.');
  });

  it('drops the old additive OR (approver_user_id OR effective_assignee, no null-guard)', () => {
    expect(src).not.toContain('approver_user_id.eq.${user.id},approver_role.in.(${myRoleNames.join(\',\')}),effective_assignee_user_id.eq.${user.id}');
    expect(src).not.toContain('`approver_user_id.eq.${user.id},effective_assignee_user_id.eq.${user.id}`');
  });
});

describe('#111 C2 — pending_since coverage is intact (resolved by C1; pin against regression)', () => {
  it('act-on-chain-step sets pending_since on the next active concept rows on advance', () => {
    const src = fn('supabase/functions/act-on-chain-step/index.ts');
    expect(src).toContain('advancedPastStepOrder(allRows, "concept", step.step_order)');
    expect(src).toMatch(/\.update\(\{ pending_since: new Date\(\)\.toISOString\(\) \}\)/);
  });
});
