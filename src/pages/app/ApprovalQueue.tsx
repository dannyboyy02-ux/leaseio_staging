import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  FileText,
  ChevronRight,
  Undo2,
  ShieldCheck,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageLayout } from '@/components/layout/PageLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { cn } from '@/lib/utils';
import {
  displayLabel,
  isEquivalent,
  roleLabel,
  stageLabel,
  type LifecycleStatus,
} from '@/lib/lifecycleStates';
import { ChainStepBadges } from '@/components/leases/ChainStepBadges';
import { VoluntaryDelegationModal } from '@/components/workflow/VoluntaryDelegationModal';

import { localizedRoleLabel, localizedStageLabel, localizedStatusLabel } from '@/lib/lifecycleLabels';
interface QueueLease {
  id: string;
  request_title: string | null;
  tenant_name: string | null;
  requesting_department: string | null;
  asset_type: string | null;
  monthly_payment: number | null;
  term_months: number | null;
  calc_total_commitment: number | null;
  covenant_flagged: boolean | null;
  lifecycle_status: string;
  financial_returned_to_submitter: boolean | null;
  manager_approved_by: string | null;
  manager_approved_at: string | null;
  financial_approved_by: string | null;
  uploaded_at: string;
  requestor_id?: string | null;
  requestorEmail?: string;
  requestorName?: string;
}

const fmt = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '\u2014';

function LeaseQueueCard({
  lease,
  isManagerApprover,
  isFinancialApprover,
  viewerMode,
  onApprove,
  onReject,
  onView,
}: {
  lease: QueueLease;
  isManagerApprover: boolean;
  isFinancialApprover: boolean;
  viewerMode: boolean;
  onApprove: (lease: QueueLease) => void;
  onReject: (lease: QueueLease) => void;
  onView: (lease: QueueLease) => void;
}) {
  const { t } = useAppTranslation();
  // Phase 3: queue-specific labels preserved for both vocabularies via
  // isEquivalent. The bespoke "Awaiting X Review" strings are queue UX —
  // localizedStatusLabel('submitted') would lose that context.
  const status = lease.lifecycle_status as LifecycleStatus;
  const statusLabel =
    isEquivalent(status, 'submitted') ? t('approvals.queue.awaiting_manager_review')
    : isEquivalent(status, 'under_review') ? t('approvals.queue.awaiting_financial_review')
    : localizedStatusLabel(status);

  const canManagerAct =
    isManagerApprover &&
    isEquivalent(status, 'submitted') &&
    !lease.financial_returned_to_submitter;
  const canFinancialAct = isFinancialApprover && isEquivalent(status, 'under_review');
  const canAct = canManagerAct || canFinancialAct;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="p-4 sm:p-5 space-y-3">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <button
                onClick={() => onView(lease)}
                className="text-sm font-semibold text-left hover:underline truncate block max-w-full"
              >
                {lease.request_title || t('approvals.queue.untitled_request')}
              </button>
              {lease.tenant_name && (
                <p className="text-xs font-medium text-foreground/70 mt-0.5 truncate">
                  {lease.tenant_name}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {lease.asset_type && (
                  <span className="capitalize">{lease.asset_type}</span>
                )}
                {lease.requesting_department && ` \u00b7 ${lease.requesting_department}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {lease.covenant_flagged && (
                <Badge variant="destructive" className="text-[10px] px-1.5">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  {t('approvals.queue.covenant_badge')}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px]">{statusLabel}</Badge>
            </div>
          </div>

          {/* Financial summary */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">{t('approvals.queue.monthly')}</p>
              <p className="font-semibold">{fmt(lease.monthly_payment)}</p>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">{t('approvals.financial.term')}</p>
              <p className="font-semibold">
                {lease.term_months != null
                  ? t('approvals.queue.months_short', { count: lease.term_months })
                  : '\u2014'}
              </p>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">{t('approvals.queue.total_commitment')}</p>
              <p className="font-semibold">{fmt(lease.calc_total_commitment)}</p>
            </div>
          </div>

          {/* Submitter + date */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {lease.requestorName || lease.requestorEmail || t('approvals.queue.unknown_submitter')}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {format(new Date(lease.uploaded_at), 'MMM d, yyyy')}
            </span>
          </div>

          {/* Actions */}
          {!viewerMode && (
            <div className="flex flex-wrap gap-2 pt-1">
              {canManagerAct ? (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="flex-1 sm:flex-none"
                    onClick={() => onApprove(lease)}
                  >
                    <CheckCircle className="h-4 w-4 mr-1.5" />
                    {t('approval.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                    onClick={() => onReject(lease)}
                  >
                    <XCircle className="h-4 w-4 mr-1.5" />
                    {t('approval.reject')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onView(lease)} className="gap-1">
                    {t('approvals.queue.view_lease')} <ChevronRight className="h-4 w-4" />
                  </Button>
                </>
              ) : canFinancialAct ? (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => onView(lease)}
                    className="flex-1 sm:flex-none gap-1"
                  >
                    {t('approvals.queue.open_financial_review')} <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                    onClick={() => onReject(lease)}
                  >
                    <XCircle className="h-4 w-4 mr-1.5" />
                    {t('approval.reject')}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onView(lease)} className="gap-1">
                  {t('approvals.queue.view_lease')} <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
          {viewerMode && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onView(lease)}
              className="gap-1 w-full sm:w-auto"
            >
              {t('approvals.queue.view_lease')} <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Phase 2 — chain-step inbox source ──────────────────────────────────
// Additive parallel data source for the merged approver inbox. Renders
// alongside (NOT replacing) the legacy QueueLease cards in the
// "Needs My Review" tab.
interface PendingChainStep {
  id: string;
  lease_id: string;
  workspace_id: string;
  stage: 'concept' | 'signator';
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  is_required: boolean;
  created_at: string;
  policy_id: string | null;
  // Phase 7 — delegate-aware fields. May be NULL on chain rows that
  // pre-date Phase 7 deployment.
  effective_assignee_user_id?: string | null;
  assignee_resolution_source?:
    | 'policy_user'
    | 'policy_role'
    | 'policy_delegate'
    | 'ooo_delegate'
    | 'voluntary_delegate'
    | 'admin_reassign'
    | null;
  pending_since?: string | null;
  delegate_after_days?: number | null;
  // Hydrated from leases table:
  request_title: string | null;
  requesting_department: string | null;
  asset_type: string | null;
  monthly_payment: number | null;
  calc_total_commitment: number | null;
  // Hydrated from approval_policies (#111 C6 — per-policy SLA aging badge):
  slaDays?: number | null;
}

// C3 (#111) — a voluntary delegation the current user made that's still active
// (revoked_at IS NULL) and whose step is still pending. Shown in the "mine" tab
// so the delegator can revoke it.
interface DelegatedByMeRow {
  chainStepId: string;
  leaseId: string;
  leaseTitle: string;
  delegateName: string;
  stage: 'concept' | 'signator';
  delegatedAt: string;
}

function ChainStepCard({
  step,
  onView,
  onActed,
}: {
  step: PendingChainStep;
  onView: (leaseId: string) => void;
  onActed: () => void;
}) {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const [actionDialog, setActionDialog] = useState<'approve' | 'reject' | 'send_back' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  // Phase 7: voluntary delegation modal
  const [delegateOpen, setDelegateOpen] = useState(false);
  // P1-2: a signator step cannot be actioned inline — its Approve requires an
  // intent-to-bind attestation that only the dedicated SignatorReview page
  // collects (a bare queue "Approve" 400s server-side). Route to that page.
  const isSignatorStep = step.stage === 'signator';

  // Visual tag distinguishing source — per the Phase 2 guard rail, makes
  // it obvious where each row came from when merged with legacy ones.
  const stageText = localizedStageLabel(step.stage);
  const tagLabel = step.approver_role
    ? `${stageText} · ${localizedRoleLabel(step.approver_role)}`
    : `${stageText} · ${t('approvals.queue.step_n', { n: step.step_order })}`;

  const submit = async (action: 'approve' | 'reject' | 'send_back') => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('act-on-chain-step', {
        body: {
          chainStepId: step.id,
          action,
          comment: comment.trim() || undefined,
        },
      });
      if (error || !(data as any)?.ok) {
        toast.error((data as any)?.error || error?.message || t('approvals.common.action_failed'));
        return;
      }
      toast.success(
        action === 'approve'
          ? t('approvals.queue.step_approved')
          : action === 'reject'
          ? t('approvals.queue.step_rejected')
          : t('approvals.queue.step_sent_back'),
      );
      setActionDialog(null);
      setComment('');
      onActed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden border-l-4 border-l-blue-400">
      <CardContent className="p-0">
        <div className="p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <button
                onClick={() => onView(step.lease_id)}
                className="text-sm font-semibold text-left hover:underline truncate block max-w-full"
              >
                {step.request_title || t('approvals.queue.untitled_request')}
              </button>
              <p className="text-xs text-muted-foreground mt-0.5">
                {step.asset_type && <span className="capitalize">{step.asset_type}</span>}
                {step.requesting_department && ` · ${step.requesting_department}`}
              </p>
            </div>
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/20 dark:text-blue-300"
            >
              {tagLabel}
            </Badge>
          </div>

          {/* Phase 7: delegation context badges (voluntary / OOO / policy
              delegate / pending N days). Auto-hides when no badges apply. */}
          <ChainStepBadges
            source={step.assignee_resolution_source ?? null}
            pendingSince={step.pending_since ?? null}
            originalAssigneeName={null}
            delegateAfterDays={step.delegate_after_days ?? null}
            slaDays={step.slaDays ?? null}
          />

          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {step.monthly_payment != null && (
              <span>
                <strong className="text-foreground">{fmt(step.monthly_payment)}</strong> /{t('common.per_month_short')}
              </span>
            )}
            {step.calc_total_commitment != null && (
              <span>
                {t('approvals.queue.total')} <strong className="text-foreground">{fmt(step.calc_total_commitment)}</strong>
              </span>
            )}
            <span>{t('approvals.queue.submitted_on', { date: format(new Date(step.created_at), 'MMM d, yyyy') })}</span>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {isSignatorStep ? (
              // Signator steps: one action that opens the attestation workbench,
              // where approve (with intent-to-bind), send back, and reject all
              // live with proper reason/attestation collection.
              <Button
                size="sm"
                onClick={() => navigate(`/app/leases/${step.lease_id}/signator-review`)}
                disabled={busy}
                className="flex-1 sm:flex-none"
              >
                <ShieldCheck className="h-4 w-4 mr-1" />
                {t('approvals.queue.review_and_sign')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => submit('approve')}
                  disabled={busy}
                  className="flex-1 sm:flex-none"
                >
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  {t('approval.approve')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActionDialog('send_back')}
                  disabled={busy}
                  className="flex-1 sm:flex-none"
                >
                  {t('approvals.signator.send_back')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setActionDialog('reject')}
                  disabled={busy}
                  className="flex-1 sm:flex-none"
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  {t('approval.reject')}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDelegateOpen(true)}
              disabled={busy}
              className="flex-1 sm:flex-none"
              title={t('approvals.queue.delegate_title')}
            >
              {t('approvals.queue.delegate_ellipsis')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onView(step.lease_id)}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              {t('common.view')} <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </CardContent>

      <VoluntaryDelegationModal
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        chainStepId={step.id}
        workspaceId={step.workspace_id}
        onDelegated={onActed}
      />

      {/* P1-2 (j4-approver §40): clear `comment` whenever this reason dialog
          closes — otherwise a typed-then-cancelled reject/send-back reason
          survives in shared state and a later bare Approve would submit it as
          the approval's audit comment. */}
      <Dialog
        open={actionDialog !== null}
        onOpenChange={(o) => {
          if (!o) {
            setActionDialog(null);
            setComment('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog === 'reject'
                ? t('approvals.queue.reject_step_title')
                : t('approvals.queue.send_back_title')}
            </DialogTitle>
            <DialogDescription>
              {actionDialog === 'reject'
                ? t('approvals.queue.reject_step_desc')
                : t('approvals.queue.send_back_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">{t('approvals.queue.comment_required')}</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('approvals.queue.explain_reason_placeholder')}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setActionDialog(null);
                setComment('');
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant={actionDialog === 'reject' ? 'destructive' : 'default'}
              onClick={() => actionDialog && submit(actionDialog)}
              disabled={busy || !comment.trim()}
            >
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface UnlockRequest {
  id: string;
  lease_id: string;
  request_reason: string;
  requested_by: string;
  created_at: string;
  leaseName?: string;
  requesterName?: string;
}

interface ChangeSetForReview {
  id: string;
  lease_id: string;
  change_summary: string | null;
  submitted_at: string | null;
  leaseName?: string;
  submitterName?: string;
  items: Array<{ field_label: string; old_value: string | null; proposed_value: string | null }>;
}

export default function ApprovalQueue() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useAppTranslation();
  const { user, workspace, userFunctionalRoles, userRole } = useApp();

  const isManagerApprover = userFunctionalRoles.includes('manager_approver');
  const isFinancialApprover = userFunctionalRoles.includes('financial_approver');
  const isAdminUser = userRole === 'admin' || userRole === 'owner';

  const [pendingMyReview, setPendingMyReview] = useState<QueueLease[]>([]);
  const [allPending, setAllPending] = useState<QueueLease[]>([]);
  const [reviewed, setReviewed] = useState<QueueLease[]>([]);
  const [loading, setLoading] = useState(true);

  // Phase 2 — chain-step inbox source. Parallel to the legacy state above.
  const [pendingChainSteps, setPendingChainSteps] = useState<PendingChainStep[]>([]);
  // C3 (#111) — "Delegated by me": active voluntary delegations this user made.
  // Exclusive delegation moves a step off the delegator's own queue, so this is
  // the surface where they revoke a mis-delegation (backed by
  // revoke-voluntary-delegation, which authorizes delegated_by === caller).
  const [delegatedByMe, setDelegatedByMe] = useState<DelegatedByMeRow[]>([]);
  const [revokingStepId, setRevokingStepId] = useState<string | null>(null);
  // Phase 5: leases in pending_counter_signature where the current user
  // is the execution_owner_id. Surfaced inside "Needs My Review" so the
  // execution owner has a single inbox view.
  const [executionOwnerLeases, setExecutionOwnerLeases] = useState<
    Array<{
      id: string;
      request_title: string | null;
      tenant_name: string | null;
      counter_signature_due_date: string | null;
      counter_signature_reminder_count: number | null;
    }>
  >([]);

  const [approveTarget, setApproveTarget] = useState<QueueLease | null>(null);
  const [rejectTarget, setRejectTarget] = useState<QueueLease | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [isActing, setIsActing] = useState(false);

  // Governance state
  const [unlockRequests, setUnlockRequests] = useState<UnlockRequest[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSetForReview[]>([]);
  const [governanceLoading, setGovernanceLoading] = useState(false);
  const [unlockActTarget, setUnlockActTarget] = useState<UnlockRequest | null>(null);
  const [unlockActType, setUnlockActType] = useState<'approve' | 'reject' | null>(null);
  const [changeSetActTarget, setChangeSetActTarget] = useState<ChangeSetForReview | null>(null);
  const [changeSetActType, setChangeSetActType] = useState<'approve' | 'reject' | null>(null);
  const [governanceNote, setGovernanceNote] = useState('');
  const [isGovernanceActing, setIsGovernanceActing] = useState(false);
  const [expandedChangeSet, setExpandedChangeSet] = useState<string | null>(null);

  const attachProfiles = async (leases: any[]): Promise<QueueLease[]> => {
    if (!leases.length) return [];
    const userIds = [...new Set(leases.map((l) => l.requestor_id).filter(Boolean))];
    if (!userIds.length) return leases;
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email, first_name, last_name')
      .in('id', userIds);
    return leases.map((l) => {
      const p = profiles?.find((pr) => pr.id === l.requestor_id);
      return {
        ...l,
        requestorEmail: p?.email,
        requestorName:
          p?.first_name && p?.last_name ? `${p.first_name} ${p.last_name}` : p?.email,
      };
    });
  };

  const fetchLeases = useCallback(async () => {
    if (!workspace?.id || !user?.id) return;
    setLoading(true);
    try {
      const baseQuery = () =>
        (supabase as any)
          .from('leases')
          .select(
            'id, request_title, tenant_name, requesting_department, asset_type,' +
            'monthly_payment, term_months, calc_total_commitment, covenant_flagged,' +
            'lifecycle_status, financial_returned_to_submitter, manager_approved_by,' +
            'manager_approved_at, financial_approved_by, uploaded_at, requestor_id',
          )
          .eq('workspace_id', workspace.id)
          .eq('archived', false);

      // Needs My Review.
      //
      // Phase 3 follow-up (2026-05-05 smoke): the LEGACY queue stays
      // legacy-only. Chain leases are surfaced exclusively via the
      // chain step section (chainQuery below). My earlier Batch B edit
      // included concept_submitted / concept_under_review here, which
      // double-listed chain leases AND let users approve them via the
      // legacy handler — which writes legacy lifecycle values and ignores
      // the chain rows, corrupting the chain state.
      const myReviewConditions: any[] = [];
      if (isManagerApprover) {
        myReviewConditions.push(
          baseQuery()
            .eq('lifecycle_status', 'submitted')
            .or('financial_returned_to_submitter.is.null,financial_returned_to_submitter.eq.false')
            .is('manager_approved_by', null),
        );
      }
      if (isFinancialApprover) {
        myReviewConditions.push(
          baseQuery()
            .eq('lifecycle_status', 'under_review')
            .is('financial_approved_by', null),
        );
      }

      const myReviewResults = await Promise.all(myReviewConditions.map((q) => q));
      const myReviewLeases = myReviewResults.flatMap((r) => r.data || []);
      const myReviewUniq = Array.from(
        new Map(myReviewLeases.map((l) => [l.id, l])).values()
      );

      const { data: allPendingData } = await baseQuery()
        .in('lifecycle_status', ['submitted', 'under_review'])
        .order('uploaded_at', { ascending: false });

      const { data: reviewedData } = await baseQuery()
        .or(`manager_approved_by.eq.${user.id},financial_approved_by.eq.${user.id}`)
        .not('lifecycle_status', 'in', '(submitted,under_review)')
        .order('uploaded_at', { ascending: false })
        .limit(50);

      const { data: activityRows } = await supabase
        .from('lease_activity_log')
        .select('lease_id')
        .eq('user_id', user.id)
        .in('activity_type', ['rejection', 'send_back']);

      const actedLeaseIds = [...new Set((activityRows || []).map((a: any) => a.lease_id))];
      let actedLeases: any[] = [];
      if (actedLeaseIds.length > 0) {
        const { data } = await baseQuery()
          .in('id', actedLeaseIds)
          .order('uploaded_at', { ascending: false });
        actedLeases = data || [];
      }

      const reviewedUniq = Array.from(
        new Map(
          [...(reviewedData || []), ...actedLeases].map((l) => [l.id, l])
        ).values()
      );

      const [myReviewWithProfiles, allPendingWithProfiles, reviewedWithProfiles] =
        await Promise.all([
          attachProfiles(myReviewUniq),
          attachProfiles(allPendingData || []),
          attachProfiles(reviewedUniq),
        ]);

      setPendingMyReview(myReviewWithProfiles);
      setAllPending(allPendingWithProfiles);
      setReviewed(reviewedWithProfiles);

      // Phase 2 — chain-step inbox. Additive, parallel to the legacy
      // queries above. Two phases:
      //   1. Get the functional roles I hold in this workspace.
      //   2. Find pending chain steps assigned to me directly OR to a
      //      role I hold. Then hydrate with lease metadata for display.
      const { data: myRoleRows } = await (supabase as any)
        .from('workspace_roles')
        .select('role')
        .eq('workspace_id', workspace.id)
        .eq('user_id', user.id);
      const myRoleNames = ((myRoleRows ?? []) as Array<{ role: string | null }>)
        .map((r) => r.role)
        .filter((r): r is string => Boolean(r));

      let chainQuery = (supabase as any)
        .from('lease_approval_chain')
        .select(
          // Phase 7: also pull delegate-aware fields so badges + delegation
          // affordance can render based on resolution source / pending_since.
          'id, lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, approver_role, is_required, created_at, policy_id, effective_assignee_user_id, assignee_resolution_source, pending_since, delegate_after_days',
        )
        .eq('workspace_id', workspace.id)
        .eq('status', 'pending');

      // C3 (#111): EXCLUSIVE delegation — mirror act-on-chain-step's authz
      // precedence so a delegator no longer SEES a step they handed off. Surface
      // a step when the user is the effective assignee (the precedence-resolved
      // actor: admin reassign / voluntary / OOO / activated policy delegate), OR
      // — only when there is no resolved effective assignee (role-based row, or a
      // pre-Phase-7 chain not yet backfilled) — when they are the original
      // assignee or hold the role.
      if (myRoleNames.length > 0) {
        chainQuery = chainQuery.or(
          `effective_assignee_user_id.eq.${user.id},` +
          `and(effective_assignee_user_id.is.null,approver_user_id.eq.${user.id}),` +
          `and(effective_assignee_user_id.is.null,approver_role.in.(${myRoleNames.join(',')}))`,
        );
      } else {
        chainQuery = chainQuery.or(
          `effective_assignee_user_id.eq.${user.id},` +
          `and(effective_assignee_user_id.is.null,approver_user_id.eq.${user.id})`,
        );
      }

      const { data: chainStepRows } = await chainQuery;
      const chainSteps = (chainStepRows ?? []) as Array<Omit<PendingChainStep, 'request_title' | 'requesting_department' | 'asset_type' | 'monthly_payment' | 'calc_total_commitment'>>;

      let hydratedChainSteps: PendingChainStep[] = [];
      if (chainSteps.length > 0) {
        const chainLeaseIds = Array.from(new Set(chainSteps.map((s) => s.lease_id)));
        // #111 C6: fetch each step's policy SLA so the badge can flag over-SLA.
        const chainPolicyIds = Array.from(
          new Set(chainSteps.map((s) => s.policy_id).filter((p): p is string => !!p)),
        );
        const [{ data: chainLeases }, { data: chainPolicies }, { data: allLeaseSteps }] = await Promise.all([
          supabase
            .from('leases')
            .select(
              'id, request_title, requesting_department, asset_type, monthly_payment, calc_total_commitment, lifecycle_status',
            )
            .in('id', chainLeaseIds),
          chainPolicyIds.length > 0
            ? supabase.from('approval_policies').select('id, sla_days').in('id', chainPolicyIds)
            : Promise.resolve({ data: [] as Array<{ id: string; sla_days: number | null }> }),
          // P1-3 intra-stage frontier: fetch EVERY step for these leases (not
          // just this user's), so we can tell whether an earlier required step
          // in the same stage is still pending and this card should wait its
          // turn. RLS lets a workspace member read all chain rows in-workspace.
          supabase
            .from('lease_approval_chain')
            .select('lease_id, stage, step_order, is_required, status')
            .in('lease_id', chainLeaseIds),
        ]);
        const leaseMap = new Map(
          (chainLeases ?? []).map((l: any) => [l.id, l]),
        );
        const policySlaMap = new Map<string, number | null>(
          (chainPolicies ?? []).map((p: any): [string, number | null] => [p.id, p.sla_days ?? null]),
        );
        // lease_id → all its chain steps (for the sequential-frontier check).
        const stepsByLease = new Map<string, Array<{ stage: string; step_order: number; is_required: boolean; status: string }>>();
        for (const st of (allLeaseSteps ?? []) as Array<any>) {
          const arr = stepsByLease.get(st.lease_id) ?? [];
          arr.push({ stage: st.stage, step_order: st.step_order, is_required: !!st.is_required, status: st.status });
          stepsByLease.set(st.lease_id, arr);
        }
        // A step waits its turn if an EARLIER required step in the SAME stage
        // for the same lease is still pending. (Cross-stage ordering — signator
        // vs concept — is handled by the lifecycle gate below, which also covers
        // the in_negotiation gap the chain state alone would miss.)
        const hasEarlierSameStageBlocker = (
          leaseId: string, stage: string, stepOrder: number,
        ): boolean => {
          const siblings = stepsByLease.get(leaseId) ?? [];
          return siblings.some(
            (o) => o.stage === stage && o.is_required && o.status === 'pending' && o.step_order < stepOrder,
          );
        };
        // P1-2/P1-3 stage-frontier filter for signator cards. A signator row is
        // inserted 'pending' at initial submission, so without a gate the CFO
        // sees an actionable "Final approval" card from day 1. The card routes to
        // SignatorReview, which ONLY accepts lifecycle==='final_review' — so this
        // is a positive ALLOWLIST, not a concept-phase blocklist: show a signator
        // card exactly when the lease is at final_review. That hides both the
        // premature (concept-phase) card AND the retro/terminal ones
        // (chain_violation / rejected / cancelled / expired / executed) that
        // would otherwise route to SignatorReview's "cannot proceed" dead-end
        // (P1-2 review — integrity/auditor/polish, unanimous). Any post-reroute
        // re-attestation is a separate flow SignatorReview doesn't yet support.
        hydratedChainSteps = chainSteps
          .filter((s) => {
            if (s.stage === 'signator') {
              const lc: string | null = (leaseMap.get(s.lease_id) as any)?.lifecycle_status ?? null;
              if (lc !== 'final_review') return false;
            }
            // P1-3 sequential frontier: hold a card until earlier required steps
            // in the same stage have acted (a step-2 approver no longer sees an
            // actionable card while step-1 is still pending).
            if (hasEarlierSameStageBlocker(s.lease_id, s.stage, s.step_order)) return false;
            return true;
          })
          .map((s) => {
            const l: any = leaseMap.get(s.lease_id) ?? {};
            return {
              ...s,
              request_title: l.request_title ?? null,
              requesting_department: l.requesting_department ?? null,
              asset_type: l.asset_type ?? null,
              monthly_payment: l.monthly_payment ?? null,
              calc_total_commitment: l.calc_total_commitment ?? null,
              slaDays: s.policy_id ? policySlaMap.get(s.policy_id) ?? null : null,
            };
          });
      }
      setPendingChainSteps(hydratedChainSteps);

      // C3 (#111) — "Delegated by me": active voluntary delegations this user
      // made, whose step is still pending. RLS (voluntary_delegations_select)
      // scopes to the user's workspaces; we additionally filter delegated_by.
      const { data: myDelegRows } = await supabase
        .from('chain_step_voluntary_delegations')
        .select('chain_step_id, lease_id, delegated_to, delegated_at')
        .eq('workspace_id', workspace.id)
        .eq('delegated_by', user.id)
        .is('revoked_at', null);
      const delegRows = (myDelegRows ?? []) as Array<{
        chain_step_id: string; lease_id: string; delegated_to: string; delegated_at: string;
      }>;
      let hydratedDelegs: DelegatedByMeRow[] = [];
      if (delegRows.length > 0) {
        const dLeaseIds = Array.from(new Set(delegRows.map((d) => d.lease_id)));
        const dDelegateIds = Array.from(new Set(delegRows.map((d) => d.delegated_to)));
        const dStepIds = Array.from(new Set(delegRows.map((d) => d.chain_step_id)));
        const [dLeasesRes, dProfilesRes, dStepsRes] = await Promise.all([
          supabase.from('leases').select('id, request_title, tenant_name').in('id', dLeaseIds),
          supabase.from('profiles').select('id, first_name, last_name, email').in('id', dDelegateIds),
          supabase.from('lease_approval_chain').select('id, stage, status').in('id', dStepIds),
        ]);
        const dLeaseMap = new Map((dLeasesRes.data ?? []).map((l: any) => [l.id, l]));
        const dProfMap = new Map((dProfilesRes.data ?? []).map((p: any) => [p.id, p]));
        const dStepMap = new Map((dStepsRes.data ?? []).map((s: any) => [s.id, s]));
        hydratedDelegs = delegRows
          // Only steps still pending — a delegation on an already-acted step is
          // moot (nothing to revoke usefully).
          .filter((d) => (dStepMap.get(d.chain_step_id)?.status ?? 'pending') === 'pending')
          .map((d) => {
            const l: any = dLeaseMap.get(d.lease_id) ?? {};
            const p: any = dProfMap.get(d.delegated_to) ?? {};
            const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || t('approvals.queue.the_delegate');
            return {
              chainStepId: d.chain_step_id,
              leaseId: d.lease_id,
              leaseTitle: l.request_title || l.tenant_name || t('locked_lease.untitled'),
              delegateName: name,
              stage: (dStepMap.get(d.chain_step_id)?.stage ?? 'concept') as 'concept' | 'signator',
              delegatedAt: d.delegated_at,
            };
          });
      }
      setDelegatedByMe(hydratedDelegs);

      // Phase 5 — execution-owner inbox section. Lists leases where the
      // user is the execution_owner_id and lifecycle is
      // pending_counter_signature. Workspace-scoped via the query.
      const { data: ownerLeaseRows } = await (supabase as any)
        .from('leases')
        .select(
          'id, request_title, tenant_name, counter_signature_due_date, counter_signature_reminder_count',
        )
        .eq('workspace_id', workspace.id)
        .eq('lifecycle_status', 'pending_counter_signature')
        .eq('execution_owner_id', user.id);
      setExecutionOwnerLeases((ownerLeaseRows ?? []) as any);
    } catch (err) {
      console.error('Error fetching approval queue:', err);
    } finally {
      setLoading(false);
    }
  }, [workspace?.id, user?.id, isManagerApprover, isFinancialApprover]);

  useEffect(() => { fetchLeases(); }, [fetchLeases]);

  useEffect(() => {
    const handler = () => fetchLeases();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [fetchLeases]);

  const fetchGovernanceData = useCallback(async () => {
    if (!workspace?.id || (!isAdminUser && !isFinancialApprover)) return;
    setGovernanceLoading(true);
    try {
      const tasks: Promise<any>[] = [];
      if (isAdminUser) {
        tasks.push(
          (supabase as any)
            .from('lease_unlock_requests')
            .select('id, lease_id, request_reason, created_at, requested_by')
            .eq('workspace_id', workspace.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
        );
      } else {
        tasks.push(Promise.resolve({ data: [] }));
      }
      if (isAdminUser || isFinancialApprover) {
        tasks.push(
          (supabase as any)
            .from('lease_change_sets')
            .select('id, lease_id, change_summary, submitted_at, submitted_by, lease_change_set_items(field_label, old_value, proposed_value)')
            .eq('workspace_id', workspace.id)
            .eq('status', 'pending_approval')
            .order('submitted_at', { ascending: false })
        );
      } else {
        tasks.push(Promise.resolve({ data: [] }));
      }

      const [unlockResult, csResult] = await Promise.all(tasks);

      // Enrich unlock requests with lease names and requester names
      const unlockRows: UnlockRequest[] = [];
      for (const row of unlockResult.data ?? []) {
        const [leaseRes, profileRes] = await Promise.all([
          supabase.from('leases').select('request_title, filename').eq('id', row.lease_id).single(),
          supabase.from('profiles').select('first_name, last_name, email').eq('id', row.requested_by).single(),
        ]);
        unlockRows.push({
          ...row,
          leaseName: (leaseRes.data as any)?.request_title ?? (leaseRes.data as any)?.filename ?? t('approvals.queue.unnamed_lease'),
          requesterName: (profileRes.data as any)?.first_name
            ? `${(profileRes.data as any).first_name} ${(profileRes.data as any).last_name}`
            : (profileRes.data as any)?.email ?? t('approvals.queue.unknown_user'),
        });
      }

      // Enrich change sets with lease names and submitter names
      const csRows: ChangeSetForReview[] = [];
      for (const row of csResult.data ?? []) {
        const [leaseRes, profileRes] = await Promise.all([
          supabase.from('leases').select('request_title, filename').eq('id', row.lease_id).single(),
          supabase.from('profiles').select('first_name, last_name, email').eq('id', row.submitted_by).single(),
        ]);
        csRows.push({
          id: row.id,
          lease_id: row.lease_id,
          change_summary: row.change_summary,
          submitted_at: row.submitted_at,
          leaseName: (leaseRes.data as any)?.request_title ?? (leaseRes.data as any)?.filename ?? t('approvals.queue.unnamed_lease'),
          submitterName: (profileRes.data as any)?.first_name
            ? `${(profileRes.data as any).first_name} ${(profileRes.data as any).last_name}`
            : (profileRes.data as any)?.email ?? t('approvals.queue.unknown_user'),
          items: row.lease_change_set_items ?? [],
        });
      }

      setUnlockRequests(unlockRows);
      setChangeSets(csRows);
    } catch (err) {
      console.error('Error fetching governance data:', err);
    } finally {
      setGovernanceLoading(false);
    }
  }, [workspace?.id, isAdminUser, isFinancialApprover]);

  useEffect(() => { fetchGovernanceData(); }, [fetchGovernanceData]);

  const handleUnlockAct = async () => {
    if (!unlockActTarget || !user?.id || !unlockActType) return;
    setIsGovernanceActing(true);
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: {
          action: unlockActType === 'approve' ? 'approve_unlock_request' : 'reject_unlock_request',
          unlockRequestId: unlockActTarget.id,
          note: governanceNote || null,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success(unlockActType === 'approve'
        ? t('approvals.queue.unlock_approved')
        : t('approvals.queue.unlock_rejected'));
      setUnlockActTarget(null);
      setUnlockActType(null);
      setGovernanceNote('');
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      fetchGovernanceData();
    } catch (err) {
      console.error('Error acting on unlock request:', err);
      toast.error(t('approvals.common.action_failed'));
    } finally {
      setIsGovernanceActing(false);
    }
  };

  const handleChangeSetAct = async () => {
    if (!changeSetActTarget || !user?.id || !changeSetActType) return;
    setIsGovernanceActing(true);
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: {
          action: changeSetActType === 'approve' ? 'approve_change_set' : 'reject_change_set',
          changeSetId: changeSetActTarget.id,
          note: governanceNote || null,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success(changeSetActType === 'approve'
        ? t('approvals.queue.changes_approved')
        : t('approvals.queue.changes_rejected'));
      setChangeSetActTarget(null);
      setChangeSetActType(null);
      setGovernanceNote('');
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      fetchGovernanceData();
    } catch (err) {
      console.error('Error acting on change set:', err);
      toast.error(t('approvals.common.action_failed'));
    } finally {
      setIsGovernanceActing(false);
    }
  };

  // C3 (#111) — revoke a voluntary delegation I made. Calls
  // revoke-voluntary-delegation (authorizes delegated_by === me; recomputes
  // effective_assignee back to me), which returns the step to my queue.
  const handleRevokeDelegation = async (chainStepId: string) => {
    setRevokingStepId(chainStepId);
    try {
      const { data, error } = await supabase.functions.invoke('revoke-voluntary-delegation', {
        body: { chainStepId },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.ok === false) throw new Error((data as any)?.error || t('approvals.queue.revoke_failed'));
      toast.success(t('approvals.queue.delegation_revoked'));
      fetchLeases();
    } catch (err: any) {
      toast.error(err?.message || t('approvals.queue.revoke_failed_toast'));
    } finally {
      setRevokingStepId(null);
    }
  };

  const handleApprove = async () => {
    if (!approveTarget || !user?.id) return;
    setIsActing(true);
    const lease = approveTarget;
    // Phase 3 follow-up: literal legacy comparison only. Chain leases are
    // approved via the chain edge function (act-on-chain-step), not this
    // handler. If a chain value somehow reaches here, isManager === false
    // and we'd fall through to the financial-approver branch — both wrong
    // for chain. Legacy queue is legacy-only post-revert, so this defends
    // in depth.
    const isManager = lease.lifecycle_status === 'submitted';

    try {
      // P1-11: lifecycle/approval columns are guarded by a DB trigger;
      // the actual transition lives in legacy-lease-action under
      // service-role. Financial-approver needs a classification value;
      // the queue defaults to 'operating' for the legacy flow (the
      // deeper FinancialReview page is where users pick explicitly).
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: isManager
          ? { action: 'manager_approve', leaseId: lease.id }
          : { action: 'financial_approve', leaseId: lease.id, classification: 'operating' },
      });
      if (error) throw new Error(error.message ?? t('approvals.errors.approval_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);

      if (isManager) {
        const { data: finRoles } = await (supabase as any)
          .from('workspace_roles')
          .select('user_id')
          .eq('workspace_id', workspace!.id)
          .eq('role', 'financial_approver');
        if (finRoles?.length) {
          await supabase.from('lease_activity_log').insert({
            lease_id: lease.id,
            user_id: null,
            activity_type: 'comment',
            details: {
              notification_type: 'notify_financial_approver',
              recipient_ids: finRoles.map((r: any) => r.user_id),
              message: `Commitment approved by manager, awaiting your financial review: ${lease.request_title}`,
            },
          } as any);
        }
      }

      toast.success(
        isManager
          ? t('approvals.queue.approved_forwarded')
          : t('approvals.common.commitment_approved'),
      );
      setApproveTarget(null);
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      fetchLeases();
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : t('approvals.errors.failed_to_approve');
      toast.error(msg);
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !user?.id || !rejectReason.trim()) return;
    setIsActing(true);
    const lease = rejectTarget;
    // Phase 3 follow-up: literal legacy comparison only. Chain rejects fire
    // via act-on-chain-step.
    const isManager = lease.lifecycle_status === 'submitted';

    try {
      // P1-11: lifecycle/rejection columns guarded by DB trigger. Edge
      // function performs the transition; browser writes the notification
      // comment after.
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: {
          action: isManager ? 'manager_reject' : 'financial_reject',
          leaseId: lease.id,
          reason: rejectReason.trim(),
        },
      });
      if (error) throw new Error(error.message ?? t('approvals.errors.rejection_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);

      if (lease.requestor_id) {
        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_rejected',
            // P1-4: recipient_ids is required — dispatch-notifications skips any
            // row without it, so previously the requestor was never told their
            // request was rejected. (Gate on requestor_id, not requestorEmail:
            // dispatch resolves the email from the profile itself.)
            recipient_ids: [lease.requestor_id],
            message: `Your request "${lease.request_title}" was rejected. Reason: ${rejectReason.trim()}`,
          },
        } as any);
      }

      toast.success(t('approvals.common.request_rejected'));
      setRejectTarget(null);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      fetchLeases();
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : t('approvals.errors.failed_to_reject');
      toast.error(msg);
    } finally {
      setIsActing(false);
    }
  };

  // Phase 2 — unified merge of legacy lease cards + chain-step cards for
  // the "Needs My Review" tab. Sorted by created_at desc per spec. The
  // existing renderList() below is unchanged and still drives "All
  // Pending" + "Reviewed".
  const renderUnifiedMyReview = () => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      );
    }
    type Item =
      | { kind: 'legacy'; lease: QueueLease; sortKey: string }
      | { kind: 'chain'; step: PendingChainStep; sortKey: string };
    const items: Item[] = [
      ...pendingMyReview.map<Item>((l) => ({
        kind: 'legacy',
        lease: l,
        sortKey: l.uploaded_at,
      })),
      ...pendingChainSteps.map<Item>((s) => ({
        kind: 'chain',
        step: s,
        sortKey: s.created_at,
      })),
    ].sort((a, b) => b.sortKey.localeCompare(a.sortKey));

    const hasExecutionOwnerItems = executionOwnerLeases.length > 0;
    const hasDelegatedByMe = delegatedByMe.length > 0;

    if (items.length === 0 && !hasExecutionOwnerItems && !hasDelegatedByMe) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FileText className="h-12 w-12 mb-3 opacity-40" />
          <p className="font-medium">{t('approvals.queue.nothing_here')}</p>
          <p className="text-sm">{t('approvals.queue.no_items')}</p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {hasExecutionOwnerItems && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              {t('approvals.queue.counter_signature_follow_up', { count: executionOwnerLeases.length })}
            </p>
            <div className="space-y-2">
              {executionOwnerLeases.map((l) => {
                const dueFmt = l.counter_signature_due_date
                  ? format(new Date(l.counter_signature_due_date), 'MMM d, yyyy')
                  : t('approvals.queue.no_due_date');
                return (
                  <Card
                    key={`exec-${l.id}`}
                    className="overflow-hidden cursor-pointer hover:bg-muted/30"
                    onClick={() => navigate(`/app/leases/${l.id}`)}
                  >
                    <CardContent className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {l.request_title || l.tenant_name || t('locked_lease.untitled')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t('approvals.queue.execution_owner_due', { date: dueFmt })}
                          {l.counter_signature_reminder_count != null &&
                          l.counter_signature_reminder_count > 0
                            ? ` · ${t('approvals.queue.reminders_sent', {
                                count: l.counter_signature_reminder_count,
                              })}`
                            : ''}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {items.map((item) =>
          item.kind === 'legacy' ? (
            <LeaseQueueCard
              key={`legacy-${item.lease.id}`}
              lease={item.lease}
              isManagerApprover={isManagerApprover}
              isFinancialApprover={isFinancialApprover}
              viewerMode={false}
              onApprove={setApproveTarget}
              onReject={setRejectTarget}
              onView={(l) => {
                if (isFinancialApprover && l.lifecycle_status === 'under_review') {
                  navigate(`/app/leases/${l.id}/financial-review`);
                } else {
                  navigate(`/app/leases/${l.id}`);
                }
              }}
            />
          ) : (
            <ChainStepCard
              key={`chain-${item.step.id}`}
              step={item.step}
              onView={(leaseId) => navigate(`/app/leases/${leaseId}`)}
              onActed={() => fetchLeases()}
            />
          ),
        )}

        {hasDelegatedByMe && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              {t('approvals.queue.delegated_by_me', { count: delegatedByMe.length })}
            </p>
            <div className="space-y-2">
              {delegatedByMe.map((d) => (
                <Card key={`deleg-${d.chainStepId}`} className="overflow-hidden">
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={() => navigate(`/app/leases/${d.leaseId}`)}
                    >
                      <p className="text-sm font-semibold truncate hover:underline">
                        {d.leaseTitle}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('approvals.queue.delegated_to', { name: d.delegateName })} ·{' '}
                        {d.stage === 'signator'
                          ? t('approvals.queue.final_approval')
                          : t('approvals.queue.initial_approval')} ·{' '}
                        {format(new Date(d.delegatedAt), 'MMM d, yyyy')}
                      </p>
                    </button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={revokingStepId === d.chainStepId}
                      onClick={() => handleRevokeDelegation(d.chainStepId)}
                    >
                      {revokingStepId === d.chainStepId ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Undo2 className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {t('approvals.queue.revoke')}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Layout note: the renderUnifiedMyReview return wraps both the
  // Phase 5 execution-owner section + the legacy/chain unified items.

  const renderList = (leases: QueueLease[], viewerMode = false) => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      );
    }
    if (!leases.length) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FileText className="h-12 w-12 mb-3 opacity-40" />
          <p className="font-medium">{t('approvals.queue.nothing_here')}</p>
          <p className="text-sm">{t('approvals.queue.no_items')}</p>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {leases.map((lease) => (
          <LeaseQueueCard
            key={lease.id}
            lease={lease}
            isManagerApprover={isManagerApprover}
            isFinancialApprover={isFinancialApprover}
            viewerMode={viewerMode}
            onApprove={setApproveTarget}
            onReject={setRejectTarget}
            onView={(l) => {
              // Phase 3 follow-up: literal legacy comparison. Chain leases
              // never reach this card (legacy queue is legacy-only); the
              // financial-review page is legacy-only too.
              if (isFinancialApprover && l.lifecycle_status === 'under_review') {
                navigate(`/app/leases/${l.id}/financial-review`);
              } else {
                navigate(`/app/leases/${l.id}`);
              }
            }}
          />
        ))}
      </div>
    );
  };

  // Phase 2: pending count merges legacy lease rows with chain steps so
  // the badge reflects the unified inbox. Phase 5 adds counter-signature
  // execution-owner items to the same badge.
  const pendingCount =
    pendingMyReview.length + pendingChainSteps.length + executionOwnerLeases.length;
  const governanceCount = unlockRequests.length + changeSets.length;
  const showGovernanceTab = isAdminUser || isFinancialApprover;

  return (
    <AppLayout>
      <AppHeader
        title={t('approvals.queue.title')}
        subtitle={t('approvals.queue.subtitle')}
      />

      <PageLayout width="narrow">
        <Tabs defaultValue="mine">
          <TabsList className={`w-full sm:w-auto mb-6 grid sm:inline-flex ${showGovernanceTab ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <TabsTrigger value="mine" className="gap-1.5">
              {t('approvals.queue.tab_mine')}
              {pendingCount > 0 && (
                <Badge variant="destructive" className="text-[10px] h-4 min-w-[1.25rem] px-1">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="all">{t('approvals.queue.tab_all')}</TabsTrigger>
            <TabsTrigger value="reviewed">{t('approvals.queue.tab_reviewed')}</TabsTrigger>
            {showGovernanceTab && (
              <TabsTrigger value="governance" className="gap-1.5">
                {t('approvals.queue.tab_governance')}
                {governanceCount > 0 && (
                  <Badge variant="destructive" className="text-[10px] h-4 min-w-[1.25rem] px-1">
                    {governanceCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="mine">{renderUnifiedMyReview()}</TabsContent>
          <TabsContent value="all">{renderList(allPending, true)}</TabsContent>
          <TabsContent value="reviewed">{renderList(reviewed, true)}</TabsContent>

          {showGovernanceTab && (
            <TabsContent value="governance" className="space-y-6">
              {governanceLoading ? (
                <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}</div>
              ) : (
                <>
                  {isAdminUser && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                        {t('approvals.queue.unlock_requests', { count: unlockRequests.length })}
                      </p>
                      {unlockRequests.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">{t('approvals.queue.no_unlock_requests')}</p>
                      ) : (
                        <div className="space-y-3">
                          {unlockRequests.map((req) => (
                            <Card key={req.id} className="overflow-hidden">
                              <CardContent className="p-4 space-y-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <button
                                      onClick={() => navigate(`/app/leases/${req.lease_id}`)}
                                      className="text-sm font-semibold hover:underline text-left"
                                    >
                                      {req.leaseName}
                                    </button>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {t('approvals.queue.requested_by', { name: req.requesterName })} · {format(new Date(req.created_at), 'MMM d, yyyy')}
                                    </p>
                                  </div>
                                </div>
                                {req.request_reason && (
                                  <p className="text-xs bg-muted/40 rounded px-2 py-1.5">
                                    <span className="font-medium">{t('approvals.queue.reason_label')} </span>{req.request_reason}
                                  </p>
                                )}
                                <div className="flex gap-2 pt-1">
                                  <Button size="sm" variant="outline"
                                    className="border-green-500 text-green-700 hover:bg-green-50"
                                    onClick={() => { setUnlockActTarget(req); setUnlockActType('approve'); setGovernanceNote(''); }}
                                  >
                                    <CheckCircle className="h-3.5 w-3.5 mr-1.5" />{t('approvals.queue.approve_unlock')}
                                  </Button>
                                  <Button size="sm" variant="ghost"
                                    className="text-muted-foreground"
                                    onClick={() => { setUnlockActTarget(req); setUnlockActType('reject'); setGovernanceNote(''); }}
                                  >
                                    <XCircle className="h-3.5 w-3.5 mr-1.5" />{t('approvals.queue.deny')}
                                  </Button>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {(isAdminUser || isFinancialApprover) && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                        {t('approvals.queue.change_set_approvals', { count: changeSets.length })}
                      </p>
                      {changeSets.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">{t('approvals.queue.no_change_approvals')}</p>
                      ) : (
                        <div className="space-y-3">
                          {changeSets.map((cs) => (
                            <Card key={cs.id} className="overflow-hidden">
                              <CardContent className="p-4 space-y-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <button
                                      onClick={() => navigate(`/app/leases/${cs.lease_id}`)}
                                      className="text-sm font-semibold hover:underline text-left"
                                    >
                                      {cs.leaseName}
                                    </button>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {t('approvals.queue.submitted_by_name', { name: cs.submitterName })}
                                      {cs.submitted_at && <> · {format(new Date(cs.submitted_at), 'MMM d, yyyy')}</>}
                                    </p>
                                  </div>
                                  <Button
                                    size="sm" variant="ghost"
                                    className="text-xs gap-1 shrink-0"
                                    onClick={() => setExpandedChangeSet(expandedChangeSet === cs.id ? null : cs.id)}
                                  >
                                    {expandedChangeSet === cs.id
                                      ? t('approvals.queue.hide_changes')
                                      : t('approvals.queue.view_changes')}
                                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expandedChangeSet === cs.id ? 'rotate-90' : ''}`} />
                                  </Button>
                                </div>
                                {cs.change_summary && (
                                  <p className="text-xs bg-muted/40 rounded px-2 py-1.5">
                                    <span className="font-medium">{t('approvals.queue.summary_label')} </span>{cs.change_summary}
                                  </p>
                                )}
                                {expandedChangeSet === cs.id && cs.items.length > 0 && (
                                  <div className="overflow-x-auto border rounded">
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b bg-muted/40">
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">{t('approvals.queue.field')}</th>
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">{t('approvals.queue.current')}</th>
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">{t('approvals.queue.proposed')}</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {cs.items.map((item, i) => (
                                          <tr key={i} className="border-b last:border-0">
                                            <td className="py-1.5 px-3 font-medium text-muted-foreground">{item.field_label}</td>
                                            <td className="py-1.5 px-3 text-muted-foreground">{item.old_value ?? '—'}</td>
                                            <td className="py-1.5 px-3 font-medium text-green-700">{item.proposed_value ?? '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                                <div className="flex gap-2 pt-1">
                                  <Button size="sm" variant="outline"
                                    className="border-green-500 text-green-700 hover:bg-green-50"
                                    onClick={() => { setChangeSetActTarget(cs); setChangeSetActType('approve'); setGovernanceNote(''); }}
                                  >
                                    <CheckCircle className="h-3.5 w-3.5 mr-1.5" />{t('approvals.queue.approve_changes')}
                                  </Button>
                                  <Button size="sm" variant="ghost"
                                    className="text-muted-foreground"
                                    onClick={() => { setChangeSetActTarget(cs); setChangeSetActType('reject'); setGovernanceNote(''); }}
                                  >
                                    <XCircle className="h-3.5 w-3.5 mr-1.5" />{t('approval.reject')}
                                  </Button>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          )}
        </Tabs>
      </PageLayout>

      {/* Governance: Unlock Request Action Dialog */}
      <Dialog
        open={!!unlockActTarget}
        onOpenChange={(o) => { if (!o) { setUnlockActTarget(null); setUnlockActType(null); setGovernanceNote(''); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {unlockActType === 'approve'
                ? t('approvals.queue.approve_unlock_q')
                : t('approvals.queue.deny_unlock_q')}
            </DialogTitle>
            <DialogDescription>
              {unlockActType === 'approve'
                ? t('approvals.queue.approve_unlock_desc', { name: unlockActTarget?.leaseName })
                : t('approvals.queue.deny_unlock_desc', { name: unlockActTarget?.leaseName })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="gov-note" className="text-sm font-medium">{t('approvals.queue.note')} {unlockActType === 'reject' && <span className="text-muted-foreground">{t('approvals.queue.optional_suffix')}</span>}</Label>
            <Textarea id="gov-note" className="mt-2" rows={2} placeholder={t('approvals.queue.note_placeholder')}
              value={governanceNote} onChange={(e) => setGovernanceNote(e.target.value)} />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setUnlockActTarget(null); setUnlockActType(null); setGovernanceNote(''); }} disabled={isGovernanceActing}>{t('common.cancel')}</Button>
            <Button
              variant={unlockActType === 'approve' ? 'default' : 'destructive'}
              onClick={handleUnlockAct}
              disabled={isGovernanceActing}
            >
              {isGovernanceActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {unlockActType === 'approve'
                ? t('approvals.queue.approve_unlock')
                : t('approvals.queue.deny_request')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Governance: Change Set Action Dialog */}
      <Dialog
        open={!!changeSetActTarget}
        onOpenChange={(o) => { if (!o) { setChangeSetActTarget(null); setChangeSetActType(null); setGovernanceNote(''); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {changeSetActType === 'approve'
                ? t('approvals.queue.approve_changes_q')
                : t('approvals.queue.reject_changes_q')}
            </DialogTitle>
            <DialogDescription>
              {changeSetActType === 'approve'
                ? t('approvals.queue.approve_changes_desc', {
                    count: changeSetActTarget?.items.length ?? 0,
                    name: changeSetActTarget?.leaseName,
                  })
                : t('approvals.queue.reject_changes_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="cs-note" className="text-sm font-medium">
              {t('approvals.queue.note')} {changeSetActType === 'approve' ? <span className="text-muted-foreground">{t('approvals.queue.optional_suffix')}</span> : <span className="text-destructive">*</span>}
            </Label>
            <Textarea id="cs-note" className="mt-2" rows={3} placeholder={t('approvals.queue.reason_feedback_placeholder')}
              value={governanceNote} onChange={(e) => setGovernanceNote(e.target.value)} />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setChangeSetActTarget(null); setChangeSetActType(null); setGovernanceNote(''); }} disabled={isGovernanceActing}>{t('common.cancel')}</Button>
            <Button
              variant={changeSetActType === 'approve' ? 'default' : 'destructive'}
              onClick={handleChangeSetAct}
              disabled={isGovernanceActing || (changeSetActType === 'reject' && !governanceNote.trim())}
            >
              {isGovernanceActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {changeSetActType === 'approve'
                ? t('approvals.queue.approve_apply')
                : t('approvals.queue.reject_changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manager Approve Confirmation Dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('approvals.queue.approve_commitment_q')}</DialogTitle>
            <DialogDescription>
              {t('approvals.queue.approve_commitment_desc', { title: approveTarget?.request_title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setApproveTarget(null)}
              disabled={isActing}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleApprove} disabled={isActing}>
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('approvals.queue.approve_for_financial')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(o) => { if (!o) { setRejectTarget(null); setRejectReason(''); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('approvals.queue.reject_request_q')}</DialogTitle>
            <DialogDescription>
              {t('approvals.queue.reject_request_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="reject-reason" className="text-sm font-medium">
              {t('approvals.queue.reason_for_rejection')} <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reject-reason"
              className="mt-2"
              rows={4}
              placeholder={t('approvals.queue.reject_reason_placeholder')}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => { setRejectTarget(null); setRejectReason(''); }}
              disabled={isActing}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={isActing || !rejectReason.trim()}
            >
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('approvals.queue.reject_request')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
