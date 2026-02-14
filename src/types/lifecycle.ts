// Lease Lifecycle Types (Business Plan Only)

export type LifecycleStatus =
  | 'requested'
  | 'negotiating'
  | 'pending_review'
  | 'executed'
  | 'active'
  | 'expired'
  | 'cancelled';

export type LeaseCategory = 'property' | 'equipment' | 'vehicle' | 'other';

export type ApprovalType = 'internal' | 'execution';

export type ApprovalAction = 'approve' | 'send_back' | 'reject' | 'pause';

export type ActivityType =
  | 'status_change'
  | 'approval'
  | 'rejection'
  | 'send_back'
  | 'pause'
  | 'nudge_sent'
  | 'document_upload'
  | 'created'
  | 'comment';

export type NudgeType = 'manual' | 'automatic_day2' | 'automatic_day5' | 'automatic_day10';

export type NudgeChannel = 'in_app' | 'email' | 'sms';

export interface LifecycleLease {
  id: string;
  workspaceId: string;
  userId: string;
  lifecycleStatus: LifecycleStatus;
  category: LeaseCategory | null;
  businessUnit: string | null;
  estimatedTermMin: number | null;
  estimatedTermMax: number | null;
  estimatedMonthlyCostMin: number | null;
  estimatedMonthlyCostMax: number | null;
  leaseOwnerId: string | null;
  notes: string | null;
  rejectionReason: string | null;
  filename: string | null;
  storagePath: string | null;
  submittedForApprovalAt: string | null;
  internalApprovedAt: string | null;
  executionApprovedAt: string | null;
  activatedAt: string | null;
  uploadedAt: string;
  // Extracted data (for executed and beyond)
  tenantName: string | null;
  landlordName: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  currentMonthlyRent: number | null;
}

export interface WorkspaceApprover {
  id: string;
  workspaceId: string;
  userId: string;
  isActive: boolean;
  createdAt: string;
  // Joined data
  userEmail?: string;
  userName?: string;
}

export interface LeaseApprover {
  id: string;
  leaseId: string;
  approverId: string;
  approvalType: ApprovalType;
  approvedAt: string | null;
  createdAt: string;
  // Joined data
  approverEmail?: string;
  approverName?: string;
}

export interface LeaseApprovalAction {
  id: string;
  leaseId: string;
  approverId: string;
  approvalType: ApprovalType;
  action: ApprovalAction;
  comment: string | null;
  createdAt: string;
  // Joined data
  approverEmail?: string;
  approverName?: string;
}

export interface LeaseActivityLog {
  id: string;
  leaseId: string;
  userId: string | null;
  activityType: ActivityType;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  // Joined data
  userEmail?: string;
  userName?: string;
}

export interface LeaseNudge {
  id: string;
  leaseId: string;
  sentBy: string | null;
  nudgeType: NudgeType;
  sentAt: string;
  channel: NudgeChannel;
}

// State machine transitions
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  requested: ['negotiating', 'cancelled'],
  negotiating: ['pending_review', 'cancelled'],
  pending_review: ['executed', 'negotiating', 'cancelled'],
  executed: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: [],
  cancelled: [],
};

// Status display configuration
export const LIFECYCLE_STATUS_CONFIG: Record<LifecycleStatus, {
  label: string;
  shortLabel: string;
  color: 'default' | 'secondary' | 'destructive' | 'outline';
  bgClass: string;
  textClass: string;
}> = {
  requested: {
    label: 'Requested',
    shortLabel: 'Requested',
    color: 'secondary',
    bgClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
  negotiating: {
    label: 'Negotiating',
    shortLabel: 'Negotiating',
    color: 'outline',
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
  },
  pending_review: {
    label: 'Pending Review',
    shortLabel: 'Review',
    color: 'outline',
    bgClass: 'bg-info/10',
    textClass: 'text-info',
  },
  executed: {
    label: 'Executed',
    shortLabel: 'Executed',
    color: 'outline',
    bgClass: 'bg-primary/10',
    textClass: 'text-primary',
  },
  active: {
    label: 'Active',
    shortLabel: 'Active',
    color: 'default',
    bgClass: 'bg-success/10',
    textClass: 'text-success',
  },
  expired: {
    label: 'Expired',
    shortLabel: 'Expired',
    color: 'outline',
    bgClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
  cancelled: {
    label: 'Cancelled',
    shortLabel: 'Cancelled',
    color: 'destructive',
    bgClass: 'bg-destructive/10',
    textClass: 'text-destructive',
  },
};

export const CATEGORY_LABELS: Record<LeaseCategory, string> = {
  property: 'Property',
  equipment: 'Equipment',
  vehicle: 'Vehicle',
  other: 'Other',
};
