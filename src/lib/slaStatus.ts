// KNOWN_ISSUES #111 C6 — per-policy SLA aging. Pure helper that turns a chain
// step's pending_since + its policy's sla_days into an aging status, so the
// blocking approver sees an "over SLA" signal in ApprovalQueue (not just the
// admin ExceptionsDashboard). Node-only (UI surface); detect-stuck-chains keeps
// its own Deno threshold for now (per-policy stuck detection is a noted
// extension). NULL/unset sla_days falls back to DEFAULT_SLA_DAYS.

export const DEFAULT_SLA_DAYS = 7;

export interface SlaStatus {
  /** Whole days the step has been the active wait, or null if not pending. */
  daysPending: number | null;
  /** True once daysPending >= the effective SLA. */
  overSla: boolean;
  /** The SLA applied (the policy's sla_days, or DEFAULT_SLA_DAYS when unset). */
  slaDays: number;
}

export function effectiveSlaDays(slaDays?: number | null): number {
  return slaDays != null && slaDays > 0 ? slaDays : DEFAULT_SLA_DAYS;
}

export function pendingSlaStatus(
  pendingSince: string | null,
  slaDays?: number | null,
  now: Date = new Date(),
): SlaStatus {
  const sla = effectiveSlaDays(slaDays);
  if (!pendingSince) return { daysPending: null, overSla: false, slaDays: sla };
  const t = new Date(pendingSince).getTime();
  if (Number.isNaN(t)) return { daysPending: null, overSla: false, slaDays: sla };
  const daysPending = Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
  return { daysPending, overSla: daysPending >= sla, slaDays: sla };
}
