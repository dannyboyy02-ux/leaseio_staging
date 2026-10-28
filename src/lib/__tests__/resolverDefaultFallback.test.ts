import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Move 1 (D1) — coverage & precedence. Static pins on the two artifacts the
// change touches (the edge fn can't be unit-run; the RPC is a migration file):
//   * resolve-approval-chain: the no-match outcome now merges into the legacy
//     default-approver branch (409 survives ONLY when there are also no default
//     approvers); the `ambiguous` outcome + its 409s are DELETED; matchPolicy()
//     gains an id-ASC total-order final tiebreak; a distinct fallback audit row
//     is written.
//   * preview_policy_resolution migration: ORDER BY gains `p.id ASC`; the
//     no-fallback branch probes workspace_roles and returns legacy_default; the
//     is_default_fallback branch is retained.

const repoRoot = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('#move1 — resolve-approval-chain default-approver fallback + deterministic tie', () => {
  const src = read('supabase/functions/resolve-approval-chain/index.ts');

  it('routes no-match through the legacy branch (guard covers BOTH kinds)', () => {
    expect(src).toMatch(
      /initialMatch\.kind === "no_policies"\s*\|\|\s*initialMatch\.kind === "no_match_no_fallback"/,
    );
  });

  it('keeps the 409 ONLY when the no-match workspace has no default approvers', () => {
    expect(src).toContain('isFallbackFromNoMatch && !hasDefaultApprovers');
    // the surviving 409 still carries the mapped reason
    const guard = sliceBetween(
      src,
      'if (isFallbackFromNoMatch && !hasDefaultApprovers) {',
      '// Distinct audit row',
    );
    expect(guard).toContain('reason: "no_match_no_fallback"');
    expect(guard).toContain('default_approvers_configured: false');
    expect(guard).toContain('409');
  });

  it('writes a distinct fallback-to-default audit activity', () => {
    expect(src).toContain('"chain_resolution_fallback_to_default"');
    expect(src).toContain('fallback_from: "no_policy_match"');
  });

  it('the `ambiguous` outcome and its 409s are gone', () => {
    expect(src).not.toContain('kind: "ambiguous"');
    expect(src).not.toContain('kind === "ambiguous"');
    expect(src).not.toContain('ambiguous_match');
  });

  it('matchPolicy() comparator has the id-ASC total-order final tiebreak', () => {
    const cmp = sliceBetween(src, '.sort((a, b) => {', '});');
    expect(cmp).toContain('b.priority - a.priority');
    expect(cmp).toContain('a.created_at.localeCompare(b.created_at)');
    expect(cmp).toContain('a.id.localeCompare(b.id)');
  });

  it('the matched outcome carries tieBrokenWith (deterministic pick attributed)', () => {
    expect(src).toContain('tieBrokenWith');
    expect(src).toContain('tie_broken: true');
  });
});

describe('#move1 — preview_policy_resolution migration (fallback + tie truthful)', () => {
  const dir = join(repoRoot, 'supabase', 'migrations');
  const file = readdirSync(dir)
    .filter((f) => f.includes('preview_policy_resolution_fallback_tie_truthful'))
    .sort()
    .pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');
  const fn = sliceBetween(
    sql,
    'CREATE OR REPLACE FUNCTION public.preview_policy_resolution',
    '$function$;',
  );

  it('ORDER BY includes the id-ASC total-order key', () => {
    expect(fn).toContain('ORDER BY p.priority DESC, p.created_at ASC, p.id ASC');
  });

  it('probes workspace_roles and returns legacy_default fallback', () => {
    expect(fn).toContain('FROM public.workspace_roles');
    expect(fn).toContain("role = 'manager_approver'");
    expect(fn).toContain("role = 'financial_approver'");
    expect(fn).toContain("'fallback', 'legacy_default'");
    expect(fn).toContain("'fallback', 'none'");
  });

  // NOTE: this block pins the HISTORICAL 20260718150000 artifact, which is
  // frozen (never edit an applied migration). At the time it was written the
  // is_default_fallback rung was still part of the ladder. Phase 0 (D-Q1)
  // superseded it: 20260719120100 CREATE OR REPLACEs the function without that
  // rung. The EFFECTIVE definition is pinned in approvalPhase0EngineTruth.test.ts,
  // which resolves the last migration to define the function rather than naming
  // one — see '#phase0 — effective preview_policy_resolution'.
  it('is superseded by the Phase 0 retirement of the is_default_fallback rung', () => {
    // historical file still carries it...
    expect(fn).toContain('p.is_default_fallback = true');
    // ...but a LATER migration must be the one that actually defines the function.
    const later = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        readFileSync(join(dir, f), 'utf8').includes(
          'CREATE OR REPLACE FUNCTION public.preview_policy_resolution',
        ),
      )
      .sort()
      .pop()!;
    expect(later.localeCompare(file)).toBeGreaterThan(0);
  });

  it('emits the structured tie signal', () => {
    expect(fn).toContain("'tie', jsonb_build_object('tied_policies'");
    expect(fn).toContain("'winner_reason', 'created_at'");
    expect(fn).toContain("'empty_chain', true");
  });
});
