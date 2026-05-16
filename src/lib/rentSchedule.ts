// Pure rent-schedule generation. Extracted from LeaseReview.handleGenerateSchedule
// (P2-04 monolith decomposition). The DB-write side stays in the page
// component; this module owns only the deterministic compute over inputs.
//
// Two modes:
//   single  — one period spanning lease_start..lease_end (or open-ended
//             if lease_end is null) at a flat baseRent.
//   annual  — one row per 12-month period from lease_start to lease_end
//             (default lease_end = start + 5 years if not provided),
//             with each year's rent compounded by escalationRate.
//
// The mirrored RentScheduleEntry type in RentScheduleTable.tsx omits
// `lease_id` because that file describes the READ-side display row.
// Inserts require lease_id so this function returns it.

export interface RentScheduleRow {
  period_start: string;          // YYYY-MM-DD
  period_end: string | null;     // YYYY-MM-DD or null for open-ended single mode
  monthly_amount: number;
  annual_amount: number;
  notes: string | null;
  lease_id: string;
}

export type RentScheduleMode = 'single' | 'annual';

export interface GenerateRentScheduleInput {
  leaseId: string;
  /** Base monthly rent in dollars. Numeric — the caller is responsible for
   *  parsing "$5,000.00" form-input strings into a number. */
  baseRent: number;
  /** ISO date string (YYYY-MM-DD or full ISO). Required. */
  startDate: string;
  /** ISO date string or null. Null means open-ended (single mode) or
   *  default-5-years (annual mode). */
  endDate: string | null;
  /** Required for annual mode; ignored for single. Expressed as a fraction
   *  (e.g. 0.03 for 3%). The caller should divide by 100 if the source is
   *  a percentage. */
  escalationRate: number;
  mode: RentScheduleMode;
}

export type GenerateRentScheduleResult =
  | { ok: true; rows: RentScheduleRow[] }
  | { ok: false; reason: 'invalid_base_rent' | 'missing_escalation_rate' };

function isoDay(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Construct a Date at UTC midnight for the given (y, m, d). */
function utcDate(year: number, monthZeroBased: number, day: number): Date {
  return new Date(Date.UTC(year, monthZeroBased, day));
}

const ONE_DAY_MS = 86_400_000;

export function generateRentScheduleRows(input: GenerateRentScheduleInput): GenerateRentScheduleResult {
  const { leaseId, baseRent, startDate, endDate, escalationRate, mode } = input;

  if (!Number.isFinite(baseRent) || baseRent <= 0) {
    return { ok: false, reason: 'invalid_base_rent' };
  }

  // All date math is in UTC. `new Date('YYYY-MM-DD')` already parses as
  // UTC midnight, but `new Date(year, month, day)` uses local time, and
  // `toISOString()` always returns UTC — mixing the two off-by-ones the
  // result in non-UTC zones. The extracted version is consistent.
  const start = new Date(startDate);
  const end = endDate ? new Date(endDate) : null;

  if (mode === 'single') {
    return {
      ok: true,
      rows: [
        {
          period_start: isoDay(start),
          period_end: end ? isoDay(end) : null,
          monthly_amount: baseRent,
          annual_amount: baseRent * 12,
          notes: 'Generated — single period',
          lease_id: leaseId,
        },
      ],
    };
  }

  // annual mode
  if (!Number.isFinite(escalationRate) || escalationRate <= 0) {
    return { ok: false, reason: 'missing_escalation_rate' };
  }

  const effectiveEnd =
    end ??
    utcDate(start.getUTCFullYear() + 5, start.getUTCMonth(), start.getUTCDate());

  const rows: RentScheduleRow[] = [];
  let current = start;
  let rent = baseRent;

  while (current < effectiveEnd) {
    const next = utcDate(
      current.getUTCFullYear() + 1,
      current.getUTCMonth(),
      current.getUTCDate(),
    );
    const periodEnd = next > effectiveEnd ? effectiveEnd : new Date(next.getTime() - ONE_DAY_MS);
    rows.push({
      period_start: isoDay(current),
      period_end: isoDay(periodEnd),
      monthly_amount: Math.round(rent * 100) / 100,
      annual_amount: Math.round(rent * 12 * 100) / 100,
      notes: null,
      lease_id: leaseId,
    });
    rent = rent * (1 + escalationRate);
    current = next;
  }

  return { ok: true, rows };
}
