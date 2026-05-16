import { describe, it, expect } from 'vitest';
import { generateRentScheduleRows } from '../rentSchedule';

const LEASE_ID = 'lease-uuid-1';

describe('generateRentScheduleRows — input validation', () => {
  it('rejects zero base rent', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 0,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      escalationRate: 0.03,
      mode: 'single',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_base_rent' });
  });

  it('rejects negative base rent', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: -100,
      startDate: '2026-01-01',
      endDate: null,
      escalationRate: 0.03,
      mode: 'single',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_base_rent' });
  });

  it('rejects NaN base rent', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: NaN,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      escalationRate: 0.03,
      mode: 'single',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_base_rent' });
  });

  it('annual mode rejects zero escalation rate', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 5000,
      startDate: '2026-01-01',
      endDate: '2030-12-31',
      escalationRate: 0,
      mode: 'annual',
    });
    expect(result).toEqual({ ok: false, reason: 'missing_escalation_rate' });
  });

  it('single mode succeeds with zero escalation (it is ignored)', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 5000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      escalationRate: 0,
      mode: 'single',
    });
    expect(result.ok).toBe(true);
  });
});

describe('generateRentScheduleRows — single mode', () => {
  it('produces one row with the supplied end date', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 5000,
      startDate: '2026-01-01',
      endDate: '2030-12-31',
      escalationRate: 0,
      mode: 'single',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      period_start: '2026-01-01',
      period_end: '2030-12-31',
      monthly_amount: 5000,
      annual_amount: 60000,
      notes: 'Generated — single period',
      lease_id: LEASE_ID,
    });
  });

  it('produces one open-ended row when endDate is null', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 5000,
      startDate: '2026-01-01',
      endDate: null,
      escalationRate: 0,
      mode: 'single',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].period_end).toBeNull();
    expect(result.rows[0].monthly_amount).toBe(5000);
  });
});

describe('generateRentScheduleRows — annual mode', () => {
  it('compounds escalation across years', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2029-01-01',
      escalationRate: 0.10, // 10% annual
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows).toHaveLength(3);
    // Year 1: 1000
    expect(result.rows[0].monthly_amount).toBe(1000);
    // Year 2: 1000 * 1.10 = 1100
    expect(result.rows[1].monthly_amount).toBe(1100);
    // Year 3: 1100 * 1.10 = 1210
    expect(result.rows[2].monthly_amount).toBe(1210);
  });

  it('rounds compounded amounts to 2 decimals', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2028-01-01',
      escalationRate: 0.033, // 3.3%
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    // Year 1: 1000
    expect(result.rows[0].monthly_amount).toBe(1000);
    // Year 2: 1000 * 1.033 = 1033
    expect(result.rows[1].monthly_amount).toBe(1033);
    // Both should round cleanly to 2 decimals.
    for (const row of result.rows) {
      expect(Number((row.monthly_amount * 100).toFixed(0)) / 100).toBe(row.monthly_amount);
    }
  });

  it('annual_amount is monthly * 12 rounded to 2 decimals', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2027-01-01',
      escalationRate: 0.05,
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows[0].annual_amount).toBe(12000);
  });

  it('defaults to 5 years when endDate is null', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: null,
      escalationRate: 0.05,
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0].period_start).toBe('2026-01-01');
    // Final row's period_end should be 5 years after start minus 1 day
    // (or capped at the effectiveEnd). Last period_end ≈ 2030-12-31.
    expect(result.rows[4].period_start).toBe('2030-01-01');
  });

  it('caps the last period at the effective end date', () => {
    // 2.5-year window: should produce 3 rows, last truncated.
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2028-07-01',
      escalationRate: 0.05,
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].period_start).toBe('2026-01-01');
    expect(result.rows[1].period_start).toBe('2027-01-01');
    expect(result.rows[2].period_start).toBe('2028-01-01');
    expect(result.rows[2].period_end).toBe('2028-07-01');
  });

  it('every period_end is exactly one day before the next period_start', () => {
    const result = generateRentScheduleRows({
      leaseId: LEASE_ID,
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2030-01-01',
      escalationRate: 0.05,
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    for (let i = 0; i < result.rows.length - 1; i++) {
      const thisEnd = new Date(result.rows[i].period_end as string);
      const nextStart = new Date(result.rows[i + 1].period_start);
      const diffMs = nextStart.getTime() - thisEnd.getTime();
      expect(diffMs).toBe(86_400_000);
    }
  });

  it('attaches the lease_id to every row', () => {
    const result = generateRentScheduleRows({
      leaseId: 'specific-lease-uuid',
      baseRent: 1000,
      startDate: '2026-01-01',
      endDate: '2029-01-01',
      escalationRate: 0.05,
      mode: 'annual',
    });
    if (!result.ok) throw new Error('expected ok');
    for (const row of result.rows) {
      expect(row.lease_id).toBe('specific-lease-uuid');
    }
  });
});
