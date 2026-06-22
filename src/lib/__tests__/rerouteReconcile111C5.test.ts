import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #111 C5 — atomic reroute supersede+insert. Static guards over the
// transactional RPC + the edge fn's abort-on-failure wiring.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#111 C5 migration — reroute_reconcile_chain_steps RPC', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir)
    .filter((f) => f.includes('reroute_reconcile_chain_steps'))
    .sort()
    .pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');

  it('does the supersede UPDATE and the INSERT in one function body (atomic)', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.reroute_reconcile_chain_steps');
    expect(sql).toMatch(/UPDATE public\.lease_approval_chain\s+SET status = 'superseded'\s+WHERE id = ANY \(p_superseded_ids\)/);
    expect(sql).toContain('INSERT INTO public.lease_approval_chain');
    expect(sql).toContain('FROM jsonb_array_elements(p_new_rows) AS r');
  });

  it('casts parallel_group as int with a default of 1 (NOT NULL column)', () => {
    expect(sql).toContain("COALESCE(NULLIF(r->>'parallel_group', '')::int, 1)");
  });

  it('is service_role-only SECURITY DEFINER, owned by postgres (mirrors the RPC convention)', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_catalog');
    expect(sql).toContain('OWNER TO postgres');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) FROM anon, authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) TO service_role');
  });
});

describe('#111 C5 edge — resolve-approval-chain calls the RPC and aborts on failure', () => {
  const src = fn('supabase/functions/resolve-approval-chain/index.ts');

  it('reconciles via the atomic RPC, not two separate writes', () => {
    expect(src).toContain('supabaseAdmin.rpc(');
    expect(src).toContain('"reroute_reconcile_chain_steps"');
    expect(src).toContain('p_superseded_ids: supersededIds');
    expect(src).toContain('p_new_rows: rowsToInsert');
  });

  it('no longer swallows a failed supersede/insert (the old console.error-and-continue pattern is gone)', () => {
    expect(src).not.toContain('.update({ status: "superseded" })');
    expect(src).not.toContain('[resolve-approval-chain] supersede error');
    expect(src).not.toContain('[resolve-approval-chain] add error');
  });

  it('aborts the reroute (500) and logs the failure when reconciliation errors', () => {
    expect(src).toContain('reroute_reconcile_failed');
    expect(src).toMatch(/jsonResponse\(\{ ok: false, error: "reroute_reconcile_failed" \}, 500, origin\)/);
    expect(src).toContain('"chain_resolution_failed"');
  });
});
