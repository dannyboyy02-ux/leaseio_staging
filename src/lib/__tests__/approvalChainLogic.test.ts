import { describe, it, expect } from 'vitest';
import {
  type ChainStepLike,
  advancedPastStepOrder,
  checkSeparationOfDuties,
  findFirstPendingAssignees,
  getEffectiveSeparationOfDuties,
  isStageComplete,
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
