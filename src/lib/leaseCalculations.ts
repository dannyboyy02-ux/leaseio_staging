/**
 * Lease calculation engine — pure functions, no side effects.
 * Takes inputs, returns outputs. Safe to unit-test in isolation.
 */

export interface LeaseInputs {
  monthlyPayment: number;
  termMonths: number;
  startDate: string;       // ISO date string (YYYY-MM-DD)
  escalationRate: number;  // annual %, e.g. 3.0 = 3%
  discountRate: number;    // workspace incremental borrowing rate %
}

export interface LeaseCalculations {
  totalCashCommitment: number;
  pvLiability: number;
  straightLineExpense: number; // per month
  cashPLDelta: number;         // at midpoint of lease term
  endDate: string;             // ISO date string
}

function parseIsoDateUtc(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      date.getUTCDate(),
    ),
  );
}

/**
 * Calculate financial impact for a lease.
 *
 * totalCashCommitment — sum of all payments across the term, applying escalation annually.
 *   Payment in month M = monthlyPayment × (1 + escalationRate/100) ^ floor((M-1)/12)
 *
 * pvLiability — present value of all future payments discounted at the monthly equivalent
 *   of the discount rate.
 *   Monthly rate = (1 + discountRate/100)^(1/12) - 1
 *   PV = Σ payment[m] / (1 + monthlyRate)^m  for m = 1..termMonths
 *
 * straightLineExpense — totalCashCommitment / termMonths (ASC 842 operating lease monthly charge)
 *
 * cashPLDelta — at the midpoint of the lease term:
 *   cumulative cash paid minus cumulative straight-line expense.
 *   Positive = cash ahead of P&L. Negative = P&L ahead of cash (common with escalating leases).
 *
 * endDate — startDate + termMonths calendar months.
 */
export function calculateLease(inputs: LeaseInputs): LeaseCalculations {
  const { monthlyPayment, termMonths, startDate, escalationRate, discountRate } = inputs;

  // Monthly equivalent of the annual discount rate
  const monthlyRate = Math.pow(1 + discountRate / 100, 1 / 12) - 1;

  // Build full payment schedule with annual escalation
  const payments: number[] = [];
  for (let m = 1; m <= termMonths; m++) {
    const yearIndex = Math.floor((m - 1) / 12);
    const payment = monthlyPayment * Math.pow(1 + escalationRate / 100, yearIndex);
    payments.push(payment);
  }

  // Total cash commitment: sum of all scheduled payments
  const totalCashCommitment = payments.reduce((sum, p) => sum + p, 0);

  // PV of liability: discount each payment back to today
  const pvLiability = payments.reduce((sum, payment, idx) => {
    const m = idx + 1;
    return sum + payment / Math.pow(1 + monthlyRate, m);
  }, 0);

  // Straight-line monthly P&L charge (ASC 842 operating)
  const straightLineExpense = termMonths > 0 ? totalCashCommitment / termMonths : 0;

  // Cash vs. P&L delta at the midpoint of the term
  const midpoint = Math.max(1, Math.floor(termMonths / 2));
  const cumulativeCash = payments.slice(0, midpoint).reduce((sum, p) => sum + p, 0);
  const cumulativeSL = straightLineExpense * midpoint;
  const cashPLDelta = cumulativeCash - cumulativeSL;

  // End date: startDate + termMonths calendar months
  const start = parseIsoDateUtc(startDate);
  const end = addUtcMonths(start, termMonths);
  const endDate = end.toISOString().slice(0, 10);

  return {
    totalCashCommitment,
    pvLiability,
    straightLineExpense,
    cashPLDelta,
    endDate,
  };
}

export interface RentSchedulePeriod {
  period_start: string;
  period_end: string | null;
  monthly_amount: number;
}

/**
 * Returns the current monthly rent for a lease.
 * Checks rent_schedules for a period covering today first,
 * then falls back to the static extracted fields.
 */
export function getCurrentMonthlyRent(
  rentSchedules: RentSchedulePeriod[] | null | undefined,
  executedMonthlyPayment: number | null | undefined,
  currentMonthlyRent: number | null | undefined,
  monthlyPayment: number | null | undefined,
): number {
  if (rentSchedules && rentSchedules.length > 0) {
    const today = new Date();
    const current = rentSchedules.find((p) => {
      const start = new Date(p.period_start);
      const end = p.period_end ? new Date(p.period_end) : null;
      return start <= today && (!end || end >= today);
    });
    if (current?.monthly_amount) return current.monthly_amount;
  }
  return (
    Number(executedMonthlyPayment) ||
    Number(currentMonthlyRent) ||
    Number(monthlyPayment) ||
    0
  );
}

/**
 * Lease-shaped subset needed to resolve the current monthly rent. Every field
 * is optional so any partial lease row (or an `any`-typed query result) can be
 * passed without ceremony.
 */
export interface MonthlyRentSource {
  rent_schedules?: RentSchedulePeriod[] | null;
  executed_monthly_payment?: number | null;
  current_monthly_rent?: number | null;
  monthly_payment?: number | null;
}

/**
 * Canonical "what is this lease's current monthly rent?" resolver — the single
 * source of truth for the priority chain, so the dashboard, portfolio, and
 * Leases-list totals can never silently drift apart (audit finding B3). Prefer
 * this object form over calling getCurrentMonthlyRent with four positional
 * args (which is easy to call with mismatched fields from two objects).
 *
 * Consults rent_schedules for the period covering today first (so escalating
 * leases reflect their *current* step), then falls back to the static fields:
 * executed → current → base monthly_payment → 0.
 *
 * IMPORTANT: schedule-awareness only engages when rent_schedules is actually
 * loaded onto the row. Display/obligation callers that load rent_schedules get
 * the current escalated step; callers that intentionally want the *base* rent
 * (PV modeling, where escalation is projected separately — portfolioAnalytics,
 * DiscountRateCard) simply don't select rent_schedules and so resolve the
 * static chain. If a PV caller ever starts loading rent_schedules, revisit
 * whether PV should compound off the current step (KNOWN_ISSUES — B3 follow-up).
 */
export function getMonthlyRent(lease: MonthlyRentSource): number {
  return getCurrentMonthlyRent(
    lease.rent_schedules ?? null,
    lease.executed_monthly_payment,
    lease.current_monthly_rent,
    lease.monthly_payment,
  );
}

/**
 * The lease's *base* monthly rent — the static chain only
 * (executed → current → base monthly_payment → 0), DELIBERATELY ignoring
 * rent_schedules even when present.
 *
 * Use this (not getMonthlyRent) for PV / escalation modeling, where
 * calculateLease projects escalation forward from the base: starting that
 * projection off an already-escalated current schedule step would double-count
 * the escalation. This is an EXPLICIT resolver rather than relying on a caller's
 * query happening not to select rent_schedules — that implicit coupling is a
 * trap (the row often carries rent_schedules at runtime even when the caller's
 * TypeScript Pick omits it).
 */
export function getBaseMonthlyRent(lease: MonthlyRentSource): number {
  return getCurrentMonthlyRent(
    null,
    lease.executed_monthly_payment,
    lease.current_monthly_rent,
    lease.monthly_payment,
  );
}
