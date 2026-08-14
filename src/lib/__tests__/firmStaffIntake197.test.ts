import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useApp } from '@/contexts/AppContext';
import { useFirm } from '@/contexts/FirmContext';
import { useFirmIntakeAccess } from '@/hooks/useFirmIntakeAccess';

// ============================================================================
// #197 (owner decision 2026-08-14): firm staff CAN create leases in child
// workspaces. Three gates move in lockstep and are documented as such:
//   1. RLS INSERT policy leases_insert_own_editor_plus (20260814190000),
//   2. _shared/role_gate.ts callerCanProcessLeases (process_lease/retry_lease),
//   3. the client predicate useFirmIntakeAccess (Dashboard/Leases/ImportHistory).
// The load-bearing subtleties these tests pin:
//   - the firm arm honors restrict_firm_access (the per-child opt-out) with a
//     STRICT false check server-side (NULL fails closed),
//   - a direct workspace_members VIEWER row out-ranks the firm-derived
//     allowance on every layer (explicit read-only beats implicit firm access),
//   - the pre-#197 arms (own-row + editor-or-better) survive the policy rewrite,
//   - every lookup-error path in the Deno gate fails closed.
// Dropping any one of these would be a silent authorization regression.
// ============================================================================

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ----------------------------------------------------------------------------
// Gate 1 — the RLS INSERT policy (static migration pin, narrowed to the
// CREATE POLICY declaration block per the repo's static-test rule).
// ----------------------------------------------------------------------------
describe('#197 gate 1 — leases INSERT policy (20260814190000)', () => {
  const migration = read(
    'supabase/migrations/20260814190000_leases_insert_firm_staff.sql',
  );
  const policyStart = migration.indexOf(
    'CREATE POLICY "leases_insert_own_editor_plus"',
  );
  const policyBlock = migration.slice(policyStart);

  it('re-creates the policy idempotently (DROP IF EXISTS precedes CREATE)', () => {
    expect(policyStart).toBeGreaterThan(-1);
    const dropIdx = migration.indexOf(
      'DROP POLICY IF EXISTS "leases_insert_own_editor_plus"',
    );
    expect(dropIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(policyStart);
    expect(policyBlock).toContain('FOR INSERT');
  });

  it('(a) the own-row arm survives: auth.uid() = user_id', () => {
    expect(policyBlock).toMatch(/"auth"\."uid"\(\)\s*=\s*"user_id"/);
  });

  it('(b) the direct-membership arm survives: has_workspace_permission(…, editor)', () => {
    expect(policyBlock).toMatch(
      /"has_workspace_permission"\("workspace_id",\s*"auth"\."uid"\(\),\s*'editor'/,
    );
  });

  describe('the firm arm (narrowed to its EXISTS sub-block)', () => {
    const firmArmStart = policyBlock.indexOf('OR EXISTS');
    const firmArm = policyBlock.slice(firmArmStart);

    it('exists and targets workspaces', () => {
      expect(firmArmStart).toBeGreaterThan(-1);
      expect(firmArm).toContain('FROM "public"."workspaces"');
    });

    it('(c) requires firm-bound + not-opted-out + firm membership, conjunctively', () => {
      expect(firmArm).toMatch(/"firm_id"\s+IS NOT NULL/);
      // Strict = false (a restricted child never grants firm intake).
      expect(firmArm).toMatch(/"restrict_firm_access"\s*=\s*false/);
      expect(firmArm).toMatch(
        /"is_firm_member"\("w"\."firm_id",\s*"auth"\."uid"\(\)\)/,
      );
      // All three are ANDed inside the one EXISTS — none is an alternative arm.
      expect(firmArm).toMatch(/AND\s+"w"\."restrict_firm_access"\s*=\s*false/);
      expect(firmArm).toMatch(/AND\s+"public"\."is_firm_member"/);
    });

    it('(d) carries the direct-viewer override: NOT EXISTS on a workspace_members viewer row', () => {
      const overrideStart = firmArm.indexOf('AND NOT EXISTS');
      expect(overrideStart).toBeGreaterThan(-1);
      const override = firmArm.slice(overrideStart);
      expect(override).toContain('FROM "public"."workspace_members"');
      expect(override).toMatch(/"m"\."user_id"\s*=\s*"auth"\."uid"\(\)/);
      expect(override).toMatch(/"m"\."role"\s*=\s*'viewer'/);
      // The override lives INSIDE the firm arm (after is_firm_member), so it
      // constrains only the firm-derived allowance — a direct editor/admin
      // going through arm (b) is untouched.
      expect(overrideStart).toBeGreaterThan(firmArm.indexOf('"is_firm_member"'));
    });
  });
});

// ----------------------------------------------------------------------------
// Gate 2 — the Deno role gate (static pin, narrowed to the
// callerCanProcessLeases function body).
// ----------------------------------------------------------------------------
describe('#197 gate 2 — role_gate.ts callerCanProcessLeases', () => {
  const src = read('supabase/functions/_shared/role_gate.ts');
  const fnStart = src.indexOf('export async function callerCanProcessLeases');
  const fnEnd = src.indexOf('export const READ_ONLY_ROLE_ERROR');
  const fn = src.slice(fnStart, fnEnd);

  it('the function body was located (narrowing sanity)', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  it('a direct viewer row returns false BEFORE the firm branch runs (explicit read-only out-ranks firm allowance)', () => {
    const viewerIdx = fn.indexOf("if (role === 'viewer') return false");
    const firmIdx = fn.indexOf('isFirmStaffOfWorkspace(admin, workspaceId, userId)');
    expect(viewerIdx).toBeGreaterThan(-1);
    expect(firmIdx).toBeGreaterThan(-1);
    expect(viewerIdx).toBeLessThan(firmIdx);
  });

  it('the firm branch delegates to the single membership-shaped helper (one firm truth for all chokepoints)', () => {
    expect(fn).toContain('return await isFirmStaffOfWorkspace(admin, workspaceId, userId)');
  });

  it('every lookup-error path fails closed (wsErr / mErr return false; firm-side errors pinned on the helper)', () => {
    expect(fn).toMatch(/if \(wsErr\) return false/);
    expect(fn).toMatch(/if \(mErr\) return false/);
  });

  it('both paid-AI entry points still call the shared gate (lockstep wiring)', () => {
    for (const entry of [
      'supabase/functions/process_lease/index.ts',
      'supabase/functions/retry_lease/index.ts',
    ]) {
      const entrySrc = read(entry);
      expect(entrySrc).toContain('from "../_shared/role_gate.ts"');
      expect(entrySrc).toContain('await callerCanProcessLeases(');
      expect(entrySrc).toContain('READ_ONLY_ROLE_REASON');
    }
  });
});

// ----------------------------------------------------------------------------
// Gate 3 — the client predicate. useFirmIntakeAccess is a pure derivation over
// useApp + useFirm (no state/effects), so — per the useWorkspaceQuota.test.ts
// precedent — it's unit-testable by mocking the two context modules and
// calling the hook as a plain function. No render harness needed.
// ----------------------------------------------------------------------------
vi.mock('@/contexts/AppContext', () => ({ useApp: vi.fn() }));
vi.mock('@/contexts/FirmContext', () => ({ useFirm: vi.fn() }));
const mockUseApp = vi.mocked(useApp);
const mockUseFirm = vi.mocked(useFirm);

function setSession(opts: {
  userRole?: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  workspaceFirmId?: string | null;
  workspaceNull?: boolean;
  memberFirmIds?: string[];
}) {
  mockUseApp.mockReturnValue({
    workspace: opts.workspaceNull
      ? null
      : ({ firmId: opts.workspaceFirmId ?? null } as never),
    userRole: opts.userRole ?? null,
  } as unknown as ReturnType<typeof useApp>);
  mockUseFirm.mockReturnValue({
    firmMemberships: (opts.memberFirmIds ?? []).map((id) => ({
      firm_id: id,
      firm_name: `Firm ${id}`,
      role: 'firm_member' as const,
    })),
  } as unknown as ReturnType<typeof useFirm>);
}

beforeEach(() => {
  mockUseApp.mockReset();
  mockUseFirm.mockReset();
});

describe('#197 gate 3 — useFirmIntakeAccess', () => {
  it('grants intake to a purely firm-derived session in a bound child (userRole null, firm matches)', () => {
    setSession({ userRole: null, workspaceFirmId: 'firm-1', memberFirmIds: ['firm-1'] });
    expect(useFirmIntakeAccess()).toBe(true);
  });

  it('grants intake to the FIRM OWNER (FirmContext synthesizes an owner membership entry — no firm_members row needed)', () => {
    setSession({ userRole: null, workspaceFirmId: 'firm-1', memberFirmIds: [] });
    mockUseFirm.mockReturnValue({
      firmMemberships: [{ firm_id: 'firm-1', firm_name: 'Firm firm-1', role: 'owner' as const }],
    } as unknown as ReturnType<typeof useFirm>);
    expect(useFirmIntakeAccess()).toBe(true);
  });

  it('ANY direct role short-circuits to false — the direct assignment owns the answer', () => {
    // The critical case: a direct VIEWER who is also firm staff stays
    // read-only (the override the RLS NOT EXISTS + role_gate order enforce).
    for (const role of ['viewer', 'editor', 'admin', 'owner'] as const) {
      setSession({ userRole: role, workspaceFirmId: 'firm-1', memberFirmIds: ['firm-1'] });
      expect(useFirmIntakeAccess()).toBe(false);
    }
  });

  it('denies when the workspace is not firm-bound', () => {
    setSession({ userRole: null, workspaceFirmId: null, memberFirmIds: ['firm-1'] });
    expect(useFirmIntakeAccess()).toBe(false);
  });

  it('denies when the user belongs to a DIFFERENT firm than the workspace', () => {
    setSession({ userRole: null, workspaceFirmId: 'firm-1', memberFirmIds: ['firm-2'] });
    expect(useFirmIntakeAccess()).toBe(false);
  });

  it('denies while the workspace is still loading (null workspace) and with no memberships', () => {
    setSession({ userRole: null, workspaceNull: true, memberFirmIds: ['firm-1'] });
    expect(useFirmIntakeAccess()).toBe(false);
    setSession({ userRole: null, workspaceFirmId: 'firm-1', memberFirmIds: [] });
    expect(useFirmIntakeAccess()).toBe(false);
  });

  it('source pin: the direct-role short-circuit precedes the firm check (order is the contract)', () => {
    // Belt-and-braces on top of the behavioral tests: if someone reorders the
    // hook so firm membership is consulted before the direct role, the
    // behavioral viewer case above would still catch it — this pin makes the
    // intent unmissable in review.
    const hookSrc = read('src/hooks/useFirmIntakeAccess.ts');
    const roleIdx = hookSrc.indexOf('if (userRole) return false');
    const firmIdx = hookSrc.indexOf('firmMemberships.some');
    expect(roleIdx).toBeGreaterThan(-1);
    expect(firmIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeLessThan(firmIdx);
  });
});

// ----------------------------------------------------------------------------
// RLS coupling — the direct-viewer override's NOT EXISTS evaluates under the
// CALLER's row security, so it silently depends on workspace_members' SELECT
// policy keeping its self-visibility arm (user_id = auth.uid()). If a future
// hardening narrowed that arm, the caller's own viewer row would become
// invisible inside the policy subquery, NOT EXISTS would flip to true, and a
// direct viewer who is also firm staff would REGAIN lease INSERT with no error
// anywhere — a classic fail-open coupling. (#197 security review, MEDIUM.)
// ----------------------------------------------------------------------------
describe('#197 RLS coupling — workspace_members SELECT keeps self-visibility', () => {
  const baseline = read('supabase/migrations/20260516120000_baseline_schema.sql');
  const policyStart = baseline.indexOf(
    'CREATE POLICY "Members can view workspace membership" ON "public"."workspace_members"',
  );

  it('the baseline SELECT policy retains the user_id = auth.uid() arm', () => {
    expect(policyStart).toBeGreaterThan(-1);
    // Narrow to this one policy statement (up to its terminating semicolon).
    const stmt = baseline.slice(policyStart, baseline.indexOf(';', policyStart));
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toMatch(/"user_id"\s*=\s*"auth"\."uid"\(\)/);
  });

  it('no later migration re-creates that policy without the self-arm', () => {
    // Any migration that DROPs or re-CREATEs the policy must keep the
    // self-visibility arm. Today none touches it beyond EXISTS smoke checks;
    // this guard makes a future replacement confront the coupling.
    const dir = join(root, 'supabase/migrations');
    const laterFiles = readdirSync(dir).filter(
      (f) => f.endsWith('.sql') && f > '20260516120000_baseline_schema.sql',
    );
    for (const f of laterFiles) {
      const src = read(join('supabase/migrations', f));
      const createIdx = src.indexOf(
        'CREATE POLICY "Members can view workspace membership"',
      );
      if (createIdx === -1) continue;
      const stmt = src.slice(createIdx, src.indexOf(';', createIdx));
      expect(stmt, `${f} re-creates the workspace_members SELECT policy without the self-visibility arm #197's viewer override depends on`).toMatch(
        /"?user_id"?\s*=\s*(\(\s*SELECT\s+)?"?auth"?\."?uid"?\(\)/i,
      );
    }
  });
});

// ----------------------------------------------------------------------------
// Server chokepoints beyond the role gate — the #197 security review found the
// capability dead-ends without these two: process_lease's workspace resolution
// and resolve-approval-chain's submission auth were owner-or-direct-member
// only. Both now consult the shared membership-shaped firm helper.
// ----------------------------------------------------------------------------
describe('#197 server chokepoints — isFirmStaffOfWorkspace wiring', () => {
  const gateSrc = read('supabase/functions/_shared/role_gate.ts');
  const helperStart = gateSrc.indexOf('export async function isFirmStaffOfWorkspace');
  const helperEnd = gateSrc.indexOf('export const READ_ONLY_ROLE_ERROR');
  const helper = gateSrc.slice(helperStart, helperEnd);

  it('the helper exists, requires strict restrict_firm_access !== false denial, and fails closed', () => {
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toMatch(/if \(!ws\?\.firm_id \|\| ws\.restrict_firm_access !== false\) return false/);
    expect(helper).toMatch(/if \(wsErr\) return false/);
    expect(helper).toMatch(/if \(fErr\) return false/);
    expect(helper).toMatch(/if \(fmErr\) return false/);
    expect(helper).toContain("select('firm_id, restrict_firm_access')");
  });

  it('the helper carries the firm-OWNER arm (SQL is_firm_member counts firms.owner_id — the owner often has no firm_members row)', () => {
    const ownerIdx = helper.indexOf("from('firms')");
    const memberIdx = helper.indexOf("from('firm_members')");
    expect(ownerIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(-1);
    expect(helper).toContain("select('owner_id')");
    expect(helper).toMatch(/if \(firm\?\.owner_id === userId\) return true/);
    // Owner short-circuit precedes the firm_members lookup.
    expect(ownerIdx).toBeLessThan(memberIdx);
  });

  it('process_lease consults the firm arm AFTER the direct-membership miss in workspace resolution', () => {
    const src = read('supabase/functions/process_lease/index.ts');
    expect(src).toContain('isFirmStaffOfWorkspace');
    const missIdx = src.indexOf('if (membership) return membership.workspace_id');
    const firmIdx = src.indexOf('await isFirmStaffOfWorkspace(supabaseAdmin, requestedWorkspaceId, userId)');
    const throwIdx = src.indexOf("throw new Error('Unauthorized workspace access.')");
    expect(missIdx).toBeGreaterThan(-1);
    expect(firmIdx).toBeGreaterThan(missIdx);
    // The deny throw survives and comes after the firm arm — the widening
    // added an arm, it did not remove the wall.
    expect(throwIdx).toBeGreaterThan(firmIdx);
  });

  it('resolve-approval-chain counts firm staff as members for submission', () => {
    const src = read('supabase/functions/resolve-approval-chain/index.ts');
    expect(src).toContain('from "../_shared/role_gate.ts"');
    const firmIdx = src.indexOf('isMember = await isFirmStaffOfWorkspace(supabaseAdmin, workspaceId, user.id)');
    expect(firmIdx).toBeGreaterThan(-1);
    // The membership 403 still exists AFTER the firm arm (the widening added
    // an arm, it did not remove the wall). An earlier `forbidden` belongs to
    // the auth check — anchor past the firm arm, not at the file's first hit.
    expect(src.indexOf('reason: "forbidden"', firmIdx)).toBeGreaterThan(firmIdx);
  });
});
