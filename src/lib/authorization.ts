import { WorkspaceRole } from '@/types';

export type AppRole = WorkspaceRole | 'owner' | null;

const normalizeRole = (role: AppRole): WorkspaceRole | null => {
  if (role === 'owner') return 'admin';
  return role;
};

const isAdmin = (role: AppRole) => normalizeRole(role) === 'admin';
const isEditor = (role: AppRole) => normalizeRole(role) === 'editor';

export const canAccessWorkspaceSettings = (role: AppRole) => isAdmin(role) || isEditor(role);
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
