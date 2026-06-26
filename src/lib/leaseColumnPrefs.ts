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
// Defaults re-budgeted to CONTENT (sum = 100). The columns that must never
// truncate get the room: dates need ~"Mmm d, yyyy" (~73px at px-3), status
// holds "Fully Executed"/"Archived" pills, actions must clear the 32px kebab.
// Chrome (the dropped header icons, the removed "SF" suffix, px-3 padding) gave
// the space back. See docs/LEASES_TABLE_POLISH_PLAN — Round 2 geometry.
export const LEASE_COLUMNS: readonly LeaseColumnDef[] = [
  { key: 'property', defaultWidth: 14, resizable: true },
  { key: 'asset_type', defaultWidth: 6, resizable: true },
  { key: 'landlord', defaultWidth: 11, resizable: true },
  { key: 'monthly_rent', defaultWidth: 13, resizable: true },
  { key: 'lease_start', defaultWidth: 11, resizable: true },
  { key: 'lease_end', defaultWidth: 11, resizable: true },
  { key: 'days_to_expiry', defaultWidth: 8, resizable: true },
  { key: 'sqft', defaultWidth: 7, resizable: true },
  // status carries slack (short-label pills ~95px); the points went to the
  // dates + the overdue day-count badge so neither clips at default width.
  { key: 'status', defaultWidth: 13, resizable: true },
  { key: 'actions', defaultWidth: 6, resizable: false },
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

// ── Column visibility (the "Columns" show/hide menu) ───────────────────────

export const LEASE_HIDDEN_COLS_KEY = 'leaseio:leases:hiddenColumns';

/** Columns the user may show/hide. The rest (property, monthly_rent, status,
 *  actions) are the always-visible finance spine of the row. */
export const HIDEABLE_COLUMNS: readonly LeaseColumnKey[] = [
  'asset_type',
  'landlord',
  'lease_start',
  'lease_end',
  'days_to_expiry',
  'sqft',
];

/** Parse a stored hidden-columns JSON array → canonical-ordered hideable keys. */
export function parseStoredHidden(raw: string | null): LeaseColumnKey[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return HIDEABLE_COLUMNS.filter((k) => arr.includes(k));
  } catch {
    return [];
  }
}

export function serializeHidden(hidden: readonly LeaseColumnKey[]): string {
  return JSON.stringify(HIDEABLE_COLUMNS.filter((k) => hidden.includes(k)));
}

/** Toggle a hideable column's visibility, returning the new hidden list. A
 *  non-hideable key is ignored (those columns can't be hidden). */
export function toggleHidden(
  hidden: readonly LeaseColumnKey[],
  key: LeaseColumnKey,
): LeaseColumnKey[] {
  if (!HIDEABLE_COLUMNS.includes(key)) return [...hidden];
  const set = new Set(hidden);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return HIDEABLE_COLUMNS.filter((k) => set.has(k));
}

/** Adjacent pairs of VISIBLE resizable columns — the resize-handle partners.
 *  Recomputed from the hidden set so a hidden column never breaks a pairing
 *  (the handle on a column's right edge drives it + its next VISIBLE neighbor). */
export function visibleResizeBoundaries(
  hidden: readonly LeaseColumnKey[],
): Array<{ left: LeaseColumnKey; right: LeaseColumnKey }> {
  const h = new Set(hidden);
  const vis = LEASE_COLUMNS.filter((c) => c.resizable && !h.has(c.key)).map((c) => c.key);
  return vis.slice(0, -1).map((left, i) => ({ left, right: vis[i + 1] }));
}

// ── Auto-fit (double-click a column border) ────────────────────────────────

/**
 * Auto-fit `key` to a target width (% of the table), redistributing the delta
 * across the OTHER resizable columns so the total stays 100 (the table keeps
 * fitting — overflow option A). Growth is bounded by the others' collective
 * slack above MIN_COLUMN_WIDTH; the column never drops below MIN itself.
 */
export function autoFitColumn(
  widths: ColumnWidths,
  key: LeaseColumnKey,
  targetPct: number,
): ColumnWidths {
  if (!Number.isFinite(targetPct)) return widths;
  const col = LEASE_COLUMNS.find((c) => c.key === key);
  if (!col || !col.resizable) return widths;
  return redistribute(widths, key, Math.max(MIN_COLUMN_WIDTH, targetPct) - widths[key]);
}

/** Apply `delta` to `key` and take it (proportionally, clamped at MIN) from the
 *  other resizable columns, preserving the sum. Shared by auto-fit. */
function redistribute(widths: ColumnWidths, key: LeaseColumnKey, delta: number): ColumnWidths {
  if (!Number.isFinite(delta)) return widths;
  const others = LEASE_COLUMNS.filter((c) => c.resizable && c.key !== key).map((c) => c.key);
  let d = delta;
  if (d > 0) {
    const slack = others.reduce((s, k) => s + Math.max(0, widths[k] - MIN_COLUMN_WIDTH), 0);
    d = Math.min(d, slack); // can't take more than the others can give up
  } else {
    d = Math.max(d, MIN_COLUMN_WIDTH - widths[key]); // key can't go below MIN
  }
  if (Math.abs(d) < 0.05) return widths;
  const result: ColumnWidths = { ...widths, [key]: round1(widths[key] + d) };
  if (d > 0) {
    const slackTotal = others.reduce((s, k) => s + Math.max(0, widths[k] - MIN_COLUMN_WIDTH), 0) || 1;
    for (const k of others) {
      result[k] = round1(widths[k] - (Math.max(0, widths[k] - MIN_COLUMN_WIDTH) / slackTotal) * d);
    }
  } else {
    const total = others.reduce((s, k) => s + widths[k], 0) || 1;
    for (const k of others) {
      result[k] = round1(widths[k] + (widths[k] / total) * -d);
    }
  }
  return normalizeTo100(result);
}
