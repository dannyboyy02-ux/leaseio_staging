import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Phase 10 CP1 — firm UX migration static-source guards.
//
// Static assertions over the migration file (live-DB behavior was validated on
// staging via the leak matrix + load test; these lock the load-bearing
// invariants against in-repo drift). Same idiom as singleLeaseCredits.test.ts:
// narrow the window to the target block before asserting.
// ============================================================================

const MIGRATION = 'supabase/migrations/20260616120000_phase10_firm_ux.sql';
const src = readFileSync(join(process.cwd(), MIGRATION), 'utf8');

function block(start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

// ----------------------------------------------------------------------------
// Block A — the inbox view is NOT security_invoker (the entire [D1] inversion).
// Flipping this to security_invoker silently empties the inbox for firm-derived
// members, because lease_approval_chain / lease_unlock_requests SELECT policies
// gate on direct workspace_members (not the firm-aware is_workspace_member).
// ----------------------------------------------------------------------------
describe('inbox view is owner-privileged (D1)', () => {
  const view = block('CREATE OR REPLACE VIEW public.v_firm_user_pending_actions', 'COMMENT ON VIEW');

  it('does NOT declare security_invoker', () => {
    expect(view.toLowerCase()).not.toContain('security_invoker');
  });

  it('documents the owner-privileged choice in a COMMENT ON VIEW', () => {
    expect(src).toContain('COMMENT ON VIEW public.v_firm_user_pending_actions');
    expect(src).toMatch(/PLAIN owner-privileged view \(NOT security_invoker\)/);
  });
});

// ----------------------------------------------------------------------------
// Block B — auth.uid() scoping present in BOTH UNION branches (the whole
// security boundary, since there is no RLS backstop on a plain view).
// ----------------------------------------------------------------------------
describe('inbox view scoping is baked into both branches', () => {
  const view = block('CREATE OR REPLACE VIEW public.v_firm_user_pending_actions', 'COMMENT ON VIEW');

  it('filters fm.user_id = auth.uid() and restrict_firm_access=false in BOTH action branches', () => {
    // The view has two UNION ALL: one inside the effective_membership CTE
    // (firm_members ∪ firms) and one between the chain/unlock action branches.
    // Count occurrences rather than split, so the CTE's internal UNION ALL
    // doesn't confuse the branch check.
    const authFilter = view.match(/fm\.user_id = auth\.uid\(\)/g) ?? [];
    expect(authFilter.length, 'auth.uid() filter in both action branches').toBe(2);
    const restrictFilter = view.match(/restrict_firm_access = false/g) ?? [];
    expect(restrictFilter.length, 'restrict_firm_access gate in both branches').toBe(2);
    // Both action types are present.
    expect(view).toContain("'chain_step'");
    expect(view).toContain("'unlock_request'");
  });

  it('restricts the unlock branch to firm_admins', () => {
    const unlock = view.slice(view.indexOf('UNION ALL'));
    expect(unlock).toContain("fm.role = 'firm_admin'");
    expect(unlock).toContain("'unlock_request'");
  });

  it('derives effective membership including firm owners', () => {
    expect(view).toContain('effective_membership');
    expect(view).toContain('SELECT id AS firm_id, owner_id AS user_id');
  });
});

// ----------------------------------------------------------------------------
// Block C — firm_activity_log CHECK includes every deployed writer's value plus
// the Phase 10 additions. A dropped value silently breaks a live audit insert.
// ----------------------------------------------------------------------------
describe('firm_activity_log activity_type CHECK completeness', () => {
  const check = block('ADD CONSTRAINT firm_activity_log_activity_type_check', ']));');

  // Values emitted by the DEPLOYED Phase 9 edge functions (must never drop).
  const deployed = [
    'firm_created', 'firm_member_added', 'workspace_joined_firm', 'workspace_left_firm',
    'firm_billing_subscription_started', 'firm_billing_subscription_updated',
    'firm_billing_subscription_canceled',
  ];
  // Phase 10 additions (invitations / join-requests / settings / delete).
  const phase10 = [
    'firm_invitation_sent', 'firm_invitation_accepted', 'firm_invitation_revoked',
    'firm_invitation_resent', 'firm_join_request_created', 'firm_join_request_approved',
    'firm_join_request_rejected', 'firm_join_request_cancelled', 'firm_join_request_expired',
    'firm_settings_updated', 'firm_billing_summary_mode_changed', 'firm_deleted',
  ];

  it.each(deployed)('includes deployed writer value %s', (v) => {
    expect(check).toContain(`'${v}'`);
  });

  it.each(phase10)('includes Phase 10 value %s', (v) => {
    expect(check).toContain(`'${v}'`);
  });
});

// ----------------------------------------------------------------------------
// Block D — join_requests have NO client UPDATE/DELETE policy (D3: transitions
// are service-role-only → an initiator cannot self-approve).
// ----------------------------------------------------------------------------
describe('join_requests are read+create only at the client (D3)', () => {
  const section = block(
    '-- --- firm_workspace_join_requests',
    '-- 6. v_firm_user_pending_actions',
  );

  it('has a SELECT and an INSERT policy', () => {
    expect(section).toContain('FOR SELECT');
    expect(section).toContain('FOR INSERT');
  });

  it('has no UPDATE / DELETE / ALL policy on this table', () => {
    expect(section).not.toContain('FOR UPDATE');
    expect(section).not.toContain('FOR DELETE');
    expect(section).not.toContain('FOR ALL');
  });

  it('pins requested_by = auth.uid() and status = pending on INSERT', () => {
    expect(section).toContain('requested_by = auth.uid()');
    expect(section).toContain("status = 'pending'");
  });
});

// ----------------------------------------------------------------------------
// Block E — invitations owner-only-mints-admins split (D2), with invited_by
// attribution pinned.
// ----------------------------------------------------------------------------
describe('firm_invitations owner-only-mints-admins (D2)', () => {
  const adminPol = block('"firm admins manage member invitations"', 'invited_by = auth.uid());');
  const ownerPol = block('"firm owner manages all invitations"', 'invited_by = auth.uid());');

  it('admin policy pins role = firm_member in USING and WITH CHECK', () => {
    const using = adminPol.slice(adminPol.indexOf('USING'), adminPol.indexOf('WITH CHECK'));
    const check = adminPol.slice(adminPol.indexOf('WITH CHECK'));
    expect(using).toContain("role = 'firm_member'");
    expect(check).toContain("role = 'firm_member'");
  });

  it('owner policy gates on firms.owner_id = auth.uid()', () => {
    expect(ownerPol).toContain('owner_id = auth.uid()');
  });

  it('both manage policies pin invited_by = auth.uid() (attribution)', () => {
    expect(adminPol).toContain('invited_by = auth.uid()');
    expect(ownerPol).toContain('invited_by = auth.uid()');
  });
});

// ----------------------------------------------------------------------------
// Block F — one-pending-per-pair is a PARTIAL unique index (D4), not a plain
// UNIQUE(firm_id,workspace_id,status) which would block legitimate history.
// ----------------------------------------------------------------------------
describe('one-pending-per-pair is a partial unique index (D4)', () => {
  const idx = block('idx_firm_workspace_join_one_pending', ';');

  it('is a UNIQUE index scoped to status = pending', () => {
    expect(src).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_firm_workspace_join_one_pending');
    expect(idx).toContain('(firm_id, workspace_id)');
    expect(idx).toContain("WHERE status = 'pending'");
  });
});
