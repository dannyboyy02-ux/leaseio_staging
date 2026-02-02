import { Loader2, CheckCircle2, AlertTriangle, XCircle, Clock, FileCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type LeaseProcessingStatus = 
  | 'Uploaded'
  | 'Processing' 
  | 'Ready' 
  | 'Needs Review'
  | 'Review Required'
  | 'Failed'
  | 'Posted'
  | 'Approved'
  | 'Pending Approval'
  | 'Rejected'
  | 'Draft';

interface LeaseStatusBadgeProps {
  status: string | null;
  className?: string;
  showIcon?: boolean;
}

const STATUS_CONFIG: Record<string, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'warning' | 'success';
  icon?: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
}> = {
  'Uploaded': { 
    label: 'Processing', 
    variant: 'secondary',
    icon: Loader2,
    iconClassName: 'animate-spin'
  },
  'Processing': { 
    label: 'Processing', 
    variant: 'secondary',
    icon: Loader2,
    iconClassName: 'animate-spin'
  },
  'Ready': { 
    label: 'Ready', 
    variant: 'success',
    icon: CheckCircle2
  },
  'Needs Review': { 
    label: 'Needs Review', 
    variant: 'warning',
    icon: AlertTriangle
  },
  'Review Required': { 
    label: 'Needs Review', 
    variant: 'warning',
    icon: AlertTriangle
  },
  'Failed': { 
    label: 'Failed', 
    variant: 'destructive',
    icon: XCircle
  },
  'Posted': { 
    label: 'Posted', 
    variant: 'success',
    icon: FileCheck
  },
  'Approved': { 
    label: 'Active', 
    variant: 'success',
    icon: CheckCircle2
  },
  'Pending Approval': { 
    label: 'Pending', 
    variant: 'outline',
    icon: Clock
  },
  'Rejected': { 
    label: 'Rejected', 
    variant: 'destructive',
    icon: XCircle
  },
  'Draft': { 
    label: 'Draft', 
    variant: 'secondary',
    icon: undefined
  },
};

export function LeaseStatusBadge({ status, className, showIcon = true }: LeaseStatusBadgeProps) {
  const config = STATUS_CONFIG[status || ''] || {
    label: status || 'Unknown',
    variant: 'outline' as const,
  };

  const Icon = config.icon;

  return (
    <Badge 
      variant={config.variant}
      className={cn('gap-1', className)}
    >
      {showIcon && Icon && (
        <Icon className={cn('h-3 w-3', config.iconClassName)} />
      )}
      {config.label}
    </Badge>
  );
}

// Helper to check if a status indicates the lease is still processing
export function isProcessingStatus(status: string | null): boolean {
  return status === 'Processing' || status === 'Uploaded';
}

// Helper to check if a status indicates the lease failed
export function isFailedStatus(status: string | null): boolean {
  return status === 'Failed';
}

// Helper to check if a status requires review
export function needsReviewStatus(status: string | null): boolean {
  return status === 'Needs Review' || status === 'Review Required';
}
