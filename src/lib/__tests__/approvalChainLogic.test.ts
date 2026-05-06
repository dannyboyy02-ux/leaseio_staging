import { describe, it, expect } from 'vitest';
import {
  type ChainStepLike,
  advancedPastStepOrder,
  checkSeparationOfDuties,
  findFirstPendingAssignees,
  getEffectiveSeparationOfDuties,
  isStageComplete,
  reconcileChainSteps,
  rollbackTargetForNewChain,
} from '../approvalChainLogic';

const userStep = (
  overrides: Partial<ChainStepLike> = {}
): ChainStepLike => ({
  stage: 'concept',
  step_order: 1,
  parallel_group: 1,
  approver_user_id: 'u-1',
  approver_role: null,
  is_required: true,
  status: 'pending',
  ...overrides,
});

const roleStep = (
  overrides: Partial<ChainStepLike> = {}
): ChainStepLike => ({
  stage: 'concept',
  step_order: 1,
  parallel_group: 1,
  approver_user_id: null,
  approver_role: 'manager_approver',
  is_required: true,
  status: 'pending',
  ...overrides,
});

describe('getEffectiveSeparationOfDuties', () => {
  it('uses workspace default when override is null', () => {
    expect(getEffectiveSeparationOfDuties(true, null)).toBe(true);
    expect(getEffectiveSeparationOfDuties(false, null)).toBe(false);
  });

  it('policy override supersedes workspace default', () => {
    expect(getEffectiveSeparationOfDuties(false, true)).toBe(true);
    expect(getEffectiveSeparationOfDuties(true, false)).toBe(false);
  });
});

describe('checkSeparationOfDuties', () => {
  it('returns null when not enforced', () => {
    expect(
      checkSeparationOfDuties(
        [userStep({ approver_user_id: 'a' }), userStep({ approver_user_id: 'a' })],
        false,
      ),
    ).toBeNull();
  });

  it('returns the violator when same user appears twice and enforcement is on', () => {
    expect(
      checkSeparationOfDuties(
        [
          userStep({ approver_user_id: 'a', step_order: 1 }),
          userStep({ stage: 'signator', approver_user_id: 'a', step_order: 1 }),
        ],
        true,
      ),
    ).toBe('a');
  });

  it('ignores role-only steps (no user collision possible)', () => {
    expect(
      checkSeparationOfDuties(
        [roleStep({ approver_role: 'manager_approver' }), roleStep({ approver_role: 'manager_approver', stage: 'signator' })],
        true,
      ),
    ).toBeNull();
  });

  it('returns null when distinct users', () => {
    expect(
      checkSeparationOfDuties(
        [userStep({ approver_user_id: 'a' }), userStep({ approver_user_id: 'b' })],
        true,
      ),
    ).toBeNull();
  });
});

describe('isStageComplete', () => {
  it('returns true when every required step in the stage is approved', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved' }),
      userStep({ step_order: 2, status: 'approved' }),
    ];
    expect(isStageComplete(steps, 'concept')).toBe(true);
  });

  it('returns false when any required step is still pending', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved' }),
      userStep({ step_order: 2, status: 'pending' }),
    ];
    expect(isStageComplete(steps, 'concept')).toBe(false);
  });

  it('ignores optional steps', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved', is_required: true }),
      userStep({ step_order: 2, status: 'pending', is_required: false }),
    ];
    expect(isStageComplete(steps, 'concept')).toBe(true);
  });

  it('returns false when no required steps exist for the stage', () => {
    const steps: ChainStepLike[] = [
      userStep({ stage: 'signator', status: 'approved' }),
    ];
    expect(isStageComplete(steps, 'concept')).toBe(false);
  });

  it('only inspects the requested stage', () => {
    const steps: ChainStepLike[] = [
      userStep({ stage: 'concept', step_order: 1, status: 'approved' }),
      userStep({ stage: 'signator', step_order: 1, status: 'pending' }),
    ];
    expect(isStageComplete(steps, 'concept')).toBe(true);
    expect(isStageComplete(steps, 'signator')).toBe(false);
  });
});

describe('findFirstPendingAssignees', () => {
  it('returns the lowest pending step_order assignees', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved', approver_user_id: 'a' }),
      userStep({ step_order: 2, status: 'pending', approver_user_id: 'b' }),
      userStep({ step_order: 3, status: 'pending', approver_user_id: 'c' }),
    ];
    expect(findFirstPendingAssignees(steps, 'concept')).toEqual([
      { userId: 'b', role: null },
    ]);
  });

  it('returns ALL parallel siblings at the lowest pending step_order', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, parallel_group: 1, status: 'pending', approver_user_id: 'a' }),
      userStep({ step_order: 1, parallel_group: 2, status: 'pending', approver_user_id: 'b' }),
      userStep({ step_order: 2, status: 'pending', approver_user_id: 'c' }),
    ];
    const result = findFirstPendingAssignees(steps, 'concept');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.userId).sort()).toEqual(['a', 'b']);
  });

  it('returns role assignees correctly', () => {
    const steps: ChainStepLike[] = [
      roleStep({ step_order: 1, status: 'pending', approver_role: 'manager_approver' }),
    ];
    expect(findFirstPendingAssignees(steps, 'concept')).toEqual([
      { userId: null, role: 'manager_approver' },
    ]);
  });

  it('returns [] when stage is fully resolved', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved' }),
      userStep({ step_order: 2, status: 'approved' }),
    ];
    expect(findFirstPendingAssignees(steps, 'concept')).toEqual([]);
  });

  it('returns [] when stage has no required steps', () => {
    const steps: ChainStepLike[] = [
      userStep({ stage: 'signator', status: 'pending' }),
    ];
    expect(findFirstPendingAssignees(steps, 'concept')).toEqual([]);
  });
});

describe('advancedPastStepOrder', () => {
  it('returns true when the just-resolved level is done AND a higher level is still pending', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved' }),
      userStep({ step_order: 2, status: 'pending' }),
    ];
    expect(advancedPastStepOrder(steps, 'concept', 1)).toBe(true);
  });

  it('returns false when same-level parallel siblings are still pending', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, parallel_group: 1, status: 'approved' }),
      userStep({ step_order: 1, parallel_group: 2, status: 'pending' }),
      userStep({ step_order: 2, status: 'pending' }),
    ];
    expect(advancedPastStepOrder(steps, 'concept', 1)).toBe(false);
  });

  it('returns false when there is no higher level (stage completed instead)', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved' }),
    ];
    expect(advancedPastStepOrder(steps, 'concept', 1)).toBe(false);
    // For "stage completed" semantics, callers use isStageComplete().
    expect(isStageComplete(steps, 'concept')).toBe(true);
  });

  it('only considers the requested stage', () => {
    const steps: ChainStepLike[] = [
      userStep({ stage: 'concept', step_order: 1, status: 'approved' }),
      userStep({ stage: 'signator', step_order: 2, status: 'pending' }),
    ];
    expect(advancedPastStepOrder(steps, 'concept', 1)).toBe(false);
  });

  it('ignores optional steps when computing advancement', () => {
    const steps: ChainStepLike[] = [
      userStep({ step_order: 1, status: 'approved', is_required: true }),
      userStep({ step_order: 2, status: 'pending', is_required: false }),
    ];
    // Only optional step pending at higher level — advanced returns false.
    expect(advancedPastStepOrder(steps, 'concept', 1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 — reconcileChainSteps + rollbackTargetForNewChain
// ─────────────────────────────────────────────────────────────────────────

describe('reconcileChainSteps', () => {
  it('returns empty lists for empty inputs', () => {
    const r = reconcileChainSteps([], []);
    expect(r.preserved).toEqual([]);
    expect(r.superseded).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it('flags a new-only step as added', () => {
    const newChain = [userStep({ approver_user_id: 'u-new' })];
    const r = reconcileChainSteps([], newChain);
    expect(r.added).toHaveLength(1);
    expect(r.added[0].approver_user_id).toBe('u-new');
    expect(r.preserved).toEqual([]);
    expect(r.superseded).toEqual([]);
  });

  it('flags an existing-only step as superseded', () => {
    const existing = [userStep({ approver_user_id: 'u-old', status: 'approved' })];
    const r = reconcileChainSteps(existing, []);
    expect(r.superseded).toHaveLength(1);
    expect(r.superseded[0].approver_user_id).toBe('u-old');
    // Preserved-from-existing semantics: status comes from `existing` row.
    // Superseded retains its prior status; the resolver flips it on UPDATE.
    expect(r.superseded[0].status).toBe('approved');
    expect(r.preserved).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it('preserves a step matched by user identity', () => {
    const existing = [userStep({ approver_user_id: 'u-1', status: 'approved' })];
    const newChain = [userStep({ approver_user_id: 'u-1', status: 'pending' })];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toHaveLength(1);
    // Preserved row is from `existing` (carries prior status).
    expect(r.preserved[0].status).toBe('approved');
    expect(r.added).toEqual([]);
    expect(r.superseded).toEqual([]);
  });

  it('preserves a step matched by role identity', () => {
    const existing = [roleStep({ approver_role: 'manager_approver', status: 'approved' })];
    const newChain = [roleStep({ approver_role: 'manager_approver', status: 'pending' })];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toHaveLength(1);
    expect(r.preserved[0].approver_role).toBe('manager_approver');
    expect(r.preserved[0].status).toBe('approved');
  });

  it('treats user-vs-role identity types as different (both supersede + add)', () => {
    // Same approver represented two ways: existing has user_id, new has role.
    // Identity types differ → not the same step.
    const existing = [userStep({ approver_user_id: 'alice', approver_role: null })];
    const newChain = [roleStep({ approver_user_id: null, approver_role: 'cfo' })];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toEqual([]);
    expect(r.superseded).toHaveLength(1);
    expect(r.added).toHaveLength(1);
  });

  it('matches across step_order shifts (identity is who, not position)', () => {
    const existing = [userStep({ approver_user_id: 'u-1', step_order: 1 })];
    const newChain = [userStep({ approver_user_id: 'u-1', step_order: 5 })];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toHaveLength(1);
    expect(r.added).toEqual([]);
    expect(r.superseded).toEqual([]);
  });

  it('does NOT match the same user across different stages', () => {
    const existing = [userStep({ stage: 'concept', approver_user_id: 'u-1' })];
    const newChain = [userStep({ stage: 'signator', approver_user_id: 'u-1' })];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toEqual([]);
    expect(r.superseded).toHaveLength(1);
    expect(r.added).toHaveLength(1);
  });

  it('reconciles a multi-step mixed chain with all three outcomes', () => {
    const existing: ChainStepLike[] = [
      userStep({ approver_user_id: 'manager-keeps', status: 'approved' }),
      userStep({ approver_user_id: 'cfo-removed', status: 'pending' }),
      roleStep({ approver_role: 'finance_director', status: 'approved' }),
    ];
    const newChain: ChainStepLike[] = [
      userStep({ approver_user_id: 'manager-keeps' }),       // preserved
      roleStep({ approver_role: 'finance_director' }),        // preserved
      userStep({ approver_user_id: 'vp-new' }),               // added
    ];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved.map((s) => s.approver_user_id ?? s.approver_role)).toEqual([
      'manager-keeps',
      'finance_director',
    ]);
    expect(r.superseded).toHaveLength(1);
    expect(r.superseded[0].approver_user_id).toBe('cfo-removed');
    expect(r.added).toHaveLength(1);
    expect(r.added[0].approver_user_id).toBe('vp-new');
  });

  it('reconciles concept and signator stages independently', () => {
    const existing: ChainStepLike[] = [
      userStep({ stage: 'concept', approver_user_id: 'u-c1' }),
      userStep({ stage: 'signator', approver_user_id: 'u-s1' }),
    ];
    const newChain: ChainStepLike[] = [
      userStep({ stage: 'concept', approver_user_id: 'u-c1' }),       // preserved
      userStep({ stage: 'signator', approver_user_id: 'u-s2' }),      // added (s1 superseded)
    ];
    const r = reconcileChainSteps(existing, newChain);
    expect(r.preserved).toHaveLength(1);
    expect(r.preserved[0].stage).toBe('concept');
    expect(r.superseded).toHaveLength(1);
    expect(r.superseded[0].approver_user_id).toBe('u-s1');
    expect(r.added).toHaveLength(1);
    expect(r.added[0].approver_user_id).toBe('u-s2');
  });
});

describe('rollbackTargetForNewChain', () => {
  it('returns no_rollback_needed when nothing is added', () => {
    const newChain: ChainStepLike[] = [userStep({ approver_user_id: 'u-1' })];
    const reconciled = {
      preserved: [userStep({ approver_user_id: 'u-1' })],
      added: [],
    };
    expect(rollbackTargetForNewChain(newChain, reconciled)).toBe('no_rollback_needed');
  });

  it('rolls back to concept_under_review when a required concept step is added', () => {
    const added = [userStep({ stage: 'concept', is_required: true })];
    expect(rollbackTargetForNewChain(added, { preserved: [], added })).toBe(
      'concept_under_review',
    );
  });

  it('does NOT roll back when only an OPTIONAL added step exists', () => {
    const added = [userStep({ stage: 'concept', is_required: false })];
    expect(rollbackTargetForNewChain(added, { preserved: [], added })).toBe(
      'no_rollback_needed',
    );
  });

  it('rolls back to final_review when only a required signator step is added', () => {
    const added = [userStep({ stage: 'signator', is_required: true })];
    expect(rollbackTargetForNewChain(added, { preserved: [], added })).toBe(
      'final_review',
    );
  });

  it('prefers concept_under_review when both concept and signator are added (earliest wins)', () => {
    const added = [
      userStep({ stage: 'concept', is_required: true }),
      userStep({ stage: 'signator', is_required: true }),
    ];
    expect(rollbackTargetForNewChain(added, { preserved: [], added })).toBe(
      'concept_under_review',
    );
  });

  it('considers only required adds — optional concept + required signator → final_review', () => {
    const added = [
      userStep({ stage: 'concept', is_required: false }),
      userStep({ stage: 'signator', is_required: true }),
    ];
    expect(rollbackTargetForNewChain(added, { preserved: [], added })).toBe(
      'final_review',
    );
  });
});
