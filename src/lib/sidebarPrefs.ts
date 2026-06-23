// Pure, dependency-free helpers + constants for the collapsible / resizable /
// reorderable app sidebar. Kept side-effect-free (no React, no DOM) so they're
// unit-testable and so SidebarContext can call them inside a useState
// initializer — reading persisted state synchronously avoids a first-paint
// flash of the default layout.

export const SIDEBAR_COLLAPSED_KEY = 'leaseio:sidebar:collapsed';
export const SIDEBAR_WIDTH_KEY = 'leaseio:sidebar:width';
export const SIDEBAR_NAV_ORDER_KEY = 'leaseio:sidebar:navOrder';

export const SIDEBAR_DEFAULT_WIDTH = 256; // matches the legacy `w-64`
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_COLLAPSED_WIDTH = 72;

// Canonical order of the reorderable standard-nav items. These are STABLE keys
// (not labels) so i18n / future renames never invalidate a persisted order.
// The Firm entry participates in the order (product decision 2026-06-23) but is
// only rendered when the user is a firm member.
export const DEFAULT_NAV_ORDER = [
  'dashboard',
  'leases',
  'firm',
  'approvals',
  'portfolio',
  'reports',
] as const;

export type NavKey = (typeof DEFAULT_NAV_ORDER)[number];

/** Clamp an arbitrary width to the allowed expanded range; NaN/∞ → default. */
export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/**
 * Reconcile a persisted nav order against the currently-known key set:
 *  - drop unknown keys (features that were removed),
 *  - keep known keys in their saved relative order,
 *  - append any known keys missing from the saved order (newly shipped items).
 * Falls back to the canonical order on any malformed input.
 */
export function validateNavOrder(
  saved: unknown,
  known: readonly string[] = DEFAULT_NAV_ORDER,
): string[] {
  if (!Array.isArray(saved)) return [...known];
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of saved) {
    if (typeof item === 'string' && knownSet.has(item) && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  // Append any known keys not present in the saved order (canonical position).
  for (const key of known) {
    if (!seen.has(key)) result.push(key);
  }
  return result;
}

/** Parse a localStorage width string; clamp/normalize, fall back to default. */
export function parseStoredWidth(raw: string | null): number {
  if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
  const n = Number(raw);
  return Number.isFinite(n) ? clampWidth(n) : SIDEBAR_DEFAULT_WIDTH;
}

/** Parse a localStorage nav-order JSON string; validate, fall back to default. */
export function parseStoredNavOrder(raw: string | null): string[] {
  if (raw == null) return [...DEFAULT_NAV_ORDER];
  try {
    return validateNavOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_NAV_ORDER];
  }
}

/**
 * Apply a drag-reorder of the VISIBLE items back onto the FULL persisted order.
 *
 * Only visible items are draggable, but the persisted order also carries hidden
 * items (e.g. Approvals for a submitter-only user, Firm for a non-firm user).
 * This moves `activeId` to `overId`'s slot among the visible items, then splices
 * the new visible sequence back into `fullOrder` while leaving every hidden
 * item exactly where it was. Returns a new array; no-ops return a copy.
 */
export function applyReorder(
  fullOrder: string[],
  visibleKeys: string[],
  activeId: string,
  overId: string,
): string[] {
  const oldIndex = visibleKeys.indexOf(activeId);
  const newIndex = visibleKeys.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return [...fullOrder];
  }
  const newVisible = [...visibleKeys];
  const [moved] = newVisible.splice(oldIndex, 1);
  newVisible.splice(newIndex, 0, moved);

  const visibleSet = new Set(visibleKeys);
  let vi = 0;
  return fullOrder.map((key) => (visibleSet.has(key) ? newVisible[vi++] : key));
}
