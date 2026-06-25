import { describe, it, expect } from 'vitest';
import { buildWatchlist } from '@/lib/portfolioWatchlist';
import { UNASSIGNED, type PortfolioLease } from '@/lib/portfolioIntelligence';

const ASOF = new Date(Date.UTC(2026, 0, 1)); // 2026-01-01

function wlease(over: Partial<PortfolioLease>): PortfolioLease {
  const current = over.currentMonthlyRent ?? 0;
  return {
    id: over.id ?? 'id',
    propertyName: over.propertyName ?? 'Prop',
    department: over.department ?? UNASSIGNED,
    region: over.region ?? null,
    squareFootage: over.squareFootage ?? null,
    currentMonthlyRent: current,
    baseMonthlyRent: over.baseMonthlyRent ?? current,
    startDate: over.startDate ?? '2024-01-01',
    endDate: over.endDate ?? null,
    escalationRate: over.escalationRate ?? 0,
    escalationType: over.escalationType ?? null,
    renewalNoticeDeadline: over.renewalNoticeDeadline ?? null,
    escalationCapEndDate: over.escalationCapEndDate ?? null,
    ...over,
  };
}

const WA = wlease({
  id: 'wa', propertyName: 'Midtown', department: 'Operations',
  squareFootage: 4000, currentMonthlyRent: 8000,        // 96000/yr → $24/sqft
  endDate: '2027-01-01', renewalNoticeDeadline: '2026-03-01', // 59 days out
});
const WB = wlease({
  id: 'wb', propertyName: 'Phoenix', department: 'Logistics',
  squareFootage: 10000, currentMonthlyRent: 6000,       // 72000/yr → $7.20/sqft
  endDate: '2026-09-30',                                 // earliest expiry
});

describe('buildWatchlist — live rules on today\'s data', () => {
  const flags = buildWatchlist([WA, WB], { asOf: ASOF });

  it('fires renewal-notice, earliest-expiry, and highest-cost, sorted by severity', () => {
    expect(flags).toHaveLength(3);
    expect(flags.map((f) => f.severity)).toEqual(['warning', 'info', 'muted']);
  });

  it('renewal-notice flag carries the days-out value + provenance', () => {
    const f = flags[0];
    expect(f.leaseId).toBe('wa');
    expect(f.sourceField).toBe('renewalOptions');
    expect(f.value).toBe('59 days');
    expect(f.icon).toBe('calendar-clock');
    expect(f.department).toBe('Operations');
    expect(f.description).toContain('Mar 1, 2026');
  });

  it('earliest-expiry flag points at the soonest-ending lease', () => {
    const f = flags[1];
    expect(f.leaseId).toBe('wb');
    expect(f.sourceField).toBe('expirationDate');
    expect(f.value).toBe('Sep 2026');
    expect(f.title).toContain('earliest term expiry');
  });

  it('highest-cost flag is the top $/sqft vs the blended average', () => {
    const f = flags[2];
    expect(f.leaseId).toBe('wa');
    expect(f.sourceField).toBe('squareFootage');
    expect(f.value).toBe('$24.00/sqft');
    expect(f.description).toContain('100% above');   // (24-12)/12
    expect(f.description).toContain('$12.00');
  });
});

describe('buildWatchlist — dormant rules stay silent without structured dates', () => {
  it('emits no renewal/escalation-cap flags when those dates are null', () => {
    const flags = buildWatchlist([WB, wlease({ id: 'x', squareFootage: 1000, currentMonthlyRent: 1000, endDate: '2028-01-01' })], { asOf: ASOF });
    expect(flags.some((f) => f.sourceField === 'renewalOptions')).toBe(false);
    expect(flags.some((f) => f.sourceField === 'escalations')).toBe(false);
    // but the live rules still produce flags
    expect(flags.length).toBeGreaterThan(0);
  });

  it('lights up the escalation-cap rule once the date is present (no code change)', () => {
    const withCap = wlease({ id: 'cap', propertyName: 'HQ', squareFootage: 1000, currentMonthlyRent: 1000, endDate: '2029-01-01', escalationCapEndDate: '2027-06-01' });
    const flags = buildWatchlist([withCap], { asOf: ASOF });
    const cap = flags.find((f) => f.sourceField === 'escalations');
    expect(cap).toBeDefined();
    expect(cap!.value).toBe('Jun 2027');
    expect(cap!.severity).toBe('muted');
  });
});

describe('buildWatchlist — expiry window + cap', () => {
  it('flags the earliest plus any lease within the expiry window', () => {
    const leases = [
      wlease({ id: 'min', propertyName: 'A', currentMonthlyRent: 100, endDate: '2026-02-01' }),     // earliest
      wlease({ id: 'soon', propertyName: 'B', currentMonthlyRent: 100, endDate: '2026-05-01' }),    // within 180d
      wlease({ id: 'far', propertyName: 'C', currentMonthlyRent: 100, endDate: '2028-01-01' }),     // outside
    ];
    const expiry = buildWatchlist(leases, { asOf: ASOF }).filter((f) => f.sourceField === 'expirationDate');
    expect(expiry.map((f) => f.leaseId).sort()).toEqual(['min', 'soon']);
    expect(expiry.find((f) => f.leaseId === 'min')!.title).toContain('earliest');
    expect(expiry.find((f) => f.leaseId === 'soon')!.title).toContain('upcoming');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      wlease({ id: `m${i}`, currentMonthlyRent: 100, endDate: `2026-0${(i % 9) + 1}-15` }),
    );
    expect(buildWatchlist(many, { asOf: ASOF, cap: 5 })).toHaveLength(5);
  });

  it('returns nothing for an empty portfolio', () => {
    expect(buildWatchlist([], { asOf: ASOF })).toEqual([]);
  });
});
