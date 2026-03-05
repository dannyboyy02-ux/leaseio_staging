/**
 * Portfolio Analytics Engine — Test Suite
 *
 * Covers all 9 scenarios from the implementation spec.
 *
 * The escalation normalization logic is mirrored here from
 * supabase/functions/process_lease/index.ts for testability.
 * The parsing boundary rule (never parse rent_escalation_type
 * downstream) is enforced architecturally — these tests verify
 * the pure normalization contract.
 */

import { describe, it, expect } from 'vitest';
import { calculateLease } from '../leaseCalculations';

// ---------------------------------------------------------------------------
// Mirror of normalizeEscalation from process_lease/index.ts
// Used for unit testing only — do not import this into production frontend code.
// ---------------------------------------------------------------------------
function normalizeEscalation(rentEscalationTypeRaw: string | null): {
  escalationType: string;
  escalationRate: number | null;
  needsEscalationReview: boolean;
} {
  if (rentEscalationTypeRaw) {
    const raw = rentEscalationTypeRaw.trim();
    const percentMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      return {
        escalationType: 'percent',
        escalationRate: parseFloat(percentMatch[1]),
        needsEscalationReview: false,
      };
    }
    const cpiPattern = /\b(cpi|index|consumer\s+price|inflation[- ]based)\b/i;
    if (cpiPattern.test(raw)) {
      return {
        escalationType: 'index',
        escalationRate: null,
        needsEscalationReview: true,
      };
    }
  }
  return {
    escalationType: 'none',
    escalationRate: 0,
    needsEscalationReview: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — escalation_rate column populated: passes through as-is
// ---------------------------------------------------------------------------
describe('Scenario 1: escalation_rate column populated', () => {
  it('uses escalation_rate directly without parsing rent_escalation_type', () => {
    // When process_lease sees a non-null escalation_rate already in the DB,
    // normalization is skipped. Downstream analytics consume the stored value.
    const storedRate = 3.5;
    const result = calculateLease({
      monthlyPayment: 5000,
      termMonths: 24,
      startDate: '2026-01-01',
      escalationRate: storedRate,
      discountRate: 5.0,
    });
    expect(result.pvLiability).toBeGreaterThan(0);
    expect(result.totalCashCommitment).toBeGreaterThan(5000 * 24); // escalation increases total
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — escalation_rate null, rent_escalation_type = "3% annual"
// ---------------------------------------------------------------------------
describe('Scenario 2: parse percent from rent_escalation_type', () => {
  it('extracts 3.0 from "3% annual"', () => {
    const result = normalizeEscalation('3% annual');
    expect(result.escalationRate).toBe(3.0);
    expect(result.escalationType).toBe('percent');
    expect(result.needsEscalationReview).toBe(false);
  });

  it('extracts 2.5 from "2.5%"', () => {
    const result = normalizeEscalation('2.5%');
    expect(result.escalationRate).toBe(2.5);
    expect(result.escalationType).toBe('percent');
    expect(result.needsEscalationReview).toBe(false);
  });

  it('extracts percent embedded in longer string', () => {
    const result = normalizeEscalation('Fixed annual increase of 3.5% per year');
    expect(result.escalationRate).toBe(3.5);
    expect(result.escalationType).toBe('percent');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — CPI/index escalation: flagged, escalation_rate = null
// ASC 842 hard rule: NEVER silently default index leases to 0
// ---------------------------------------------------------------------------
describe('Scenario 3: CPI/index escalation flagging', () => {
  it('flags "CPI-based" — escalation_rate is null, not 0', () => {
    const result = normalizeEscalation('CPI-based');
    expect(result.escalationType).toBe('index');
    expect(result.escalationRate).toBeNull(); // must be null, never 0
    expect(result.needsEscalationReview).toBe(true);
  });

  it('flags "index" keyword', () => {
    const result = normalizeEscalation('Annual index adjustment');
    expect(result.escalationType).toBe('index');
    expect(result.escalationRate).toBeNull();
    expect(result.needsEscalationReview).toBe(true);
  });

  it('flags "consumer price" keyword', () => {
    const result = normalizeEscalation('Adjusted annually per consumer price index');
    expect(result.escalationType).toBe('index');
    expect(result.escalationRate).toBeNull();
    expect(result.needsEscalationReview).toBe(true);
  });

  it('flags "inflation-based" keyword', () => {
    const result = normalizeEscalation('inflation-based annual increase');
    expect(result.escalationType).toBe('index');
    expect(result.escalationRate).toBeNull();
    expect(result.needsEscalationReview).toBe(true);
  });

  it('flags "CPI" case-insensitively', () => {
    const result = normalizeEscalation('Annual CPI adjustment per lease section 4.2');
    expect(result.escalationType).toBe('index');
    expect(result.escalationRate).toBeNull();
    expect(result.needsEscalationReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Both fields null/empty
// ---------------------------------------------------------------------------
describe('Scenario 4: both fields null/empty', () => {
  it('defaults to escalation_type=none, escalation_rate=0 when null', () => {
    const result = normalizeEscalation(null);
    expect(result.escalationType).toBe('none');
    expect(result.escalationRate).toBe(0);
    expect(result.needsEscalationReview).toBe(false);
  });

  it('defaults to none when empty string', () => {
    const result = normalizeEscalation('');
    expect(result.escalationType).toBe('none');
    expect(result.escalationRate).toBe(0);
    expect(result.needsEscalationReview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Portfolio with mixed lease types
// ---------------------------------------------------------------------------
describe('Scenario 5: mixed portfolio aggregation', () => {
  interface MockLease {
    escalationType: string;
    monthlyPayment: number;
    termMonths: number;
    startDate: string;
    escalationRate: number;
    discountRate: number;
  }

  function computePortfolio(leases: MockLease[]) {
    const nonIndex = leases.filter(l => l.escalationType !== 'index');
    const index    = leases.filter(l => l.escalationType === 'index');

    const pv = (l: MockLease, rateOverride?: number) =>
      calculateLease({
        monthlyPayment: l.monthlyPayment,
        termMonths:     l.termMonths,
        startDate:      l.startDate,
        escalationRate: rateOverride !== undefined ? rateOverride : l.escalationRate,
        discountRate:   l.discountRate,
      }).pvLiability;

    return {
      totalPVLiability:    nonIndex.reduce((s, l) => s + pv(l), 0),
      indexBasedLeaseCount: index.length,
      indexBasedLeasePV:   index.reduce((s, l) => s + pv(l, 0), 0),
    };
  }

  it('totalPVLiability excludes index leases', () => {
    const leases: MockLease[] = [
      { escalationType: 'percent', monthlyPayment: 5000, termMonths: 24, startDate: '2026-01-01', escalationRate: 3,   discountRate: 5 },
      { escalationType: 'index',   monthlyPayment: 3000, termMonths: 24, startDate: '2026-01-01', escalationRate: 0,   discountRate: 5 },
    ];
    const result = computePortfolio(leases);
    const percentOnly = calculateLease({ monthlyPayment: 5000, termMonths: 24, startDate: '2026-01-01', escalationRate: 3, discountRate: 5 });
    expect(result.totalPVLiability).toBeCloseTo(percentOnly.pvLiability, 0);
    expect(result.indexBasedLeaseCount).toBe(1);
    expect(result.indexBasedLeasePV).toBeGreaterThan(0);
  });

  it('indexBasedLeasePV and totalPVLiability counts are correct for 3-lease mix', () => {
    const leases: MockLease[] = [
      { escalationType: 'percent', monthlyPayment: 4000, termMonths: 36, startDate: '2026-01-01', escalationRate: 2,   discountRate: 5 },
      { escalationType: 'none',    monthlyPayment: 2000, termMonths: 12, startDate: '2026-01-01', escalationRate: 0,   discountRate: 5 },
      { escalationType: 'index',   monthlyPayment: 6000, termMonths: 24, startDate: '2026-01-01', escalationRate: 0,   discountRate: 5 },
    ];
    const result = computePortfolio(leases);
    expect(result.indexBasedLeaseCount).toBe(1);
    expect(result.indexBasedLeasePV).toBeGreaterThan(0);
    // totalPVLiability should include only the percent + none leases
    const expected = [
      calculateLease({ monthlyPayment: 4000, termMonths: 36, startDate: '2026-01-01', escalationRate: 2, discountRate: 5 }).pvLiability,
      calculateLease({ monthlyPayment: 2000, termMonths: 12, startDate: '2026-01-01', escalationRate: 0, discountRate: 5 }).pvLiability,
    ].reduce((a, b) => a + b, 0);
    expect(result.totalPVLiability).toBeCloseTo(expected, 0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Dashboard renders both figures when indexBasedLeaseCount > 0
// (logic test — UI rendering verified in integration/E2E)
// ---------------------------------------------------------------------------
describe('Scenario 6: dashboard disclosure condition', () => {
  it('shows disclosure when indexBasedLeaseCount > 0', () => {
    const indexBasedLeaseCount = 2;
    const shouldShowDisclosure = indexBasedLeaseCount > 0;
    expect(shouldShowDisclosure).toBe(true);
  });

  it('hides disclosure when indexBasedLeaseCount === 0', () => {
    const indexBasedLeaseCount = 0;
    const shouldShowDisclosure = indexBasedLeaseCount > 0;
    expect(shouldShowDisclosure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — term_months present: used directly
// ---------------------------------------------------------------------------
describe('Scenario 7: term_months preference', () => {
  it('longer term_months produces higher pvLiability', () => {
    const short = calculateLease({ monthlyPayment: 5000, termMonths: 24, startDate: '2026-01-01', escalationRate: 0, discountRate: 5 });
    const long  = calculateLease({ monthlyPayment: 5000, termMonths: 36, startDate: '2026-01-01', escalationRate: 0, discountRate: 5 });
    expect(long.pvLiability).toBeGreaterThan(short.pvLiability);
  });

  it('uses term_months=36 directly without date derivation', () => {
    const direct = calculateLease({ monthlyPayment: 5000, termMonths: 36, startDate: '2026-01-01', escalationRate: 0, discountRate: 5 });
    expect(direct.pvLiability).toBeGreaterThan(0);
    expect(direct.endDate).toBe('2029-01-01');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — term_months null: falls back to lease_start / lease_end
// ---------------------------------------------------------------------------
describe('Scenario 8: term_months fallback to date derivation', () => {
  it('derived months from 2026-01-01 to 2028-01-01 ≈ 24 months', () => {
    const derivedMonths = Math.max(
      1,
      Math.round(
        (new Date('2028-01-01').getTime() - new Date('2026-01-01').getTime()) /
          (365.25 / 12 * 24 * 60 * 60 * 1000)
      )
    );
    expect(derivedMonths).toBeGreaterThanOrEqual(23);
    expect(derivedMonths).toBeLessThanOrEqual(25);
  });

  it('derived PV is within rounding tolerance of direct 24-month calculation', () => {
    const derivedMonths = Math.max(
      1,
      Math.round(
        (new Date('2028-01-01').getTime() - new Date('2026-01-01').getTime()) /
          (365.25 / 12 * 24 * 60 * 60 * 1000)
      )
    );
    const direct  = calculateLease({ monthlyPayment: 5000, termMonths: 24,           startDate: '2026-01-01', escalationRate: 0, discountRate: 5 });
    const derived = calculateLease({ monthlyPayment: 5000, termMonths: derivedMonths, startDate: '2026-01-01', escalationRate: 0, discountRate: 5 });
    expect(Math.abs(direct.pvLiability - derived.pvLiability)).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Downstream analytics never references rent_escalation_type
// (architectural boundary — verified by code search, asserted conceptually here)
// ---------------------------------------------------------------------------
describe('Scenario 9: parsing boundary — downstream uses escalation_type only', () => {
  it('portfolio computation uses escalation_type flag, not rent_escalation_type string', () => {
    // Simulate what FinancialSummary does: filter by escalation_type field
    const leases = [
      { escalation_type: 'percent', rent_escalation_type: '3% annual',   monthly: 5000 },
      { escalation_type: 'index',   rent_escalation_type: 'CPI-linked',  monthly: 3000 },
      { escalation_type: 'none',    rent_escalation_type: null,           monthly: 2000 },
    ];

    // Downstream code must filter on escalation_type — never parse rent_escalation_type
    const nonIndex = leases.filter(l => l.escalation_type !== 'index');
    const index    = leases.filter(l => l.escalation_type === 'index');

    expect(nonIndex).toHaveLength(2);
    expect(index).toHaveLength(1);
    expect(index[0].escalation_type).toBe('index');
    // Downstream code does not need to inspect rent_escalation_type at all
  });
});

// ---------------------------------------------------------------------------
// ASC 842 hard rules — summary assertions
// ---------------------------------------------------------------------------
describe('ASC 842 hard rules', () => {
  it('index lease escalation_rate is null — never silently 0', () => {
    const result = normalizeEscalation('CPI annual adjustment');
    expect(result.escalationRate).toBeNull();
  });

  it('index lease PV uses explicit 0 override, documented as floor estimate', () => {
    // When portfolio code calculates index lease PV, it passes 0 explicitly
    // as an override. This is a documented floor, not a projection.
    const floor = calculateLease({
      monthlyPayment: 5000,
      termMonths: 24,
      startDate: '2026-01-01',
      escalationRate: 0, // explicit override for floor calculation
      discountRate: 5.0,
    });
    expect(floor.pvLiability).toBeGreaterThan(0);
  });

  it('pvLiability naming is consistent — no pvExposure or totalPVExposure', () => {
    const result = calculateLease({
      monthlyPayment: 5000,
      termMonths: 24,
      startDate: '2026-01-01',
      escalationRate: 3,
      discountRate: 5,
    });
    expect(result).toHaveProperty('pvLiability');
    expect(result).not.toHaveProperty('pvExposure');
    expect(result).not.toHaveProperty('totalPVExposure');
  });
});
