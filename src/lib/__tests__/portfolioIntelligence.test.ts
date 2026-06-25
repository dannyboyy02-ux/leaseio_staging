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
