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

export default function ApprovalQueue() {
  const navigate = useNavigate();
  const { user, workspace, userFunctionalRoles } = useApp();

  const isManagerApprover = userFunctionalRoles.includes('manager_approver');
  const isFinancialApprover = userFunctionalRoles.includes('financial_approver');

  const [pendingMyReview, setPendingMyReview] = useState<QueueLease[]>([]);
  const [allPending, setAllPending] = useState<QueueLease[]>([]);
  const [reviewed, setReviewed] = useState<QueueLease[]>([]);
  const [loading, setLoading] = useState(true);

  const [approveTarget, setApproveTarget] = useState<QueueLease | null>(null);
  const [rejectTarget, setRejectTarget] = useState<QueueLease | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [isActing, setIsActing] = useState(false);

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

  return (
    <AppLayout>
      <AppHeader
        title="Approvals"
        subtitle="Review and act on commitment requests requiring your approval"
      />

      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <Tabs defaultValue="mine">
          <TabsList className="w-full sm:w-auto mb-6 grid grid-cols-3 sm:inline-flex">
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
          </TabsList>

          <TabsContent value="mine">{renderList(pendingMyReview)}</TabsContent>
          <TabsContent value="all">{renderList(allPending, true)}</TabsContent>
          <TabsContent value="reviewed">{renderList(reviewed, true)}</TabsContent>
        </Tabs>
      </div>

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
