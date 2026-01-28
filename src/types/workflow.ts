export type WorkflowLeaseType = 'Real Estate' | 'Equipment';

export type WorkflowStatus = 
  | 'Draft' 
  | 'Pending Approval' 
  | 'Rejected' 
  | 'Abstracting' 
  | 'Review Required' 
  | 'Posted';

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

export interface CreateLeaseFormData {
  leaseType: WorkflowLeaseType;
  approverEmail: string;
  file?: File;
}

export const WORKFLOW_STATUS_CONFIG: Record<WorkflowStatus, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  bgClass: string;
}> = {
  'Draft': { label: 'Draft', variant: 'secondary', bgClass: 'bg-muted' },
  'Pending Approval': { label: 'Pending', variant: 'outline', bgClass: 'bg-yellow-100' },
  'Rejected': { label: 'Rejected', variant: 'destructive', bgClass: 'bg-red-100' },
  'Abstracting': { label: 'Processing', variant: 'outline', bgClass: 'bg-blue-100' },
  'Review Required': { label: 'Review', variant: 'outline', bgClass: 'bg-purple-100' },
  'Posted': { label: 'Posted', variant: 'default', bgClass: 'bg-green-100' },
};

export const LOW_CONFIDENCE_THRESHOLD = 80;
