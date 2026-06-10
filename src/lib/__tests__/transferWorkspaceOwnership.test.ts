import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-source coverage for the Phase 3 ownership transfer (spec §4.2 +
// the same-day hardening pass). The transfer is split across two sources:
//
//   - supabase/migrations/20260609180000_transfer_workspace_ownership_rpc.sql
//     — the atomic SECURITY DEFINER RPC that owns ALL mutations + the audit
//     row in one transaction (added after the reviewer pass found the
//     original inline edge-function writes could log a transfer that never
//     committed).
//   - supabase/functions/transfer-workspace-ownership/index.ts — auth,
//     validation, rate limiting, and delegation to the RPC.
//
// Deno functions / SQL can't run under vitest, so — per repo convention
// (see workspaceLimits.test.ts) — we pin the load-bearing source blocks with
// readFileSync, narrowing the search window to each block's declaration
// before asserting. Full-file toContain is a known false-positive trap.

const fnSrc = readFileSync(
  join(
    process.cwd(),
    'supabase/functions/transfer-workspace-ownership/index.ts',
  ),
  'utf8',
);

const sqlSrc = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260609180000_transfer_workspace_ownership_rpc.sql',
  ),
  'utf8',
);

/** Slice a source between two unique markers; fail loudly if either moved. */
function section(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `start marker not found: "${start}"`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end marker not found after "${start}": "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

// ─────────────────────────────────────────────────────────────────────────
// Migration: the atomic RPC
// ─────────────────────────────────────────────────────────────────────────

describe('transfer_workspace_ownership_locked (migration) — locking & authorization', () => {
  it('locks the workspace row FOR UPDATE before any check', () => {
    const block = section(sqlSrc, 'Lock the workspace row', 'no workspace-existence');
    expect(block).toContain('FROM public.workspaces');
    expect(block).toContain('FOR UPDATE');
  });

  it('answers not_found for BOTH missing and not-yours (no existence oracle)', () => {
    const block = section(sqlSrc, 'Same answer for', 'already_owner');
    expect(block).toContain('IF NOT FOUND OR v_ws.owner_id IS DISTINCT FROM p_caller_id');
    expect(block).toMatch(/'reason',\s*'not_found'/);
  });

  it('rejects transferring to the current owner (already_owner)', () => {
    const block = section(sqlSrc, "'already_owner'", 'Accepted member only');
    expect(block).toBeTruthy();
    expect(sqlSrc).toContain("IF p_target_user_id = v_ws.owner_id THEN");
  });
});

describe('transfer_workspace_ownership_locked (migration) — target eligibility', () => {
  it('requires an ACCEPTED member, scoped to the workspace, and locks the member row', () => {
    const block = section(sqlSrc, 'Accepted member only', '1. Promote target');
    expect(block).toContain('workspace_id = p_workspace_id');
    expect(block).toContain('user_id = p_target_user_id');
    expect(block).toContain('accepted_at IS NOT NULL');
    expect(block).toContain('FOR UPDATE');
    expect(block).toMatch(/'reason',\s*'target_not_accepted_member'/);
  });
});

describe('transfer_workspace_ownership_locked (migration) — mutations', () => {
  it('promotes the target to admin and RAISEs (full rollback) on zero rows', () => {
    const block = section(sqlSrc, '1. Promote target', '2. Mandatorily demote');
    expect(block).toContain("SET role = 'admin' WHERE id = v_target.id");
    expect(block).toContain('RAISE EXCEPTION');
    expect(block).toContain('transfer_conflict');
  });

  it("demotes the prior owner to 'admin' on the update path AND the insert fallback (accepted_at stamped)", () => {
    const block = section(sqlSrc, '2. Mandatorily demote', '3. Swap owner');
    expect(block).toContain("SET role = 'admin'");
    expect(block).toContain('user_id = v_ws.owner_id');
    expect(block).toContain('INSERT INTO public.workspace_members');
    expect(block).toMatch(/'admin',\s*now\(\),\s*now\(\)/);
  });

  it('swaps owner_id guarded on the prior owner and RAISEs on a concurrent change', () => {
    const block = section(sqlSrc, '3. Swap owner', '4. Audit row');
    expect(block).toContain('SET owner_id = p_target_user_id');
    expect(block).toContain('AND owner_id = v_ws.owner_id');
    expect(block).toContain('RAISE EXCEPTION');
    expect(block).toContain('owner changed concurrently');
  });

  it('mutations are ordered promote → demote → swap → audit, all inside the function body', () => {
    const promoteIdx = sqlSrc.indexOf('1. Promote target');
    const demoteIdx = sqlSrc.indexOf('2. Mandatorily demote');
    const swapIdx = sqlSrc.indexOf('3. Swap owner');
    const auditIdx = sqlSrc.indexOf('4. Audit row');
    const endIdx = sqlSrc.indexOf('END;');
    expect(promoteIdx).toBeGreaterThan(-1);
    expect(demoteIdx).toBeGreaterThan(promoteIdx);
    expect(swapIdx).toBeGreaterThan(demoteIdx);
    expect(auditIdx).toBeGreaterThan(swapIdx);
    expect(endIdx).toBeGreaterThan(auditIdx);
  });
});

describe('transfer_workspace_ownership_locked (migration) — audit row', () => {
  it('logs owner_transferred in the SAME transaction with the spec §4.2(4) shape + target_prior_role', () => {
    const block = section(sqlSrc, '4. Audit row', 'RETURN jsonb_build_object');
    expect(block).toContain('INSERT INTO public.workspace_activity_log');
    expect(block).toContain("'owner_transferred'");
    expect(block).toContain("'from', v_ws.owner_id");
    expect(block).toContain("'to', p_target_user_id");
    expect(block).toContain("'prior_owner_new_role', 'admin'");
    expect(block).toContain("'target_prior_role', v_target.role");
    // Boolean, NOT the raw Stripe customer id — the row is member-readable
    // (spec §4.2(4) deviation, recorded in the as-built).
    expect(block).toContain("'billing_remains_on_prior_owner', true");
    expect(block).not.toContain('stripe_customer_id');
    expect(block).toContain("'billing_transferred', false");
    // The actor is the caller (prior owner), not NULL/system.
    expect(block).toContain('p_caller_id');
  });
});

describe('transfer_workspace_ownership_locked (migration) — grants', () => {
  it('is SECURITY DEFINER with a pinned search_path (pg_temp last) and postgres owner', () => {
    const block = section(sqlSrc, 'CREATE OR REPLACE FUNCTION', 'DECLARE');
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toContain('SET search_path = public, pg_temp');
    // Definer identity must not depend on which role applies the migration.
    expect(sqlSrc).toContain(
      'ALTER FUNCTION public.transfer_workspace_ownership_locked(uuid, uuid, uuid) OWNER TO postgres;',
    );
  });

  it('EXECUTE is revoked from PUBLIC/anon/authenticated and granted to service_role only', () => {
    // Load-bearing: the baseline grants ALL ON FUNCTIONS to anon/authenticated
    // by default — without these REVOKEs any authenticated user could call
    // the RPC with an arbitrary p_caller_id via /rest/v1/rpc.
    const block = sqlSrc.slice(sqlSrc.indexOf('REVOKE ALL'));
    expect(block).toContain('FROM PUBLIC');
    expect(block).toContain('FROM anon');
    expect(block).toContain('FROM authenticated');
    expect(block).toContain('GRANT EXECUTE');
    expect(block).toContain('TO service_role');
    expect(block).not.toContain('TO authenticated');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Edge function: auth, validation, delegation
// ─────────────────────────────────────────────────────────────────────────

describe('transfer-workspace-ownership (edge fn) — validation', () => {
  it('validates both body fields as UUIDs before any query', () => {
    const block = section(fnSrc, 'const workspaceId = body?.workspaceId', 'Advisory owner pre-check');
    expect(block).toContain('UUID_RE.test(workspaceId)');
    expect(block).toContain('UUID_RE.test(targetUserId)');
  });

  it('pre-check answers the SAME 404 for missing and not-yours (no existence oracle)', () => {
    const block = section(fnSrc, 'Advisory owner pre-check', 'Rate limit');
    expect(block).toContain('.owner_id !== user.id');
    expect(block).toMatch(/reason:\s*"not_found"/);
    expect(block).toMatch(/404/);
    // The old 403 not_owner split was an existence oracle — keep it gone.
    expect(fnSrc).not.toContain('"not_owner"');
  });
});

describe('transfer-workspace-ownership (edge fn) — rate limit', () => {
  it('enforces the shared workspace rate limit, wrapped so a helper throw cannot escape as a CORS-less 500', () => {
    const block = section(fnSrc, 'Rate limit', 'Atomic transfer via RPC');
    expect(block).toContain('enforceWorkspaceRateLimit');
    expect(block).toContain('"transfer-workspace-ownership"');
    expect(block).toContain('try {');
    expect(block).toContain('} catch');
  });

  it('the rate limit runs AFTER the owner pre-check (non-owners cannot burn the quota)', () => {
    const preIdx = fnSrc.indexOf('Advisory owner pre-check');
    // The call site, not the import at the top of the file.
    const rateIdx = fnSrc.indexOf('await enforceWorkspaceRateLimit(');
    expect(preIdx).toBeGreaterThan(-1);
    expect(rateIdx).toBeGreaterThan(preIdx);
  });
});

describe('transfer-workspace-ownership (edge fn) — RPC delegation', () => {
  it('delegates to transfer_workspace_ownership_locked with the verified caller id', () => {
    const block = section(fnSrc, 'Atomic transfer via RPC', 'if (rpcError)');
    expect(block).toContain('"transfer_workspace_ownership_locked"');
    expect(block).toContain('p_workspace_id: workspaceId');
    expect(block).toContain('p_caller_id: user.id');
    expect(block).toContain('p_target_user_id: targetUserId');
  });

  it('maps transfer_conflict to 409 and other RPC errors to 500', () => {
    const block = section(fnSrc, 'if (rpcError)', 'const outcome');
    expect(block).toContain('transfer_conflict');
    expect(block).toMatch(/reason:\s*"conflict"/);
    expect(block).toContain('409');
  });

  it('the success response surfaces billingTransferred: false so the UI can tell the prior owner', () => {
    const block = fnSrc.slice(fnSrc.indexOf('ok: true'));
    expect(block).toMatch(/billingTransferred:\s*false/);
    expect(block).toMatch(/priorOwnerNewRole:\s*"admin"/);
  });

  it('does NOT write workspace tables or the audit log directly (mutations live in the RPC)', () => {
    // The function may read workspaces (pre-check) but must not update
    // members/workspaces or insert audit rows outside the transaction.
    expect(fnSrc).not.toContain('.update(');
    expect(fnSrc).not.toContain('.insert(');
    expect(fnSrc).not.toContain('workspace_activity_log');
  });
});
