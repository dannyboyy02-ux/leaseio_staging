import { describe, it, expect } from 'vitest';
import {
  validatePolicy,
  type ChainStepLike,
  type PolicyFormLike,
  type SodMode,
} from '../approvalPolicyValidation';

const baseForm = (overrides: Partial<PolicyFormLike> = {}): PolicyFormLike => ({
  name: 'Test policy',
  priority: 100,
  match_min_annual_cost: '',
  match_max_annual_cost: '',
  sod_mode: 'inherit' as SodMode,
  ...overrides,
});

const userStep = (
  overrides: Partial<ChainStepLike> = {}
): ChainStepLike => ({
  step_order: 1,
  parallel_group: 1,
  approver_user_id: 'u-1',
  approver_role: null,
  delegate_user_id: null,
  delegate_after_days: null,
  is_required: true,
  ...overrides,
});

const roleStep = (
  overrides: Partial<ChainStepLike> = {}
): ChainStepLike => ({
  step_order: 1,
  parallel_group: 1,
  approver_user_id: null,
  approver_role: 'manager_approver',
  delegate_user_id: null,
  delegate_after_days: null,
  is_required: true,
  ...overrides,
});

describe('validatePolicy — identity', () => {
  it('rejects empty name', () => {
    const err = validatePolicy(
      baseForm({ name: '   ' }),
      [roleStep()],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('Name is required.');
  });

  it('rejects non-positive priority', () => {
    expect(
      validatePolicy(
        baseForm({ priority: 0 }),
        [roleStep()],
        [roleStep({ approver_role: 'signator' })],
        { workspaceSodDefault: true }
      )
    ).toBe('Priority must be a positive integer.');
    expect(
      validatePolicy(
        baseForm({ priority: -5 }),
        [roleStep()],
        [roleStep({ approver_role: 'signator' })],
        { workspaceSodDefault: true }
      )
    ).toBe('Priority must be a positive integer.');
  });
});

describe('validatePolicy — cost range', () => {
  it('rejects min > max', () => {
    const err = validatePolicy(
      baseForm({ match_min_annual_cost: '500000', match_max_annual_cost: '100000' }),
      [roleStep()],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('Min annual cost must be ≤ max annual cost.');
  });

  it('accepts only-min or only-max', () => {
    expect(
      validatePolicy(
        baseForm({ match_min_annual_cost: '100000', match_max_annual_cost: '' }),
        [roleStep()],
        [roleStep({ approver_role: 'signator' })],
        { workspaceSodDefault: true }
      )
    ).toBeNull();
    expect(
      validatePolicy(
        baseForm({ match_min_annual_cost: '', match_max_annual_cost: '500000' }),
        [roleStep()],
        [roleStep({ approver_role: 'signator' })],
        { workspaceSodDefault: true }
      )
    ).toBeNull();
  });
});

describe('validatePolicy — chain shape (the spec\'s headline cases)', () => {
  it('blocks save with no concept step', () => {
    const err = validatePolicy(
      baseForm(),
      [],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"First, get the green light" needs at least one approver.');
  });

  it('blocks save with no signator step', () => {
    const err = validatePolicy(
      baseForm(),
      [roleStep()],
      [],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"Then, sign the deal" needs at least one approver.');
  });

  it('rejects step with both user and role set', () => {
    const err = validatePolicy(
      baseForm(),
      [{ ...roleStep(), approver_user_id: 'u-1' }],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"First, get the green light": pick an approver for every empty slot.');
  });

  it('rejects step with neither user nor role', () => {
    const err = validatePolicy(
      baseForm(),
      [{ ...roleStep(), approver_role: null }],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"First, get the green light": pick an approver for every empty slot.');
  });

  it('rejects duplicate step_order within the same parallel_group', () => {
    const err = validatePolicy(
      baseForm(),
      [
        roleStep({ step_order: 1, parallel_group: 1 }),
        roleStep({ step_order: 1, parallel_group: 1, approver_role: 'financial_approver' }),
      ],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"First, get the green light": duplicate step 1 in parallel group 1.');
  });

  it('allows duplicate step_order across different parallel_groups', () => {
    const err = validatePolicy(
      baseForm(),
      [
        roleStep({ step_order: 1, parallel_group: 1 }),
        roleStep({ step_order: 1, parallel_group: 2, approver_role: 'financial_approver' }),
      ],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBeNull();
  });

  it('rejects delegate without delegate_after_days', () => {
    const err = validatePolicy(
      baseForm(),
      [roleStep({ delegate_user_id: 'u-9', delegate_after_days: null })],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe('"First, get the green light": a backup approver needs "forward after N days" > 0.');
  });
});

describe('validatePolicy — separation of duties (the spec\'s headline cases)', () => {
  it('blocks duplicate user across steps when separation is REQUIRED via override', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'require' }),
      [userStep({ approver_user_id: 'u-shared' })],
      [userStep({ approver_user_id: 'u-shared' })],
      // workspace default doesn't matter when override is explicit
      { workspaceSodDefault: false }
    );
    expect(err).toBe(
      'Separation of duties is required, but the same user appears in multiple steps.'
    );
  });

  it('blocks duplicate user when sod_mode INHERITS workspace default that is ON', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'inherit' }),
      [userStep({ approver_user_id: 'u-shared' })],
      [userStep({ approver_user_id: 'u-shared' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBe(
      'Separation of duties is required, but the same user appears in multiple steps.'
    );
  });

  it('ALLOWS duplicate user across steps when separation is ALLOWED via override', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'allow' }),
      [userStep({ approver_user_id: 'u-shared' })],
      [userStep({ approver_user_id: 'u-shared' })],
      // workspace default is ON but the policy explicitly overrides
      { workspaceSodDefault: true }
    );
    expect(err).toBeNull();
  });

  it('ALLOWS duplicate user when sod_mode INHERITS workspace default that is OFF', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'inherit' }),
      [userStep({ approver_user_id: 'u-shared' })],
      [userStep({ approver_user_id: 'u-shared' })],
      { workspaceSodDefault: false }
    );
    expect(err).toBeNull();
  });

  it('does not flag separation conflicts on role-based steps (no user collision possible)', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'require' }),
      [roleStep({ approver_role: 'manager_approver' })],
      [roleStep({ approver_role: 'manager_approver' })],
      { workspaceSodDefault: true }
    );
    // role steps don't carry approver_user_id, so the separation check
    // (which only inspects approver_user_id) doesn't trip.
    expect(err).toBeNull();
  });
});

describe('validatePolicy — happy paths', () => {
  it('accepts a fully valid minimal policy', () => {
    const err = validatePolicy(
      baseForm({ priority: 100, match_min_annual_cost: '0', match_max_annual_cost: '50000' }),
      [roleStep()],
      [roleStep({ approver_role: 'signator' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBeNull();
  });

  it('accepts a multi-step policy with user-based separation', () => {
    const err = validatePolicy(
      baseForm({ sod_mode: 'require' }),
      [
        userStep({ step_order: 1, approver_user_id: 'u-1' }),
        userStep({ step_order: 2, approver_user_id: 'u-2' }),
      ],
      [userStep({ approver_user_id: 'u-3' })],
      { workspaceSodDefault: true }
    );
    expect(err).toBeNull();
  });
});
