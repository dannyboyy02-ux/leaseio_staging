/**
 * Portfolio Analytics — Pure Module
 *
 * Constraints (enforced here, never violated):
 * 1. No DB queries, no side effects — accepts lease rows, returns metrics.
 * 2. Never references rent_escalation_type — uses escalation_type and escalation_rate only.
 *    The parsing boundary lives exclusively in supabase/functions/process_lease/index.ts.
 * 3. Index leases are NEVER silently included in totalPVLiability.
 *    indexBasedLeasePV uses an explicit 0 as a documented baseline floor, not a projection.
 * 4. pvLiability naming is consistent with leaseCalculations.ts — no synonyms introduced.
 */
import { calculateLease } from './leaseCalculations';

// Default IBR used when the lease record has no discount_rate.
// 5% is a reasonable mid-market incremental borrowing rate for ASC 842 purposes.
const PORTFOLIO_DISCOUNT_RATE_DEFAULT = 5.0;

export interface LeaseRow {
  executed_monthly_payment?: number | null;
  current_monthly_rent?: number | null;
  monthly_payment?: number | null;
  lease_start?: string | null;
  lease_end?: string | null;
  term_months?: number | null;
  escalation_rate?: number | null;
  escalation_type?: string | null;
  discount_rate?: number | null;
}

export interface PortfolioMetrics {
  /** Sum of pvLiability for non-index leases only. */
  totalPVLiability: number;
  /** Count of leases where escalation_type === 'index'. */
  indexBasedLeaseCount: number;
  /** Sum of pvLiability for index leases computed at escalation_rate=0 (floor estimate). */
  indexBasedLeasePV: number;
}

function getMonthlyRent(lease: LeaseRow): number {
  return (
    Number(lease.executed_monthly_payment) ||
    Number(lease.current_monthly_rent) ||
    Number(lease.monthly_payment) ||
    0
  );
}

function getTermMonths(lease: LeaseRow): number {
  if (typeof lease.term_months === 'number' && lease.term_months > 0) {
    return lease.term_months;
  }
  if (lease.lease_start && lease.lease_end) {
    return Math.max(
      1,
      Math.round(
        (new Date(lease.lease_end).getTime() - new Date(lease.lease_start).getTime()) /
          ((365.25 / 12) * 24 * 60 * 60 * 1000)
      )
    );
  }
  return 12;
}

function calcLeasePV(lease: LeaseRow, escalationRateOverride?: number): number {
  const monthly = getMonthlyRent(lease);
  if (!monthly) return 0;

  const termMonths = getTermMonths(lease);
  const startDate = lease.lease_start ?? new Date().toISOString().slice(0, 10);
  const escalationRate =
    escalationRateOverride !== undefined
      ? escalationRateOverride
      : Number(lease.escalation_rate) || 0;
  const discountRate = Number(lease.discount_rate) || PORTFOLIO_DISCOUNT_RATE_DEFAULT;

  try {
    return calculateLease({
      monthlyPayment: monthly,
      termMonths,
      startDate,
      escalationRate,
      discountRate,
    }).pvLiability;
  } catch {
    return 0;
  }
}

/**
 * Compute portfolio-level PV liability metrics.
 *
 * Pure function — no DB access, no side effects.
 *
 * @param leases  Active/executed lease rows from the database.
 */
export function computePortfolioMetrics(leases: LeaseRow[]): PortfolioMetrics {
  const indexLeases    = leases.filter(l => l.escalation_type === 'index');
  const nonIndexLeases = leases.filter(l => l.escalation_type !== 'index');

  return {
    totalPVLiability:     nonIndexLeases.reduce((sum, l) => sum + calcLeasePV(l), 0),
    indexBasedLeaseCount: indexLeases.length,
    // Explicit 0 override — baseline floor, not a CPI projection (ASC 842)
    indexBasedLeasePV:    indexLeases.reduce((sum, l) => sum + calcLeasePV(l, 0), 0),
  };
}
