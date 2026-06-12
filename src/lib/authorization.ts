import { WorkspaceRole } from '@/types';
import type { FunctionalRole } from '@/types/lifecycle';

export type AppRole = WorkspaceRole | 'owner' | null;

const normalizeRole = (role: AppRole): WorkspaceRole | null => {
  if (role === 'owner') return 'admin';
  return role;
};

const isAdmin = (role: AppRole) => normalizeRole(role) === 'admin';
const isEditor = (role: AppRole) => normalizeRole(role) === 'editor';

export const canEditWorkspaceSettings = (role: AppRole) => isAdmin(role);
export const canManageWorkspaceMembers = (role: AppRole) => isAdmin(role);
export const canAccessWorkspaceBilling = (role: AppRole) => isAdmin(role);
export const canAccessWorkspaceIntegrations = (role: AppRole) => isAdmin(role) || isEditor(role);
export const canAccessWorkspaceDefaults = (role: AppRole) => isAdmin(role) || isEditor(role);
export const canAccessWorkspaceProfile = (role: AppRole) => isAdmin(role) || isEditor(role);

export const canAccessIntegrationsPage = (role: AppRole) => isAdmin(role) || isEditor(role);

export const canAccessReportsAuditLog = (role: AppRole) => isAdmin(role);
export const canAccessReportsDataQuality = (role: AppRole) => isAdmin(role) || isEditor(role);
export const canExportReports = (role: AppRole) => isAdmin(role) || isEditor(role);

// Phase 2 — functional role checks
/** User can access the Approvals page if they hold manager_approver or financial_approver role */
export const canAccessApprovals = (functionalRoles: FunctionalRole[]): boolean =>
  functionalRoles.includes('manager_approver') || functionalRoles.includes('financial_approver');

/** User is a submitter-only (no approval capability — hide the Approvals nav item) */
export const isSubmitterOnly = (functionalRoles: FunctionalRole[]): boolean =>
  functionalRoles.length > 0 &&
  !functionalRoles.includes('manager_approver') &&
  !functionalRoles.includes('financial_approver') &&
  !functionalRoles.includes('admin');

// Phase 4 — executed document role checks
/** User can upload an executed document (financial_approver or admin) */
export const canUploadExecutedDocument = (functionalRoles: FunctionalRole[]): boolean =>
  functionalRoles.includes('financial_approver') || functionalRoles.includes('admin');

/** User can access variance review (financial_approver or admin) */
export const canAccessVarianceReview = (functionalRoles: FunctionalRole[]): boolean =>
  functionalRoles.includes('financial_approver') || functionalRoles.includes('admin');
