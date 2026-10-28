import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ORDER_STEP,
  assignOrderPriorities,
  compareByEngineOrder,
  engineOrder,
  moveDown,
  moveToBottom,
  moveToTop,
  moveUp,
  policiesNeedingOrderWrite,
  validateOrderSet,
} from '../approvalPolicyOrder';

// Phase 1 of the Approval Rules redesign: `set_approval_policy_order()` is the
// ONLY write path for rule order. These tests pin the four properties the
// security + repository-integrity reviews sign off on:
//   1. set-equality rejection (the concurrency guard),
//   2. priority = (N - i) * 100,
//   3. the `IS DISTINCT FROM` write guard (a swap writes two rows, not N),
//   4. the initial displayed order equals the engine's effective order, so the
//      first save from the legacy all-100 state cannot silently reroute.
// Static assertions guard the SQL itself; logic assertions guard the Node
// mirror the UI will use. Static tests catch in-repo drift, not live-DB drift.

const repoRoot = join(__dirname, '..', '..', '..');

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

// Narrow to a named block before asserting `toContain`, so a match from an
// unrelated part of the file can't produce a false positive.
function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

const MIGRATION = '20260719121000_set_approval_policy_order_rpc.sql';
const sql = readRepoFile('supabase', 'migrations', MIGRATION);
const fnBody = sliceBetween(
  sql,
  'CREATE OR REPLACE FUNCTION public.set_approval_policy_order(',
  '$$;',
);

// ───────────────────────────────────────────────────────────────────────────
// Logic — the Node mirror
// ───────────────────────────────────────────────────────────────────────────

describe('approvalPolicyOrder — assignment', () => {
  it('assigns priority = (N - i) * 100, 0-based from the top', () => {
    expect(assignOrderPriorities(['a', 'b', 'c', 'd'])).toEqual([
      { id: 'a', priority: 400 },
      { id: 'b', priority: 300 },
      { id: 'c', priority: 200 },
      { id: 'd', priority: 100 },
    ]);
  });

  it('leaves a gap of 100 between adjacent rules and never emits 0 or a tie', () => {
    const assigned = assignOrderPriorities(Array.from({ length: 7 }, (_, i) => `p${i}`));
    expect(ORDER_STEP).toBe(100);
    expect(new Set(assigned.map((a) => a.priority)).size).toBe(assigned.length);
    for (let i = 1; i < assigned.length; i += 1) {
      expect(assigned[i - 1].priority - assigned[i].priority).toBe(ORDER_STEP);
    }
    expect(assigned[assigned.length - 1].priority).toBe(100);
    // Stays a positive integer — approvalPolicyValidation's server-adjacent
    // backstop is satisfied by construction.
    expect(assigned.every((a) => Number.isInteger(a.priority) && a.priority > 0)).toBe(true);
  });

  it('handles the single-rule and empty cases without special-casing', () => {
    expect(assignOrderPriorities(['only'])).toEqual([{ id: 'only', priority: 100 }]);
    expect(assignOrderPriorities([])).toEqual([]);
  });

  it('produces an order the engine comparator reproduces exactly', () => {
    const ids = ['r3', 'r1', 'r4', 'r2'];
    const assigned = assignOrderPriorities(ids);
    // created_at deliberately in the OPPOSITE order, so only `priority` can
    // be what carries the intent.
    const rows = assigned.map((a, i) => ({
      ...a,
      created_at: `2026-07-0${assigned.length - i}T00:00:00Z`,
    }));
    expect(engineOrder(rows).map((r) => r.id)).toEqual(ids);
  });
});

describe('approvalPolicyOrder — the engine total order', () => {
  it('sorts priority DESC, then created_at ASC, then id ASC', () => {
    const rows = [
      { id: 'zz', priority: 100, created_at: '2026-01-01T00:00:00Z' },
      { id: 'aa', priority: 100, created_at: '2026-01-01T00:00:00Z' },
      { id: 'mm', priority: 100, created_at: '2025-12-31T00:00:00Z' },
      { id: 'hi', priority: 200, created_at: '2026-06-01T00:00:00Z' },
    ];
    expect(engineOrder(rows).map((r) => r.id)).toEqual(['hi', 'mm', 'aa', 'zz']);
  });

  it('is a TOTAL order — identical (priority, created_at) still resolves by id', () => {
    const a = { id: 'b', priority: 100, created_at: 'same' };
    const b = { id: 'a', priority: 100, created_at: 'same' };
    expect(compareByEngineOrder(a, b)).toBeGreaterThan(0);
    expect(compareByEngineOrder(b, a)).toBeLessThan(0);
    expect(compareByEngineOrder(a, a)).toBe(0);
  });

  it('matches resolve-approval-chain matchPolicy() key-for-key', () => {
    const engine = readRepoFile('supabase', 'functions', 'resolve-approval-chain', 'index.ts');
    const comparator = sliceBetween(engine, '.sort((a, b) => {', 'const chosen =');
    expect(comparator).toContain('b.priority - a.priority');
    expect(comparator).toContain('a.created_at.localeCompare(b.created_at)');
    expect(comparator).toContain('a.id.localeCompare(b.id)');
  });

  it('THE ALL-100 CASE: the first save of the displayed order changes no routing', () => {
    // Exactly today's live data shape: every rule at priority 100.
    const legacy = [
      { id: 'd', priority: 100, created_at: '2026-03-04T00:00:00Z' },
      { id: 'b', priority: 100, created_at: '2026-01-02T00:00:00Z' },
      { id: 'c', priority: 100, created_at: '2026-01-02T00:00:00Z' }, // ties b on created_at
      { id: 'a', priority: 100, created_at: '2026-02-03T00:00:00Z' },
    ];
    // What the screen shows on first paint (no write on load).
    const displayed = engineOrder(legacy).map((r) => r.id);
    expect(displayed).toEqual(['b', 'c', 'a', 'd']);

    // The admin saves without moving anything: renormalize 100/100/100/100.
    const assigned = assignOrderPriorities(displayed);
    expect(assigned.map((a) => a.priority)).toEqual([400, 300, 200, 100]);

    // The engine's effective order is byte-identical before and after.
    const after = legacy.map((row) => ({
      ...row,
      priority: assigned.find((a) => a.id === row.id)!.priority,
    }));
    expect(engineOrder(after).map((r) => r.id)).toEqual(displayed);
  });
});

describe('approvalPolicyOrder — the IS DISTINCT FROM write guard', () => {
  const current = [
    { id: 'a', priority: 400 },
    { id: 'b', priority: 300 },
    { id: 'c', priority: 200 },
    { id: 'd', priority: 100 },
  ];

  it('writes exactly the two rows a single swap moves — not N', () => {
    const changed = policiesNeedingOrderWrite(current, ['a', 'c', 'b', 'd']);
    expect(changed).toEqual([
      { id: 'c', priority: 300 },
      { id: 'b', priority: 200 },
    ]);
  });

  it('writes nothing when the submitted order is already in effect', () => {
    expect(policiesNeedingOrderWrite(current, ['a', 'b', 'c', 'd'])).toEqual([]);
  });

  it('writes every row when normalizing the legacy all-100 set', () => {
    const allHundred = current.map((p) => ({ ...p, priority: 100 }));
    // 'd' already lands on 100, so it is correctly left untouched.
    expect(policiesNeedingOrderWrite(allHundred, ['a', 'b', 'c', 'd'])).toEqual([
      { id: 'a', priority: 400 },
      { id: 'b', priority: 300 },
      { id: 'c', priority: 200 },
    ]);
  });
});

describe('approvalPolicyOrder — set-equality (the concurrency guard)', () => {
  const currentIds = ['a', 'b', 'c'];

  it('accepts an exact permutation of the current set', () => {
    expect(validateOrderSet(currentIds, ['c', 'a', 'b'])).toEqual({ ok: true });
    expect(validateOrderSet([], [])).toEqual({ ok: true });
  });

  it('rejects a duplicate', () => {
    expect(validateOrderSet(currentIds, ['a', 'a', 'b'])).toEqual({
      ok: false,
      reason: 'stale_policy_order',
      problem: 'duplicate',
    });
  });

  it('rejects an omission (another admin added a rule)', () => {
    expect(validateOrderSet(currentIds, ['a', 'b'])).toEqual({
      ok: false,
      reason: 'stale_policy_order',
      problem: 'count_mismatch',
    });
  });

  it('rejects an extra (another admin deleted a rule)', () => {
    expect(validateOrderSet(currentIds, ['a', 'b', 'c', 'd'])).toEqual({
      ok: false,
      reason: 'stale_policy_order',
      problem: 'count_mismatch',
    });
  });

  it('rejects a foreign id even when the count happens to match', () => {
    expect(validateOrderSet(currentIds, ['a', 'b', 'other-workspace-rule'])).toEqual({
      ok: false,
      reason: 'stale_policy_order',
      problem: 'unknown_id',
    });
  });
});

describe('approvalPolicyOrder — move intents', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves up, down, to top and to bottom, always preserving the set', () => {
    expect(moveUp(ids, 'c')).toEqual(['a', 'c', 'b', 'd']);
    expect(moveDown(ids, 'b')).toEqual(['a', 'c', 'b', 'd']);
    expect(moveToTop(ids, 'd')).toEqual(['d', 'a', 'b', 'c']);
    expect(moveToBottom(ids, 'a')).toEqual(['b', 'c', 'd', 'a']);
    for (const next of [moveUp(ids, 'c'), moveDown(ids, 'b'), moveToTop(ids, 'd'), moveToBottom(ids, 'a')]) {
      expect(validateOrderSet(ids, next)).toEqual({ ok: true });
    }
  });

  it('no-ops at the boundaries and for an unknown id, never dropping a rule', () => {
    expect(moveUp(ids, 'a')).toEqual(ids);
    expect(moveDown(ids, 'd')).toEqual(ids);
    expect(moveUp(ids, 'nope')).toEqual(ids);
    expect(moveDown(ids, 'nope')).toEqual(ids);
    expect(moveToTop(ids, 'nope')).toEqual(ids);
    expect(moveToBottom(ids, 'nope')).toEqual(ids);
  });

  it('does not mutate its input', () => {
    const original = [...ids];
    moveUp(ids, 'c');
    moveToBottom(ids, 'a');
    expect(ids).toEqual(original);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Static — the migration
// ───────────────────────────────────────────────────────────────────────────

describe('set_approval_policy_order migration — shape', () => {
  it('is a SECURITY DEFINER function with a pinned search_path', () => {
    expect(fnBody).toContain('SECURITY DEFINER');
    expect(fnBody).toContain('SET search_path = public, pg_temp');
    expect(fnBody).toContain('RETURNS jsonb');
  });

  it('authorizes owner-or-admin explicitly in the body (RLS is bypassed)', () => {
    // Same predicate as the live "workspace admins write policies update" RLS:
    // workspace owner UNION workspace_members with role = 'admin'.
    expect(fnBody).toContain("public.has_workspace_permission(p_workspace_id, v_actor, 'admin'::public.workspace_role)");
    expect(fnBody).toContain('v_actor IS NULL');
    expect(fnBody).toContain("RAISE EXCEPTION 'Forbidden'");
  });

  it('re-asserts the Vault read-only gate that SECURITY DEFINER bypasses', () => {
    expect(fnBody).toContain('public.is_workspace_live(p_workspace_id)');
    expect(fnBody).toContain("RAISE EXCEPTION 'workspace_not_live'");
  });

  it('locks the workspace rule set in a deterministic order before asserting', () => {
    const lock = sliceBetween(fnBody, 'PERFORM 1', 'FOR UPDATE;');
    expect(lock).toContain('FROM public.approval_policies p');
    expect(lock).toContain('WHERE p.workspace_id = p_workspace_id');
    expect(lock).toContain('ORDER BY p.id');
  });

  it('asserts exact set equality and raises a distinguishable stale_policy_order', () => {
    expect(fnBody).toContain('count(DISTINCT e)');
    expect(fnBody).toContain('v_count <> v_distinct');
    expect(fnBody).toContain('v_count <> v_existing');
    // Every submitted id must belong to THIS workspace — blocks cross-workspace
    // id injection as well as a stale list.
    const foreign = sliceBetween(fnBody, 'IF EXISTS (', "RAISE EXCEPTION 'stale_policy_order'\n      USING DETAIL = 'p_ordered_ids contains an id that is not a rule of this workspace'");
    expect(foreign).toContain('p.workspace_id = p_workspace_id');
    expect((fnBody.match(/RAISE EXCEPTION 'stale_policy_order'/g) ?? []).length).toBe(3);
  });

  it('assigns (N - i) * 100 with ordinality', () => {
    const assign = sliceBetween(fnBody, 'WITH desired AS (', 'updated AS (');
    expect(assign).toContain('((v_count - (o.ord - 1)) * 100)::integer');
    expect(assign).toContain('unnest(p_ordered_ids) WITH ORDINALITY');
  });

  it('carries the IS DISTINCT FROM write guard so a swap writes two rows', () => {
    const update = sliceBetween(fnBody, 'UPDATE public.approval_policies p', 'RETURNING');
    expect(update).toContain('SET priority = d.new_priority');
    expect(update).toContain('AND p.workspace_id = p_workspace_id');
    expect(update).toContain('AND p.priority IS DISTINCT FROM d.new_priority');
    // One column, one table: no version, no updated_by, no chain writes.
    expect(update).not.toContain('version');
    expect(update).not.toContain('updated_by');
  });

  it('touches no chain, step, or lease table', () => {
    for (const table of [
      'lease_approval_chain',
      'approval_chain_steps',
      'lease_reroute_events',
      'lifecycle_status',
      'leases',
    ]) {
      expect(fnBody.includes(`INTO public.${table}`)).toBe(false);
      expect(fnBody.includes(`UPDATE public.${table}`)).toBe(false);
    }
  });

  it('audits one workspace_activity_log row per changing call', () => {
    const audit = sliceBetween(fnBody, 'INSERT INTO public.workspace_activity_log', 'RETURN jsonb_build_object');
    expect(audit).toContain("'approval_rules_reordered'");
    expect(audit).toContain('v_actor');
    expect(audit).toContain("'moves'");
    expect(audit).toContain("'before'");
    expect(audit).toContain("'after'");
    // Guarded on something having actually changed — a no-op writes nothing.
    expect(fnBody).toContain('IF jsonb_array_length(v_changed) > 0 THEN');
  });

  it('returns what changed, for auditability', () => {
    const ret = sliceBetween(fnBody, "RETURN jsonb_build_object(\n    'ok', true,\n    'workspace_id'", 'END;');
    expect(ret).toContain("'changed', v_changed");
    expect(ret).toContain("'moves', v_moves");
    expect(ret).toContain("'order'");
    expect(ret).toContain("'count', v_count");
  });

  it('is granted to authenticated only, and pins the definer identity', () => {
    expect(sql).toContain('ALTER FUNCTION public.set_approval_policy_order(uuid, uuid[]) OWNER TO postgres');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) FROM PUBLIC');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) FROM anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) TO authenticated');
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) TO service_role');
  });

  it('is idempotent (CREATE OR REPLACE)', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.set_approval_policy_order(');
  });

  it('states the Phase-0 trigger dependency in the header', () => {
    const header = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(header).toContain('20260719120000_approval_policies_version_ignores_priority.sql');
    expect(header).toContain('APPLY ORDER');
    expect(header.toLowerCase()).toContain('in flight');
  });
});

describe('set_approval_policy_order migration — read order lockstep', () => {
  it('snapshots the before-order with the engine total order', () => {
    const snapshot = sliceBetween(fnBody, 'row_number() OVER (', ') AS ord');
    expect(snapshot).toContain('ORDER BY p.priority DESC, p.created_at ASC, p.id ASC');
  });

  it('applies AFTER the Phase-0 trigger migration by timestamp', () => {
    expect(MIGRATION > '20260719120000_approval_policies_version_ignores_priority.sql').toBe(true);
  });
});
