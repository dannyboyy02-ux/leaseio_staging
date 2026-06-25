// Pure, dependency-free helpers + constants for the resizable Leases table
// columns. Mirrors the `sidebarPrefs.ts` pattern: side-effect-free (no React,
// no DOM) so they're unit-testable and can be read synchronously inside a
// useState initializer (avoids a first-paint flash of the default layout).
//
// Column widths are PERCENTAGES of the table width and sum to 100 across the
// full (desktop) column set. With `table-fixed` + `w-full`, that means the
// table ALWAYS fits its container — columns share the viewport instead of
// forcing a horizontal scroll. A resize drags the boundary between two adjacent
// columns: the left grows by the same amount the right shrinks, so the total
// stays 100 and the table keeps fitting. Resize is a lg+ affordance (where the
// full column set is visible and the boundary pairing is exact); below lg the
// responsive column-hiding keeps the remaining columns fitting.

export const LEASE_COLUMN_WIDTHS_KEY = 'leaseio:leases:columnWidths';

export type LeaseColumnKey =
  | 'property'
  | 'asset_type'
  | 'landlord'
  | 'monthly_rent'
  | 'lease_start'
  | 'lease_end'
  | 'days_to_expiry'
  | 'sqft'
  | 'status'
  | 'actions';

export interface LeaseColumnDef {
  key: LeaseColumnKey;
  /** Default width as a percentage of the table; the full set sums to 100. */
  defaultWidth: number;
  /** Whether the column participates in resizing (Actions is a fixed control column). */
  resizable: boolean;
}

/** Floor (in %) so a column can never be dragged to nothing. Kept at/below the
 *  smallest default (the fixed Actions column, 4) so resolve() never re-floors a
 *  legitimately-narrow column and breaks idempotency. */
export const MIN_COLUMN_WIDTH = 3;

// Canonical column order + default proportions (sum = 100). STABLE keys (not
// labels) so i18n / renames never invalidate a persisted layout.
export const LEASE_COLUMNS: readonly LeaseColumnDef[] = [
  { key: 'property', defaultWidth: 20, resizable: true },
  { key: 'asset_type', defaultWidth: 8, resizable: true },
  { key: 'landlord', defaultWidth: 14, resizable: true },
  { key: 'monthly_rent', defaultWidth: 11, resizable: true },
  { key: 'lease_start', defaultWidth: 9, resizable: true },
  { key: 'lease_end', defaultWidth: 9, resizable: true },
  { key: 'days_to_expiry', defaultWidth: 8, resizable: true },
  { key: 'sqft', defaultWidth: 7, resizable: true },
  { key: 'status', defaultWidth: 10, resizable: true },
  { key: 'actions', defaultWidth: 4, resizable: false },
] as const;

export type ColumnWidths = Record<LeaseColumnKey, number>;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = LEASE_COLUMNS.reduce(
  (acc, c) => ({ ...acc, [c.key]: c.defaultWidth }),
  {} as ColumnWidths,
);

const ALL_KEYS = LEASE_COLUMNS.map((c) => c.key);

/** The resize boundaries: each adjacent pair of RESIZABLE columns, in order.
 *  A handle on the left column's right edge drives the (left, right) pair. */
export const RESIZE_BOUNDARIES: ReadonlyArray<{ left: LeaseColumnKey; right: LeaseColumnKey }> =
  LEASE_COLUMNS.filter((c) => c.resizable).flatMap((c, i, arr) =>
    i < arr.length - 1 ? [{ left: c.key, right: arr[i + 1].key }] : [],
  );

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Scale a width map so its values sum to ~100 (guarantees table fit). Idempotent:
 *  a map already summing within rounding tolerance of 100 is returned rounded but
 *  un-rescaled, so parse(serialize(x)) === x. */
export function normalizeTo100(widths: ColumnWidths): ColumnWidths {
  const total = ALL_KEYS.reduce((sum, k) => sum + (widths[k] || 0), 0);
  if (total <= 0) return { ...DEFAULT_COLUMN_WIDTHS };
  const rounded = {} as ColumnWidths;
  // Max post-round drift is 0.05 per column × 10 columns = 0.5; skip rescaling
  // inside that band so rounding can't perturb an already-normalized map.
  const factor = Math.abs(total - 100) <= 0.5 ? 1 : 100 / total;
  for (const k of ALL_KEYS) rounded[k] = round1((widths[k] || 0) * factor);
  return rounded;
}

/**
 * Merge a (possibly partial / corrupt) width map onto the defaults: unknown
 * keys dropped, missing keys filled from defaults, each value coerced to a
 * finite number floored at MIN_COLUMN_WIDTH, then normalized to sum 100. Always
 * returns a complete, fit-guaranteed map.
 */
export function resolveColumnWidths(partial: unknown): ColumnWidths {
  const merged = { ...DEFAULT_COLUMN_WIDTHS };
  if (partial && typeof partial === 'object') {
    for (const k of ALL_KEYS) {
      const v = (partial as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        merged[k] = Math.max(MIN_COLUMN_WIDTH, v);
      }
    }
  }
  return normalizeTo100(merged);
}

/** Parse a localStorage JSON string into a resolved width map; defaults on any error. */
export function parseStoredColumnWidths(raw: string | null): ColumnWidths {
  if (raw == null) return { ...DEFAULT_COLUMN_WIDTHS };
  try {
    return resolveColumnWidths(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

export function serializeColumnWidths(widths: ColumnWidths): string {
  return JSON.stringify(widths);
}

/**
 * Move the boundary between two adjacent columns by `deltaPct` percentage
 * points: the left column grows by the applied delta and the right shrinks by
 * the same amount, so the total is preserved (the table keeps fitting). The
 * delta is clamped so neither column drops below MIN_COLUMN_WIDTH.
 */
export function applyBoundaryResize(
  widths: ColumnWidths,
  leftKey: LeaseColumnKey,
  rightKey: LeaseColumnKey,
  deltaPct: number,
): ColumnWidths {
  if (!Number.isFinite(deltaPct) || leftKey === rightKey) return widths;
  const left = widths[leftKey];
  const right = widths[rightKey];
  // left + d >= MIN  →  d >= MIN - left ; right - d >= MIN  →  d <= right - MIN
  const d = Math.min(Math.max(deltaPct, MIN_COLUMN_WIDTH - left), right - MIN_COLUMN_WIDTH);
  if (d === 0) return widths;
  return { ...widths, [leftKey]: round1(left + d), [rightKey]: round1(right - d) };
}
