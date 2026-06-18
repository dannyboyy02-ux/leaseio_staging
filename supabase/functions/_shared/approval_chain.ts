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

// ─────────────────────────────────────────────────────────────────────────
// Phase 7 — Effective assignee resolution + delegate timer + stuck check
// ─────────────────────────────────────────────────────────────────────────
//
// Phase 7 adds three sources of "who can act on this step" beyond the
// original policy_user / policy_role: voluntary delegation (per-step,
// user-initiated), out-of-office routing (workspace-level, declared in
// advance), policy delegate timeout (the latent delegate_user_id /
// delegate_after_days config from Phase 1, finally activated), and
// admin reassignment (override path).
//
// resolveEffectiveAssignee is the single source of truth for "who can
// act now." Edge functions and the `effective_assignee_user_id` denormalized
// column on lease_approval_chain must always agree with what this
// helper returns — the column is convenience for queries; the helper
// is correctness.
//
// Same SYNC CONSTRAINT applies — Node and Deno mirrors must stay
// byte-equivalent in behavior.

export type AssigneeResolutionSource =
  | "policy_user"
  | "policy_role"
  | "policy_delegate"
  | "ooo_delegate"
  | "voluntary_delegate"
  | "admin_reassign";

/**
 * Inputs for resolveEffectiveAssignee. All "active" semantics are
 * pushed up to the caller — these fields represent the CURRENT state
 * for each source (e.g., voluntary_delegate_user_id is non-null only
 * when an active, un-revoked voluntary delegation exists; ooo_delegate
 * is non-null only when an OOO record covers `now`).
 *
 * This keeps the helper pure: it doesn't reach into a database or run
 * windowing logic; it just applies priority rules over a pre-resolved
 * snapshot.
 */
export interface AssigneeContext {
  policy_user_id: string | null;
  policy_role: string | null;
  policy_delegate_user_id: string | null;
  policy_delegate_after_days: number | null;
  voluntary_delegate_user_id: string | null;
  ooo_delegate_user_id: string | null;
  admin_reassigned_user_id: string | null;
  pending_since: Date | string | null;
}

/**
 * Returns true if the policy delegate would activate based on time
 * elapsed since the step became pending. Pure function — no I/O.
 *
 * All three of (delegate_user_id, delegate_after_days, pending_since)
 * must be non-null. delegate_after_days is in days; the threshold is
 * `pending_since + delegate_after_days * 24h`. Comparison is `>=` so
 * "exactly N days elapsed" activates.
 */
export function shouldActivatePolicyDelegate(
  pending_since: Date | string | null,
  delegate_after_days: number | null,
  delegate_user_id: string | null,
  now: Date = new Date(),
): boolean {
  if (!pending_since || delegate_after_days == null || !delegate_user_id) {
    return false;
  }
  const since = pending_since instanceof Date ? pending_since : new Date(pending_since);
  if (Number.isNaN(since.getTime())) return false;
  if (delegate_after_days < 0) return false;
  const thresholdMs = delegate_after_days * 24 * 60 * 60 * 1000;
  return now.getTime() - since.getTime() >= thresholdMs;
}

/**
 * Returns true if a step has been pending without action longer than
 * the threshold. Default threshold is 7 days, matching the
 * detect-stuck-chains scheduled function. Pure function.
 *
 * pending_since null → false (the step isn't yet the active blocker).
 */
export function isStepStuck(
  pending_since: Date | string | null,
  threshold_days: number = 7,
  now: Date = new Date(),
): boolean {
  if (!pending_since) return false;
  if (threshold_days < 0) return false;
  const since = pending_since instanceof Date ? pending_since : new Date(pending_since);
  if (Number.isNaN(since.getTime())) return false;
  const thresholdMs = threshold_days * 24 * 60 * 60 * 1000;
  return now.getTime() - since.getTime() >= thresholdMs;
}

/**
 * Computes the effective assignee at a given moment based on a snapshot
 * of all assignment sources for a chain step.
 *
 * Priority order (highest to lowest):
 *   1. admin_reassign — admin override always wins
 *   2. voluntary_delegate — current user-declared intent
 *   3. ooo_delegate — current user-declared OOO routing
 *   4. policy_delegate — only if shouldActivatePolicyDelegate is true
 *   5. policy_user — original explicit assignment
 *   6. policy_role — original role-based assignment
 *
 * Returns the resolved (user_id, role, source). When the source is
 * 'policy_role' the user_id is null and role carries the value;
 * otherwise role is null and user_id carries the resolved user.
 *
 * If NO source produces a non-null assignee (which the
 * chain_assignee_present DB CHECK should prevent), defaults to
 * 'policy_role' with both fields null. This keeps the function total
 * — every call returns a structurally valid result.
 */
export function resolveEffectiveAssignee(
  ctx: AssigneeContext,
  now: Date = new Date(),
): { user_id: string | null; role: string | null; source: AssigneeResolutionSource } {
  if (ctx.admin_reassigned_user_id) {
    return { user_id: ctx.admin_reassigned_user_id, role: null, source: "admin_reassign" };
  }
  if (ctx.voluntary_delegate_user_id) {
    return { user_id: ctx.voluntary_delegate_user_id, role: null, source: "voluntary_delegate" };
  }
  if (ctx.ooo_delegate_user_id) {
    return { user_id: ctx.ooo_delegate_user_id, role: null, source: "ooo_delegate" };
  }
  if (
    shouldActivatePolicyDelegate(
      ctx.pending_since,
      ctx.policy_delegate_after_days,
      ctx.policy_delegate_user_id,
      now,
    )
  ) {
    return { user_id: ctx.policy_delegate_user_id, role: null, source: "policy_delegate" };
  }
  if (ctx.policy_user_id) {
    return { user_id: ctx.policy_user_id, role: null, source: "policy_user" };
  }
  if (ctx.policy_role) {
    return { user_id: null, role: ctx.policy_role, source: "policy_role" };
  }
  return { user_id: null, role: null, source: "policy_role" };
}

// ── #111 C1: frontier active-step predicate ─────────────────────────────────
// Pure spec-mirror of the backfill migration 20260618150000's frontier WHERE
// clause (and of resolve-approval-chain / advance-to-final-review creation
// semantics): a pending REQUIRED step is the "active" wait the lease is blocked
// on iff no earlier still-blocking required step exists for that lease.
//   earlier   = concept stage before signator, then lower step_order
//   blocking  = status is "pending" or "sent_back" (approved/skipped/superseded/
//               rejected no longer block)
//   parallel  = same stage + same step_order are co-active (neither is "earlier")
// Keep in lockstep with the migration. detect-stuck-chains / process-delegate-
// timers trust that any pending row with non-null pending_since is the active
// blocker, so the backfill must set pending_since on exactly these rows.
export interface FrontierStepLike {
  stage: "concept" | "signator";
  step_order: number;
  status: string;
  is_required: boolean;
}

const FRONTIER_STAGE_RANK: Record<string, number> = { concept: 0, signator: 1 };
const FRONTIER_BLOCKING_STATUSES = new Set(["pending", "sent_back"]);

export function isFrontierActiveRequiredStep(
  step: FrontierStepLike,
  allStepsForLease: FrontierStepLike[],
): boolean {
  // The backfill only targets pending + required rows.
  if (!step.is_required || step.status !== "pending") return false;
  const myRank = FRONTIER_STAGE_RANK[step.stage] ?? 1;
  const hasEarlierBlocker = allStepsForLease.some((other) => {
    if (!other.is_required || !FRONTIER_BLOCKING_STATUSES.has(other.status)) return false;
    const otherRank = FRONTIER_STAGE_RANK[other.stage] ?? 1;
    return (
      otherRank < myRank ||
      (otherRank === myRank && other.step_order < step.step_order)
    );
  });
  return !hasEarlierBlocker;
}
