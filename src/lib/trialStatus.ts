// Shared trial-countdown math so the sidebar pill and the subscription
// banner can never disagree on the day count. Both surfaces derive their
// "days left" from this single helper (auditor LOW, 2026-06-11).

/**
 * Whole days remaining until `periodEnd`, clamped at 0. Returns null when
 * there is no valid period end (no trial / un-mirrored subscription).
 *
 * Uses ceil so a partial final day still reads as "1 day left" until the
 * actual moment of expiry; the day-of-charge (and any webhook-lag window
 * past expiry) collapses to 0, which callers render as "ends today".
 */
export function trialDaysRemaining(periodEnd: string | null | undefined): number | null {
  if (!periodEnd) return null;
  const end = new Date(periodEnd).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}
