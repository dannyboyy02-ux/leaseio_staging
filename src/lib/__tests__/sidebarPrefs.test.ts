import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAV_ORDER,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  applyReorder,
  clampWidth,
  parseStoredNavOrder,
  parseStoredWidth,
  validateNavOrder,
} from '../sidebarPrefs';

// Pure-helper coverage for the collapsible/resizable/reorderable sidebar.
// These guard the localStorage round-trip (Phase 1–3 persistence) against
// corruption, drift (a renamed/removed nav key), and out-of-range widths.

describe('clampWidth', () => {
  it('keeps in-range widths (rounded)', () => {
    expect(clampWidth(256)).toBe(256);
    expect(clampWidth(300.6)).toBe(301);
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(clampWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampWidth(NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampWidth(Infinity)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('validateNavOrder', () => {
  it('returns the canonical order when input is not an array', () => {
    expect(validateNavOrder(null)).toEqual([...DEFAULT_NAV_ORDER]);
    expect(validateNavOrder('garbage')).toEqual([...DEFAULT_NAV_ORDER]);
    expect(validateNavOrder({})).toEqual([...DEFAULT_NAV_ORDER]);
  });

  it('preserves a valid custom order', () => {
    const custom = ['reports', 'leases', 'dashboard', 'firm', 'approvals', 'portfolio'];
    expect(validateNavOrder(custom)).toEqual(custom);
  });

  it('drops unknown keys and de-dupes', () => {
    expect(validateNavOrder(['leases', 'ghost', 'leases', 'dashboard'])).toEqual([
      'leases',
      'dashboard',
      // appended in canonical order:
      'firm',
      'approvals',
      'portfolio',
      'reports',
    ]);
  });

  it('appends newly shipped keys missing from a saved order', () => {
    // Saved order predates the `firm` key shipping.
    const saved = ['dashboard', 'leases', 'approvals', 'portfolio', 'reports'];
    expect(validateNavOrder(saved)).toEqual([
      'dashboard',
      'leases',
      'approvals',
      'portfolio',
      'reports',
      'firm',
    ]);
  });

  it('honors a custom known set', () => {
    expect(validateNavOrder(['b', 'z', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

describe('parseStoredWidth', () => {
  it('defaults on null', () => {
    expect(parseStoredWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
  it('parses and clamps a stored number', () => {
    expect(parseStoredWidth('320')).toBe(320);
    expect(parseStoredWidth('5000')).toBe(SIDEBAR_MAX_WIDTH);
  });
  it('defaults on non-numeric junk', () => {
    expect(parseStoredWidth('not-a-number')).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('parseStoredNavOrder', () => {
  it('defaults on null', () => {
    expect(parseStoredNavOrder(null)).toEqual([...DEFAULT_NAV_ORDER]);
  });
  it('defaults on malformed JSON', () => {
    expect(parseStoredNavOrder('{not json')).toEqual([...DEFAULT_NAV_ORDER]);
  });
  it('parses + validates a stored array', () => {
    expect(parseStoredNavOrder(JSON.stringify(['leases', 'dashboard']))).toEqual([
      'leases',
      'dashboard',
      'firm',
      'approvals',
      'portfolio',
      'reports',
    ]);
  });
});

describe('applyReorder', () => {
  const full = ['dashboard', 'leases', 'firm', 'approvals', 'portfolio', 'reports'];

  it('moves a visible item and preserves hidden-item slots', () => {
    // `firm` + `approvals` are hidden (not draggable for this user).
    const visible = ['dashboard', 'leases', 'portfolio', 'reports'];
    // Drag `reports` onto `dashboard` (to the front of the visible list).
    const result = applyReorder(full, visible, 'reports', 'dashboard');
    // Hidden firm/approvals stay in their original index slots; visible items
    // refill the remaining slots in the new order.
    expect(result).toEqual(['reports', 'dashboard', 'firm', 'approvals', 'leases', 'portfolio']);
  });

  it('reorders the full visible set', () => {
    const visible = [...full];
    expect(applyReorder(full, visible, 'dashboard', 'reports')).toEqual([
      'leases',
      'firm',
      'approvals',
      'portfolio',
      'reports',
      'dashboard',
    ]);
  });

  it('no-ops (returns a copy) when ids match or are missing', () => {
    const visible = [...full];
    expect(applyReorder(full, visible, 'leases', 'leases')).toEqual(full);
    expect(applyReorder(full, visible, 'leases', 'ghost')).toEqual(full);
    const copy = applyReorder(full, visible, 'leases', 'leases');
    expect(copy).not.toBe(full);
  });
});
