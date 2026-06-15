import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// KNOWN_ISSUES #26 + #25 regression guard.
//
// Migration 20260614000000_smoke_check_vault_restrictive_and_name_alignment.sql
// CREATE OR REPLACEs audit_rls_smoke_check() so that:
//   (#26) the five `*_only_one_*_policy` content checks filter to
//         permissive = 'PERMISSIVE' — a RESTRICTIVE policy can only narrow
//         access (never grant it), so the legitimate Vault V1 "live workspace
//         required for ..." RESTRICTIVE policies coexist without tripping the
//         duplicate-grant tripwire; an unexpected PERMISSIVE grant (incl. FOR
//         ALL via `cmd IN (...,'ALL')`) still trips.
//   (#25) governance_unlock_policy / governance_change_set_policy assert the
//         LIVE SELECT policy names ("workspace members can view ...") rather
//         than the never-applied "workspace access can view ..." names.
//
// Why this guards live behavior: the smoke script (scripts/smoke-audit-hardening
// .mjs) fails CI on ANY key !== true. Before this migration the live function
// returned 6 false keys (verified 2026-06-14), which would fail CI the moment
// the SUPABASE_* secrets are configured. This test pins the corrected
// definition so a future edit can't silently regress it (re-introducing the
// false keys) or silently DROP a check (which would make the script pass green
// while a real guard was gone).

const ROOT = join(__dirname, '../../..');

// The latest migration that (re)defines the smoke-check function. Found by
// content marker + sort, mirroring the clientActivityAllowlist test pattern, so
// the guard follows the function wherever its newest definition lives.
function latestSmokeMigration(): { file: string; sql: string } {
  const dir = join(ROOT, 'supabase/migrations');
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      readFileSync(join(dir, f), 'utf8').includes(
        'CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()',
      ),
    )
    .sort();
  expect(
    candidates.length,
    'no migration defines audit_rls_smoke_check()',
  ).toBeGreaterThan(0);
  const file = candidates[candidates.length - 1];
  return { file, sql: readFileSync(join(dir, file), 'utf8') };
}

// The 26 jsonb keys the function must emit. Silent removal of any one would make
// the smoke script pass green with a missing guard — this list is the contract.
const EXPECTED_KEYS = [
  'is_workspace_member_function',
  'workspace_members_policy',
  'workspace_roles_policy',
  'leases_select_policy',
  'summary_views_policy',
  'executed_legacy_storage_policies_removed',
  'executed_scoped_storage_policy',
  'strict_model_lock_trigger',
  'strict_model_lock_function',
  'workspace_entitlement_guard',
  'workspace_subscription_columns',
  'governance_unlock_policy',
  'governance_change_set_policy',
  'governance_audit_append_guard',
  'governance_change_set_draft_only_edit',
  'governance_audit_no_member_insert',
  'change_set_no_unrestricted_update',
  'governance_audit_only_one_insert_policy',
  'change_set_only_one_update_policy',
  'change_set_items_draft_only_insert',
  'change_set_items_draft_only_update',
  'change_set_items_draft_only_delete',
  'change_set_items_only_one_insert_policy',
  'change_set_items_only_one_update_policy',
  'change_set_items_only_one_delete_policy',
  'change_set_field_tampering_trigger',
] as const;

// The five duplicate-grant tripwires that MUST carry the permissive filter.
const ONLY_ONE_KEYS = [
  'governance_audit_only_one_insert_policy',
  'change_set_only_one_update_policy',
  'change_set_items_only_one_insert_policy',
  'change_set_items_only_one_update_policy',
  'change_set_items_only_one_delete_policy',
] as const;

describe('audit_rls_smoke_check Vault-restrictive carve-out + name alignment (#26/#25)', () => {
  const { file, sql } = latestSmokeMigration();

  it('emits all 26 governance keys (guards against silent check removal)', () => {
    const missing = EXPECTED_KEYS.filter((k) => !sql.includes(`'${k}'`));
    expect(missing, `${file} is missing smoke-check keys`).toEqual([]);
  });

  it('every *_only_one_*_policy check filters to permissive = \'PERMISSIVE\' (#26)', () => {
    // For each tripwire, slice the block from its key to its closing `)` and
    // assert the permissive filter is inside it — so the carve-out is on the
    // RIGHT check, not merely present somewhere in the file.
    for (const key of ONLY_ONE_KEYS) {
      const start = sql.indexOf(`'${key}'`);
      expect(start, `${file}: ${key} not found`).toBeGreaterThanOrEqual(0);
      const end = sql.indexOf('),', start);
      const block = sql.slice(start, end > start ? end : start + 400);
      expect(
        block.includes("permissive = 'PERMISSIVE'"),
        `${file}: ${key} must filter to permissive='PERMISSIVE' so Vault RESTRICTIVE policies don't trip it (#26)`,
      ).toBe(true);
      // The FOR ALL blind-spot closer must remain alongside it.
      expect(
        block.includes("'ALL'"),
        `${file}: ${key} must retain cmd IN (...,'ALL') (FOR ALL bypass closer)`,
      ).toBe(true);
    }
  });

  it('governance SELECT-policy checks assert the LIVE names (#25)', () => {
    // Strip `-- ...` line comments so explanatory text (which legitimately
    // names the old policy) doesn't trip the negative assertion below.
    const code = sql.replace(/--[^\n]*/g, '');
    expect(
      code.includes("'workspace members can view unlock requests'"),
      `${file}: governance_unlock_policy must assert the live name (#25)`,
    ).toBe(true);
    expect(
      code.includes("'workspace members can view change sets'"),
      `${file}: governance_change_set_policy must assert the live name (#25)`,
    ).toBe(true);
    // The never-applied 'workspace access can view ...' names must be gone from
    // the executable SQL (comments may still reference them for context).
    expect(
      code.includes("'workspace access can view"),
      `${file}: the never-applied 'workspace access can view ...' names must not return`,
    ).toBe(false);
  });

  it('preserves SECURITY DEFINER + pinned search_path (privilege-safety invariants)', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_catalog');
  });
});
