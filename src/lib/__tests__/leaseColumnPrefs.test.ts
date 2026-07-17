import { describe, it, expect } from 'vitest';
import {
  LEASE_COLUMNS,
  DEFAULT_COLUMN_WIDTHS,
  RESIZE_BOUNDARIES,
  MIN_COLUMN_WIDTH,
  normalizeTo100,
  resolveColumnWidths,
  parseStoredColumnWidths,
  serializeColumnWidths,
  applyBoundaryResize,
  HIDEABLE_COLUMNS,
  parseStoredHidden,
  serializeHidden,
  toggleHidden,
  visibleResizeBoundaries,
  autoFitColumn,
  type ColumnWidths,
  type LeaseColumnKey,
} from '@/lib/leaseColumnPrefs';

const sum = (w: ColumnWidths) => Object.values(w).reduce((a, b) => a + b, 0);

describe('column model', () => {
  it('default widths sum to 100', () => {
    expect(sum(DEFAULT_COLUMN_WIDTHS)).toBe(100);
  });

  it('has a width entry for every defined column', () => {
    for (const c of LEASE_COLUMNS) {
      expect(DEFAULT_COLUMN_WIDTHS[c.key]).toBe(c.defaultWidth);
    }
  });

  it('exposes one resize boundary between each adjacent pair of resizable columns', () => {
    const resizable = LEASE_COLUMNS.filter((c) => c.resizable);
    expect(RESIZE_BOUNDARIES).toHaveLength(resizable.length - 1);
    // boundaries never involve the non-resizable Actions column
    for (const b of RESIZE_BOUNDARIES) {
      expect(b.left).not.toBe('actions');
      expect(b.right).not.toBe('actions');
    }
    expect(RESIZE_BOUNDARIES[0]).toEqual({ left: 'property', right: 'asset_type' });
    expect(RESIZE_BOUNDARIES[RESIZE_BOUNDARIES.length - 1]).toEqual({ left: 'sqft', right: 'status' });
  });
});

describe('normalizeTo100', () => {
  it('scales an arbitrary map to sum 100', () => {
    const doubled = Object.fromEntries(
      Object.entries(DEFAULT_COLUMN_WIDTHS).map(([k, v]) => [k, v * 2]),
    ) as ColumnWidths;
    expect(sum(normalizeTo100(doubled))).toBeCloseTo(100, 0);
  });

  it('falls back to defaults when total is non-positive', () => {
    const zeroed = Object.fromEntries(
      Object.keys(DEFAULT_COLUMN_WIDTHS).map((k) => [k, 0]),
    ) as ColumnWidths;
    expect(normalizeTo100(zeroed)).toEqual(DEFAULT_COLUMN_WIDTHS);
  });
});

describe('resolveColumnWidths', () => {
  it('returns normalized defaults for empty / non-object input', () => {
    expect(resolveColumnWidths({})).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(resolveColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(resolveColumnWidths('nope')).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('ignores unknown keys and fills missing ones from defaults', () => {
    const resolved = resolveColumnWidths({ property: 30, bogus: 999 });
    expect(sum(resolved)).toBeCloseTo(100, 0);
    expect(resolved).not.toHaveProperty('bogus');
    // property was larger than default, so it keeps a larger share after normalize
    expect(resolved.property).toBeGreaterThan(resolved.status);
  });

  it('floors any sub-minimum value before normalizing (never collapses a column)', () => {
    const resolved = resolveColumnWidths({ status: 0.1 });
    expect(resolved.status).toBeGreaterThan(0);
    expect(sum(resolved)).toBeCloseTo(100, 0);
  });
});

describe('parse / serialize', () => {
  it('round-trips through serialize', () => {
    const resolved = resolveColumnWidths({ property: 25 });
    expect(parseStoredColumnWidths(serializeColumnWidths(resolved))).toEqual(resolved);
  });

  it('returns defaults for null or malformed JSON', () => {
    expect(parseStoredColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(parseStoredColumnWidths('{not json')).toEqual(DEFAULT_COLUMN_WIDTHS);
  });
});

describe('applyBoundaryResize', () => {
  it('grows the left column and shrinks the right by the same amount (total preserved)', () => {
    const next = applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', 3);
    expect(next.property).toBe(DEFAULT_COLUMN_WIDTHS.property + 3);
    expect(next.asset_type).toBe(DEFAULT_COLUMN_WIDTHS.asset_type - 3);
    expect(sum(next)).toBe(100);
  });

  it('clamps the delta so neither column drops below the minimum', () => {
    // asset_type can only give up (default - MIN) before hitting the floor.
    const next = applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', 50);
    expect(next.asset_type).toBe(MIN_COLUMN_WIDTH);
    expect(next.property).toBe(DEFAULT_COLUMN_WIDTHS.property + (DEFAULT_COLUMN_WIDTHS.asset_type - MIN_COLUMN_WIDTH));
    expect(sum(next)).toBe(100);
  });

  it('supports shrinking the left column (negative delta)', () => {
    const next = applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', -3);
    expect(next.property).toBe(DEFAULT_COLUMN_WIDTHS.property - 3);
    expect(next.asset_type).toBe(DEFAULT_COLUMN_WIDTHS.asset_type + 3);
    expect(sum(next)).toBe(100);
  });

  it('is a no-op for equal keys or a non-finite delta', () => {
    expect(applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'property', 5)).toBe(DEFAULT_COLUMN_WIDTHS);
    expect(applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', Number.NaN)).toBe(DEFAULT_COLUMN_WIDTHS);
  });
});

describe('column visibility', () => {
  it('toggleHidden adds/removes a hideable column and keeps canonical order', () => {
    const a = toggleHidden([], 'landlord');
    expect(a).toEqual(['landlord']);
    const b = toggleHidden(a, 'asset_type');
    expect(b).toEqual(['asset_type', 'landlord']); // canonical order, not insertion order
    expect(toggleHidden(b, 'landlord')).toEqual(['asset_type']);
  });

  it('toggleHidden ignores always-visible columns', () => {
    expect(toggleHidden([], 'property')).toEqual([]);
    expect(toggleHidden([], 'status')).toEqual([]);
    expect(toggleHidden([], 'actions')).toEqual([]);
  });

  it('parse/serialize round-trips and drops non-hideable / malformed entries', () => {
    expect(parseStoredHidden(serializeHidden(['landlord', 'sqft']))).toEqual(['landlord', 'sqft']);
    // First visit / unreadable prefs → the density defaults (2026-07-17):
    // dates + sqft start hidden; days-to-expiry carries the date signal.
    expect(parseStoredHidden(null)).toEqual(['lease_start', 'lease_end', 'sqft']);
    expect(parseStoredHidden('{bad')).toEqual(['lease_start', 'lease_end', 'sqft']);
    expect(parseStoredHidden(JSON.stringify(['property', 'landlord', 'bogus']))).toEqual(['landlord']);
  });

  it('visibleResizeBoundaries pairs adjacent VISIBLE resizable columns', () => {
    const none = visibleResizeBoundaries([]);
    expect(none[0]).toEqual({ left: 'property', right: 'asset_type' });
    // hide asset_type → property now pairs with landlord (the next visible resizable)
    const hid = visibleResizeBoundaries(['asset_type']);
    expect(hid[0]).toEqual({ left: 'property', right: 'landlord' });
    expect(hid.every((b) => b.left !== 'asset_type' && b.right !== 'asset_type')).toBe(true);
    // boundaries never include the non-resizable actions column
    expect(none.every((b) => b.left !== 'actions' && b.right !== 'actions')).toBe(true);
  });
});

describe('autoFitColumn', () => {
  it('grows a column toward its target and preserves the total (still fits)', () => {
    const next = autoFitColumn(DEFAULT_COLUMN_WIDTHS, 'property', 30);
    expect(next.property).toBeGreaterThan(DEFAULT_COLUMN_WIDTHS.property);
    expect(next.property).toBeLessThanOrEqual(30);
    expect(sum(next)).toBeCloseTo(100, 0);
  });

  it('shrinks a column toward a smaller target', () => {
    const next = autoFitColumn(DEFAULT_COLUMN_WIDTHS, 'status', 8);
    expect(next.status).toBeLessThan(DEFAULT_COLUMN_WIDTHS.status);
    expect(sum(next)).toBeCloseTo(100, 0);
  });

  it('never pushes any column below the minimum', () => {
    const next = autoFitColumn(DEFAULT_COLUMN_WIDTHS, 'property', 95);
    for (const c of LEASE_COLUMNS) {
      expect(next[c.key as LeaseColumnKey]).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    }
    expect(sum(next)).toBeCloseTo(100, 0);
  });

  it('is a no-op for a non-resizable column or non-finite target', () => {
    expect(autoFitColumn(DEFAULT_COLUMN_WIDTHS, 'actions', 20)).toBe(DEFAULT_COLUMN_WIDTHS);
    expect(autoFitColumn(DEFAULT_COLUMN_WIDTHS, 'property', Number.NaN)).toBe(DEFAULT_COLUMN_WIDTHS);
  });
});
