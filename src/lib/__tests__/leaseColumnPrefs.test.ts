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
  type ColumnWidths,
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
    expect(next.property).toBe(23);
    expect(next.asset_type).toBe(5);
    expect(sum(next)).toBe(100);
  });

  it('clamps the delta so neither column drops below the minimum', () => {
    // asset_type default 8 can only give up 3 before hitting MIN (5)
    const next = applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', 50);
    expect(next.asset_type).toBe(MIN_COLUMN_WIDTH);
    expect(next.property).toBe(20 + (8 - MIN_COLUMN_WIDTH));
    expect(sum(next)).toBe(100);
  });

  it('supports shrinking the left column (negative delta)', () => {
    const next = applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', -3);
    expect(next.property).toBe(17);
    expect(next.asset_type).toBe(11);
    expect(sum(next)).toBe(100);
  });

  it('is a no-op for equal keys or a non-finite delta', () => {
    expect(applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'property', 5)).toBe(DEFAULT_COLUMN_WIDTHS);
    expect(applyBoundaryResize(DEFAULT_COLUMN_WIDTHS, 'property', 'asset_type', Number.NaN)).toBe(DEFAULT_COLUMN_WIDTHS);
  });
});
