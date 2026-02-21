// Re-export calculation types so consumers can import from one place
export type { LeaseInputs, LeaseCalculations } from '@/lib/leaseCalculations';

export type WorkflowLeaseType = 'Real Estate' | 'Equipment';

/** Lifecycle status values — matches DB constraint */
export type WorkflowStatus =
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'executed'
  | 'active'
  | 'rejected'
  | 'cancelled';

export interface ConfidenceScores {
  [field: string]: number; // 0-100
}

export interface AuditEntry {
  field: string;
  oldValue: string;
  newValue: string;
  userId: string;
  timestamp: string;
}

/** Data submitted when creating a new lease commitment request (Phase 1) */
export interface CreateLeaseRequestData {
  // Commitment Details
  assetType: 'property' | 'equipment' | 'vehicle' | 'other';
  description: string;
  vendor?: string;
  requestingDepartment: string;
  // Lease Terms
  monthlyPayment: number;
  termMonths: number;
  startDate: string;         // ISO date
  escalationRate?: number;   // annual %, default 0
  // Financial Review
  covenantFlagged?: boolean;
  // Document
  file?: File;
}

export interface PostedLease {
  id: string;
  filename: string;
  tenant_name: string | null;
  landlord_name: string | null;
  lease_end: string | null;
}

export const WORKFLOW_STATUS_CONFIG: Record<WorkflowStatus, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  bgClass: string;
}> = {
  submitted:    { label: 'Submitted',    variant: 'secondary',    bgClass: 'bg-muted' },
  under_review: { label: 'Under Review', variant: 'outline',      bgClass: 'bg-yellow-100' },
  approved:     { label: 'Approved',     variant: 'default',      bgClass: 'bg-green-100' },
  executed:     { label: 'Executed',     variant: 'outline',      bgClass: 'bg-blue-100' },
  active:       { label: 'Active',       variant: 'default',      bgClass: 'bg-green-100' },
  rejected:     { label: 'Rejected',     variant: 'destructive',  bgClass: 'bg-red-100' },
  cancelled:    { label: 'Cancelled',    variant: 'destructive',  bgClass: 'bg-red-100' },
};

export const LOW_CONFIDENCE_THRESHOLD = 80;
