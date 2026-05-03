// Pure validation rules for the Approval Policy editor. Extracted from
// ApprovalPolicyEditPage so they can be tested in isolation (no React, no
// Supabase, no DOM).
//
// Mirrors the spec in docs/PHASE_1_BUILD_SPEC.md ("Validation rules to
// enforce in the UI"). Server-side, these are reinforced by CHECK
// constraints and the partial-unique index on default_fallback.

export type SodMode = 'inherit' | 'allow' | 'require';

export interface ChainStepLike {
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days: number | null;
  is_required: boolean;
}

export interface PolicyFormLike {
  name: string;
  priority: number;
  match_min_annual_cost: string;
  match_max_annual_cost: string;
  sod_mode: SodMode;
}

export interface ValidationContext {
  /** The workspace's separation_of_duties_default flag — used when sod_mode is 'inherit'. */
  workspaceSodDefault: boolean;
}

/**
 * Returns the first validation error message, or null when the policy is
 * valid. Error messages are user-facing and surface in a toast.
 */
export function validatePolicy(
  form: PolicyFormLike,
  conceptSteps: ChainStepLike[],
  signatorSteps: ChainStepLike[],
  ctx: ValidationContext
): string | null {
  // Identity
  if (!form.name.trim()) return 'Name is required.';
  if (!Number.isInteger(form.priority) || form.priority <= 0)
    return 'Priority must be a positive integer.';

  // Cost range
  const min =
    form.match_min_annual_cost.trim() === '' ? null : parseFloat(form.match_min_annual_cost);
  const max =
    form.match_max_annual_cost.trim() === '' ? null : parseFloat(form.match_max_annual_cost);
  if (min != null && !Number.isFinite(min)) return 'Min annual cost is invalid.';
  if (max != null && !Number.isFinite(max)) return 'Max annual cost is invalid.';
  if (min != null && max != null && min > max)
    return 'Min annual cost must be ≤ max annual cost.';

  // Chain shape
  if (conceptSteps.length === 0) return 'At least one concept-chain step is required.';
  if (signatorSteps.length === 0) return 'At least one signator-chain step is required.';

  // Per-step shape + duplicate (parallel_group, step_order) inside a stage
  for (const stage of [
    { steps: conceptSteps, label: 'Concept' },
    { steps: signatorSteps, label: 'Signator' },
  ]) {
    const seen = new Set<string>();
    for (const s of stage.steps) {
      if (!Number.isInteger(s.step_order) || s.step_order <= 0)
        return `${stage.label}: step order must be a positive integer.`;
      if (!Number.isInteger(s.parallel_group) || s.parallel_group <= 0)
        return `${stage.label}: parallel group must be a positive integer.`;
      const userSet = !!s.approver_user_id;
      const roleSet = !!s.approver_role;
      if (userSet === roleSet)
        return `${stage.label}: each step must have exactly one of user or role.`;
      if (s.delegate_user_id && (s.delegate_after_days == null || s.delegate_after_days <= 0))
        return `${stage.label}: delegate requires "delegate after N days" > 0.`;
      const key = `${s.parallel_group}:${s.step_order}`;
      if (seen.has(key))
        return `${stage.label}: duplicate step order ${s.step_order} in parallel group ${s.parallel_group}.`;
      seen.add(key);
    }
  }

  // Effective separation of duties
  const sodEffective: boolean =
    form.sod_mode === 'inherit' ? ctx.workspaceSodDefault : form.sod_mode === 'require';
  if (sodEffective) {
    const seenUsers = new Set<string>();
    for (const s of [...conceptSteps, ...signatorSteps]) {
      if (s.approver_user_id) {
        if (seenUsers.has(s.approver_user_id))
          return 'Separation of duties is required, but the same user appears in multiple steps.';
        seenUsers.add(s.approver_user_id);
      }
    }
  }

  return null;
}
