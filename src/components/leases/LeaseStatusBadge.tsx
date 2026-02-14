import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCheck,
  FileText,
  Loader2,
  XCircle,
} from 'lucide-react';

interface LeaseStatusBadgeProps {
  status: string | null;
  className?: string;
  showIcon?: boolean;
}

const STATUS_CONFIG: Record<string, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'warning' | 'success' | 'info';
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
}> = {
  Processing: { label: 'Processing', variant: 'info', icon: Loader2, iconClassName: 'animate-spin' },
  Uploaded: { label: 'Uploaded', variant: 'secondary', icon: FileText },
  Failed: { label: 'Failed', variant: 'destructive', icon: AlertCircle },
  Ready: { label: 'Ready', variant: 'success', icon: CheckCircle2 },
  review: { label: 'Review', variant: 'warning', icon: AlertTriangle },
  final: { label: 'Final', variant: 'success', icon: CheckCircle2 },
  Posted: { label: 'Posted', variant: 'default', icon: FileCheck },
  requested: { label: 'Requested', variant: 'secondary', icon: Clock },
  negotiating: { label: 'Negotiating', variant: 'warning', icon: Clock },
  pending_review: { label: 'Pending Review', variant: 'outline', icon: AlertTriangle },
  executed: { label: 'Executed', variant: 'outline', icon: FileCheck },
  active: { label: 'Active', variant: 'success', icon: CheckCircle2 },
  expired: { label: 'Expired', variant: 'secondary', icon: Clock },
  cancelled: { label: 'Cancelled', variant: 'destructive', icon: XCircle },
};

export function LeaseStatusBadge({ status, className, showIcon = true }: LeaseStatusBadgeProps) {
  const config = STATUS_CONFIG[status || ''] || {
    label: status || 'Unknown',
    variant: 'outline' as const,
  };

  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={cn('gap-1', className)}>
      {showIcon && Icon && <Icon className={cn('h-3 w-3', config.iconClassName)} />}
      {config.label}
    </Badge>
  );
}

export function isProcessingStatus(status: string | null): boolean {
  return status === 'Processing' || status === 'Uploaded';
}

export function isFailedStatus(status: string | null): boolean {
  return status === 'Failed';
}

export function needsReviewStatus(status: string | null): boolean {
  return status === 'Needs Review' || status === 'Review Required' || status === 'pending_review';
}
