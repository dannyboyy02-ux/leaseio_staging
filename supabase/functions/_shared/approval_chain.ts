// ─────────────────────────────────────────────────────────────────────────
// Pure approval-chain helpers — Deno mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Node
// counterpart:
//   src/lib/approvalChainLogic.ts
//
// Both files contain identical pure functions and types. This Deno copy
// is imported by the resolve-approval-chain and act-on-chain-step edge
// functions; the Node copy is imported by vitest unit tests in
// src/lib/__tests__/approvalChainLogic.test.ts.
//
// When you change one, change the other in the same commit. No imports
// allowed in either file (no React, no Supabase, no Deno-only or
// Node-only modules) — only language-level types and logic.
//
// LIFECYCLE TRANSITION CONVENTION
// Anyone editing the chain helpers is likely also touching transition
// logic. Read CLAUDE.md → "Lifecycle Transition Convention" before
// changing how lease.lifecycle_status is updated. Brief: every lifecycle
// UPDATE bumps status_changed_at in the same statement; every
// status_change activity log row populates from_status + to_status as
// top-level columns AND the equivalent inside details, plus a
// routing_path tag. The chain-driven helpers in act-on-chain-step
// (updateLifecycle, logStatusChange) implement this; the form-path
// writer in LeaseRequestForm matches.
// ─────────────────────────────────────────────────────────────────────────

export type Stage = "concept" | "signator";
export type ChainStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "sent_back"
  | "superseded"
  | "delegated"
  | "skipped";

/**
 * Minimal row shape used by the helpers. Edge functions and tests pass in
 * the columns they actually need; extra columns on the row are ignored.
 */
export interface ChainStepLike {
  stage: Stage;
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  is_required: boolean;
  status: ChainStatus;
}

/**
 * Effective separation-of-duties rule.
 * - Workspace default applies when policy override is null.
 * - Policy override (true/false) supersedes workspace default when set.
 * Returns true when "require distinct users" is in effect.
 */
export function getEffectiveSeparationOfDuties(
  workspaceDefault: boolean,
  policyOverride: boolean | null,
): boolean {
  if (policyOverride === null || policyOverride === undefined) {
    return workspaceDefault;
  }
  return policyOverride === true;
}

/**
 * Returns null when separation of duties is satisfied, else the violating
 * user id. Only inspects steps with a concrete approver_user_id; role-only
 * steps don't carry a user and so cannot collide.
 */
export function checkSeparationOfDuties(
  steps: ChainStepLike[],
  effective: boolean,
): string | null {
  if (!effective) return null;
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.approver_user_id) {
      if (seen.has(s.approver_user_id)) return s.approver_user_id;
      seen.add(s.approver_user_id);
    }
  }
  return null;
}

/**
 * A stage is complete when every required step in that stage has
 * status='approved'. Optional steps don't block completion regardless of
 * their status (they can stay pending or be skipped).
 */
export function isStageComplete(steps: ChainStepLike[], stage: Stage): boolean {
  const stageSteps = steps.filter((s) => s.stage === stage && s.is_required);
  if (stageSteps.length === 0) return false; // No required steps = never "complete"
  return stageSteps.every((s) => s.status === "approved");
}

/**
 * Find the next batch of assignees that should be notified for a given
 * stage. "Next batch" = the lowest step_order in that stage with any
 * pending required step; all parallel siblings at that step_order are
 * returned. Each assignee is either a userId or a role.
 *
 * Returns [] when:
 *   - The stage has no pending required steps
 *   - The stage doesn't exist in the given rows
 */
export function findFirstPendingAssignees(
  steps: ChainStepLike[],
  stage: Stage,
): { userId: string | null; role: string | null }[] {
  const stageSteps = steps.filter((s) => s.stage === stage && s.is_required);
  if (stageSteps.length === 0) return [];
  const pendingOrders = stageSteps
    .filter((s) => s.status === "pending")
    .map((s) => s.step_order);
  if (pendingOrders.length === 0) return [];
  const minOrder = Math.min(...pendingOrders);
  return stageSteps
    .filter((s) => s.step_order === minOrder && s.status === "pending")
    .map((s) => ({
      userId: s.approver_user_id,
      role: s.approver_role,
    }));
}

/**
 * After a step is approved, decide whether the stage just advanced past
 * the step's step_order. Returns true when:
 *   - Every required step at the just-resolved step_order is approved
 *   - AND there exist required pending steps at higher step_orders (we
 *     "advanced" past this level but the stage isn't fully complete)
 *
 * Use isStageComplete() separately to tell whether the whole stage just
 * finished. Together: stage advanced iff (advancedPastLevel || stageComplete).
 */
export function advancedPastStepOrder(
  steps: ChainStepLike[],
  stage: Stage,
  stepOrder: number,
): boolean {
  const stageSteps = steps.filter((s) => s.stage === stage && s.is_required);
  const sameLevelPending = stageSteps.some(
    (s) => s.step_order === stepOrder && s.status === "pending",
  );
  if (sameLevelPending) return false;
  return stageSteps.some(
    (s) => s.step_order > stepOrder && s.status === "pending",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 — Chain reconciliation helpers
// ─────────────────────────────────────────────────────────────────────────
//
// When a lease's policy-triggering attributes change and the resolver
// re-runs in reroute mode, the new chain composition must be reconciled
// against the existing chain. Approvers who are still required keep
// their existing rows (and any prior approval action); approvers who
// are no longer required get marked superseded; new approvers get
// pending rows inserted.
//
// Identity for matching is by (stage, approver_user_id) for user-based
// rows or (stage, approver_role) for role-based rows. step_order and
// parallel_group can shift between chains — the identity is who the
// approver is, not what position they occupy. Mixed identity types
// (a user-based existing row vs. a role-based new row for the same
// person, or vice versa) do NOT match: they're treated as a
// supersede + add pair so the audit trail captures the change in
// assignment style.
//
// These helpers are pure. Side effects (UPDATEs, INSERTs, activity
// log writes) live in resolve-approval-chain. The same SYNC CONSTRAINT
// applies — Node and Deno mirrors must stay byte-equivalent in
// behavior.

/**
 * Stable identity key for a chain step. User-based steps key on
 * stage + user; role-based steps key on stage + role. Per the
 * chain_assignee_present CHECK, exactly one of (approver_user_id,
 * approver_role) is non-null per row.
 *
 * Steps with neither set (which the CHECK should prevent at the DB
 * layer) get a defensive synthetic key derived from step_order +
 * parallel_group so they don't all collide on the same key.
 */
function chainStepIdentity(step: ChainStepLike): string {
  if (step.approver_user_id) {
    return `${step.stage}::user::${step.approver_user_id}`;
  }
  if (step.approver_role) {
    return `${step.stage}::role::${step.approver_role}`;
  }
  return `${step.stage}::orphan::${step.step_order}::${step.parallel_group}`;
}

/**
 * Reconciles two chains by step identity. Returns three disjoint lists:
 *   - preserved: steps that exist in BOTH (returned from `existing` so
 *     callers see the live status / action history)
 *   - superseded: steps in `existing` whose identity is NOT in the new
 *     chain — these get marked status='superseded' by the resolver
 *   - added: steps in `newChain` whose identity is NOT in the existing
 *     chain — these get inserted as fresh pending rows
 *
 * preserved.length + superseded.length === existing.length
 * preserved.length + added.length === newChain.length (when matched
 * 1:1; duplicates within a chain are collapsed by the Set semantics)
 */
export function reconcileChainSteps(
  existing: ChainStepLike[],
  newChain: ChainStepLike[],
): {
  preserved: ChainStepLike[];
  superseded: ChainStepLike[];
  added: ChainStepLike[];
} {
  const newKeys = new Set(newChain.map(chainStepIdentity));
  const existingKeys = new Set(existing.map(chainStepIdentity));

  const preserved: ChainStepLike[] = [];
  const superseded: ChainStepLike[] = [];
  for (const s of existing) {
    if (newKeys.has(chainStepIdentity(s))) {
      preserved.push(s);
    } else {
      superseded.push(s);
    }
  }

  const added: ChainStepLike[] = newChain.filter(
    (s) => !existingKeys.has(chainStepIdentity(s)),
  );

  return { preserved, superseded, added };
}

/**
 * Determines the lifecycle stage the lease should roll back to after a
 * reroute. Only ADDED required steps can pull the lease backward — a
 * preserved step is already accounted for, an optional added step
 * doesn't gate stage completion.
 *
 * Returns the EARLIEST unsatisfied stage:
 *   - any added required concept step → 'concept_under_review'
 *   - else any added required signator step → 'final_review'
 *   - else 'no_rollback_needed'
 *
 * The caller (resolve-approval-chain) computes the actual lifecycle
 * value as min(current_lifecycle, this_target) — if the lease is
 * already earlier than the target, no transition happens. If the
 * lease has executed (fully_executed / active) and this target is
 * non-trivial, the resolver instead sets lifecycle to 'chain_violation'
 * and surfaces it for retroactive resolution.
 *
 * The 'concept_submitted' and 'in_negotiation' values appear in the
 * return type for forward-compat with future phases that might
 * distinguish those rollback shapes; the current logic never returns
 * them.
 */
export function rollbackTargetForNewChain(
  newChain: ChainStepLike[],
  reconciled: { preserved: ChainStepLike[]; added: ChainStepLike[] },
):
  | "concept_submitted"
  | "concept_under_review"
  | "in_negotiation"
  | "final_review"
  | "no_rollback_needed" {
  const requiredAdded = reconciled.added.filter((s) => s.is_required);
  if (requiredAdded.length === 0) return "no_rollback_needed";

  if (requiredAdded.some((s) => s.stage === "concept")) {
    return "concept_under_review";
  }
  if (requiredAdded.some((s) => s.stage === "signator")) {
    return "final_review";
  }
  return "no_rollback_needed";
}
