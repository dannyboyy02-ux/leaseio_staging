// ─────────────────────────────────────────────────────────────────────────
// Pure approval-chain helpers — Node mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Deno
// counterpart:
//   supabase/functions/_shared/approval_chain.ts
//
// Both files contain identical pure functions and types. The Deno copy is
// imported by the resolve-approval-chain and act-on-chain-step edge
// functions; this Node copy is imported by vitest unit tests in
// src/lib/__tests__/approvalChainLogic.test.ts.
//
// When you change one, change the other in the same commit. No imports
// allowed in either file (no React, no Supabase, no Deno-only or
// Node-only modules) — only language-level types and logic.
// ─────────────────────────────────────────────────────────────────────────

export type Stage = 'concept' | 'signator';
export type ChainStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'sent_back'
  | 'superseded'
  | 'delegated'
  | 'skipped';

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
  return stageSteps.every((s) => s.status === 'approved');
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
    .filter((s) => s.status === 'pending')
    .map((s) => s.step_order);
  if (pendingOrders.length === 0) return [];
  const minOrder = Math.min(...pendingOrders);
  return stageSteps
    .filter((s) => s.step_order === minOrder && s.status === 'pending')
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
    (s) => s.step_order === stepOrder && s.status === 'pending',
  );
  if (sameLevelPending) return false;
  return stageSteps.some(
    (s) => s.step_order > stepOrder && s.status === 'pending',
  );
}
