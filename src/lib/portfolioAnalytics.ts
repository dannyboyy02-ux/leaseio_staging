/**
 * Portfolio analytics helpers.
 *
 * Pure module: no DB reads, no side effects.
 */
import type { Database } from '@/integrations/supabase/types';
import { calculateLease, getBaseMonthlyRent } from './leaseCalculations';

type LeaseRecord = Database['public']['Tables']['leases']['Row'];

export type LeaseRow = Pick<
  LeaseRecord,
  | 'executed_monthly_payment'
  | 'current_monthly_rent'
  | 'monthly_payment'
  | 'lease_start'
  | 'lease_end'
  | 'term_months'
  | 'escalation_rate'
  | 'escalation_type'
>;

export interface PortfolioMetrics {
  totalPVLiability: number;
  indexBasedLeaseCount: number;
  indexBasedLeasePV: number;
  excludedLeaseCount: number;
}

interface PortfolioOptions {
  discountRate: number | null | undefined;
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
          ((365.25 / 12) * 24 * 60 * 60 * 1000),
      ),
    );
  }

  return 0;
}

function calcLeasePV(
  lease: LeaseRow,
  discountRate: number,
  escalationRateOverride?: number,
): { value: number; excluded: boolean } {
  // Base rent only — calculateLease projects escalation forward from here, so
  // starting off the current (already-escalated) schedule step would
  // double-count. getBaseMonthlyRent ignores rent_schedules even if a caller's
  // row carries them (e.g. FinancialSummary passes schedule-bearing rows).
  const monthly = getBaseMonthlyRent(lease);
  if (!monthly) return { value: 0, excluded: false };

  const termMonths = getTermMonths(lease);
  if (termMonths <= 0 || !(discountRate > 0)) {
    return { value: 0, excluded: true };
  }

  const startDate = lease.lease_start ?? new Date().toISOString().slice(0, 10);
  const escalationRate =
    escalationRateOverride !== undefined
      ? escalationRateOverride
      : Number(lease.escalation_rate) || 0;

  try {
    return {
      value: calculateLease({
        monthlyPayment: monthly,
        termMonths,
        startDate,
        escalationRate,
        discountRate,
      }).pvLiability,
      excluded: false,
    };
  } catch {
    return { value: 0, excluded: true };
  }
}

export function computePortfolioMetrics(
  leases: LeaseRow[],
  { discountRate }: PortfolioOptions,
): PortfolioMetrics {
  const effectiveDiscountRate = Number(discountRate);
  let totalPVLiability = 0;
  let indexBasedLeasePV = 0;
  let indexBasedLeaseCount = 0;
  let excludedLeaseCount = 0;

  for (const lease of leases) {
    const isIndexLease = lease.escalation_type === 'index';
    const result = calcLeasePV(
      lease,
      effectiveDiscountRate,
      isIndexLease ? 0 : undefined,
    );

    if (result.excluded) {
      excludedLeaseCount += 1;
      continue;
    }

    if (isIndexLease) {
      indexBasedLeaseCount += 1;
      indexBasedLeasePV += result.value;
      continue;
    }

    totalPVLiability += result.value;
  }

  return {
    totalPVLiability,
    indexBasedLeaseCount,
    indexBasedLeasePV,
    excludedLeaseCount,
  };
}
