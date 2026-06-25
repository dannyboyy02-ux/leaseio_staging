import { describe, it, expect } from 'vitest';
import { format, addDays, subDays } from 'date-fns';
import {
  getLeaseEnd,
  getDaysUntilExpiration,
  statusText,
  isArchivedDisplay,
  makeStatusSortKey,
  makeLeaseComparator,
  type LeaseSortRow,
  type LeaseSortField,
  type SortDirection,
} from '@/lib/leaseSort';

// The i18n'd label the page injects (t('archive.deleted_badge') === 'Archived').
const ARCHIVED_LABEL = 'Archived';

/** A minimal valid row; override only the fields a test exercises. */
function row(overrides: Partial<LeaseSortRow> = {}): LeaseSortRow {
  return {
    status: 'executed',
    lifecycle_status: 'executed',
    request_title: null,
    landlord_name: null,
    asset_type: null,
    property_address: null,
    lease_start: null,
    lease_end: null,
    executed_expiry_date: null,
    square_footage: null,
    extracted_json: null,
    filename: null,
    archived: false,
    rent_schedules: null,
    executed_monthly_payment: null,
    current_monthly_rent: null,
    monthly_payment: null,
    ...overrides,
  };
}

/** YYYY-MM-DD for a date N days from today (the SUT measures against `new Date()`). */
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

function sortRows(
  rows: LeaseSortRow[],
  field: LeaseSortField,
  direction: SortDirection,
  archivedLabel = ARCHIVED_LABEL,
): LeaseSortRow[] {
  const statusSortKey = makeStatusSortKey(archivedLabel);
  return [...rows].sort(makeLeaseComparator(field, direction, statusSortKey));
}

describe('statusText', () => {
  it('prefers lifecycle_status, underscores → spaces', () => {
    expect(statusText(row({ lifecycle_status: 'fully_executed', status: 'x' }))).toBe('fully executed');
  });
  it('falls back to status when lifecycle is null', () => {
    expect(statusText(row({ lifecycle_status: null, status: 'chain_violation' }))).toBe('chain violation');
  });
  it('empty when neither present', () => {
    expect(statusText(row({ lifecycle_status: null, status: '' }))).toBe('');
  });
});

describe('getLeaseEnd', () => {
  it('executed_expiry_date wins over lease_end', () => {
    expect(getLeaseEnd(row({ executed_expiry_date: '2030-01-01', lease_end: '2025-01-01' }))).toBe('2030-01-01');
  });
  it('falls back to lease_end', () => {
    expect(getLeaseEnd(row({ executed_expiry_date: null, lease_end: '2025-01-01' }))).toBe('2025-01-01');
  });
  it('null when neither present', () => {
    expect(getLeaseEnd(row())).toBeNull();
  });
});

describe('getDaysUntilExpiration', () => {
  it('null end date → null (no expiry)', () => {
    expect(getDaysUntilExpiration(null)).toBeNull();
  });
  // Pins the ACTUAL behavior: parseISO('not-a-date') yields an Invalid Date
  // (it does NOT throw), so differenceInDays returns NaN rather than hitting the
  // catch/null path. The try/catch only guards an outright throw. This mirrors
  // the previous inline implementation exactly. (See finding NaN-1 below.)
  it('unparseable date → NaN (not null — parseISO does not throw)', () => {
    expect(getDaysUntilExpiration('not-a-date')).toBeNaN();
  });
  it('future date → positive, past date → negative', () => {
    expect(getDaysUntilExpiration(iso(addDays(new Date(), 30)))).toBeGreaterThan(0);
    expect(getDaysUntilExpiration(iso(subDays(new Date(), 30)))).toBeLessThan(0);
  });
});

describe('isArchivedDisplay — "archived replaces lifecycle" decision', () => {
  it('true for an archived row (renders ONLY the Archived badge)', () => {
    expect(isArchivedDisplay(row({ archived: true, lifecycle_status: 'active' }))).toBe(true);
  });
  it('false for a non-archived row (renders the lifecycle badge)', () => {
    expect(isArchivedDisplay(row({ archived: false, lifecycle_status: 'active' }))).toBe(false);
  });
  it('false when archived is null/undefined', () => {
    expect(isArchivedDisplay(row({ archived: null }))).toBe(false);
    expect(isArchivedDisplay(row({ archived: undefined }))).toBe(false);
  });
});

describe('makeStatusSortKey', () => {
  it('an archived row sorts as "archived" regardless of its hidden lifecycle', () => {
    const key = makeStatusSortKey(ARCHIVED_LABEL);
    // archived=true with an active lifecycle still keys to the archived label.
    expect(key(row({ archived: true, lifecycle_status: 'active' }))).toBe('archived');
  });
  it('a non-archived row sorts by its lifecycle text (lowercased)', () => {
    const key = makeStatusSortKey(ARCHIVED_LABEL);
    expect(key(row({ archived: false, lifecycle_status: 'fully_executed' }))).toBe('fully executed');
  });
});

describe('makeLeaseComparator — status sort', () => {
  // statusSortKey lowercases; the alphabetical order of the *display* text is
  // what the user sees. 'active' < 'archived' < 'executed' < 'expired'.
  const active = row({ id: 'active', lifecycle_status: 'active', archived: false } as Partial<LeaseSortRow>);
  const archived = row({ id: 'arch', lifecycle_status: 'active', archived: true } as Partial<LeaseSortRow>);
  const executed = row({ id: 'exec', lifecycle_status: 'executed', archived: false } as Partial<LeaseSortRow>);
  const expired = row({ id: 'exp', lifecycle_status: 'expired', archived: false } as Partial<LeaseSortRow>);

  it('ascending orders by the displayed status text (archived sorts as "archived")', () => {
    const sorted = sortRows([expired, archived, executed, active], 'status', 'asc');
    expect(sorted.map((r) => statusKeyOf(r))).toEqual(['active', 'archived', 'executed', 'expired']);
  });

  it('descending reverses the order', () => {
    const sorted = sortRows([active, archived, executed, expired], 'status', 'desc');
    expect(sorted.map((r) => statusKeyOf(r))).toEqual(['expired', 'executed', 'archived', 'active']);
  });

  // archived row keys to the injected label, NOT its underlying 'active'
  // lifecycle — so it does NOT collide with the real active row in sort order.
  function statusKeyOf(r: LeaseSortRow): string {
    return makeStatusSortKey(ARCHIVED_LABEL)(r);
  }
});

describe('makeLeaseComparator — days_to_expiry (null end date last/farthest)', () => {
  const soon = row({ lease_end: iso(addDays(new Date(), 10)) });      // ~10d
  const later = row({ lease_end: iso(addDays(new Date(), 100)) });    // ~100d
  const past = row({ lease_end: iso(subDays(new Date(), 20)) });      // ~-20d (expired)
  const noEnd = row({ lease_end: null, executed_expiry_date: null }); // +Infinity

  it('ascending: expired first, then soonest → latest, no-end-date LAST (farthest out)', () => {
    const sorted = sortRows([noEnd, later, soon, past], 'days_to_expiry', 'asc');
    expect(sorted).toEqual([past, soon, later, noEnd]);
  });

  it('descending: no-end-date is STILL farthest out, so it comes FIRST', () => {
    // +Infinity is the largest value in both directions — a no-end lease has the
    // most runway, so descending (most-runway-first) puts it at the top.
    const sorted = sortRows([soon, noEnd, past, later], 'days_to_expiry', 'desc');
    expect(sorted[0]).toBe(noEnd);
    expect(sorted[sorted.length - 1]).toBe(past);
  });

  it('two no-end-date leases compare equal (both +Infinity) — stable, no throw', () => {
    const a = row({ id: 'a', lease_end: null } as Partial<LeaseSortRow>);
    const b = row({ id: 'b', lease_end: null } as Partial<LeaseSortRow>);
    const sorted = sortRows([a, b], 'days_to_expiry', 'asc');
    expect(sorted).toHaveLength(2);
  });
});

describe('makeLeaseComparator — ascending/descending toggle on other fields', () => {
  it('landlord ascending then descending are mirror images', () => {
    const alpha = row({ landlord_name: 'Alpha LLC' });
    const beta = row({ landlord_name: 'Beta LLC' });
    const gamma = row({ landlord_name: 'Gamma LLC' });
    const asc = sortRows([gamma, alpha, beta], 'landlord', 'asc').map((r) => r.landlord_name);
    const desc = sortRows([gamma, alpha, beta], 'landlord', 'desc').map((r) => r.landlord_name);
    expect(asc).toEqual(['Alpha LLC', 'Beta LLC', 'Gamma LLC']);
    expect(desc).toEqual(['Gamma LLC', 'Beta LLC', 'Alpha LLC']);
  });

  it('monthly_rent sorts numerically (not lexically) — 9 < 100', () => {
    const small = row({ monthly_payment: 9 });
    const big = row({ monthly_payment: 100 });
    const sorted = sortRows([big, small], 'monthly_rent', 'asc');
    expect(sorted).toEqual([small, big]);
  });

  it('sqft missing → 0, sorts before any positive value', () => {
    const none = row({ square_footage: null });
    const some = row({ square_footage: 500 });
    const sorted = sortRows([some, none], 'sqft', 'asc');
    expect(sorted).toEqual([none, some]);
  });
});
