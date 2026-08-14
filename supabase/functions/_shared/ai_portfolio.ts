// Pure portfolio-scoping helpers for the Leo assistant (ai-assistant/index.ts).
// Extracted so the #187 contract — Leo's counts and obligation totals must
// mirror the dashboard/Portfolio EXACTLY — is unit-testable even though the
// edge function itself runs on Deno.
//
// The bug this defends against: Leo was counting draft + archived leases as
// "active" and summing base (not schedule-aware) rent, so its total ran ~29%
// high and its lease count was inflated, reconciling with no UI surface.

import { groupOf, type LifecycleStatus } from "./lifecycle.ts";

export interface RentSchedulePeriod {
  period_start: string;
  period_end: string | null;
  monthly_amount: number;
}

export interface PortfolioLeaseInput {
  lifecycle_status?: string | null;
  rent_schedules?: RentSchedulePeriod[] | null;
  executed_monthly_payment?: number | null;
  current_monthly_rent?: number | null;
  monthly_payment?: number | null;
}

// The lifecycle states the UI treats as the live "portfolio". The dashboard
// monthly-rent tile and the Portfolio page both scope to exactly these AND
// exclude archived leases (archived exclusion is applied at the DB fetch).
// Kept in lockstep with src/components/dashboard/SummaryStrip.tsx.
export const PORTFOLIO_STATES = ['active', 'executed', 'fully_executed'] as const;

export function isPortfolioLease(lease: { lifecycle_status?: string | null }): boolean {
  return (PORTFOLIO_STATES as readonly string[]).includes(lease.lifecycle_status ?? '');
}

// Ported from src/lib/leaseCalculations.ts getCurrentMonthlyRent — MUST stay in
// lockstep so Leo's figures match the dashboard/Portfolio. Prefers the
// rent-schedule period covering `asOf` (the current escalated step), then falls
// back to the static chain executed → current → base.
export function currentMonthlyRent(lease: PortfolioLeaseInput, asOf: Date = new Date()): number {
  const schedules = lease.rent_schedules ?? null;
  if (schedules && schedules.length > 0) {
    const current = schedules.find((p) => {
      const start = new Date(p.period_start);
      const end = p.period_end ? new Date(p.period_end) : null;
      return start <= asOf && (!end || end >= asOf);
    });
    if (current?.monthly_amount) return Number(current.monthly_amount);
  }
  return (
    Number(lease.executed_monthly_payment) ||
    Number(lease.current_monthly_rent) ||
    Number(lease.monthly_payment) ||
    0
  );
}

// The lifecycle groups that mean a lease is CLOSED, not in-flight — mirrors
// _shared/lifecycle.ts STATE_GROUPS. A rejected/expired/chain-violation lease is
// finished, so it must NOT be described to Leo as "in the approval pipeline"
// (integrity review of #187). `cancelled` is in terminal_negative too but is
// already excluded at the DB fetch, so it never reaches here.
const CLOSED_GROUPS = new Set(['terminal_negative', 'terminal_neutral', 'exception']);

export type LeaseBucket = 'portfolio' | 'pipeline' | 'closed';

export function classifyLease(lease: { lifecycle_status?: string | null }): LeaseBucket {
  if (isPortfolioLease(lease)) return 'portfolio';
  const group = groupOf((lease.lifecycle_status ?? '') as LifecycleStatus);
  if (group && CLOSED_GROUPS.has(group)) return 'closed';
  return 'pipeline';
}

export interface PortfolioPartition<T> {
  /** Leases the UI counts as the live portfolio (active/executed/fully_executed). */
  portfolio: T[];
  /** In-flight leases still moving through the request/approval pipeline. */
  pipeline: T[];
  /** Closed leases (rejected / expired / chain-violation) — done, not pipeline. */
  closed: T[];
  /** Schedule-aware sum of the portfolio's monthly rent — equals the dashboard tile. */
  totalMonthly: number;
}

export function partitionPortfolio<T extends PortfolioLeaseInput>(
  leases: T[],
  asOf: Date = new Date(),
): PortfolioPartition<T> {
  const portfolio: T[] = [];
  const pipeline: T[] = [];
  const closed: T[] = [];
  for (const lease of leases) {
    const bucket = classifyLease(lease);
    if (bucket === 'portfolio') portfolio.push(lease);
    else if (bucket === 'closed') closed.push(lease);
    else pipeline.push(lease);
  }
  const totalMonthly = portfolio.reduce((sum, l) => sum + currentMonthlyRent(l, asOf), 0);
  return { portfolio, pipeline, closed, totalMonthly };
}
