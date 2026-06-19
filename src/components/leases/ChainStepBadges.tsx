// ChainStepBadges — Phase 7 Checkpoint 4.
//
// Pure presentation. Renders the right context badges next to a chain
// step row based on its assignee_resolution_source + pending_since.
// Used in the approval queue (chain step rows) and the lease detail
// page (chain history surfaces).
//
// Source-to-badge mapping (per spec):
//   voluntary_delegate → "Delegated to you by [Original Assignee]"
//   ooo_delegate       → "Acting for [Original Assignee] (out of office)"
//   policy_delegate    → "Delegate active (original did not respond
//                         within N days)"
//   any pending_since  → "Pending N days" if > 3 days
//   admin_reassign     → "Admin reassigned"
//
// The component is presentational; the parent supplies a pre-resolved
// AssigneeContext shape with the original assignee's display name.

import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Clock, ShieldCheck, UserCheck, UserCog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pendingSlaStatus } from '@/lib/slaStatus';

export type AssigneeResolutionSource =
  | 'policy_user'
  | 'policy_role'
  | 'policy_delegate'
  | 'ooo_delegate'
  | 'voluntary_delegate'
  | 'admin_reassign'
  | null;

interface ChainStepBadgesProps {
  /** From lease_approval_chain.assignee_resolution_source. */
  source: AssigneeResolutionSource;
  /** From lease_approval_chain.pending_since (ISO string from DB). */
  pendingSince: string | null;
  /** Display name of the original approver_user_id (for delegation
   *  context). Null when the original assignment was role-based.  */
  originalAssigneeName?: string | null;
  /** From lease_approval_chain.delegate_after_days. Used for the
   *  policy_delegate timeout-elapsed message. */
  delegateAfterDays?: number | null;
  /** Threshold for the "pending N days" badge. Default 3 — anything
   *  smaller is too noisy. */
  pendingDaysThreshold?: number;
  /** Per-policy SLA in days (approval_policies.sla_days). Drives the "over SLA"
   *  red badge; falls back to DEFAULT_SLA_DAYS (7) when null/unset. #111 C6. */
  slaDays?: number | null;
  className?: string;
}

export function ChainStepBadges({
  source,
  pendingSince,
  originalAssigneeName,
  delegateAfterDays,
  pendingDaysThreshold = 3,
  slaDays,
  className,
}: ChainStepBadgesProps) {
  const { daysPending: days, overSla } = pendingSlaStatus(pendingSince, slaDays);
  const badges: React.ReactNode[] = [];

  if (source === 'voluntary_delegate') {
    badges.push(
      <Badge key="vd" variant="outline" className="text-[10px] gap-1">
        <UserCheck className="h-2.5 w-2.5" />
        {originalAssigneeName
          ? `Delegated to you by ${originalAssigneeName}`
          : 'Delegated to you'}
      </Badge>,
    );
  } else if (source === 'ooo_delegate') {
    badges.push(
      <Badge key="ooo" variant="outline" className="text-[10px] gap-1">
        <UserCog className="h-2.5 w-2.5" />
        {originalAssigneeName
          ? `Acting for ${originalAssigneeName} (out of office)`
          : 'Acting (original assignee out of office)'}
      </Badge>,
    );
  } else if (source === 'policy_delegate') {
    badges.push(
      <Badge key="pd" variant="outline" className="text-[10px] gap-1 text-warning">
        <Clock className="h-2.5 w-2.5" />
        {delegateAfterDays != null
          ? `Delegate active (no response in ${delegateAfterDays} days)`
          : 'Delegate active (timeout)'}
      </Badge>,
    );
  } else if (source === 'admin_reassign') {
    badges.push(
      <Badge key="ar" variant="outline" className="text-[10px] gap-1 text-destructive">
        <ShieldCheck className="h-2.5 w-2.5" />
        Admin reassigned
      </Badge>,
    );
  }

  // Show once aging is meaningful (>= threshold) OR once it's breached SLA (so a
  // short per-policy SLA still surfaces even below the noise floor). Over SLA →
  // red + "over SLA"; otherwise amber.
  if (days !== null && (days >= pendingDaysThreshold || overSla)) {
    badges.push(
      <Badge
        key="pending"
        variant="outline"
        className={cn(
          'text-[10px] gap-1',
          overSla ? 'text-destructive' : 'text-warning',
        )}
      >
        {overSla ? <AlertTriangle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
        {overSla
          ? `Pending ${days} ${days === 1 ? 'day' : 'days'} · over SLA`
          : `Pending ${days} ${days === 1 ? 'day' : 'days'}`}
      </Badge>,
    );
  }

  if (badges.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {badges}
    </div>
  );
}
