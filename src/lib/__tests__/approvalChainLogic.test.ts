import { describe, it, expect } from 'vitest';
import {
  type AssigneeContext,
  type ChainStepLike,
  advancedPastStepOrder,
  checkSeparationOfDuties,
  findFirstPendingAssignees,
  getEffectiveSeparationOfDuties,
  isStageComplete,
  isStepStuck,
  reconcileChainSteps,
  resolveEffectiveAssignee,
  rollbackTargetForNewChain,
  shouldActivatePolicyDelegate,
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 7 — shouldActivatePolicyDelegate + isStepStuck + resolveEffectiveAssignee
// ─────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-05-06T12:00:00Z');
const daysAgo = (n: number): Date => new Date(FIXED_NOW.getTime() - n * 24 * 60 * 60 * 1000);

const baseCtx = (
  overrides: Partial<AssigneeContext> = {},
): AssigneeContext => ({
  policy_user_id: null,
  policy_role: null,
  policy_delegate_user_id: null,
  policy_delegate_after_days: null,
  voluntary_delegate_user_id: null,
  ooo_delegate_user_id: null,
  admin_reassigned_user_id: null,
  pending_since: null,
  ...overrides,
});

describe('shouldActivatePolicyDelegate', () => {
  it('returns false when pending_since is null', () => {
    expect(shouldActivatePolicyDelegate(null, 2, 'u-delegate', FIXED_NOW)).toBe(false);
  });

  it('returns false when delegate_after_days is null', () => {
    expect(shouldActivatePolicyDelegate(daysAgo(10), null, 'u-delegate', FIXED_NOW)).toBe(false);
  });

  it('returns false when delegate_user_id is null', () => {
    expect(shouldActivatePolicyDelegate(daysAgo(10), 2, null, FIXED_NOW)).toBe(false);
  });

  it('returns false when threshold not yet elapsed', () => {
    // pending 1 day, threshold 2 days → not yet
    expect(shouldActivatePolicyDelegate(daysAgo(1), 2, 'u-delegate', FIXED_NOW)).toBe(false);
  });

  it('returns true at exactly the threshold (>= comparison)', () => {
    expect(shouldActivatePolicyDelegate(daysAgo(2), 2, 'u-delegate', FIXED_NOW)).toBe(true);
  });

  it('returns true past the threshold', () => {
    expect(shouldActivatePolicyDelegate(daysAgo(5), 2, 'u-delegate', FIXED_NOW)).toBe(true);
  });

  it('handles ISO string input', () => {
    const iso = daysAgo(3).toISOString();
    expect(shouldActivatePolicyDelegate(iso, 2, 'u-delegate', FIXED_NOW)).toBe(true);
  });

  it('returns false for negative delegate_after_days (defensive)', () => {
    expect(shouldActivatePolicyDelegate(daysAgo(10), -1, 'u-delegate', FIXED_NOW)).toBe(false);
  });

  it('returns false for invalid date string', () => {
    expect(shouldActivatePolicyDelegate('not a date', 2, 'u-delegate', FIXED_NOW)).toBe(false);
  });
});

describe('isStepStuck', () => {
  it('returns false when pending_since is null', () => {
    expect(isStepStuck(null, 7, FIXED_NOW)).toBe(false);
  });

  it('returns false below threshold', () => {
    expect(isStepStuck(daysAgo(3), 7, FIXED_NOW)).toBe(false);
  });

  it('returns true at exactly the threshold', () => {
    expect(isStepStuck(daysAgo(7), 7, FIXED_NOW)).toBe(true);
  });

  it('returns true past the threshold', () => {
    expect(isStepStuck(daysAgo(14), 7, FIXED_NOW)).toBe(true);
  });

  it('uses default threshold of 7 days when not specified', () => {
    expect(isStepStuck(daysAgo(8), undefined, FIXED_NOW)).toBe(true);
    expect(isStepStuck(daysAgo(6), undefined, FIXED_NOW)).toBe(false);
  });

  it('returns false for invalid date string', () => {
    expect(isStepStuck('garbage', 7, FIXED_NOW)).toBe(false);
  });
});

describe('resolveEffectiveAssignee', () => {
  it('returns policy_user when only that source is set', () => {
    const r = resolveEffectiveAssignee(baseCtx({ policy_user_id: 'u-policy' }), FIXED_NOW);
    expect(r).toEqual({ user_id: 'u-policy', role: null, source: 'policy_user' });
  });

  it('returns policy_role when only role is set', () => {
    const r = resolveEffectiveAssignee(baseCtx({ policy_role: 'manager_approver' }), FIXED_NOW);
    expect(r).toEqual({ user_id: null, role: 'manager_approver', source: 'policy_role' });
  });

  it('prefers policy_user over policy_role when both are set', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({ policy_user_id: 'u-policy', policy_role: 'manager_approver' }),
      FIXED_NOW,
    );
    expect(r.source).toBe('policy_user');
    expect(r.user_id).toBe('u-policy');
  });

  it('does NOT activate policy_delegate before threshold elapses', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({
        policy_user_id: 'u-policy',
        policy_delegate_user_id: 'u-delegate',
        policy_delegate_after_days: 2,
        pending_since: daysAgo(1),
      }),
      FIXED_NOW,
    );
    expect(r.source).toBe('policy_user');
    expect(r.user_id).toBe('u-policy');
  });

  it('activates policy_delegate after threshold elapses', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({
        policy_user_id: 'u-policy',
        policy_delegate_user_id: 'u-delegate',
        policy_delegate_after_days: 2,
        pending_since: daysAgo(3),
      }),
      FIXED_NOW,
    );
    expect(r.source).toBe('policy_delegate');
    expect(r.user_id).toBe('u-delegate');
  });

  it('ooo_delegate beats activated policy_delegate', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({
        policy_user_id: 'u-policy',
        policy_delegate_user_id: 'u-delegate',
        policy_delegate_after_days: 2,
        pending_since: daysAgo(10),
        ooo_delegate_user_id: 'u-ooo',
      }),
      FIXED_NOW,
    );
    expect(r.source).toBe('ooo_delegate');
    expect(r.user_id).toBe('u-ooo');
  });

  it('voluntary_delegate beats ooo_delegate', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({
        policy_user_id: 'u-policy',
        ooo_delegate_user_id: 'u-ooo',
        voluntary_delegate_user_id: 'u-voluntary',
      }),
      FIXED_NOW,
    );
    expect(r.source).toBe('voluntary_delegate');
    expect(r.user_id).toBe('u-voluntary');
  });

  it('admin_reassign beats every other source', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({
        policy_user_id: 'u-policy',
        policy_delegate_user_id: 'u-delegate',
        policy_delegate_after_days: 2,
        pending_since: daysAgo(10),
        ooo_delegate_user_id: 'u-ooo',
        voluntary_delegate_user_id: 'u-voluntary',
        admin_reassigned_user_id: 'u-admin-target',
      }),
      FIXED_NOW,
    );
    expect(r.source).toBe('admin_reassign');
    expect(r.user_id).toBe('u-admin-target');
  });

  it('admin_reassign with no other source still wins', () => {
    const r = resolveEffectiveAssignee(
      baseCtx({ admin_reassigned_user_id: 'u-admin-target' }),
      FIXED_NOW,
    );
    expect(r.source).toBe('admin_reassign');
    expect(r.user_id).toBe('u-admin-target');
  });

  it('falls back to policy_role default with null fields when no source is set', () => {
    // Defensive: chain_assignee_present DB CHECK should prevent this in
    // practice, but the function stays total.
    const r = resolveEffectiveAssignee(baseCtx(), FIXED_NOW);
    expect(r).toEqual({ user_id: null, role: null, source: 'policy_role' });
  });

  it('priority order is fully transitive (admin > voluntary > ooo > policy_delegate > policy_user)', () => {
    // Sweep through the layers, peeling one source off at a time.
    const allOn = baseCtx({
      policy_user_id: 'u-policy',
      policy_delegate_user_id: 'u-delegate',
      policy_delegate_after_days: 2,
      pending_since: daysAgo(10),
      ooo_delegate_user_id: 'u-ooo',
      voluntary_delegate_user_id: 'u-voluntary',
      admin_reassigned_user_id: 'u-admin',
    });
    expect(resolveEffectiveAssignee(allOn, FIXED_NOW).source).toBe('admin_reassign');
    expect(
      resolveEffectiveAssignee({ ...allOn, admin_reassigned_user_id: null }, FIXED_NOW).source,
    ).toBe('voluntary_delegate');
    expect(
      resolveEffectiveAssignee(
        { ...allOn, admin_reassigned_user_id: null, voluntary_delegate_user_id: null },
        FIXED_NOW,
      ).source,
    ).toBe('ooo_delegate');
    expect(
      resolveEffectiveAssignee(
        {
          ...allOn,
          admin_reassigned_user_id: null,
          voluntary_delegate_user_id: null,
          ooo_delegate_user_id: null,
        },
        FIXED_NOW,
      ).source,
    ).toBe('policy_delegate');
    expect(
      resolveEffectiveAssignee(
        {
          ...allOn,
          admin_reassigned_user_id: null,
          voluntary_delegate_user_id: null,
          ooo_delegate_user_id: null,
          policy_delegate_user_id: null, // disable delegate
        },
        FIXED_NOW,
      ).source,
    ).toBe('policy_user');
  });
});
