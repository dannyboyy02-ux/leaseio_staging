import { describe, expect, it } from 'vitest';
import { ownsAnyWorkspace, workspaceCreationTarget } from '../workspaceOwnership';

// #195 — a user who owns no workspace must be routed to the free-trial
// onboarding, not the $499 add-workspace dialog (which has no Stripe customer
// to bill and dead-ends at "add a card").

describe('workspaceOwnership — ownsAnyWorkspace', () => {
  it('is false for a user who only belongs to others\' workspaces (owns nothing)', () => {
    expect(ownsAnyWorkspace([{ role: 'admin' }, { role: 'editor' }])).toBe(false);
    expect(ownsAnyWorkspace([{ role: 'viewer' }])).toBe(false);
  });

  it('is false for an empty workspace list (a brand-new signup)', () => {
    expect(ownsAnyWorkspace([])).toBe(false);
  });

  it('is true as soon as any workspace has the owner role', () => {
    expect(ownsAnyWorkspace([{ role: 'owner' }])).toBe(true);
    expect(ownsAnyWorkspace([{ role: 'admin' }, { role: 'owner' }])).toBe(true);
  });
});

describe('workspaceOwnership — workspaceCreationTarget (the #195 routing gate)', () => {
  it('routes a member who owns nothing to first-workspace onboarding', () => {
    expect(workspaceCreationTarget([{ role: 'admin' }])).toBe('first_workspace_onboarding');
    expect(workspaceCreationTarget([])).toBe('first_workspace_onboarding');
  });

  it('routes an owner to the paid add-workspace dialog', () => {
    expect(workspaceCreationTarget([{ role: 'owner' }])).toBe('add_workspace_dialog');
    // owner of one, member of another → still an owner, still the paid dialog
    expect(workspaceCreationTarget([{ role: 'owner' }, { role: 'admin' }])).toBe(
      'add_workspace_dialog',
    );
  });
});
