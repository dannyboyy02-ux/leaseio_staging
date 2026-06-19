// ─────────────────────────────────────────────────────────────────────────
// Lease lifecycle state vocabulary — Node mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Deno
// counterpart:
//   supabase/functions/_shared/lifecycle.ts
//
// Both files contain identical pure functions and types. This Node copy
// is imported by the frontend and by vitest unit tests in
// src/lib/__tests__/lifecycleStates.test.ts. The Deno copy is imported
// by the resolve-approval-chain and act-on-chain-step edge functions.
//
// When you change one, change the other in the same commit. No imports
// allowed in either file (no React, no Supabase, no Deno-only or
// Node-only modules) — only language-level types and logic.
//
// LIFECYCLE TRANSITION CONVENTION
// Anyone editing the chain helpers, the legacy hook, or the
// LeaseRequestForm submission flow is touching transition logic.
// Read CLAUDE.md → "Lifecycle Transition Convention" before changing
// how leases.lifecycle_status is updated. Brief: every lifecycle UPDATE
// bumps status_changed_at in the same statement; every status_change
// activity log row populates from_status + to_status as top-level
// columns AND the equivalent inside details, plus a routing_path tag.
// ─────────────────────────────────────────────────────────────────────────

// Phase 3 introduces a chain-vocabulary alongside the legacy vocabulary.
// Both coexist permanently — chain-driven leases use the new states, and
// leases that took the legacy fallback path keep using the old states.
// See docs/PHASE_3_BUILD_SPEC.md for the full mapping.

export type LegacyLifecycleStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'executed'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'cancelled';

export type ChainLifecycleStatus =
  | 'draft'
  | 'concept_submitted'
  | 'concept_under_review'
  | 'in_negotiation'
  | 'final_review'
  | 'pending_counter_signature'
  | 'fully_executed'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'cancelled'
  | 'chain_violation';

export type LifecycleStatus = LegacyLifecycleStatus | ChainLifecycleStatus;

// Maps a state to its semantic group. Used by display helpers and routing
// decisions. Legacy and chain states that mean the same thing share a group.
export const STATE_GROUPS = {
  pre_submission: ['draft'],
  awaiting_concept_approval: ['submitted', 'concept_submitted'],
  in_concept_review: ['under_review', 'concept_under_review'],
  post_concept_pre_signator: ['approved', 'in_negotiation'],
  signator_review: ['final_review'],
  awaiting_counter_signature: ['pending_counter_signature'],
  executed_pre_active: ['executed', 'fully_executed'],
  active: ['active'],
  terminal_negative: ['rejected', 'cancelled'],
  terminal_neutral: ['expired'],
  exception: ['chain_violation'],
} as const;

export type LifecycleGroup = keyof typeof STATE_GROUPS;

// Returns the semantic group of a state, or null if unknown.
export function groupOf(status: LifecycleStatus): LifecycleGroup | null {
  for (const [group, members] of Object.entries(STATE_GROUPS)) {
    if ((members as readonly string[]).includes(status)) return group as LifecycleGroup;
  }
  return null;
}

// Whether two states belong to the same semantic group. Returns false if
// either state is unknown (no group).
export function isEquivalent(a: LifecycleStatus, b: LifecycleStatus): boolean {
  const ga = groupOf(a);
  return ga !== null && ga === groupOf(b);
}

// Normalizes legacy → new for routing decisions where chain-driven leases
// need a unified vocabulary. Chain states pass through unchanged. Returns
// null for genuinely unknown values (defensive — should never happen with
// typed inputs).
export function normalizeToChainStates(status: LifecycleStatus): ChainLifecycleStatus | null {
  const map: Record<LegacyLifecycleStatus, ChainLifecycleStatus | null> = {
    draft: 'draft',
    submitted: 'concept_submitted',
    under_review: 'concept_under_review',
    approved: 'in_negotiation',
    executed: 'fully_executed',
    active: 'active',
    expired: 'expired',
    rejected: 'rejected',
    cancelled: 'cancelled',
  };
  if (status in map) return map[status as LegacyLifecycleStatus];
  // Already a chain status — return as-is (typed narrowing).
  return status as ChainLifecycleStatus;
}

// Display label for UI. Short, human-readable, no jargon. Legacy and chain
// pairs in the same semantic group return identical strings — the UI
// should not surface internal vocabulary differences to the user.
export function displayLabel(status: LifecycleStatus): string {
  const labels: Record<LifecycleStatus, string> = {
    draft: 'Draft',
    submitted: 'Submitted',
    under_review: 'Under Review',
    approved: 'Approved',
    executed: 'Executed',
    active: 'Active',
    expired: 'Expired',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    concept_submitted: 'Submitted',
    concept_under_review: 'Under Review',
    in_negotiation: 'In Negotiation',
    final_review: 'Final Review',
    pending_counter_signature: 'Awaiting Counter-Signature',
    fully_executed: 'Fully Executed',
    chain_violation: 'Chain Violation',
  };
  return labels[status] ?? status;
}

// Display label for a chain-step STAGE. Same rule as displayLabel: keep the
// internal stage codes out of the UI. 'concept' = the initial request approval
// (before negotiation); 'signator' = the final / signature approval (the
// execution-ready lease). One source of truth for the queue, audit log,
// violation banner, policy test dialog, and exception views.
export function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    concept: 'Initial approval',
    signator: 'Final approval',
  };
  return labels[stage] ?? stage;
}

// Display label for a workspace functional role. Keeps raw snake_case role
// codes ('manager_approver', etc.) out of the UI. Mirrors the labels the
// policy editor (ChainDiagram) surfaces; the snake_case fallback only fires
// for an unknown role.
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '';
  const labels: Record<string, string> = {
    submitter: 'Submitter',
    manager_approver: 'Manager',
    financial_approver: 'Finance',
    signator: 'Signatory',
    admin: 'Admin',
  };
  return labels[role] ?? role.replace(/_/g, ' ');
}

// Defines what transitions are valid from each state. Used to guard manual
// transitions in the UI and to validate state changes in edge functions.
// Phase 3 includes both legacy and chain transitions; rerouting (Phase 6)
// will introduce more.
export const VALID_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  // Legacy
  draft: ['submitted', 'concept_submitted', 'cancelled'],
  submitted: ['under_review', 'approved', 'rejected', 'cancelled'],
  under_review: ['approved', 'rejected', 'submitted', 'cancelled'],
  approved: ['executed', 'rejected', 'cancelled'],
  executed: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: [],
  rejected: [],
  cancelled: [],
  // Chain
  concept_submitted: ['concept_under_review', 'in_negotiation', 'rejected', 'cancelled'],
  concept_under_review: ['in_negotiation', 'rejected', 'concept_submitted', 'cancelled'],
  in_negotiation: ['final_review', 'rejected', 'cancelled'],
  final_review: ['pending_counter_signature', 'in_negotiation', 'rejected', 'cancelled'],
  pending_counter_signature: ['fully_executed', 'cancelled'],
  fully_executed: ['active', 'chain_violation', 'cancelled'],
  chain_violation: ['active', 'cancelled'],
};

// Returns true when (from, to) is in VALID_TRANSITIONS, false otherwise.
// Self-transitions are never valid (no state lists itself).
export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// All known states — useful for tests and exhaustive iteration.
export const ALL_STATES: LifecycleStatus[] = Object.keys(VALID_TRANSITIONS) as LifecycleStatus[];

// ─────────────────────────────────────────────────────────────────────────
// Counter-signature urgency (Phase 5)
//
// Drives the dashboard banner + reminder cadence for leases in the
// pending_counter_signature state. Pure date math — same input today
// = same output, no side effects.
//
// SYNC CONSTRAINT applies: the Deno mirror must match this logic
// byte-equivalent.
// ─────────────────────────────────────────────────────────────────────────

export type CounterSignatureUrgency =
  | 'on_track'           // Due date is more than 7 days away
  | 'approaching'        // Within 7 days of due date
  | 'due_today'          // Due today
  | 'overdue'            // Past due date
  | 'critically_overdue' // 14+ days past due
  | 'no_due_date';       // Defensive fallback

/**
 * Bucket a counter-signature due date into one of six urgency
 * categories relative to `today`. Day boundaries are calendar-day
 * coarse: anything within the same calendar day is "due_today",
 * regardless of HH:MM. Negative day counts wrap to overdue /
 * critically_overdue. Null due date returns no_due_date.
 *
 * The thresholds (>7 on_track, 1..7 approaching, 0 due_today,
 * -1..-13 overdue, <=-14 critically_overdue) are the spec's
 * reminder-cadence thresholds. Keep them in lockstep with the
 * send-counter-signature-reminder edge function.
 */
export function counterSignatureUrgency(
  dueDate: Date | string | null,
  today: Date = new Date(),
): CounterSignatureUrgency {
  if (dueDate === null || dueDate === undefined) return 'no_due_date';
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  if (Number.isNaN(due.getTime())) return 'no_due_date';

  // Compare at calendar-day granularity. Both sides truncated to
  // midnight UTC so HH:MM:SS noise within the same day doesn't flip
  // the bucket. Without this, a due_at="2026-05-20" and
  // today="2026-05-20T18:00" would compute to negative days.
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysUntil = Math.floor((dueDay - todayDay) / (1000 * 60 * 60 * 24));

  if (daysUntil > 7) return 'on_track';
  if (daysUntil > 0) return 'approaching';
  if (daysUntil === 0) return 'due_today';
  if (daysUntil > -14) return 'overdue';
  return 'critically_overdue';
}

/**
 * User-facing label for a counter-signature urgency bucket.
 */
export function counterSignatureUrgencyLabel(urgency: CounterSignatureUrgency): string {
  const labels: Record<CounterSignatureUrgency, string> = {
    on_track: 'On Track',
    approaching: 'Approaching Due Date',
    due_today: 'Due Today',
    overdue: 'Overdue',
    critically_overdue: 'Critically Overdue',
    no_due_date: 'No Due Date Set',
  };
  return labels[urgency];
}
