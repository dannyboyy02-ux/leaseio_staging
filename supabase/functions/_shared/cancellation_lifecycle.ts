// Cancellation-lifecycle pure logic (ratified 2026-06-12).
// Frontend source of truth: src/lib/cancellationLifecycle.ts — keep in sync.
//
// Policy: subscription fully ends → 30-day read-only grace (view + export)
// → soft-delete (access revoked, hidden) → hard purge ~10 days later.
// Reminder emails at days 0/7/14/21/27 and a final notice on the last day.

export const GRACE_DAYS = 30;
export const PURGE_BUFFER_DAYS = 10;

export type CancellationNoticeType =
  | 'day0'
  | 'day7'
  | 'day14'
  | 'day21'
  | 'day27'
  | 'day30_final';

/** Notice fires once daysSinceCanceled >= atDay (daily cron cadence). The
 *  final notice arms on day 29 so it lands ON the last day of access —
 *  soft-delete only triggers at >= GRACE_DAYS, one cron cycle later. */
export const NOTICE_SCHEDULE: ReadonlyArray<{ type: CancellationNoticeType; atDay: number }> = [
  { type: 'day0', atDay: 0 },
  { type: 'day7', atDay: 7 },
  { type: 'day14', atDay: 14 },
  { type: 'day21', atDay: 21 },
  { type: 'day27', atDay: 27 },
  { type: 'day30_final', atDay: 29 },
];

export type LifecycleState = 'active' | 'grace' | 'soft_deleted' | 'purge_due';

export interface LifecycleFields {
  canceledAt: string | null;
  graceExpiresAt: string | null;
  softDeletedAt: string | null;
  purgeAfter: string | null;
}

/** Derive the workspace's cancellation state. 'active' covers every
 *  not-canceled workspace (including trialing/past_due — dunning is a
 *  different lane and must never start the deletion clock). */
export function deriveLifecycleState(f: LifecycleFields, now: Date = new Date()): LifecycleState {
  if (f.softDeletedAt) {
    return f.purgeAfter && now.getTime() >= new Date(f.purgeAfter).getTime()
      ? 'purge_due'
      : 'soft_deleted';
  }
  if (f.canceledAt) return 'grace';
  return 'active';
}

export function daysSinceCanceled(canceledAt: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(canceledAt).getTime()) / 86_400_000);
}

/** Whole days of view/export access remaining (clamped at 0). */
export function graceDaysRemaining(graceExpiresAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(graceExpiresAt).getTime() - now.getTime()) / 86_400_000));
}

/** Notice types due for sending given the cycle age and what was already
 *  sent this cycle. A cron that was down for days catches up but the
 *  per-(cycle, type) ledger uniqueness still prevents double-sends. */
export function dueNotices(
  canceledAt: string,
  alreadySent: ReadonlySet<string>,
  now: Date = new Date(),
): CancellationNoticeType[] {
  const age = daysSinceCanceled(canceledAt, now);
  return NOTICE_SCHEDULE.filter((n) => age >= n.atDay && !alreadySent.has(n.type)).map(
    (n) => n.type,
  );
}
