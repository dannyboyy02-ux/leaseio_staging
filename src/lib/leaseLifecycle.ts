// Lease Lifecycle State Machine
// Defines valid transitions, roles, and field editing permissions

export type LeaseStatus = 'Processing' | 'Ready' | 'Failed';
export type LifecycleStatus = 'Draft' | 'In Approval' | 'Posted' | 'Rejected' | 'Archived' | 'Pending Approval' | 'Review Required';
export type UserRole = 'owner' | 'approver' | 'admin' | 'editor' | 'viewer';

interface StateTransition {
  from: LeaseStatus | LifecycleStatus;
  to: LeaseStatus | LifecycleStatus;
  allowedRoles: UserRole[];
  requiresFields?: string[];
}

export const VALID_TRANSITIONS: StateTransition[] = [
  // AI Processing
  { from: 'Processing', to: 'Ready', allowedRoles: ['admin'] },
  { from: 'Processing', to: 'Failed', allowedRoles: ['admin'] },
  
  // User workflow
  { from: 'Ready', to: 'Draft', allowedRoles: ['owner', 'admin', 'editor'] },
  { 
    from: 'Draft', 
    to: 'Pending Approval', 
    allowedRoles: ['owner', 'admin', 'editor'],
    requiresFields: ['tenant_name', 'landlord_name', 'lease_start', 'lease_end']
  },
  
  // Approval
  { from: 'Pending Approval', to: 'Review Required', allowedRoles: ['approver', 'admin'] },
  { from: 'Pending Approval', to: 'Rejected', allowedRoles: ['approver', 'admin'] },
  { from: 'Review Required', to: 'Posted', allowedRoles: ['owner', 'admin', 'editor'] },
  { from: 'Rejected', to: 'Draft', allowedRoles: ['owner', 'admin', 'editor'] },
  
  // Archive
  { from: 'Posted', to: 'Archived', allowedRoles: ['admin'] },
];

export const FIELD_EDIT_PERMISSIONS: Record<LifecycleStatus, UserRole[]> = {
  'Draft': ['owner', 'admin', 'editor'],
  'Pending Approval': [],
  'In Approval': [],
  'Review Required': ['owner', 'admin', 'editor'],
  'Posted': [],
  'Rejected': ['owner', 'admin', 'editor'],
  'Archived': [],
};

export const CORRECTION_TRACKING_STAGES: LifecycleStatus[] = ['Draft', 'Review Required'];

export function canTransition(
  from: LeaseStatus | LifecycleStatus,
  to: LeaseStatus | LifecycleStatus,
  userRole: UserRole
): boolean {
  const transition = VALID_TRANSITIONS.find(t => t.from === from && t.to === to);
  if (!transition) return false;
  return transition.allowedRoles.includes(userRole);
}

export function canEditFields(status: LifecycleStatus, userRole: UserRole): boolean {
  const allowedRoles = FIELD_EDIT_PERMISSIONS[status] || [];
  return allowedRoles.includes(userRole);
}

export function shouldTrackCorrection(status: LifecycleStatus): boolean {
  return CORRECTION_TRACKING_STAGES.includes(status);
}

export function validateRequiredFields(
  from: LeaseStatus | LifecycleStatus,
  to: LeaseStatus | LifecycleStatus,
  leaseData: Record<string, any>
): { valid: boolean; missingFields: string[] } {
  const transition = VALID_TRANSITIONS.find(t => t.from === from && t.to === to);
  
  if (!transition || !transition.requiresFields) {
    return { valid: true, missingFields: [] };
  }
  
  const missingFields = transition.requiresFields.filter(
    field => !leaseData[field] || leaseData[field] === ''
  );
  
  return {
    valid: missingFields.length === 0,
    missingFields
  };
}

// Helper to map workspace role to lifecycle role
export function mapWorkspaceRoleToLifecycleRole(
  workspaceRole: 'admin' | 'editor' | 'viewer' | null,
  isOwner: boolean,
  isApprover: boolean
): UserRole {
  if (isOwner) return 'owner';
  if (isApprover) return 'approver';
  if (workspaceRole === 'admin') return 'admin';
  if (workspaceRole === 'editor') return 'editor';
  return 'viewer';
}
