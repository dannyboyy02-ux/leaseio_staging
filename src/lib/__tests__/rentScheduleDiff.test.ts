import { describe, it, expect } from 'vitest';
import {
  classifyRentScheduleDiff,
  isNewRowId,
  NEW_ROW_ID_PREFIX,
  type RentScheduleRow,
} from '../rentScheduleDiff';

function row(p: Partial<RentScheduleRow> & { id: string }): RentScheduleRow {
  return {
    id: p.id,
    period_start: p.period_start ?? '2026-01-01',
    period_end: p.period_end ?? '2026-12-31',
    monthly_amount: p.monthly_amount ?? 1000,
    annual_amount: p.annual_amount ?? 12000,
    notes: p.notes ?? null,
  };
}

describe('isNewRowId', () => {
  it('returns true for ids with the new- prefix', () => {
    expect(isNewRowId(`${NEW_ROW_ID_PREFIX}abc`)).toBe(true);
    expect(isNewRowId('new-')).toBe(true);
    expect(isNewRowId('new-12345')).toBe(true);
  });

  it('returns false for persisted uuids', () => {
    expect(isNewRowId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isNewRowId('abc-new-')).toBe(false);
  });
});

describe('classifyRentScheduleDiff', () => {
  it('classifies a no-op diff as all updates, no inserts, no deletes', () => {
    const e1 = row({ id: 'a' });
    const e2 = row({ id: 'b' });
    const result = classifyRentScheduleDiff([e1, e2], [e1, e2]);
    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([]);
    expect(result.updates.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('flags a removed row for deletion', () => {
    const e1 = row({ id: 'a' });
    const e2 = row({ id: 'b' });
    const result = classifyRentScheduleDiff([e1, e2], [e1]);
    expect(result.deleteIds).toEqual(['b']);
    expect(result.updates.map((r) => r.id)).toEqual(['a']);
    expect(result.inserts).toEqual([]);
  });

  it('flags a new-prefixed row as an insert', () => {
    const e1 = row({ id: 'a' });
    const fresh = row({ id: 'new-1' });
    const result = classifyRentScheduleDiff([e1], [e1, fresh]);
    expect(result.inserts).toHaveLength(1);
    expect(result.inserts[0].id).toBe('new-1');
    expect(result.updates.map((r) => r.id)).toEqual(['a']);
    expect(result.deleteIds).toEqual([]);
  });

  it('handles add + edit + delete in one diff', () => {
    const before = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const after = [
      row({ id: 'a', monthly_amount: 999 }),
      row({ id: 'c' }),
      row({ id: 'new-x' }),
    ];
    const result = classifyRentScheduleDiff(before, after);
    expect(result.deleteIds).toEqual(['b']);
    expect(result.inserts.map((r) => r.id)).toEqual(['new-x']);
    expect(result.updates.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('never deletes a new-prefixed id (defensive against stale state)', () => {
    const before = [row({ id: 'new-stale' }), row({ id: 'real-uuid' })];
    const after = [row({ id: 'real-uuid' })];
    const result = classifyRentScheduleDiff(before, after);
    expect(result.deleteIds).toEqual([]);
  });

  it('skips orphan updated rows (id not in existing, no new- prefix)', () => {
    const before = [row({ id: 'a' })];
    const after = [row({ id: 'a' }), row({ id: 'orphan-uuid' })];
    const result = classifyRentScheduleDiff(before, after);
    expect(result.updates.map((r) => r.id)).toEqual(['a']);
    expect(result.inserts).toEqual([]);
  });

  it('insert order matches the position of new- rows in the updated array', () => {
    const before = [row({ id: 'a' })];
    const after = [row({ id: 'new-1' }), row({ id: 'a' }), row({ id: 'new-2' })];
    const result = classifyRentScheduleDiff(before, after);
    expect(result.inserts.map((r) => r.id)).toEqual(['new-1', 'new-2']);
  });

  it('does not mutate its inputs', () => {
    const e1 = row({ id: 'a' });
    const e2 = row({ id: 'b' });
    const existing = [e1, e2];
    const updated = [e1];
    const existingSnapshot = [...existing];
    const updatedSnapshot = [...updated];
    classifyRentScheduleDiff(existing, updated);
    expect(existing).toEqual(existingSnapshot);
    expect(updated).toEqual(updatedSnapshot);
  });
});
