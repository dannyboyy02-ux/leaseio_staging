import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-6 (END_TO_END_REVIEW / notifications F-1) — resurrect the nudge. The
// NudgeApproverButton's only gate was `const isPendingApproval = false`, so a
// requestor could NEVER nudge a stalled approver. Fix: derive isPendingApproval
// from the waiting-for-approver lifecycle, mount the button on the reachable
// intake view (+ the workbench for final_review), and add the day-2/5/10
// automatic escalation cron the schema (lease_nudges.automatic_dayN) always
// anticipated but was never built.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-6 — the manual nudge is reachable again', () => {
  const lr = read('src/pages/app/LeaseReview.tsx');
  it('isPendingApproval is a real waiting-for-approver predicate, not hardcoded false', () => {
    expect(lr).not.toMatch(/const isPendingApproval = false;/);
    expect(lr).toMatch(/const isPendingApproval = lifecycleStatusTyped != null &&/);
    expect(lr).toMatch(/lifecycleStatusTyped === 'final_review'/);
  });
  it('mounts NudgeApproverButton on the intake view, gated to requestor/admin', () => {
    // Two mounts (intake header + workbench), both gated on the nudger identity.
    const mounts = lr.match(/isPendingApproval && \(isRequestor \|\| isAdminUser\) && !isReadOnly && \(/g) || [];
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    expect(lr).toContain('<NudgeApproverButton');
  });
});

describe('P1-6 — day-2/5/10 automatic nudge cron', () => {
  const fn = read('supabase/functions/auto-nudge-approvers/index.ts');
  it('is cron-secret authed (fail-closed), no JWT', () => {
    expect(fn).toContain('AUTO_NUDGE_CRON_SECRET');
    expect(fn).toMatch(/x-cron-secret"\) !== expectedCronSecret/);
    expect(fn).toMatch(/reason: "no_auth" \}, 401\)/);
  });
  it('fires the highest crossed milestone and records the matching automatic_dayN type', () => {
    expect(fn).toMatch(/automatic_day10/);
    expect(fn).toMatch(/automatic_day5/);
    expect(fn).toMatch(/automatic_day2/);
    // Highest-first so a step past day 10 fires day10, not day2.
    expect(fn).toMatch(/MILESTONES\.find\(\(m\) => daysPending >= m\.days\)/);
  });
  it('dedupes a milestone per step-cycle (lease_nudges since pending_since)', () => {
    expect(fn).toMatch(/from\("lease_nudges"\)[\s\S]{0,200}nudge_type["'\s,]+milestone\.type/);
    expect(fn).toMatch(/gte\("sent_at"/);
  });
  it('resolves the CURRENT pending approver + skips non-live/soft-deleted', () => {
    expect(fn).toContain('effective_assignee_user_id');
    expect(fn).toContain('checkWorkspaceLive');
    expect(fn).toMatch(/is\("deleted_at", null\)/);
  });
  it('is scheduled daily, reading the secret from private.cron_secrets', () => {
    const mig = read('supabase/migrations/20260716170000_schedule_auto_nudge_cron.sql');
    expect(mig).toContain('auto-nudge-approvers-cron');
    expect(mig).toMatch(/cron_secrets WHERE id = 'auto_nudge'/);
  });
});
