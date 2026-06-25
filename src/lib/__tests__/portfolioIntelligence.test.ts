import { describe, it, expect } from 'vitest';
import {
  toPortfolioLease,
  computeKpis,
  remainingContractedRent,
  costByDepartment,
  costPerSqftByLocation,
  rentCommitmentForecast,
  UNASSIGNED,
  type PortfolioLease,
} from '@/lib/portfolioIntelligence';
import { getMonthlyRent } from '@/lib/leaseCalculations';

const ASOF = new Date(Date.UTC(2026, 0, 1)); // 2026-01-01

// Helper to build a normalized lease with sane defaults.
function lease(over: Partial<PortfolioLease>): PortfolioLease {
  return {
    id: over.id ?? 'id',
    propertyName: over.propertyName ?? 'Prop',
    department: over.department ?? UNASSIGNED,
    region: over.region ?? null,
    squareFootage: over.squareFootage ?? null,
    currentMonthlyRent: over.currentMonthlyRent ?? 0,
    baseMonthlyRent: over.baseMonthlyRent ?? over.currentMonthlyRent ?? 0,
    startDate: over.startDate ?? null,
    endDate: over.endDate ?? null,
    escalationRate: over.escalationRate ?? 0,
    escalationType: over.escalationType ?? null,
    renewalNoticeDeadline: over.renewalNoticeDeadline ?? null,
    escalationCapEndDate: over.escalationCapEndDate ?? null,
    ...over,
  };
}

// Canonical fixture (no escalation → exact integer math).
const FIXTURE: PortfolioLease[] = [
  lease({ id: 'L1', propertyName: 'HQ', department: 'Facilities', region: 'West', squareFootage: 10000, currentMonthlyRent: 10000, startDate: '2024-01-01', endDate: '2028-01-01' }),
  lease({ id: 'L2', propertyName: 'Lab', department: 'R&D', region: 'East', squareFootage: 5000, currentMonthlyRent: 10000, startDate: '2024-01-01', endDate: '2027-01-01' }),
  lease({ id: 'L3', propertyName: 'Annex', department: UNASSIGNED, region: 'West', squareFootage: null, currentMonthlyRent: 5000, startDate: '2025-01-01', endDate: '2030-01-01' }),
  lease({ id: 'L4', propertyName: 'Pending', department: 'Facilities', region: null, squareFootage: 2000, currentMonthlyRent: 0, startDate: '2025-01-01', endDate: '2029-01-01' }),
];

describe('toPortfolioLease', () => {
  it('normalizes department, area, escalation, region fallback', () => {
    const p = toPortfolioLease(
      {
        id: 'x', requesting_department: '   ', region: null, location: 'Metro',
        square_footage: 0, lease_start: '2025-01-01', lease_end: '2030-01-01',
        escalation_type: 'index', escalation_rate: 5, current_monthly_rent: 8000,
      },
      'Office One',
    );
    expect(p.department).toBe(UNASSIGNED);     // blank → Unassigned
    expect(p.region).toBe('Metro');            // location fallback
    expect(p.squareFootage).toBeNull();        // 0 → null
    expect(p.escalationRate).toBe(0);          // index → flat 0%
    expect(p.escalationType).toBe('index');
    expect(p.currentMonthlyRent).toBe(8000);
    expect(p.baseMonthlyRent).toBe(8000);
    expect(p.propertyName).toBe('Office One');
  });
});

describe('computeKpis', () => {
  const k = computeKpis(FIXTURE, ASOF);
  it('annual occupancy cost = Σ current rent × 12 (rented only)', () => {
    expect(k.annualOccupancyCost).toBe(300000); // (10000+10000+5000)*12
  });
  it('blended $/sqft = with-area annual ÷ with-area sqft', () => {
    expect(k.blendedCostPerSqft).toBe(16); // 240000 / 15000
  });
  it('total footprint = Σ sqft (all area leases incl. no-rent)', () => {
    expect(k.totalSquareFootage).toBe(17000); // 10000+5000+2000
  });
  it('market count = distinct non-null regions', () => {
    expect(k.marketCount).toBe(2); // West, East
  });
  it('WALT is rent-weighted years to expiry', () => {
    // (2*120000 + 1*120000 + 4*60000) / 300000 = 2.0
    expect(k.avgTermRemainingYears).toBeCloseTo(2, 6);
  });
  it('contracted-through = latest future expiry year', () => {
    expect(k.contractedThroughYear).toBe(2030);
  });
  it('counts partial-data exclusions', () => {
    expect(k.missingAreaCount).toBe(1); // L3 rented, no area
    expect(k.missingRentCount).toBe(1); // L4 no rent
    expect(k.leaseCount).toBe(4);
  });
  it('remaining commitment sums escalated remaining rent (NOT a PV)', () => {
    // L1 24mo*10000 + L2 12mo*10000 + L3 48mo*5000 = 600000
    expect(k.remainingCommitment).toBe(600000);
  });
});

describe('remainingContractedRent (escalation)', () => {
  it('applies annual escalation from lease start', () => {
    const l = lease({ baseMonthlyRent: 1000, currentMonthlyRent: 1000, escalationRate: 10, startDate: '2026-01-01', endDate: '2028-01-01' });
    // months 0-11 @1000, months 12-23 @1100 → 12000 + 13200
    expect(remainingContractedRent(l, ASOF)).toBeCloseTo(25200, 4);
  });
  it('is zero for an already-expired lease', () => {
    const l = lease({ baseMonthlyRent: 1000, currentMonthlyRent: 1000, startDate: '2020-01-01', endDate: '2025-01-01' });
    expect(remainingContractedRent(l, ASOF)).toBe(0);
  });
  it('books the current partial month for a near-expiry lease (H2 fix — was rounding to $0)', () => {
    // asOf 2026-01-01; lease ends 2026-01-20 (~19 days left) → still books the month.
    const l = lease({ baseMonthlyRent: 3000, currentMonthlyRent: 3000, startDate: '2024-01-01', endDate: '2026-01-20' });
    expect(remainingContractedRent(l, ASOF)).toBe(3000);
  });
});

describe('costByDepartment', () => {
  it('groups, weights by annual rent, sums to 100%', () => {
    const segs = costByDepartment(FIXTURE);
    const map = Object.fromEntries(segs.map((s) => [s.department, s]));
    expect(map['Facilities'].annualCost).toBe(120000); // L1 only (L4 no rent)
    expect(map['R&D'].annualCost).toBe(120000);
    expect(map[UNASSIGNED].annualCost).toBe(60000);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 6);
  });
  it('caps segments and rolls the tail into "Other"', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      lease({ id: `d${i}`, department: `Dept${i}`, currentMonthlyRent: 1000 * (8 - i), startDate: '2025-01-01', endDate: '2030-01-01' }),
    );
    const segs = costByDepartment(many, 6);
    expect(segs).toHaveLength(6);
    expect(segs[segs.length - 1].department).toBe('Other');
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 6);
  });
});

describe('costPerSqftByLocation', () => {
  const res = costPerSqftByLocation(FIXTURE);
  it('average reconciles with the blended KPI', () => {
    expect(res.averageRatePerSqft).toBe(16); // matches computeKpis blendedCostPerSqft
  });
  it('rows sorted desc, deltas vs average, excludes no-area leases', () => {
    expect(res.rows.map((r) => r.id)).toEqual(['L2', 'L1']); // 24/sqft then 12/sqft
    expect(res.rows[0].deltaVsAvg).toBeCloseTo(0.5, 6); // (24-16)/16
    expect(res.rows[0].position).toBe('above');
    expect(res.rows[1].position).toBe('below');
    expect(res.excludedCount).toBe(1); // L3 rented but no area
  });
});

describe('rentCommitmentForecast', () => {
  const f = rentCommitmentForecast(FIXTURE, ASOF, 5);
  it('produces 5 year buckets + a tail', () => {
    expect(f.map((b) => b.label)).toEqual(['2026', '2027', '2028', '2029', '2030', '2031+']);
    expect(f[f.length - 1].isTail).toBe(true);
  });
  it('shows the re-leasing cliff: contracted declines, uncontracted grows', () => {
    expect(f[0].contracted).toBe(300000); // all active in 2026
    expect(f[0].uncontracted).toBe(0);
    expect(f[1].contracted).toBe(180000); // L2 rolled off in 2027
    expect(f[1].uncontracted).toBe(120000);
    expect(f[0].contracted).toBeGreaterThan(f[2].contracted);
    expect(f[5].contracted).toBe(0); // nothing under contract in the tail
  });
});

// ===========================================================================
// Gap-closing coverage (added by lease-test-author) — derivation-layer edge
// cases + the two load-bearing reconciliation invariants. Each test pins the
// CURRENT behavior so a silent regression fails cleanly.
// ===========================================================================

describe('empty portfolio', () => {
  it('every KPI degrades to a safe zero/null (no NaN, no throw)', () => {
    const k = computeKpis([], ASOF);
    expect(k.leaseCount).toBe(0);
    expect(k.annualOccupancyCost).toBe(0);
    expect(k.remainingCommitment).toBe(0);
    expect(k.contractedThroughYear).toBeNull();
    expect(k.blendedCostPerSqft).toBeNull();
    expect(k.totalSquareFootage).toBe(0);
    expect(k.marketCount).toBe(0);
    expect(k.avgTermRemainingYears).toBe(0); // weightTotal 0 → guarded, not NaN
    expect(k.missingAreaCount).toBe(0);
    expect(k.missingRentCount).toBe(0);
  });
  it('derived collections are empty, not undefined', () => {
    expect(costByDepartment([])).toEqual([]);
    const loc = costPerSqftByLocation([]);
    expect(loc.rows).toEqual([]);
    expect(loc.averageRatePerSqft).toBeNull();
    expect(loc.excludedCount).toBe(0);
  });
  it('forecast still emits the full horizon + tail with zeroed bars', () => {
    const f = rentCommitmentForecast([], ASOF, 5);
    expect(f.map((b) => b.label)).toEqual(['2026', '2027', '2028', '2029', '2030', '2031+']);
    expect(f.every((b) => b.contracted === 0 && b.uncontracted === 0)).toBe(true);
  });
});

describe('lease with no end date (open-ended term)', () => {
  const noEnd = lease({ id: 'noend', currentMonthlyRent: 1000, baseMonthlyRent: 1000, startDate: '2024-01-01', endDate: null });

  it('contributes $0 to Remaining Commitment (no knowable horizon)', () => {
    expect(remainingContractedRent(noEnd, ASOF)).toBe(0);
  });

  it('contributes 0 to WALT/commitment, no contracted-through year, and is counted as missing-dates', () => {
    const k = computeKpis([noEnd], ASOF);
    expect(k.avgTermRemainingYears).toBe(0);
    expect(k.contractedThroughYear).toBeNull();
    expect(k.remainingCommitment).toBe(0);
    expect(k.missingEndDateCount).toBe(1);
  });

  it(
    // H3 fix: a null end date is "unknown horizon" → EXCLUDED from the forecast,
    // matching the commitment KPI + WALT. No bar treats it as contracted-forever.
    'is EXCLUDED from the forecast too (reconciled with the KPI)',
    () => {
      const f = rentCommitmentForecast([noEnd], ASOF, 5);
      expect(f.every((b) => b.contracted === 0)).toBe(true);
      expect(f.every((b) => b.uncontracted === 0)).toBe(true);
      expect(f[f.length - 1].isTail).toBe(true);
    },
  );
});

describe('all-leases-missing-area ($/sqft null path)', () => {
  const noArea = [
    lease({ id: 'a', squareFootage: null, currentMonthlyRent: 1000, startDate: '2025-01-01', endDate: '2028-01-01' }),
    lease({ id: 'b', squareFootage: null, currentMonthlyRent: 2000, startDate: '2025-01-01', endDate: '2028-01-01' }),
  ];
  it('blended KPI is null (no divide-by-zero) but cost still computes', () => {
    const k = computeKpis(noArea, ASOF);
    expect(k.blendedCostPerSqft).toBeNull();
    expect(k.totalSquareFootage).toBe(0);
    expect(k.annualOccupancyCost).toBe(36000); // cost is independent of area
    expect(k.missingAreaCount).toBe(2);
  });
  it('location view returns no rows, null average, and counts all as excluded', () => {
    const loc = costPerSqftByLocation(noArea);
    expect(loc.rows).toEqual([]);
    expect(loc.averageRatePerSqft).toBeNull();
    expect(loc.excludedCount).toBe(2);
  });
});

describe('zero-rent leases', () => {
  const z = lease({ id: 'z', squareFootage: 1000, currentMonthlyRent: 0, startDate: '2025-01-01', endDate: '2028-01-01' });
  it('are excluded from cost, $/sqft, dept rollup, WALT — but counted as missing rent', () => {
    const k = computeKpis([z], ASOF);
    expect(k.annualOccupancyCost).toBe(0);
    expect(k.blendedCostPerSqft).toBeNull(); // hasRent filter drops it from area math
    expect(k.missingRentCount).toBe(1);
    expect(k.missingAreaCount).toBe(0);      // it HAS area; missingArea only counts rented-no-area
    expect(k.avgTermRemainingYears).toBe(0);
    expect(k.totalSquareFootage).toBe(1000); // footprint still counts (hasArea only)
    expect(costByDepartment([z])).toEqual([]);
    expect(costPerSqftByLocation([z]).rows).toEqual([]);
    expect(costPerSqftByLocation([z]).excludedCount).toBe(0); // excludedCount is rented-no-area, not zero-rent
  });
  it('zero-rent lease contributes nothing to the forecast', () => {
    const f = rentCommitmentForecast([z], ASOF, 5);
    expect(f.every((b) => b.contracted === 0 && b.uncontracted === 0)).toBe(true);
  });
});

describe('index lease (escalationRate forced to 0 by the mapper)', () => {
  it('projects flat — no escalation applied to forward commitment', () => {
    const idx = toPortfolioLease(
      { id: 'i', square_footage: 1000, current_monthly_rent: 1000, lease_start: '2026-01-01', lease_end: '2029-01-01', escalation_type: 'index', escalation_rate: 8 },
      'Indexed',
    );
    expect(idx.escalationRate).toBe(0);
    expect(idx.escalationType).toBe('index');
    // 36 months flat @ 1000 = 36000 (no compounding despite the 8% source rate)
    expect(remainingContractedRent(idx, ASOF)).toBe(36000);
  });
});

describe('negative / clamped escalation inputs', () => {
  it('negative escalation deflates rent forward (math is symmetric, not clamped to flat)', () => {
    const l = lease({ baseMonthlyRent: 1000, currentMonthlyRent: 1000, escalationRate: -10, startDate: '2026-01-01', endDate: '2028-01-01' });
    // yr0: 12*1000=12000, yr1: 12*900=10800 → 22800
    expect(remainingContractedRent(l, ASOF)).toBe(22800);
  });
  it('escalatedMonthly never applies a NEGATIVE year index (pre-start months held at base)', () => {
    // start AFTER asOf — elapsed months are negative; yearIndex clamps at 0 so base is never inflated below itself
    const l = lease({ baseMonthlyRent: 1000, currentMonthlyRent: 1000, escalationRate: 10, startDate: '2026-06-01', endDate: '2027-06-01' });
    // asOf 2026-01-01: firstMonth from start is negative → ceil keeps it; the loop still escalates from the start anchor
    const v = remainingContractedRent(l, ASOF);
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('forecast tail-bucket boundaries', () => {
  it('a lease ending EXACTLY at the tail year start is contracted up to it, then rolls off in the tail', () => {
    // tailYear = 2031; lease ends 2031-01-01
    const l = lease({ id: 't', currentMonthlyRent: 1000, baseMonthlyRent: 1000, startDate: '2024-01-01', endDate: '2031-01-01' });
    const f = rentCommitmentForecast([l], ASOF, 5);
    expect(f.slice(0, 5).every((b) => b.contracted === 12000)).toBe(true);
    expect(f[5].isTail).toBe(true);
    expect(f[5].contracted).toBe(0);      // 2031-01-01 is NOT < 2031 cursor months → rolled off
    expect(f[5].uncontracted).toBe(12000);
  });
  it('a lease ending AFTER the horizon folds its contracted rent into the tail bucket', () => {
    const l = lease({ id: 'p', currentMonthlyRent: 1000, baseMonthlyRent: 1000, startDate: '2024-01-01', endDate: '2035-01-01' });
    const f = rentCommitmentForecast([l], ASOF, 5);
    expect(f[5].isTail).toBe(true);
    expect(f[5].contracted).toBe(12000);  // full tail-year of contract folded in
    expect(f[5].uncontracted).toBe(0);
  });
});

describe('costByDepartment tie + Other rollup', () => {
  it('preserves a stable order for equal-cost departments (JS sort is stable)', () => {
    const leases = [
      lease({ id: 'a', department: 'Alpha', currentMonthlyRent: 1000, startDate: '2025-01-01', endDate: '2030-01-01' }),
      lease({ id: 'b', department: 'Beta', currentMonthlyRent: 1000, startDate: '2025-01-01', endDate: '2030-01-01' }),
      lease({ id: 'c', department: 'Gamma', currentMonthlyRent: 1000, startDate: '2025-01-01', endDate: '2030-01-01' }),
    ];
    expect(costByDepartment(leases).map((s) => s.department)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
  it('rolls equal-cost tail departments into Other when over cap, summing them', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      lease({ id: `d${i}`, department: `D${i}`, currentMonthlyRent: 1000, startDate: '2025-01-01', endDate: '2030-01-01' }),
    );
    const segs = costByDepartment(many, 6);
    expect(segs).toHaveLength(6);
    expect(segs.slice(0, 5).map((s) => s.department)).toEqual(['D0', 'D1', 'D2', 'D3', 'D4']);
    expect(segs[5].department).toBe('Other');
    expect(segs[5].annualCost).toBe(36000); // D5+D6+D7 = 3 × 12000
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 6);
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING INVARIANTS — these MUST hold or the UI shows two contradictory
// numbers for the same thing. The file header promises both reconciliations.
// ---------------------------------------------------------------------------
describe('reconciliation invariants', () => {
  it('blended-$/sqft KPI === the cost-per-sqft card average (same with-area set)', () => {
    const k = computeKpis(FIXTURE, ASOF);
    const loc = costPerSqftByLocation(FIXTURE);
    expect(k.blendedCostPerSqft).toBe(loc.averageRatePerSqft);
  });

  it('invariant holds on a randomized portfolio (not just the canonical fixture)', () => {
    const rnd = Array.from({ length: 9 }, (_, i) =>
      lease({
        id: `r${i}`,
        squareFootage: i % 3 === 0 ? null : 1000 + i * 137, // some without area
        currentMonthlyRent: i % 4 === 0 ? 0 : 500 + i * 311, // some without rent
        startDate: '2025-01-01',
        endDate: '2030-01-01',
      }),
    );
    const k = computeKpis(rnd, ASOF);
    const loc = costPerSqftByLocation(rnd);
    expect(k.blendedCostPerSqft).toBe(loc.averageRatePerSqft);
  });

  it('AnnualOccupancyCost === Σ getMonthlyRent(row) × 12 (the Dashboard/Leases resolver)', () => {
    // Drive the same raw rows through BOTH the page resolver and the mapper so a
    // resolver drift (e.g. a schedule-aware step the KPI silently misses) fails here.
    const rawRows = [
      { id: 'a', current_monthly_rent: 8000, square_footage: 1000, lease_start: '2025-01-01', lease_end: '2030-01-01' },
      { id: 'b', monthly_payment: 4200, square_footage: 500, lease_start: '2025-01-01', lease_end: '2030-01-01' },
      { id: 'c', executed_monthly_payment: 9999, lease_start: '2025-01-01', lease_end: '2030-01-01' },
      { id: 'd', current_monthly_rent: 0, lease_start: '2025-01-01', lease_end: '2030-01-01' }, // no rent → excluded both sides
    ];
    const expected = rawRows.reduce((acc, r) => acc + getMonthlyRent(r) * 12, 0);
    const mapped = rawRows.map((r) => toPortfolioLease(r, 'P'));
    expect(computeKpis(mapped, ASOF).annualOccupancyCost).toBe(expected);
  });
});
