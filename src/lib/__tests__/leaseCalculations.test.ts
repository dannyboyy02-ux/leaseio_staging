import { describe, it, expect } from 'vitest';
import {
  getCurrentMonthlyRent,
  getMonthlyRent,
  getBaseMonthlyRent,
  type RentSchedulePeriod,
} from '@/lib/leaseCalculations';

// ───────────────────────────────────────────────────────────────────────────
// Monthly-rent resolution (audit finding B3). These guard the single source of
// truth for "what is this lease's current monthly rent?" — the chain that, when
// it was copy-pasted across 6 sites, let the portfolio total silently disagree
// with the dashboard total for escalating leases.
// ───────────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// A schedule period whose window straddles today.
const currentPeriod = (amount: number): RentSchedulePeriod => ({
  period_start: iso(-30),
  period_end: iso(30),
  monthly_amount: amount,
});

describe('getCurrentMonthlyRent (positional primitive)', () => {
  it('prefers the static chain executed → current → base → 0 when no schedule', () => {
    expect(getCurrentMonthlyRent(null, 4000, 3000, 2000)).toBe(4000);
    expect(getCurrentMonthlyRent(null, null, 3000, 2000)).toBe(3000);
    expect(getCurrentMonthlyRent(null, null, null, 2000)).toBe(2000);
    expect(getCurrentMonthlyRent(null, null, null, null)).toBe(0);
  });

  it('consults the schedule period covering today before the static fields', () => {
    expect(getCurrentMonthlyRent([currentPeriod(5500)], 4000, 3000, 2000)).toBe(5500);
  });

  it('treats 0/NaN-ish static values as falsy and walks the chain', () => {
    expect(getCurrentMonthlyRent(null, 0, 3000, 2000)).toBe(3000);
    expect(getCurrentMonthlyRent(null, undefined, undefined, 2000)).toBe(2000);
  });
});

describe('getMonthlyRent (object wrapper — the canonical call form)', () => {
  it('resolves the static chain when rent_schedules is absent (PV / portfolio path)', () => {
    expect(
      getMonthlyRent({
        executed_monthly_payment: 4000,
        current_monthly_rent: 3000,
        monthly_payment: 2000,
      }),
    ).toBe(4000);
  });

  it('falls through executed → current → base → 0', () => {
    expect(getMonthlyRent({ current_monthly_rent: 3000, monthly_payment: 2000 })).toBe(3000);
    expect(getMonthlyRent({ monthly_payment: 2000 })).toBe(2000);
    expect(getMonthlyRent({})).toBe(0);
  });

  it('REGRESSION (B3): a loaded schedule wins over the static base, so a site '
    + 'that loads rent_schedules and one that does not must be reconciled deliberately', () => {
    const lease = {
      rent_schedules: [currentPeriod(5500)],
      executed_monthly_payment: 4000,
      current_monthly_rent: 3000,
      monthly_payment: 2000,
    };
    // Schedule-aware (dashboard / Leases list) → current escalated step.
    expect(getMonthlyRent(lease)).toBe(5500);
    // Same row without the schedule (portfolio / PV path) → static base.
    expect(getMonthlyRent({ ...lease, rent_schedules: null })).toBe(4000);
  });

  it('ignores a schedule whose periods do not cover today and uses the static chain', () => {
    const futureOnly: RentSchedulePeriod = {
      period_start: iso(60),
      period_end: iso(420),
      monthly_amount: 9999,
    };
    expect(
      getMonthlyRent({
        rent_schedules: [futureOnly],
        executed_monthly_payment: 4000,
      }),
    ).toBe(4000);
  });

  it('honors an open-ended (period_end null) current period', () => {
    const openEnded: RentSchedulePeriod = {
      period_start: iso(-10),
      period_end: null,
      monthly_amount: 7000,
    };
    expect(getMonthlyRent({ rent_schedules: [openEnded], executed_monthly_payment: 4000 })).toBe(
      7000,
    );
  });

  it('agrees with the positional primitive for the same inputs (no logic drift)', () => {
    const schedules = [currentPeriod(5500)];
    expect(getMonthlyRent({ rent_schedules: schedules, executed_monthly_payment: 4000 })).toBe(
      getCurrentMonthlyRent(schedules, 4000, null, null),
    );
  });

  // ─── Edge cases on the schedule branch (added by test-author review) ───────

  it('a covering period with monthly_amount 0 falls through to the static chain '
    + '(a $0 step does NOT zero out rent — guard treats 0 as falsy)', () => {
    // Load-bearing contract: `if (current?.monthly_amount)` skips a 0 step, so a
    // schedule row that happens to read 0 must not silently report $0 rent — it
    // defers to the extracted static fields. Tightening the guard to `!= null`
    // would flip this to 0 and this test would catch it.
    expect(
      getMonthlyRent({
        rent_schedules: [{ period_start: iso(-30), period_end: iso(30), monthly_amount: 0 }],
        executed_monthly_payment: 4000,
        current_monthly_rent: 3000,
        monthly_payment: 2000,
      }),
    ).toBe(4000);
  });

  it('when multiple periods cover today, the FIRST matching period (array order) wins', () => {
    // Tie-break contract: resolution is `Array.prototype.find`, which returns the
    // first match in array order — not the most-recently-started or highest amount.
    const overlapping: RentSchedulePeriod[] = [
      { period_start: iso(-60), period_end: iso(60), monthly_amount: 5500 },
      { period_start: iso(-10), period_end: iso(60), monthly_amount: 7000 },
    ];
    expect(getMonthlyRent({ rent_schedules: overlapping })).toBe(5500);
  });

  it('returns a negative covering amount verbatim (helper does not floor at 0)', () => {
    // Pins that getMonthlyRent is a pure resolver, not a sanitizer: a negative
    // monthly_amount (bad data) is truthy and returned as-is rather than clamped.
    expect(
      getMonthlyRent({
        rent_schedules: [{ period_start: iso(-30), period_end: iso(30), monthly_amount: -500 }],
        executed_monthly_payment: 4000,
      }),
    ).toBe(-500);
  });

  it('an empty (length 0) rent_schedules array uses the static chain', () => {
    expect(getMonthlyRent({ rent_schedules: [], executed_monthly_payment: 4000 })).toBe(4000);
  });
});

describe('getBaseMonthlyRent (PV base — deliberately schedule-blind)', () => {
  it('resolves the static chain and IGNORES a covering schedule period', () => {
    // The whole point: even with a current escalated step loaded, PV must start
    // from the base (4000), because calculateLease projects escalation forward
    // off it. Returning 5500 here would double-count escalation in PV.
    const lease = {
      rent_schedules: [currentPeriod(5500)],
      executed_monthly_payment: 4000,
      current_monthly_rent: 3000,
      monthly_payment: 2000,
    };
    expect(getBaseMonthlyRent(lease)).toBe(4000);
    // Contrast: the schedule-aware resolver WOULD take the step.
    expect(getMonthlyRent(lease)).toBe(5500);
  });

  it('walks executed → current → base → 0 just like the static chain', () => {
    expect(getBaseMonthlyRent({ current_monthly_rent: 3000, monthly_payment: 2000 })).toBe(3000);
    expect(getBaseMonthlyRent({ monthly_payment: 2000 })).toBe(2000);
    expect(getBaseMonthlyRent({})).toBe(0);
  });
});
