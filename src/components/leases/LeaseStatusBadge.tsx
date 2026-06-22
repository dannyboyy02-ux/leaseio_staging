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
import { LIFECYCLE_STATUS_CONFIG } from '@/types/lifecycle';

// Canonical status badge for the whole app. Unifies the two former badges:
//   - appearance="variant" (default): icon + semantic Badge variant. Covers the
//     AI-extraction `status` column (Processing/Uploaded/Failed/Ready) AND
//     lifecycle/chain vocabulary — used by the Leases list, ImportHistory, and
//     the LeaseReview header.
//   - appearance="soft": bg/text pill with optional short labels at size="sm".
//     Used by lifecycle surfaces via the LifecycleStatusBadge wrapper.
//
// Single label source: displayLabel() handles every lifecycle/chain value and
// falls back to the raw string for AI-extraction statuses it doesn't know
// (which render fine). The soft pill's short labels + bg/text styling come from
// LIFECYCLE_STATUS_CONFIG (the only place those are defined). Its full labels
// are kept in lock-step with displayLabel(), so the two appearances never drift.

const VARIANT_CONFIG: Record<string, {
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

export interface StatusBadgeProps {
  status: string | null;
  className?: string;
  /** 'variant' (default): icon + semantic Badge variant. 'soft': bg/text pill. */
  appearance?: 'variant' | 'soft';
  /** variant appearance only. */
  showIcon?: boolean;
  /** soft appearance only — 'sm' renders the short label + tighter padding. */
  size?: 'sm' | 'default';
}

export function LeaseStatusBadge({
  status,
  className,
  appearance = 'variant',
  showIcon = true,
  size = 'default',
}: StatusBadgeProps) {
  const key = status ?? '';
  // Canonical full label, shared by both appearances.
  const fullLabel = key ? displayLabel(key as LifecycleStatus) : 'Unknown';

  if (appearance === 'soft') {
    const lifecycleConfig = LIFECYCLE_STATUS_CONFIG[key as LifecycleStatus];
    const label =
      size === 'sm' ? (lifecycleConfig?.shortLabel ?? fullLabel) : fullLabel;
    return (
      <Badge
        variant={lifecycleConfig?.color ?? 'outline'}
        className={cn(
          lifecycleConfig?.bgClass,
          lifecycleConfig?.textClass,
          'border-0 font-medium',
          size === 'sm' && 'text-xs px-2 py-0.5',
          className,
        )}
      >
        {label}
      </Badge>
    );
  }

  const config = VARIANT_CONFIG[key] ?? { variant: 'outline' as const };
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={cn('gap-1', className)}>
      {showIcon && Icon && <Icon className={cn('h-3 w-3', config.iconClassName)} />}
      {fullLabel}
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
