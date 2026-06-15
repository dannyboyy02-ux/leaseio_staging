import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveAccess,
  hasWorkspaceAuthority,
  type EffectiveAccess,
} from '../firmAccess';

// Phase 9 firm-layer access logic. The pure mirror of the SQL `is_workspace_member`
// firm-awareness + the firm-derived role mapping. Direct membership / ownership
// always override firm-derived access; restrict_firm_access hard-excludes.

const U = 'user-1';
const ws = (over: Partial<Parameters<typeof resolveEffectiveAccess>[1]> = {}) => ({
  id: 'ws-1',
  owner_id: 'someone-else',
  firm_id: 'firm-1' as string | null,
  restrict_firm_access: false,
  ...over,
});

describe('resolveEffectiveAccess', () => {
  it('owner wins over everything', () => {
    const r = resolveEffectiveAccess(U, ws({ owner_id: U }), { user_id: U, role: 'viewer' }, { user_id: U, role: 'firm_member' });
    expect(r).toEqual({ hasAccess: true, source: 'workspace_owner', effective_workspace_role: 'owner' });
  });

  it('direct workspace membership wins over firm-derived role', () => {
    // firm_admin would map to 'admin', but the explicit 'viewer' membership wins.
    const r = resolveEffectiveAccess(U, ws(), { user_id: U, role: 'viewer' }, { user_id: U, role: 'firm_admin' });
    expect(r.source).toBe('direct_workspace_member');
    expect(r.effective_workspace_role).toBe('viewer');
  });

  it('firm_admin → admin when no direct membership', () => {
    const r = resolveEffectiveAccess(U, ws(), null, { user_id: U, role: 'firm_admin' });
    expect(r).toEqual({ hasAccess: true, source: 'firm_member', effective_workspace_role: 'admin' });
  });

  it('firm_member → editor when no direct membership', () => {
    const r = resolveEffectiveAccess(U, ws(), null, { user_id: U, role: 'firm_member' });
    expect(r).toEqual({ hasAccess: true, source: 'firm_member', effective_workspace_role: 'editor' });
  });

  it('restrict_firm_access=true hard-excludes firm members', () => {
    const r = resolveEffectiveAccess(U, ws({ restrict_firm_access: true }), null, { user_id: U, role: 'firm_admin' });
    expect(r).toEqual({ hasAccess: false, source: 'none', effective_workspace_role: null });
  });

  it('no firm binding → firm membership grants nothing', () => {
    const r = resolveEffectiveAccess(U, ws({ firm_id: null }), null, { user_id: U, role: 'firm_admin' });
    expect(r.hasAccess).toBe(false);
  });

  it('a firm membership belonging to a different user grants nothing', () => {
    const r = resolveEffectiveAccess(U, ws(), null, { user_id: 'other', role: 'firm_admin' });
    expect(r.hasAccess).toBe(false);
  });

  it('no access path → none', () => {
    const r = resolveEffectiveAccess(U, ws(), null, null);
    expect(r).toEqual({ hasAccess: false, source: 'none', effective_workspace_role: null });
  });
});

describe('hasWorkspaceAuthority', () => {
  const access = (role: EffectiveAccess['effective_workspace_role']): EffectiveAccess => ({
    hasAccess: role !== null,
    source: role === null ? 'none' : 'firm_member',
    effective_workspace_role: role,
  });

  it('owner satisfies every requirement', () => {
    expect(hasWorkspaceAuthority(access('owner'), 'admin')).toBe(true);
    expect(hasWorkspaceAuthority(access('owner'), 'owner')).toBe(true);
  });

  it('viewer does not satisfy admin', () => {
    expect(hasWorkspaceAuthority(access('viewer'), 'admin')).toBe(false);
  });

  it('editor satisfies editor and viewer but not admin', () => {
    expect(hasWorkspaceAuthority(access('editor'), 'editor')).toBe(true);
    expect(hasWorkspaceAuthority(access('editor'), 'viewer')).toBe(true);
    expect(hasWorkspaceAuthority(access('editor'), 'admin')).toBe(false);
  });

  it('admin satisfies admin but not owner', () => {
    expect(hasWorkspaceAuthority(access('admin'), 'admin')).toBe(true);
    expect(hasWorkspaceAuthority(access('admin'), 'owner')).toBe(false);
  });

  it('no access satisfies nothing', () => {
    expect(hasWorkspaceAuthority(access(null), 'viewer')).toBe(false);
  });
});
