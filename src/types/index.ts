// Core Types for LeaseIO

export type SubscriptionPlan = 'pro' | 'business';

export type UserRole = 'owner' | 'admin' | 'manager' | 'reviewer' | 'readonly';

export type LeaseType = 'master' | 'amendment';

export type LeaseStatus = 'draft' | 'processing' | 'review' | 'final' | 'archived';

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  companyName?: string;
  address?: string;
  timezone: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  plan: SubscriptionPlan;
  documentLimit: number;
  documentsUsed: number;
  timezone: string;
  defaultNotificationDays: number;
  createdAt: string;
  updatedAt: string;
  renewalDate: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: UserRole;
  user?: User;
  joinedAt: string;
}

export interface Lease {
  id: string;
  workspaceId: string;
  type: LeaseType;
  parentLeaseId?: string; // For amendments
  status: LeaseStatus;
  documentUrl: string;
  documentName: string;
  
  // Core extracted data
  lessor?: string;
  lessee?: string;
  propertyAddress?: string;
  commencementDate?: string;
  expirationDate?: string;
  rentAmount?: number;
  rentFrequency?: 'monthly' | 'quarterly' | 'annually';
  
  // Confidence scores (AI)
  extractionConfidence?: number;
  
  // Audit
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizedBy?: string;
}

export interface RentRollEntry {
  id: string;
  leaseId: string;
  startDate: string;
  endDate: string;
  amount: number;
  escalationType?: 'fixed' | 'step' | 'cpi';
  escalationValue?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  workspaceId: string;
  leaseId: string;
  type: 'renewal' | 'escalation' | 'expiration';
  title: string;
  message: string;
  scheduledFor: string;
  sentAt?: string;
  channels: ('email' | 'sms')[];
  status: 'scheduled' | 'sent' | 'failed';
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  userId: string;
  entityType: 'lease' | 'rent_roll' | 'notification' | 'integration' | 'workspace' | 'user';
  entityId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SecurityLogEntry {
  id: string;
  userId: string;
  eventType: 'login' | 'logout' | 'password_change' | 'integration_connect' | 'integration_disconnect' | 'session_terminate';
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface QuickBooksConnection {
  id: string;
  workspaceId: string;
  realmId: string;
  role: 'lessor' | 'lessee';
  isActive: boolean;
  lastSyncAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Navigation types
export interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  requiresPlan?: SubscriptionPlan;
}

// Onboarding
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  href?: string;
}
