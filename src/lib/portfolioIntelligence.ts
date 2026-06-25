/**
 * Portfolio Intelligence — pure occupancy-cost & commitment derivations.
 *
 * Deliberately NOT lease accounting: no PV, no discounting, no ROU asset.
 * (Hard Rule #1 — LeaseIO is an awareness/abstraction product, not an
 * accounting tool.) This layer turns already-abstracted lease terms into
 * portfolio-level cost visibility: contractual cash commitment, cost
 * composition, and a forward rent-commitment forecast.
 *
 * Every function is pure and side-effect-free (no Supabase, no React, and no
 * implicit `new Date()` — callers pass `asOf`) so the whole layer is
 * unit-testable in isolation. Numbers that face the user must reconcile:
 * Annual Occupancy Cost here is `getMonthlyRent × 12` (the same resolver the
 * Dashboard/Leases totals use), and the Cost-per-sqft card's reference line is
 * the Blended $/sqft KPI computed from the SAME with-area lease set.
 *
 * Voice: observational only. Surfaces facts (rates, dates), never advice.
 */

import { getMonthlyRent, getBaseMonthlyRent, type MonthlyRentSource } from '@/lib/leaseCalculations';

/** Normalized, derivation-ready lease shape. Build via {@link toPortfolioLease}. */
export interface PortfolioLease {
  id: string;
  propertyName: string;
  /** Normalized department — never empty; null/blank source → {@link UNASSIGNED}. */
  department: string;
  /** Market/region bucket for the "N markets" count; null if not captured. */
  region: string | null;
  /** Rentable area in sqft; null when the term wasn't abstracted (excluded from $/sqft). */
  squareFootage: number | null;
  /** Current monthly rent (schedule-aware step) — the run-rate basis for cost metrics. */
  currentMonthlyRent: number;
  /** Static base monthly rent — the basis for forward escalation projection (no double-count). */
  baseMonthlyRent: number;
  /** ISO yyyy-mm-dd lease commencement; null when unknown (excluded from term metrics). */
  startDate: string | null;
  /** ISO yyyy-mm-dd lease expiry; null when unknown (excluded from term/forecast metrics). */
  endDate: string | null;
  /** Annual escalation rate as a percent (e.g. 3 = 3%); 0 when none/unknown. */
  escalationRate: number;
  /** Raw escalation type (e.g. 'fixed', 'index'); informational. */
  escalationType: string | null;
  /**
   * Renewal-notice deadline (ISO) for the Watchlist's renewal-notice rule.
   * NULL today — `renewal_options` is abstracted as prose, not a structured
   * date. A Tier-1 extraction enhancement will populate this, lighting the rule
   * up with no code change (the rule already reads this field).
   */
  renewalNoticeDeadline: string | null;
  /**
   * Escalation-cap end date (ISO) for the Watchlist's escalation-cap rule.
   * NULL today — only escalation_type/rate are captured (no structured cap).
   */
  escalationCapEndDate: string | null;
}

export const UNASSIGNED = 'Unassigned';
/** Cap on Cost-by-Department segments before rolling the tail into "Other". */
export const DEPT_SEGMENT_CAP = 6;
/** A rate within ±this fraction of the average is "at" the average (neutral). */
export const AVG_BAND = 0.02;
/** Default forecast horizon in explicit year buckets (plus a "+tail" bucket). */
export const FORECAST_HORIZON = 5;

// ---------------------------------------------------------------------------
// Date helpers (UTC, mirrors leaseCalculations' parsing — no local-tz drift)
// ---------------------------------------------------------------------------

export function parseIso(date: string | null): Date | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m) return null;
  const dt = new Date(Date.UTC(y, m - 1, d || 1));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Days from `asOf` until an ISO date; null if unparseable. Negative = in the past. */
export function daysUntil(asOf: Date, iso: string | null): number | null {
  const d = parseIso(iso);
  return d ? (d.getTime() - asOf.getTime()) / 86_400_000 : null;
}

/** Whole + fractional months from `from` to `to` (0 if `to` <= `from`). */
function monthsBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  const whole =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  const dayFrac = (to.getUTCDate() - from.getUTCDate()) / 30;
  return Math.max(0, whole + dayFrac);
}

/** Years from `asOf` to `end`, clamped at 0. */
function yearsRemaining(asOf: Date, end: Date | null): number {
  if (!end) return 0;
  return monthsBetween(asOf, end) / 12;
}

/** Escalated monthly rent in the calendar month `monthsFromStart` after start. */
function escalatedMonthly(base: number, escalationPct: number, monthsFromStart: number): number {
  const yearIndex = Math.floor(monthsFromStart / 12);
  return base * Math.pow(1 + escalationPct / 100, Math.max(0, yearIndex));
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const annualRunRate = (l: PortfolioLease): number => l.currentMonthlyRent * 12;
const hasArea = (l: PortfolioLease): boolean => !!l.squareFootage && l.squareFootage > 0;
const hasRent = (l: PortfolioLease): boolean => l.currentMonthlyRent > 0;

// ---------------------------------------------------------------------------
// Mapper — raw lease row → PortfolioLease
// ---------------------------------------------------------------------------

/**
 * Fields the mapper reads off a lease row. Loosely typed (the page query is an
 * `any[]`); every field is optional so a partial row never throws.
 */
export type RawLeaseRow = MonthlyRentSource & {
  id?: string;
  filename?: string | null;
  request_title?: string | null;
  property_address?: string | null;
  landlord_name?: string | null;
  requesting_department?: string | null;
  region?: string | null;
  location?: string | null;
  square_footage?: number | null;
  lease_start?: string | null;
  lease_end?: string | null;
  escalation_rate?: number | null;
  escalation_type?: string | null;
};

/**
 * Normalize a raw lease row into a {@link PortfolioLease}. `propertyName` is
 * resolved by the caller (it owns `getPropertyDisplayName(extracted_json, …)`);
 * pass it in so this stays dependency-light and testable.
 */
export function toPortfolioLease(row: RawLeaseRow, propertyName: string): PortfolioLease {
  const dept = (row.requesting_department ?? '').trim();
  const sqft = row.square_footage;
  return {
    id: row.id ?? '',
    propertyName,
    department: dept || UNASSIGNED,
    region: (row.region ?? row.location ?? null) || null,
    squareFootage: typeof sqft === 'number' && sqft > 0 ? sqft : null,
    currentMonthlyRent: getMonthlyRent(row),
    baseMonthlyRent: getBaseMonthlyRent(row),
    startDate: row.lease_start ?? null,
    endDate: row.lease_end ?? null,
    // Index leases have no knowable future rate → treat as flat 0% (labelled in UI).
    escalationRate:
      row.escalation_type === 'index' ? 0 : Number(row.escalation_rate) || 0,
    escalationType: row.escalation_type ?? null,
    // Structured critical dates the Watchlist needs. NULL today (the source
    // terms are abstracted as prose); populated by a later extraction pass.
    renewalNoticeDeadline: null,
    escalationCapEndDate: null,
  };
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export interface PortfolioKpis {
  leaseCount: number;
  annualOccupancyCost: number;
  /** Remaining contracted cash from `asOf` to each lease's end, with escalation. NOT a PV. */
  remainingCommitment: number;
  /** Latest expiry year across leases → "contracted through {year}". */
  contractedThroughYear: number | null;
  /** Annual Occupancy Cost (with-area leases) ÷ their Σ sqft. null if no area data. */
  blendedCostPerSqft: number | null;
  totalSquareFootage: number;
  marketCount: number;
  /** Rent-weighted average years to expiry (WALT). */
  avgTermRemainingYears: number;
  /** Leases excluded from $/sqft views (no area) — drives the partial-data banner. */
  missingAreaCount: number;
  /** Leases excluded from cost (no resolvable rent). */
  missingRentCount: number;
}

/** Remaining contracted cash for one lease from `asOf` to `endDate`, escalated. */
export function remainingContractedRent(lease: PortfolioLease, asOf: Date): number {
  const start = parseIso(lease.startDate);
  const end = parseIso(lease.endDate);
  if (!end || end <= asOf || lease.baseMonthlyRent <= 0) return 0;
  const anchor = start ?? asOf; // escalation indexes from start when known
  const firstMonth = Math.ceil(monthsBetween(anchor, asOf)); // months already elapsed
  const lastMonth = Math.floor(monthsBetween(anchor, end));
  let total = 0;
  for (let m = firstMonth; m < lastMonth; m++) {
    total += escalatedMonthly(lease.baseMonthlyRent, lease.escalationRate, m);
  }
  return total;
}

export function computeKpis(leases: PortfolioLease[], asOf: Date): PortfolioKpis {
  const rented = leases.filter(hasRent);
  const annualOccupancyCost = sum(rented.map(annualRunRate));

  const withArea = leases.filter((l) => hasArea(l) && hasRent(l));
  const areaTotalForBlended = sum(withArea.map((l) => l.squareFootage!));
  const blendedCostPerSqft =
    areaTotalForBlended > 0 ? sum(withArea.map(annualRunRate)) / areaTotalForBlended : null;

  const endYears = leases
    .map((l) => parseIso(l.endDate))
    .filter((d): d is Date => !!d && d > asOf)
    .map((d) => d.getUTCFullYear());

  const weightTotal = sum(rented.map(annualRunRate));
  const weighted = sum(
    rented.map((l) => yearsRemaining(asOf, parseIso(l.endDate)) * annualRunRate(l)),
  );

  return {
    leaseCount: leases.length,
    annualOccupancyCost,
    remainingCommitment: sum(leases.map((l) => remainingContractedRent(l, asOf))),
    contractedThroughYear: endYears.length ? Math.max(...endYears) : null,
    blendedCostPerSqft,
    totalSquareFootage: sum(leases.filter(hasArea).map((l) => l.squareFootage!)),
    marketCount: new Set(leases.map((l) => l.region).filter(Boolean)).size,
    avgTermRemainingYears: weightTotal > 0 ? weighted / weightTotal : 0,
    missingAreaCount: rented.filter((l) => !hasArea(l)).length,
    missingRentCount: leases.filter((l) => !hasRent(l)).length,
  };
}

// ---------------------------------------------------------------------------
// Cost by Department
// ---------------------------------------------------------------------------

export interface DeptSegment {
  department: string;
  annualCost: number;
  /** Share of Annual Occupancy Cost, 0–100. */
  pct: number;
}

/**
 * Group active leases by department, sum annual rent, sort desc, cap to
 * {@link DEPT_SEGMENT_CAP} with the tail rolled into "Other". Null departments
 * bucket as "Unassigned" so segments still sum to 100% of Annual Occupancy Cost.
 */
export function costByDepartment(
  leases: PortfolioLease[],
  cap: number = DEPT_SEGMENT_CAP,
): DeptSegment[] {
  const byDept = new Map<string, number>();
  for (const l of leases.filter(hasRent)) {
    byDept.set(l.department, (byDept.get(l.department) ?? 0) + annualRunRate(l));
  }
  const total = sum([...byDept.values()]);
  if (total <= 0) return [];

  const sorted = [...byDept.entries()]
    .map(([department, annualCost]) => ({ department, annualCost }))
    .sort((a, b) => b.annualCost - a.annualCost);

  let head = sorted;
  if (sorted.length > cap) {
    head = sorted.slice(0, cap - 1);
    const other = sum(sorted.slice(cap - 1).map((s) => s.annualCost));
    head = [...head, { department: 'Other', annualCost: other }];
  }
  return head.map((s) => ({ ...s, pct: (s.annualCost / total) * 100 }));
}

// ---------------------------------------------------------------------------
// Cost per sqft by Location (vs the portfolio's OWN blended average)
// ---------------------------------------------------------------------------

export interface LocationRate {
  id: string;
  name: string;
  ratePerSqft: number;
  /** Signed fraction vs the blended average (e.g. +0.73 = 73% above). */
  deltaVsAvg: number;
  /** 'above' | 'below' | 'at' the average (neutral, observational — not an alarm). */
  position: 'above' | 'below' | 'at';
}

export interface LocationRates {
  rows: LocationRate[];
  /** Portfolio blended average $/sqft — the reference line. Reconciles to the KPI. */
  averageRatePerSqft: number | null;
  /** Leases excluded for missing area (partial-data banner). */
  excludedCount: number;
}

export function costPerSqftByLocation(leases: PortfolioLease[]): LocationRates {
  const withArea = leases.filter((l) => hasArea(l) && hasRent(l));
  const excludedCount = leases.filter(hasRent).length - withArea.length;
  const avg =
    withArea.length > 0
      ? sum(withArea.map(annualRunRate)) / sum(withArea.map((l) => l.squareFootage!))
      : null;

  const rows = withArea
    .map((l) => {
      const ratePerSqft = annualRunRate(l) / l.squareFootage!;
      const deltaVsAvg = avg && avg > 0 ? (ratePerSqft - avg) / avg : 0;
      const position: LocationRate['position'] =
        deltaVsAvg > AVG_BAND ? 'above' : deltaVsAvg < -AVG_BAND ? 'below' : 'at';
      return { id: l.id, name: l.propertyName, ratePerSqft, deltaVsAvg, position };
    })
    .sort((a, b) => b.ratePerSqft - a.ratePerSqft);

  return { rows, averageRatePerSqft: avg, excludedCount };
}

// ---------------------------------------------------------------------------
// Rent Commitment Forecast (the "re-leasing cliff")
// ---------------------------------------------------------------------------

export interface ForecastYear {
  /** Display label — calendar year, or "{year}+" for the tail bucket. */
  label: string;
  year: number;
  /** Contracted rent payable that year (escalated), zero after each lease's end. */
  contracted: number;
  /** Today's run-rate that has rolled OFF contract that year (held flat). Informational. */
  uncontracted: number;
  isTail: boolean;
}

/**
 * Build a per-year forecast from `asOf` for `horizon` explicit years plus a
 * trailing "+tail" bucket. For each month a lease is under contract, it
 * contributes its escalated rent to `contracted`; once past its end date, its
 * (flat) current run-rate contributes to `uncontracted` — so each bar's total
 * approximates today's run-rate held flat, split into contracted (shrinking)
 * vs. uncontracted/expiring (growing). This is informational (what's coming up
 * for renewal), NOT a forecast of future deals.
 */
export function rentCommitmentForecast(
  leases: PortfolioLease[],
  asOf: Date,
  horizon: number = FORECAST_HORIZON,
): ForecastYear[] {
  const startYear = asOf.getUTCFullYear();
  const tailYear = startYear + horizon; // everything >= this folds into the tail
  const buckets: ForecastYear[] = [];
  for (let y = startYear; y < tailYear; y++) {
    buckets.push({ label: String(y), year: y, contracted: 0, uncontracted: 0, isTail: false });
  }
  buckets.push({ label: `${tailYear}+`, year: tailYear, contracted: 0, uncontracted: 0, isTail: true });

  const bucketFor = (year: number): ForecastYear =>
    year >= tailYear ? buckets[buckets.length - 1] : buckets[year - startYear];

  // Walk each lease month-by-month across the horizon window.
  const windowEnd = new Date(Date.UTC(tailYear + 1, 0, 1)); // include the tail year fully
  for (const l of leases.filter(hasRent)) {
    const start = parseIso(l.startDate);
    const end = parseIso(l.endDate);
    const anchor = start ?? asOf;
    const cursor = new Date(Date.UTC(startYear, asOf.getUTCMonth(), 1));
    const monthlyRunRate = l.currentMonthlyRent;
    while (cursor < windowEnd) {
      const bucket = bucketFor(cursor.getUTCFullYear());
      const underContract = !end || cursor < end;
      if (underContract) {
        const mFromStart = Math.floor(monthsBetween(anchor, cursor));
        bucket.contracted += escalatedMonthly(l.baseMonthlyRent, l.escalationRate, mFromStart);
      } else {
        bucket.uncontracted += monthlyRunRate; // run-rate rolled off contract
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return buckets;
}
