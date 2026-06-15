// Firm-context navigation helpers (Phase 10). Pure, dependency-free, frontend.
//
// These drive FirmContext + the sidebar/switcher (CP4): which firm is active,
// how urgent a pending inbox action is, and which navigation mode the sidebar
// shows. They are UI logic and have NO Deno mirror — the genuinely
// cross-runtime firm helper (authority gating) lives in `firmAccess.ts`
// (isFirmAdminOrOwner), which edge functions share via _shared/firm_access.ts.
// If a future edge function needs urgency/context server-side, move that helper
// to firmAccess (mirrored) at that point rather than mirroring this whole file.

import type { FirmRole } from './firmAccess';

export type FirmMembership = {
  firm_id: string;
  firm_name: string;
  // The user's role in this firm. 'owner' is surfaced distinctly from
  // 'firm_admin' so the UI can show ownership, but both are admin-authority
  // (see isFirmAdminOrOwner in firmAccess.ts).
  role: FirmRole | 'owner';
};

// Resolve which firm is the active context. Prefers the persisted selection
// (profiles.current_firm_id) when the user is still a member; otherwise falls
// back to the first membership in the provided order (the caller sorts — e.g.
// by firm name — so the fallback is stable). Returns null for non-firm users.
export function resolveActiveFirm(
  memberships: FirmMembership[],
  persistedFirmId: string | null,
): FirmMembership | null {
  if (memberships.length === 0) return null;
  if (persistedFirmId) {
    const match = memberships.find((m) => m.firm_id === persistedFirmId);
    if (match) return match;
  }
  return memberships[0];
}

// Urgency of a pending inbox action, derived from how long it has been waiting.
// Thresholds are deliberately conservative for a finance audience (a few days
// of approval latency is normal; a week+ is overdue).
export type ActionUrgency = 'fresh' | 'aging' | 'overdue';

export const URGENCY_AGING_DAYS = 3;
export const URGENCY_OVERDUE_DAYS = 7;

export function computeActionUrgency(
  pendingSinceIso: string | null,
  nowMs: number,
): ActionUrgency {
  if (!pendingSinceIso) return 'fresh';
  const pendingMs = Date.parse(pendingSinceIso);
  if (Number.isNaN(pendingMs)) return 'fresh';
  const days = (nowMs - pendingMs) / (1000 * 60 * 60 * 24);
  if (days >= URGENCY_OVERDUE_DAYS) return 'overdue';
  if (days >= URGENCY_AGING_DAYS) return 'aging';
  return 'fresh';
}

// Which navigation mode the sidebar renders (spec §sidebar refactor):
//   'workspace'  — no firm membership, or a standalone workspace: existing nav
//   'firm'       — firm member on a /app/firm route: firm-level nav
//   'firm_child' — firm member viewing a firm-bound child workspace: workspace
//                  nav + a "back to firm" affordance
export type FirmSidebarMode = 'workspace' | 'firm' | 'firm_child';

export function computeFirmSidebarMode(input: {
  hasFirmMembership: boolean;
  onFirmRoute: boolean;
  activeWorkspaceFirmId: string | null;
}): FirmSidebarMode {
  if (!input.hasFirmMembership) return 'workspace';
  if (input.onFirmRoute) return 'firm';
  if (input.activeWorkspaceFirmId) return 'firm_child';
  return 'workspace';
}
