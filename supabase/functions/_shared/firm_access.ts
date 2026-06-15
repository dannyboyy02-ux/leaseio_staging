// Firm-layer effective-access logic (Phase 9) — Deno mirror.
//
// ⚠️ MIRROR: keep byte-for-byte in sync with `src/lib/firmAccess.ts` (the
// canonical Node copy). `check-mirror-parity.mjs` enforces this.
//
// Firm-derived role mapping (PRODUCT_STRATEGY.md / PHASE_9_BUILD_SPEC.md):
//   firm_admin  → effective 'admin'  in every child workspace
//   firm_member → effective 'editor' in every child workspace
// Direct workspace membership (and ownership) overrides firm-derived access.

export type FirmRole = 'firm_admin' | 'firm_member';
export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export type EffectiveAccess = {
  hasAccess: boolean;
  source: 'direct_workspace_member' | 'workspace_owner' | 'firm_member' | 'none';
  effective_workspace_role: WorkspaceRole | 'owner' | null;
};

export function resolveEffectiveAccess(
  userId: string,
  workspace: {
    id: string;
    owner_id: string;
    firm_id: string | null;
    restrict_firm_access: boolean;
  },
  directMembership: { user_id: string; role: WorkspaceRole } | null,
  firmMembership: { user_id: string; role: FirmRole } | null,
): EffectiveAccess {
  // Ownership wins over everything.
  if (workspace.owner_id === userId) {
    return { hasAccess: true, source: 'workspace_owner', effective_workspace_role: 'owner' };
  }

  // Direct workspace membership wins over firm-derived access.
  if (directMembership && directMembership.user_id === userId) {
    return {
      hasAccess: true,
      source: 'direct_workspace_member',
      effective_workspace_role: directMembership.role,
    };
  }

  // Firm membership grants implicit access UNLESS the workspace opted out.
  if (
    workspace.firm_id &&
    !workspace.restrict_firm_access &&
    firmMembership &&
    firmMembership.user_id === userId
  ) {
    return {
      hasAccess: true,
      source: 'firm_member',
      effective_workspace_role: firmMembership.role === 'firm_admin' ? 'admin' : 'editor',
    };
  }

  return { hasAccess: false, source: 'none', effective_workspace_role: null };
}

const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

// True if the resolved access meets or exceeds the required authority level.
// Use this instead of raw `role === 'admin'` checks (Permissions Gating Convention).
export function hasWorkspaceAuthority(
  effective: EffectiveAccess,
  required: WorkspaceRole | 'owner',
): boolean {
  if (!effective.hasAccess || !effective.effective_workspace_role) return false;
  return (
    (ROLE_HIERARCHY[effective.effective_workspace_role] ?? 0) >= (ROLE_HIERARCHY[required] ?? 0)
  );
}

// Firm-level authority (Phase 10). Mirrors the DB helpers exactly:
//   is_firm_admin  = firm owner OR a firm_members row with role='firm_admin'
//   is_firm_member = firm owner OR any firm_members row
// Gate firm-admin actions with isFirmAdminOrOwner() instead of a raw
// `firmRole === 'firm_admin'` check (the owner has no firm_members row, so the
// raw check wrongly excludes them) — Permissions Gating Convention.
export type FirmAuthority = {
  isOwner: boolean;
  firmRole: FirmRole | null;
};

export function isFirmAdminOrOwner(authority: FirmAuthority): boolean {
  return authority.isOwner || authority.firmRole === 'firm_admin';
}

export function isFirmMemberOrOwner(authority: FirmAuthority): boolean {
  return authority.isOwner || authority.firmRole !== null;
}
