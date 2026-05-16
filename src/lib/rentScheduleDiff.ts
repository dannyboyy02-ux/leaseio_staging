// Pure rent-schedule diff classifier. Extracted from
// LeaseReview.handleScheduleChange (P2-04 monolith decomposition).
//
// The inline-edit table can mutate any combination of rows: edit a
// row in place, remove a row, or add a new one. New rows are
// identified by an id with the prefix below — assigned client-side
// when the user clicks "Add row" so the table renders correctly
// before the server-side id exists.
//
// This classifier answers the question: given the previous schedule
// and the user's edited schedule, what set of DELETE / INSERT /
// UPDATE operations should the page issue against rent_schedules?
//
// Stays defensive against stale state: a row with the new- prefix
// that somehow appears in `existing` is never proposed for deletion
// because there's no server row to delete. An updated row that's not
// in `existing` and has no new- prefix is treated as orphan and
// skipped — the page won't fabricate UPDATE calls against
// unknown ids.

export const NEW_ROW_ID_PREFIX = 'new-';

export function isNewRowId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(NEW_ROW_ID_PREFIX);
}

export interface RentScheduleRow {
  id: string;
  period_start: string;
  period_end: string | null;
  monthly_amount: number | null;
  annual_amount: number | null;
  notes: string | null;
}

export interface ClassifiedRentScheduleDiff {
  /** Ids the page should DELETE from rent_schedules. Never includes
   *  new- prefixed ids (those have no server row). */
  deleteIds: string[];
  /** Rows the page should INSERT. The new- prefix should be stripped
   *  before sending to the DB; the caller does that on its own. */
  inserts: RentScheduleRow[];
  /** Rows the page should UPDATE by id. Excludes any updated row
   *  whose id wasn't in `existing` and isn't a new- prefix (orphan). */
  updates: RentScheduleRow[];
}

export function classifyRentScheduleDiff(
  existing: readonly RentScheduleRow[],
  updated: readonly RentScheduleRow[],
): ClassifiedRentScheduleDiff {
  const existingIds = new Set(existing.map((r) => r.id));
  const updatedIds = new Set(updated.map((r) => r.id));

  const deleteIds: string[] = [];
  for (const e of existing) {
    if (updatedIds.has(e.id)) continue;
    // Defensive: a stale new- row in `existing` has no server row to delete.
    if (isNewRowId(e.id)) continue;
    deleteIds.push(e.id);
  }

  const inserts: RentScheduleRow[] = [];
  const updates: RentScheduleRow[] = [];
  for (const u of updated) {
    if (isNewRowId(u.id)) {
      inserts.push(u);
    } else if (existingIds.has(u.id)) {
      updates.push(u);
    }
    // Else: orphan id — not in existing, not new-prefixed. Skip.
  }

  return { deleteIds, inserts, updates };
}
