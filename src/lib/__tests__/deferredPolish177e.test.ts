import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #177e — two dashboard/lease polish fixes, pinned statically:
//
// 1. RentScheduleTable: the "Next Increase" tile used to label EVERY upcoming
//    period change an increase — a flat or decreasing step was mislabeled.
//    getNextChange() now compares the upcoming period's monthly_amount against
//    its predecessor (falling back to the currentMonthlyRent prop) and the
//    tile picks next_increase / next_decrease / next_change accordingly.
//
// 2. SummaryStrip: the two-bucket expiring dismiss was silent, per-device, and
//    irreversible. handleDismissExpiring() now snapshots both localStorage
//    buckets before merging, guards against double-clicks, and fires the
//    repo's sonner undo-toast pattern (Leases.tsx precedent) whose description
//    honestly scopes the action to this tile + this device.

const window = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `window start marker not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `window end marker not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe('RentScheduleTable — direction-aware next-change tile', () => {
  const src = read('src/components/leases/RentScheduleTable.tsx');

  it('getNextChange compares the upcoming amount against its predecessor', () => {
    const fn = window(src, 'const getNextChange', 'const startEdit');
    expect(fn).toContain('prevAmount');
    expect(fn).toContain("'increase'");
    expect(fn).toContain("'decrease'");
    // Falls back to the lease-level current rent when the first row is future
    expect(fn).toContain('currentMonthlyRent');
  });

  it('tile label is conditional on direction — all three keys present', () => {
    const tile = window(src, 'nextChange &&', 'rent_schedule.period');
    expect(tile).toContain('rent_schedule.next_increase');
    expect(tile).toContain('rent_schedule.next_decrease');
    expect(tile).toContain('rent_schedule.next_change');
  });

  it('the old unconditional getNextIncrease is gone', () => {
    expect(src).not.toContain('getNextIncrease');
  });
});

describe('SummaryStrip — combined expiring dismiss with sonner undo', () => {
  const src = read('src/components/dashboard/SummaryStrip.tsx');

  it("imports toast from 'sonner'", () => {
    expect(src).toMatch(/import\s*\{\s*toast\s*\}\s*from\s*'sonner'/);
  });

  it('snapshots both buckets BEFORE merging, with a double-click guard', () => {
    const fn = window(src, 'const handleDismissExpiring', 'useEffect(');
    // Raw pre-merge snapshots of both localStorage keys
    expect(fn).toContain('const prev90 = localStorage.getItem(key90)');
    expect(fn).toContain('const prev120 = localStorage.getItem(key120)');
    // Guard: nothing new to dismiss → early return keeps the first undo valid
    expect(fn).toContain('if (added.length === 0) return');
  });

  it('fires the undo toast with the honest per-device scope description', () => {
    const fn = window(src, 'const handleDismissExpiring', 'useEffect(');
    expect(fn).toContain("id: 'expiring-seen'");
    expect(fn).toContain("t('dashboard.marked_seen_toast')");
    expect(fn).toContain("t('dashboard.marked_seen_scope')");
    expect(fn).toContain("t('common.undo')");
    // Undo restores the exact snapshots (removeItem when the key was absent)
    expect(fn).toContain('localStorage.removeItem(key90)');
    expect(fn).toContain('localStorage.removeItem(key120)');
  });

  it('the expiring tile routes through the single combined handler', () => {
    expect(src).toContain('handleDismissExpiring : undefined');
    // The old per-bucket closure is gone
    expect(src).not.toContain("handleDismiss('90')");
    expect(src).not.toContain("handleDismiss('120')");
  });
});

describe('locale keys backing #177e exist non-empty in both files', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));
  const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);

  for (const key of [
    'rent_schedule.next_increase',
    'rent_schedule.next_decrease',
    'rent_schedule.next_change',
    'dashboard.marked_seen_toast',
    'dashboard.marked_seen_scope',
    'common.undo',
  ]) {
    it(`${key} present in en + es`, () => {
      expect(get(en, key), `en missing ${key}`).toBeTruthy();
      expect(get(es, key), `es missing ${key}`).toBeTruthy();
    });
  }
});
