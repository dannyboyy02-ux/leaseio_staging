/**
 * Pure sort + status-display logic for the Leases portfolio table.
 *
 * Extracted from `src/pages/Leases.tsx` so the comparator, the status sort key,
 * and the "archived replaces lifecycle" decision can be unit-pinned without
 * rendering the page (which pulls Supabase + contexts + router). The page now
 * imports these and supplies the i18n'd archived label via {@link makeStatusSortKey}.
 *
 * Behavior is intentionally identical to the previous inline implementation:
 *  - an archived row sorts as (and displays only) "Archived";
 *  - a no-end-date lease sorts as +Infinity on `days_to_expiry` (farthest out
 *    in BOTH directions — matching the cell, which renders it as "no expiry");
 *  - the status column sorts by the same text the badge shows.
 */
import { differenceInDays, parseISO } from 'date-fns';
import { getMonthlyRent, type MonthlyRentSource } from '@/lib/leaseCalculations';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';

export type LeaseSortField =
  | 'property'
  | 'asset_type'
  | 'landlord'
  | 'monthly_rent'
  | 'lease_start'
  | 'lease_end'
  | 'sqft'
  | 'days_to_expiry'
  | 'status';

export type SortDirection = 'asc' | 'desc';

/**
 * The fields the comparator + display helpers actually read. A structural
 * subset of the page's `LeaseRow`; kept minimal so the helper is decoupled from
 * the page's full row shape. Extends {@link MonthlyRentSource} for `monthly_rent`.
 */
export interface LeaseSortRow extends MonthlyRentSource {
  status: string;
  lifecycle_status: string | null;
  request_title?: string | null;
  landlord_name: string | null;
  asset_type: string | null;
  property_address?: string | null;
  lease_start: string | null;
  lease_end: string | null;
  executed_expiry_date?: string | null;
  square_footage: number | null;
  extracted_json?: Record<string, unknown> | null;
  filename?: string | null;
  archived?: boolean | null;
}

/** Display property/address with the same fallback chain the table renders. */
export function getPropertyAddress(lease: LeaseSortRow): string {
  const json = lease.extracted_json ?? null;
  return (
    lease.request_title ||
    lease.property_address ||
    getExtractedFieldValue(json?.address) ||
    lease.filename ||
    ''
  );
}

/** Executed expiry wins over the negotiated end date (mirrors the cell). */
export function getLeaseEnd(lease: LeaseSortRow): string | null {
  return lease.executed_expiry_date || lease.lease_end;
}

/** Days until expiry; null end date OR unparseable date → null. */
export function getDaysUntilExpiration(leaseEnd: string | null): number | null {
  if (!leaseEnd) return null;
  try {
    return differenceInDays(parseISO(leaseEnd), new Date());
  } catch {
    return null;
  }
}

/** Plain-text status for search + export (the visual badge is LeaseStatusBadge). */
export function statusText(lease: LeaseSortRow): string {
  return (lease.lifecycle_status || lease.status || '').replace(/_/g, ' ');
}

/**
 * True when the row should render ONLY the "Archived" badge and have its
 * lifecycle badge suppressed. Single source of truth for the cell AND the sort
 * key so the two never drift apart.
 */
export function isArchivedDisplay(lease: LeaseSortRow): boolean {
  return !!lease.archived;
}

/**
 * Build the Status-column sort key resolver. An archived lease shows ONLY the
 * "Archived" badge (its lifecycle is suppressed in the cell), so it must also
 * SORT as "Archived" — matching what the user sees — rather than by a hidden
 * lifecycle value. Non-archived rows sort by their lifecycle text.
 *
 * @param archivedLabel the i18n'd "Archived" badge label (e.g. t('archive.deleted_badge'))
 */
export function makeStatusSortKey(
  archivedLabel: string,
): (lease: LeaseSortRow) => string {
  return (lease: LeaseSortRow): string =>
    (isArchivedDisplay(lease) ? archivedLabel : statusText(lease)).toLowerCase();
}

/**
 * Build a stable comparator for the given field/direction. `statusSortKey` is
 * injected (it carries the i18n'd archived label) so this stays pure.
 *
 * The `days_to_expiry` case maps a no-end-date lease to +Infinity so it lands
 * at the "most runway" end regardless of direction — same as the cell, which
 * treats a no-date lease as "no expiry / farthest out".
 */
export function makeLeaseComparator(
  sortField: LeaseSortField,
  sortDirection: SortDirection,
  statusSortKey: (lease: LeaseSortRow) => string,
): (a: LeaseSortRow, b: LeaseSortRow) => number {
  return (a, b) => {
    let aVal: string | number = '';
    let bVal: string | number = '';

    switch (sortField) {
      case 'property':
        aVal = getPropertyAddress(a).toLowerCase();
        bVal = getPropertyAddress(b).toLowerCase();
        break;
      case 'asset_type':
        aVal = (a.asset_type || '').toLowerCase();
        bVal = (b.asset_type || '').toLowerCase();
        break;
      case 'landlord':
        aVal = (a.landlord_name || '').toLowerCase();
        bVal = (b.landlord_name || '').toLowerCase();
        break;
      case 'monthly_rent':
        aVal = getMonthlyRent(a);
        bVal = getMonthlyRent(b);
        break;
      case 'lease_start':
        aVal = a.lease_start || '';
        bVal = b.lease_start || '';
        break;
      case 'lease_end':
        aVal = getLeaseEnd(a) || '';
        bVal = getLeaseEnd(b) || '';
        break;
      case 'sqft':
        aVal = a.square_footage || 0;
        bVal = b.square_footage || 0;
        break;
      case 'days_to_expiry': {
        // No end date = no expiry = farthest out: sort as +Infinity so it
        // lands at the "most runway" end in both directions, consistent
        // with how the cell renders a no-date lease.
        const ad = getDaysUntilExpiration(getLeaseEnd(a));
        const bd = getDaysUntilExpiration(getLeaseEnd(b));
        aVal = ad === null ? Number.POSITIVE_INFINITY : ad;
        bVal = bd === null ? Number.POSITIVE_INFINITY : bd;
        break;
      }
      case 'status':
        aVal = statusSortKey(a);
        bVal = statusSortKey(b);
        break;
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  };
}
