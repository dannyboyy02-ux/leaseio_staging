// Lease Lifecycle State Machine
// Aligned with the intake-first lifecycle defined in src/types/lifecycle.ts

import type { LifecycleStatus } from '@/types/lifecycle';
import { LIFECYCLE_TRANSITIONS } from '@/types/lifecycle';

export type UserRole = 'owner' | 'approver' | 'admin' | 'editor' | 'viewer';

const TRANSITION_PERMISSIONS: Record<LifecycleStatus, UserRole[]> = {
  requested: ['owner', 'admin', 'editor'],
  negotiating: ['owner', 'admin', 'editor'],
  pending_review: ['owner', 'admin', 'editor'],
  executed: ['admin', 'owner'],
  active: ['admin'],
  expired: ['admin'],
  cancelled: ['owner', 'admin'],
};

const FIELD_EDIT_PERMISSIONS: Record<LifecycleStatus, UserRole[]> = {
  requested: ['owner', 'admin', 'editor'],
  negotiating: ['owner', 'admin', 'editor'],
  pending_review: ['admin', 'editor'],
  executed: ['admin'],
  active: [],
  expired: [],
  cancelled: [],
};

export function canTransition(
  from: LifecycleStatus,
  to: LifecycleStatus,
  userRole: UserRole,
): boolean {
  const validTargets = LIFECYCLE_TRANSITIONS[from] || [];
  if (!validTargets.includes(to)) return false;
  const allowedRoles = TRANSITION_PERMISSIONS[to] || [];
  return allowedRoles.includes(userRole);
}

export function canEditFields(status: LifecycleStatus, userRole: UserRole): boolean {
  const allowedRoles = FIELD_EDIT_PERMISSIONS[status] || [];
  return allowedRoles.includes(userRole);
}

export function mapWorkspaceRoleToLifecycleRole(
  workspaceRole: 'admin' | 'editor' | 'viewer' | null,
  isOwner: boolean,
  isApprover: boolean,
): UserRole {
  if (isOwner) return 'owner';
  if (isApprover) return 'approver';
  if (workspaceRole === 'admin') return 'admin';
  if (workspaceRole === 'editor') return 'editor';
  return 'viewer';
}
