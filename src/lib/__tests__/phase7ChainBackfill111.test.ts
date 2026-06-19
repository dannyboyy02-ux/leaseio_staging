import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #111 C1 — backfill of the Phase-7 denormalized columns on
// lease_approval_chain. Static guards over the frontier-aware migration (the
// deliberate pivot away from the buggy A4 one-liner).

const root = process.cwd();
const dir = join(root, 'supabase/migrations');
const file = readdirSync(dir)
  .filter((f) => f.includes('backfill_phase7_chain_columns'))
  .sort()
  .pop()!;
const sql = readFileSync(join(dir, file), 'utf8');

describe('#111 C1 backfill migration', () => {
  it('backfills the assignee mirror only where not already set (idempotent, no clobber)', () => {
    expect(sql).toContain('effective_assignee_user_id = lac.approver_user_id');
    expect(sql).toMatch(/assignee_resolution_source = CASE/);
    expect(sql).toContain("THEN 'policy_user'");
    expect(sql).toContain("ELSE 'policy_role'");
    expect(sql).toContain('lac.effective_assignee_user_id IS NULL');
  });

  it('sets pending_since only on the FRONTIER active required step (mirrors creation)', () => {
    expect(sql).toContain('lac.is_required IS TRUE');
    expect(sql).toContain('lac.pending_since IS NULL');
    // The frontier predicate: no earlier still-blocking required row.
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toContain("earlier.status IN ('pending', 'sent_back')");
    // concept (0) ordered before signator (1).
    expect(sql).toMatch(/CASE earlier\.stage WHEN 'concept' THEN 0 ELSE 1 END/);
    expect(sql).toContain('earlier.step_order < lac.step_order');
  });

  it('AVOIDS the A4 bugs: no status_changed_at on the chain table; pulls it from leases with a created_at fallback', () => {
    // status_changed_at must only be read from the leases table, never the chain.
    expect(sql).not.toMatch(/lac\.status_changed_at/);
    expect(sql).not.toMatch(/lease_approval_chain\.status_changed_at/);
    // The executable pending_since assignment uses the leases subquery + a
    // created_at fallback. (The buggy A4 one-liner is quoted in the cautionary
    // comment by design, so we assert the real SET form rather than string-
    // absence.)
    expect(sql).toMatch(/SET pending_since = COALESCE\(\s*\(SELECT l\.status_changed_at FROM public\.leases l WHERE l\.id = lac\.lease_id\),\s*lac\.created_at\s*\)/);
  });

  it('documents the pivot + the operator burst note (provenance trustworthy)', () => {
    expect(sql).toMatch(/PIVOT FROM THE A4/i);
    expect(sql).toMatch(/OPERATOR NOTE/i);
    expect(sql).toMatch(/redeploy/i);
  });
});
