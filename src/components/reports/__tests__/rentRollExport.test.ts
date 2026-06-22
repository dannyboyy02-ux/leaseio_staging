import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static regression guard for the rent-roll export query + rent resolution.
// Converts audit findings B4 + #126 into permanent contracts.
//
//   - B4: the rent-roll query must filter on the canonical IN-FORCE
//     lifecycle_status set (executed / active / fully_executed) and archived=false,
//     NOT the legacy `status` vocabulary (['Ready','final','review']) which
//     silently dropped valid active/executed leases from the roll.
//   - #126: monthly rent must resolve through getBaseMonthlyRent (the static
//     executed → current → base chain), NOT a bare `current_monthly_rent || 0`,
//     which exported an executed lease whose rent lives in
//     executed_monthly_payment as $0 — understating the roll handed to auditors.
//
// Why static, not a mount test: RentRollExport's CSV logic is inline in the
// component, which pulls in radix/lucide/contexts (heavy to mount), and the two
// load-bearing contracts are query-shape + call-site facts a source assertion
// pins directly. getBaseMonthlyRent's own behavior is unit-tested in
// leaseCalculations.test.ts — this only guards the RentRoll wiring to it.
//
// Static-source idiom (see documentLifecyclePolish.test.ts): narrow the search
// window to the relevant block before asserting, so a match elsewhere in the
// file can't produce a false positive (CLAUDE.md full-file-toContain caveat).

const root = process.cwd();
const source = readFileSync(
  join(root, 'src/components/reports/RentRollExport.tsx'),
  'utf8',
);

/** Slice `source` from the first occurrence of `start` to the next occurrence of `end`. */
function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected source to contain "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

describe('RentRollExport — query lifecycle filter (audit B4)', () => {
  // The leases query, anchored on the builder start to the ordering tail.
  const query = sliceBetween(source, "from('leases')", "order('lease_end'");

  it('filters on the canonical in-force lifecycle_status set, not the legacy status vocabulary', () => {
    expect(query).toContain(
      ".in('lifecycle_status', ['executed', 'active', 'fully_executed'])",
    );
    // The exact regression we are guarding against: the legacy `status` filter.
    expect(query).not.toContain(".in('status'");
    expect(query).not.toContain("'Ready'");
    expect(query).not.toContain("'final'");
    expect(query).not.toContain("'review'");
  });

  it('scopes to the active workspace and excludes archived leases', () => {
    expect(query).toContain(".eq('workspace_id', workspace.id)");
    expect(query).toContain(".eq('archived', false)");
  });
});

describe('RentRollExport — rent resolution (audit #126)', () => {
  it('imports the canonical static resolver getBaseMonthlyRent', () => {
    // getBaseMonthlyRent (not getMonthlyRent) pins the STATIC chain, matching
    // Portfolio and staying immune to the query ever embedding rent_schedules.
    expect(source).toContain(
      "import { getBaseMonthlyRent } from '@/lib/leaseCalculations'",
    );
  });

  it('totals and per-row rent both resolve through getBaseMonthlyRent, not current_monthly_rent || 0', () => {
    // Portfolio total.
    expect(source).toContain('leases.reduce((sum, l) => sum + getBaseMonthlyRent(l), 0)');
    // Per-row monthly figure (drives both Monthly Rent and Annual Rent columns).
    const row = sliceBetween(source, 'const rows = leases.map', 'return [');
    expect(row).toContain('const monthly = getBaseMonthlyRent(lease)');
    // The exact understatement bug we are guarding against must NOT return.
    expect(source).not.toContain('current_monthly_rent || 0');
  });
});
