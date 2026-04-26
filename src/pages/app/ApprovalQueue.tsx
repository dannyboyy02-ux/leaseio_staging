import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
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
import { cn } from '@/lib/utils';

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
  const statusLabel =
    lease.lifecycle_status === 'submitted' ? 'Awaiting Manager Review'
    : lease.lifecycle_status === 'under_review' ? 'Awaiting Financial Review'
    : lease.lifecycle_status === 'approved' ? 'Approved'
    : lease.lifecycle_status === 'rejected' ? 'Rejected'
    : lease.lifecycle_status;

  const canManagerAct =
    isManagerApprover &&
    lease.lifecycle_status === 'submitted' &&
    !lease.financial_returned_to_submitter;
  const canFinancialAct = isFinancialApprover && lease.lifecycle_status === 'under_review';
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
                {lease.request_title || 'Untitled Request'}
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
                  Covenant
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px]">{statusLabel}</Badge>
            </div>
          </div>

          {/* Financial summary */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">Monthly</p>
              <p className="font-semibold">{fmt(lease.monthly_payment)}</p>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">Term</p>
              <p className="font-semibold">
                {lease.term_months != null ? `${lease.term_months} mo` : '\u2014'}
              </p>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <p className="text-muted-foreground">Total Commitment</p>
              <p className="font-semibold">{fmt(lease.calc_total_commitment)}</p>
            </div>
          </div>

          {/* Submitter + date */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {lease.requestorName || lease.requestorEmail || 'Unknown submitter'}
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
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                    onClick={() => onReject(lease)}
                  >
                    <XCircle className="h-4 w-4 mr-1.5" />
                    Reject
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onView(lease)} className="gap-1">
                    View Lease <ChevronRight className="h-4 w-4" />
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
                    Open Financial Review <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                    onClick={() => onReject(lease)}
                  >
                    <XCircle className="h-4 w-4 mr-1.5" />
                    Reject
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onView(lease)} className="gap-1">
                  View Lease <ChevronRight className="h-4 w-4" />
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
              View Lease <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
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
  const { user, workspace, userFunctionalRoles, userRole } = useApp();

  const isManagerApprover = userFunctionalRoles.includes('manager_approver');
  const isFinancialApprover = userFunctionalRoles.includes('financial_approver');
  const isAdminUser = userRole === 'admin' || userRole === 'owner';

  const [pendingMyReview, setPendingMyReview] = useState<QueueLease[]>([]);
  const [allPending, setAllPending] = useState<QueueLease[]>([]);
  const [reviewed, setReviewed] = useState<QueueLease[]>([]);
  const [loading, setLoading] = useState(true);

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
        supabase
          .from('leases')
          .select(
            'id, request_title, tenant_name, requesting_department, asset_type,' +
            'monthly_payment, term_months, calc_total_commitment, covenant_flagged,' +
            'lifecycle_status, financial_returned_to_submitter, manager_approved_by,' +
            'manager_approved_at, financial_approved_by, uploaded_at, requestor_id',
          )
          .eq('workspace_id', workspace.id);

      // Needs My Review
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
          leaseName: (leaseRes.data as any)?.request_title ?? (leaseRes.data as any)?.filename ?? 'Unnamed lease',
          requesterName: (profileRes.data as any)?.first_name
            ? `${(profileRes.data as any).first_name} ${(profileRes.data as any).last_name}`
            : (profileRes.data as any)?.email ?? 'Unknown user',
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
          leaseName: (leaseRes.data as any)?.request_title ?? (leaseRes.data as any)?.filename ?? 'Unnamed lease',
          submitterName: (profileRes.data as any)?.first_name
            ? `${(profileRes.data as any).first_name} ${(profileRes.data as any).last_name}`
            : (profileRes.data as any)?.email ?? 'Unknown user',
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
      const now = new Date().toISOString();
      if (unlockActType === 'approve') {
        // Approve the request: unlock lease, create draft change set
        await (supabase as any)
          .from('lease_unlock_requests')
          .update({ status: 'approved', reviewed_by: user.id, reviewed_at: now, review_note: governanceNote || null })
          .eq('id', unlockActTarget.id);

        await supabase.from('leases').update({ model_locked: false } as any).eq('id', unlockActTarget.lease_id);

        await (supabase as any)
          .from('lease_change_sets')
          .insert({
            lease_id: unlockActTarget.lease_id,
            workspace_id: workspace!.id,
            unlock_request_id: unlockActTarget.id,
            submitted_by: unlockActTarget.requested_by,
            status: 'draft',
          });

        await supabase.from('lease_activity_log').insert({
          lease_id: unlockActTarget.lease_id,
          user_id: user.id,
          activity_type: 'unlock_approved',
          details: { unlock_request_id: unlockActTarget.id, note: governanceNote || null },
        });
        toast.success('Unlock approved — lease is now unlocked for staged editing');
      } else {
        await (supabase as any)
          .from('lease_unlock_requests')
          .update({ status: 'rejected', reviewed_by: user.id, reviewed_at: now, review_note: governanceNote || null })
          .eq('id', unlockActTarget.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: unlockActTarget.lease_id,
          user_id: user.id,
          activity_type: 'unlock_rejected',
          details: { unlock_request_id: unlockActTarget.id, note: governanceNote || null },
        });
        toast.success('Unlock request rejected');
      }
      setUnlockActTarget(null);
      setUnlockActType(null);
      setGovernanceNote('');
      fetchGovernanceData();
    } catch (err) {
      console.error('Error acting on unlock request:', err);
      toast.error('Action failed');
    } finally {
      setIsGovernanceActing(false);
    }
  };

  const handleChangeSetAct = async () => {
    if (!changeSetActTarget || !user?.id || !changeSetActType) return;
    setIsGovernanceActing(true);
    try {
      const now = new Date().toISOString();
      if (changeSetActType === 'approve') {
        // Write each proposed value to the lease columns using field_name (not field_label)
        // Items are fetched with field_label for display; we need the full items with field_name
        const { data: fullItems } = await (supabase as any)
          .from('lease_change_set_items')
          .select('field_name, proposed_value')
          .eq('change_set_id', changeSetActTarget.id);

        const fieldToColumn: Record<string, string> = {
          tenant_name: 'executed_tenant_name',
          landlord_name: 'executed_landlord_name',
          commencement_date: 'executed_commencement_date',
          expiry_date: 'executed_expiry_date',
          monthly_payment: 'executed_monthly_payment',
          rent_review_clause: 'executed_rent_review_clause',
          break_clause: 'executed_break_clause',
        };
        const leaseUpdate: Record<string, any> = {};
        for (const item of (fullItems ?? [])) {
          const col = fieldToColumn[item.field_name];
          if (col) leaseUpdate[col] = item.proposed_value;
        }
        if (Object.keys(leaseUpdate).length > 0) {
          await supabase.from('leases').update(leaseUpdate as any).eq('id', changeSetActTarget.lease_id);
        }
        // Re-lock the lease
        await supabase.from('leases').update({ model_locked: true } as any).eq('id', changeSetActTarget.lease_id);

        await (supabase as any)
          .from('lease_change_sets')
          .update({ status: 'approved', reviewed_by: user.id, reviewed_at: now, review_note: governanceNote || null })
          .eq('id', changeSetActTarget.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: changeSetActTarget.lease_id,
          user_id: user.id,
          activity_type: 'change_approved',
          details: { change_set_id: changeSetActTarget.id, note: governanceNote || null },
        });
        toast.success('Changes approved and applied to lease');
      } else {
        await (supabase as any)
          .from('lease_change_sets')
          .update({ status: 'rejected', reviewed_by: user.id, reviewed_at: now, review_note: governanceNote || null })
          .eq('id', changeSetActTarget.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: changeSetActTarget.lease_id,
          user_id: user.id,
          activity_type: 'change_rejected',
          details: { change_set_id: changeSetActTarget.id, note: governanceNote || null },
        });
        toast.success('Changes rejected — submitter can revise or cancel');
      }
      setChangeSetActTarget(null);
      setChangeSetActType(null);
      setGovernanceNote('');
      fetchGovernanceData();
    } catch (err) {
      console.error('Error acting on change set:', err);
      toast.error('Action failed');
    } finally {
      setIsGovernanceActing(false);
    }
  };

  const handleApprove = async () => {
    if (!approveTarget || !user?.id) return;
    setIsActing(true);
    const now = new Date().toISOString();
    const lease = approveTarget;
    const isManager = lease.lifecycle_status === 'submitted';

    try {
      if (isManager) {
        await supabase
          .from('leases')
          .update({
            lifecycle_status: 'under_review',
            manager_approved_by: user.id,
            manager_approved_at: now,
            status_changed_at: now,
          } as any)
          .eq('id', lease.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: user.id,
          activity_type: 'approval',
          from_status: 'submitted',
          to_status: 'under_review',
          details: { role: 'manager_approver', action: 'manager_approved' },
        } as any);

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
      } else {
        // Financial approver: transition to approved
        await supabase
          .from('leases')
          .update({
            lifecycle_status: 'approved',
            financial_approved_by: user.id,
            financial_approved_at: now,
            status_changed_at: now,
          } as any)
          .eq('id', lease.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: user.id,
          activity_type: 'approval',
          from_status: 'under_review',
          to_status: 'approved',
          details: { role: 'financial_approver', action: 'financial_approved' },
        } as any);
      }

      toast.success(isManager ? 'Approved \u2014 forwarded to financial review' : 'Commitment approved');
      setApproveTarget(null);
      fetchLeases();
    } catch (err) {
      console.error(err);
      toast.error('Failed to approve');
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !user?.id || !rejectReason.trim()) return;
    setIsActing(true);
    const now = new Date().toISOString();
    const lease = rejectTarget;
    const isManager = lease.lifecycle_status === 'submitted';

    try {
      if (isManager) {
        await supabase
          .from('leases')
          .update({
            lifecycle_status: 'rejected',
            manager_rejection_reason: rejectReason.trim(),
            status_changed_at: now,
          } as any)
          .eq('id', lease.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: user.id,
          activity_type: 'rejection',
          from_status: 'submitted',
          to_status: 'rejected',
          details: { role: 'manager_approver', action: 'manager_rejected', reason: rejectReason.trim() },
        } as any);
      } else {
        await supabase
          .from('leases')
          .update({
            lifecycle_status: 'rejected',
            financial_rejection_reason: rejectReason.trim(),
            status_changed_at: now,
          } as any)
          .eq('id', lease.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: user.id,
          activity_type: 'rejection',
          from_status: 'under_review',
          to_status: 'rejected',
          details: { role: 'financial_approver', action: 'financial_rejected', reason: rejectReason.trim() },
        } as any);
      }

      if (lease.requestorEmail) {
        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_rejected',
            message: `Your request "${lease.request_title}" was rejected. Reason: ${rejectReason.trim()}`,
          },
        } as any);
      }

      toast.success('Request rejected');
      setRejectTarget(null);
      setRejectReason('');
      fetchLeases();
    } catch (err) {
      console.error(err);
      toast.error('Failed to reject');
    } finally {
      setIsActing(false);
    }
  };

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
          <p className="font-medium">Nothing here</p>
          <p className="text-sm">No items to show in this tab</p>
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

  const pendingCount = pendingMyReview.length;
  const governanceCount = unlockRequests.length + changeSets.length;
  const showGovernanceTab = isAdminUser || isFinancialApprover;

  return (
    <AppLayout>
      <AppHeader
        title="Approvals"
        subtitle="Review and act on commitment requests requiring your approval"
      />

      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <Tabs defaultValue="mine">
          <TabsList className={`w-full sm:w-auto mb-6 grid sm:inline-flex ${showGovernanceTab ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <TabsTrigger value="mine" className="gap-1.5">
              Needs My Review
              {pendingCount > 0 && (
                <Badge variant="destructive" className="text-[10px] h-4 min-w-[1.25rem] px-1">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="all">All Pending</TabsTrigger>
            <TabsTrigger value="reviewed">Reviewed</TabsTrigger>
            {showGovernanceTab && (
              <TabsTrigger value="governance" className="gap-1.5">
                Governance
                {governanceCount > 0 && (
                  <Badge variant="destructive" className="text-[10px] h-4 min-w-[1.25rem] px-1">
                    {governanceCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="mine">{renderList(pendingMyReview)}</TabsContent>
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
                        Unlock Requests ({unlockRequests.length})
                      </p>
                      {unlockRequests.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No pending unlock requests</p>
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
                                      Requested by {req.requesterName} · {format(new Date(req.created_at), 'MMM d, yyyy')}
                                    </p>
                                  </div>
                                </div>
                                {req.request_reason && (
                                  <p className="text-xs bg-muted/40 rounded px-2 py-1.5">
                                    <span className="font-medium">Reason: </span>{req.request_reason}
                                  </p>
                                )}
                                <div className="flex gap-2 pt-1">
                                  <Button size="sm" variant="outline"
                                    className="border-green-500 text-green-700 hover:bg-green-50"
                                    onClick={() => { setUnlockActTarget(req); setUnlockActType('approve'); setGovernanceNote(''); }}
                                  >
                                    <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Approve & Unlock
                                  </Button>
                                  <Button size="sm" variant="ghost"
                                    className="text-muted-foreground"
                                    onClick={() => { setUnlockActTarget(req); setUnlockActType('reject'); setGovernanceNote(''); }}
                                  >
                                    <XCircle className="h-3.5 w-3.5 mr-1.5" />Deny
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
                        Change Set Approvals ({changeSets.length})
                      </p>
                      {changeSets.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No pending change approvals</p>
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
                                      Submitted by {cs.submitterName}
                                      {cs.submitted_at && <> · {format(new Date(cs.submitted_at), 'MMM d, yyyy')}</>}
                                    </p>
                                  </div>
                                  <Button
                                    size="sm" variant="ghost"
                                    className="text-xs gap-1 shrink-0"
                                    onClick={() => setExpandedChangeSet(expandedChangeSet === cs.id ? null : cs.id)}
                                  >
                                    {expandedChangeSet === cs.id ? 'Hide' : 'View'} changes
                                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expandedChangeSet === cs.id ? 'rotate-90' : ''}`} />
                                  </Button>
                                </div>
                                {cs.change_summary && (
                                  <p className="text-xs bg-muted/40 rounded px-2 py-1.5">
                                    <span className="font-medium">Summary: </span>{cs.change_summary}
                                  </p>
                                )}
                                {expandedChangeSet === cs.id && cs.items.length > 0 && (
                                  <div className="overflow-x-auto border rounded">
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b bg-muted/40">
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">Field</th>
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">Current</th>
                                          <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">Proposed</th>
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
                                    <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Approve Changes
                                  </Button>
                                  <Button size="sm" variant="ghost"
                                    className="text-muted-foreground"
                                    onClick={() => { setChangeSetActTarget(cs); setChangeSetActType('reject'); setGovernanceNote(''); }}
                                  >
                                    <XCircle className="h-3.5 w-3.5 mr-1.5" />Reject
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
      </div>

      {/* Governance: Unlock Request Action Dialog */}
      <Dialog
        open={!!unlockActTarget}
        onOpenChange={(o) => { if (!o) { setUnlockActTarget(null); setUnlockActType(null); setGovernanceNote(''); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {unlockActType === 'approve' ? 'Approve unlock request?' : 'Deny unlock request?'}
            </DialogTitle>
            <DialogDescription>
              {unlockActType === 'approve'
                ? `Approving will unlock "${unlockActTarget?.leaseName}" for staged editing. Changes will require financial approval before taking effect.`
                : `Denying will keep "${unlockActTarget?.leaseName}" locked. The submitter will see the denied status.`}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="gov-note" className="text-sm font-medium">Note {unlockActType === 'reject' && <span className="text-muted-foreground">(optional)</span>}</Label>
            <Textarea id="gov-note" className="mt-2" rows={2} placeholder="Optional note to the requester..."
              value={governanceNote} onChange={(e) => setGovernanceNote(e.target.value)} />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setUnlockActTarget(null); setUnlockActType(null); setGovernanceNote(''); }} disabled={isGovernanceActing}>Cancel</Button>
            <Button
              variant={unlockActType === 'approve' ? 'default' : 'destructive'}
              onClick={handleUnlockAct}
              disabled={isGovernanceActing}
            >
              {isGovernanceActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {unlockActType === 'approve' ? 'Approve & Unlock' : 'Deny Request'}
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
              {changeSetActType === 'approve' ? 'Approve proposed changes?' : 'Reject proposed changes?'}
            </DialogTitle>
            <DialogDescription>
              {changeSetActType === 'approve'
                ? `Approving will apply ${changeSetActTarget?.items.length ?? 0} field change(s) to "${changeSetActTarget?.leaseName}" and re-lock it.`
                : `Rejecting returns the change set to the submitter for revision. The lease stays unlocked.`}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="cs-note" className="text-sm font-medium">
              Note {changeSetActType === 'approve' ? <span className="text-muted-foreground">(optional)</span> : <span className="text-destructive">*</span>}
            </Label>
            <Textarea id="cs-note" className="mt-2" rows={3} placeholder="Reason or feedback..."
              value={governanceNote} onChange={(e) => setGovernanceNote(e.target.value)} />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setChangeSetActTarget(null); setChangeSetActType(null); setGovernanceNote(''); }} disabled={isGovernanceActing}>Cancel</Button>
            <Button
              variant={changeSetActType === 'approve' ? 'default' : 'destructive'}
              onClick={handleChangeSetAct}
              disabled={isGovernanceActing || (changeSetActType === 'reject' && !governanceNote.trim())}
            >
              {isGovernanceActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {changeSetActType === 'approve' ? 'Approve & Apply' : 'Reject Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manager Approve Confirmation Dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve this commitment?</DialogTitle>
            <DialogDescription>
              Approving will forward "{approveTarget?.request_title}" to the Financial Approver
              for review. This action is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setApproveTarget(null)}
              disabled={isActing}
            >
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={isActing}>
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Approve for Financial Review
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
            <DialogTitle>Reject this request?</DialogTitle>
            <DialogDescription>
              The submitter will be notified with your reason. This action is recorded in the
              audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="reject-reason" className="text-sm font-medium">
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reject-reason"
              className="mt-2"
              rows={4}
              placeholder="Explain why this request is being rejected\u2026"
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
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={isActing || !rejectReason.trim()}
            >
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reject Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
