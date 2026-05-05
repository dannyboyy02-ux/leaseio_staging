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
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';

interface LeaseStatusBadgeProps {
  status: string | null;
  className?: string;
  showIcon?: boolean;
}

// Phase 3 audit miss reconciled here: this component is a SEPARATE badge
// from LifecycleStatusBadge.tsx (the canonical chain-aware badge in
// /components/lifecycle/). It's used by Leases.tsx + ImportHistory.tsx
// and the audit only traced the lifecycle/ badge.
//
// The Phase 3 fix: every label is sourced from displayLabel() so chain
// vocabulary states render correctly ("Submitted" for both submitted and
// concept_submitted, etc.). The local STATUS_CONFIG below stays — it
// drives icon + variant per status — and is extended with chain values.
const STATUS_CONFIG: Record<string, {
  variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'warning' | 'success' | 'info';
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
}> = {
  // AI extraction status (separate column from lifecycle_status)
  Processing: { variant: 'info', icon: Loader2, iconClassName: 'animate-spin' },
  Uploaded: { variant: 'secondary', icon: FileText },
  Failed: { variant: 'destructive', icon: AlertCircle },
  Ready: { variant: 'success', icon: CheckCircle2 },
  review: { variant: 'warning', icon: AlertTriangle },
  final: { variant: 'success', icon: CheckCircle2 },
  Posted: { variant: 'default', icon: FileCheck },
  // Legacy lifecycle vocabulary
  draft: { variant: 'secondary', icon: FileText },
  submitted: { variant: 'secondary', icon: Clock },
  under_review: { variant: 'warning', icon: AlertTriangle },
  approved: { variant: 'success', icon: CheckCircle2 },
  requested: { variant: 'secondary', icon: Clock },
  negotiating: { variant: 'warning', icon: Clock },
  pending_review: { variant: 'outline', icon: AlertTriangle },
  executed: { variant: 'outline', icon: FileCheck },
  active: { variant: 'success', icon: CheckCircle2 },
  expired: { variant: 'secondary', icon: Clock },
  rejected: { variant: 'destructive', icon: XCircle },
  cancelled: { variant: 'destructive', icon: XCircle },
  // Phase 3 chain vocabulary — variants mirror equivalent legacy states
  concept_submitted: { variant: 'secondary', icon: Clock },
  concept_under_review: { variant: 'warning', icon: AlertTriangle },
  in_negotiation: { variant: 'outline', icon: FileCheck },
  final_review: { variant: 'warning', icon: AlertTriangle },
  pending_counter_signature: { variant: 'warning', icon: Clock },
  fully_executed: { variant: 'outline', icon: FileCheck },
  chain_violation: { variant: 'destructive', icon: AlertCircle },
};

export function LeaseStatusBadge({ status, className, showIcon = true }: LeaseStatusBadgeProps) {
  const key = status ?? '';
  const config = STATUS_CONFIG[key] ?? { variant: 'outline' as const };
  // displayLabel handles every lifecycle vocabulary value and falls back
  // to the raw string for non-lifecycle values like 'Processing',
  // 'Uploaded', etc., which it doesn't know but which render fine.
  const label = key
    ? displayLabel(key as LifecycleStatus)
    : 'Unknown';

  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={cn('gap-1', className)}>
      {showIcon && Icon && <Icon className={cn('h-3 w-3', config.iconClassName)} />}
      {label}
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
