// Lease Lifecycle Types
//
// Phase 3 expanded the vocabulary: the legacy 8 states are joined by 8
// chain-vocabulary states (draft, concept_submitted, concept_under_review,
// in_negotiation, final_review, pending_counter_signature, fully_executed,
// chain_violation). Both vocabularies coexist permanently — chain-driven
// leases use the new states; legacy-fallback leases stay on the old ones.
//
// The canonical state list, group helpers, transitions, and display
// labels live in src/lib/lifecycleStates.ts (Node) ↔
// supabase/functions/_shared/lifecycle.ts (Deno). This file re-exports
// the type and keeps the static UI-facing config the badge consumes.
//
// NOTE: 'draft' is part of both vocabularies (per lifecycleStates.ts) but
// it is not in the legacy 8-state list above and was previously absent
// here. Phase 3 adds it so the LIFECYCLE_STATUS_CONFIG below can render
// it consistently.

export type LifecycleStatus =
  | 'draft'
  // Legacy
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'executed'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'cancelled'
  // Chain
  | 'concept_submitted'
  | 'concept_under_review'
  | 'in_negotiation'
  | 'final_review'
  | 'pending_counter_signature'
  | 'fully_executed'
  | 'chain_violation';

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
  | 'comment'
  // Phase 2 — approval chain
  | 'manager_approved'
  | 'manager_rejected'
  | 'financial_approved'
  | 'financial_rejected'
  | 'financial_returned'
  | 'resubmitted'
  // Phase 4 — executed record
  | 'executed_uploaded'
  | 'executed_terms_extracted'
  | 'executed_terms_edited'
  | 'classification_resolved'
  | 'model_locked'
  // Governance workflow
  | 'change_submitted'
  | 'unlock_approved'
  | 'unlock_rejected'
  | 'change_approved'
  | 'change_rejected'
  | 'change_canceled';

export type FunctionalRole = 'submitter' | 'manager_approver' | 'financial_approver' | 'admin';

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
  // Financial inputs (Phase 1)
  monthlyPayment: number | null;
  termMonths: number | null;
  assetType: LeaseCategory | null;
  escalationRate: number | null;
  calcTotalCommitment: number | null;
  calcPvLiability: number | null;
  calcStraightLineExp: number | null;
  calcCashPlDelta: number | null;
  leaseClassification: 'operating' | 'finance' | 'pending' | null;
  covenantFlagged: boolean;
  intakeSource: 'request_workflow' | 'email_intake' | 'backdoor' | 'manual_upload';
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
//
// Mirrors VALID_TRANSITIONS in src/lib/lifecycleStates.ts (which is the
// canonical source for the chain helpers + vitest tests). Kept here for
// existing consumers that import LIFECYCLE_TRANSITIONS from this file.
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  // Legacy
  draft: ['submitted', 'concept_submitted', 'cancelled'],
  submitted: ['under_review', 'rejected', 'approved', 'cancelled'],
  under_review: ['approved', 'rejected', 'submitted', 'cancelled'],
  approved: ['executed', 'rejected', 'cancelled'],
  executed: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: [],
  rejected: ['submitted'],
  cancelled: [],
  // Chain
  concept_submitted: ['concept_under_review', 'in_negotiation', 'rejected', 'cancelled'],
  concept_under_review: ['in_negotiation', 'rejected', 'concept_submitted', 'cancelled'],
  in_negotiation: ['final_review', 'rejected', 'cancelled'],
  final_review: ['pending_counter_signature', 'in_negotiation', 'rejected', 'cancelled'],
  pending_counter_signature: ['fully_executed', 'cancelled'],
  fully_executed: ['active', 'chain_violation', 'cancelled'],
  chain_violation: ['active', 'cancelled'],
};

// Status display configuration
export const LIFECYCLE_STATUS_CONFIG: Record<LifecycleStatus, {
  label: string;
  shortLabel: string;
  color: 'default' | 'secondary' | 'destructive' | 'outline';
  bgClass: string;
  textClass: string;
}> = {
  submitted: {
    label: 'Submitted',
    shortLabel: 'Submitted',
    color: 'secondary',
    bgClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
  under_review: {
    label: 'Under Review',
    shortLabel: 'Review',
    color: 'outline',
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
  },
  approved: {
    label: 'Approved',
    shortLabel: 'Approved',
    color: 'default',
    bgClass: 'bg-success/10',
    textClass: 'text-success',
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
  rejected: {
    label: 'Rejected',
    shortLabel: 'Rejected',
    color: 'destructive',
    bgClass: 'bg-destructive/10',
    textClass: 'text-destructive',
  },
  cancelled: {
    label: 'Cancelled',
    shortLabel: 'Cancelled',
    color: 'destructive',
    bgClass: 'bg-destructive/10',
    textClass: 'text-destructive',
  },
  // ── Phase 3 additions ────────────────────────────────────────────────
  // 'draft' is the pre-submission state both vocabularies share.
  draft: {
    label: 'Draft',
    shortLabel: 'Draft',
    color: 'secondary',
    bgClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
  // Chain vocabulary. Per the Phase 3 spec, user-facing labels for chain
  // states in the same semantic group as a legacy state are intentionally
  // identical (e.g. 'concept_submitted' renders as "Submitted" — the user
  // should not see internal vocabulary differences).
  concept_submitted: {
    label: 'Submitted',
    shortLabel: 'Submitted',
    color: 'secondary',
    bgClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
  concept_under_review: {
    label: 'Under Review',
    shortLabel: 'Review',
    color: 'outline',
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
  },
  in_negotiation: {
    label: 'In Negotiation',
    shortLabel: 'Negotiation',
    color: 'outline',
    bgClass: 'bg-primary/10',
    textClass: 'text-primary',
  },
  final_review: {
    label: 'Final Review',
    shortLabel: 'Final',
    color: 'outline',
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
  },
  pending_counter_signature: {
    label: 'Awaiting Counter-Signature',
    shortLabel: 'Counter-Sign',
    color: 'outline',
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
  },
  fully_executed: {
    label: 'Fully Executed',
    shortLabel: 'Executed',
    color: 'outline',
    bgClass: 'bg-primary/10',
    textClass: 'text-primary',
  },
  chain_violation: {
    label: 'Chain Violation',
    shortLabel: 'Violation',
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
