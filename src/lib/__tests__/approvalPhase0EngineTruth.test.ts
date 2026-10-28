import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Approval Rules redesign — PHASE 0 (engine truth). Static pins on the three
// artifacts that cannot be unit-run (two migration files + a Deno edge fn):
//
//   D-Q1  `is_default_fallback` is retired as a ROUTING mechanism, in the
//         ENGINE and in the preview RPC — not just as a UI badge. A data
//         migration converts each flagged rule into an ordinary rule pinned
//         last and clears the flag. The COLUMN survives (authored data is not
//         destroyed); it is simply inert.
//
//   IN-FLIGHT SAFETY
//         `approval_policies_version_increment` no longer watches `priority`.
//         version stamps a rule's ROUTING DEFINITION; a rule's POSITION is not
//         part of that definition. Without this, every reorder bumps version,
//         breaks resolve-approval-chain's `snapshot.policy_version` short-
//         circuit, and fabricates lease_reroute_events rows for leases whose
//         steps did not change.
//
// These are drift guards on the repo, not on the live DB — the live layer is
// the post-apply verification described in the migration headers.

const repoRoot = join(__dirname, '..', '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

function migration(fragment: string): { name: string; sql: string } {
  const name = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f.includes(fragment))
    .sort()
    .pop();
  expect(name, `expected a migration matching "${fragment}"`).toBeTruthy();
  return { name: name!, sql: readFileSync(join(migrationsDir, name!), 'utf8') };
}

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

/**
 * The EFFECTIVE preview_policy_resolution definition: migrations replay in
 * filename order, so the last file that CREATE OR REPLACEs the function wins.
 * Resolving it this way (rather than naming a file) means a future migration
 * that regresses Move 1 or Move 2 fails this suite instead of sliding past it.
 */
function effectivePreviewRpc(): { name: string; body: string } {
  const marker = 'CREATE OR REPLACE FUNCTION public.preview_policy_resolution';
  const name = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(migrationsDir, f), 'utf8').includes(marker))
    .sort()
    .pop();
  expect(name, 'expected at least one migration defining preview_policy_resolution').toBeTruthy();
  const sql = readFileSync(join(migrationsDir, name!), 'utf8');
  return { name: name!, body: sliceBetween(sql, marker, '$function$;') };
}

describe('#phase0 — approval_policies_version_increment ignores priority', () => {
  const { name, sql } = migration('approval_policies_version_ignores_priority');
  const when = sliceBetween(sql, 'CREATE OR REPLACE TRIGGER approval_policies_version_increment', 'EXECUTE FUNCTION');

  it('the WHEN clause no longer compares priority', () => {
    expect(when).not.toMatch(/priority/i);
  });

  it('every other column comparison from baseline_schema.sql:3043 is preserved exactly', () => {
    for (const col of [
      'name',
      'match_asset_types',
      'match_departments',
      'match_min_annual_cost',
      'match_max_annual_cost',
      'match_regions',
      'match_lease_types',
      'separation_of_duties_override',
    ]) {
      expect(when, `missing comparison for ${col}`).toContain(
        `(OLD.${col} IS DISTINCT FROM NEW.${col})`,
      );
    }
    // Exactly 8 disjuncts — one per column above, priority removed, nothing added.
    expect(when.match(/IS DISTINCT FROM/g)?.length).toBe(8);
  });

  it('still runs BEFORE UPDATE FOR EACH ROW against increment_policy_version()', () => {
    expect(sql).toContain('BEFORE UPDATE ON public.approval_policies');
    expect(sql).toContain('FOR EACH ROW');
    expect(sql).toContain('EXECUTE FUNCTION public.increment_policy_version()');
  });

  it('is idempotent (CREATE OR REPLACE TRIGGER)', () => {
    expect(sql).toContain('CREATE OR REPLACE TRIGGER');
  });

  it('applies BEFORE the is_default_fallback retirement (which writes priority)', () => {
    const retirement = migration('retire_is_default_fallback_routing');
    expect(name.localeCompare(retirement.name)).toBeLessThan(0);
  });
});

describe('#phase0 — is_default_fallback retirement (data migration)', () => {
  const { sql } = migration('retire_is_default_fallback_routing');

  it('clears the flag on every previously-flagged rule', () => {
    expect(sql).toContain('WHERE is_default_fallback = true');
    expect(sql).toContain('is_default_fallback = false');
  });

  it('pins the converted rule last by lowering its priority', () => {
    expect(sql).toContain('SET priority = v_new');
    // "Last" in the engine's total order == strictly the lowest priority.
    expect(sql).toContain('MIN(p.priority)');
    // Never leaves a non-positive priority behind (approvalPolicyValidation
    // requires a positive integer, so 0 would make the rule unsavable).
    expect(sql).toContain('GREATEST(1, v_min_other - 100)');
  });

  it('writes one attributable workspace_activity_log row per conversion', () => {
    expect(sql).toContain('INSERT INTO public.workspace_activity_log');
    expect(sql).toContain("'approval_policy_fallback_retired'");
  });

  it('does NOT drop the column or its partial unique index (data is preserved)', () => {
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+INDEX/i);
    expect(sql).toContain('COMMENT ON COLUMN public.approval_policies.is_default_fallback');
  });

  it('touches no in-flight chain table', () => {
    for (const t of ['lease_approval_chain', 'approval_chain_steps', 'lease_reroute_events']) {
      // approval_chain_steps is READ by the preview RPC in the same file; assert
      // only that nothing WRITES to any chain table.
      expect(sql).not.toMatch(new RegExp(`(UPDATE|INSERT INTO|DELETE FROM)\\s+(public\\.)?${t}`, 'i'));
    }
  });
});

describe('#phase0 — effective preview_policy_resolution', () => {
  const { body } = effectivePreviewRpc();

  it('the is_default_fallback rung is gone from the precedence ladder', () => {
    // Strip `--` comments: the body carries an explanatory note naming the
    // retired rung, and the pin is about executable SQL, not prose.
    const code = body
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(code).not.toContain('is_default_fallback');
  });

  it('keeps the exact 6-param signature and SECURITY DEFINER hardening', () => {
    for (const p of [
      'p_workspace_id uuid',
      'p_asset_type text',
      'p_department text',
      'p_annual_cost numeric',
      'p_region text',
      'p_lease_type text',
    ]) {
      expect(body).toContain(p);
    }
    expect(body).toContain('RETURNS jsonb');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public'");
  });

  it('keeps the membership gate', () => {
    expect(body).toContain("RAISE EXCEPTION 'Forbidden'");
    expect(body).toContain('FROM public.workspace_members');
  });

  it('retains Move 1 — total order, tie, empty_chain, legacy fallback ladder', () => {
    expect(body).toContain('ORDER BY p.priority DESC, p.created_at ASC, p.id ASC');
    expect(body).toContain("'tie', jsonb_build_object('tied_policies'");
    expect(body).toContain("'winner_reason', 'created_at'");
    expect(body).toContain("'empty_chain', true");
    expect(body).toContain('FROM public.workspace_roles');
    expect(body).toContain("role = 'manager_approver'");
    expect(body).toContain("role = 'financial_approver'");
    expect(body).toContain("'fallback', 'legacy_default'");
    expect(body).toContain("'fallback', 'none'");
    expect(body).toContain('has_manager_approver');
    expect(body).toContain('has_financial_approver');
  });

  it('retains Move 2 — signator inheritance from concept steps', () => {
    expect(body).toContain("s.stage = 'signator'");
    expect(body).toContain("'stage', 'signator'");
    expect(body).toContain("s.stage = 'concept'");
    expect(body).toContain("'inherited', true");
    expect(body).toContain("'signator_inherited', v_signator_inherited");
  });

  it('retains the engine-lockstep canonical asset matcher and its empty guard', () => {
    expect(body).toContain('public.canonical_asset_type(p_asset_type)');
    expect(body).toContain("public.canonical_asset_type(p_asset_type) <> ''");
    expect(body).toContain('cardinality(p.match_asset_types) = 0');
  });
});

describe('#phase0 — resolve-approval-chain no longer routes via is_default_fallback', () => {
  const src = read('supabase/functions/resolve-approval-chain/index.ts');

  it('the fallback lookup is deleted from matchPolicy()', () => {
    expect(src).not.toContain('allPolicies.find((p) => p.is_default_fallback === true)');
    expect(src).toContain('const chosen = matched[0];');
  });

  it('the column is not even selected (it can no longer influence routing)', () => {
    const select = sliceBetween(src, '.from("approval_policies")', '.eq("workspace_id"');
    expect(select).not.toContain('is_default_fallback');
    // the routing-relevant columns are all still selected
    expect(select).toContain('priority');
    expect(select).toContain('is_active');
    expect(select).toContain('created_at');
  });

  it('no reference to is_default_fallback survives outside explanatory comments', () => {
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('is_default_fallback');
  });

  it('the chain_resolved audit shape is unchanged (used_default_fallback still emitted)', () => {
    expect(src).toContain('used_default_fallback: false');
    // ...and the dead plumbing that fed it is gone
    expect(src).not.toContain('usedFallback:');
    expect(src).not.toContain('.usedFallback');
  });

  it('still filters candidate policies on is_active (the bug the old branch bypassed)', () => {
    expect(src).toContain('.eq("is_active", true)');
  });
});
