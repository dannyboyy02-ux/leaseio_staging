import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronLeft,
  Loader2,
  DollarSign,
  RotateCcw,
  FileText,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { LeaseDiscountRateCard } from '@/components/leases/LeaseDiscountRateCard';

interface LeaseDetail {
  id: string;
  request_title: string | null;
  requesting_department: string | null;
  asset_type: string | null;
  vendor_name: string | null;
  monthly_payment: number | null;
  term_months: number | null;
  escalation_rate: number | null;
  lease_start: string | null;
  lease_end: string | null;
  calc_total_commitment: number | null;
  calc_pv_liability: number | null;
  calc_straight_line_exp: number | null;
  calc_cash_pl_delta: number | null;
  lease_classification: string | null;
  covenant_flagged: boolean | null;
  lifecycle_status: string;
  financial_returned_to_submitter: boolean | null;
  manager_approved_by: string | null;
  manager_approved_at: string | null;
  financial_approved_by: string | null;
  storage_path: string | null;
  filename: string | null;
  requestor_id: string | null;
  uploaded_at: string | null;
  created_at: string;
  requestorName?: string;
  requestorEmail?: string;
  managerName?: string;
}

type Classification = 'operating' | 'finance' | 'pending';

const ASC842_CRITERIA = [
  { id: 'ownership', label: 'Does the lease transfer ownership of the asset by the end of the term?' },
  { id: 'purchase_option', label: 'Does the lessee have a purchase option they are reasonably certain to exercise?' },
  {
    id: 'major_part',
    label: 'Is the lease term for the major part of the asset\'s remaining economic life? (≥75% is a common threshold)',
  },
  {
    id: 'pv_substantially_all',
    label: 'Is the present value of payments ≥ substantially all of the fair value of the asset? (≥90% is a common threshold)',
  },
  { id: 'specialized', label: 'Is the asset so specialized it has no alternative use to the lessor at the end of the term?' },
];

const fmt = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
const fmtDec = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

export default function FinancialReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { user, workspace, userFunctionalRoles, userRole } = useApp();
  const canEditDiscountRate =
    userFunctionalRoles.includes('financial_approver') ||
    userRole === 'admin' ||
    userRole === 'owner' ||
    userRole === 'editor';

  const isFinancialApprover = userFunctionalRoles.includes('financial_approver');

  const [lease, setLease] = useState<LeaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [wsSettings, setWsSettings] = useState<{
    discountRate: number;
    covenantThreshold: number | null;
  }>({ discountRate: 5.5, covenantThreshold: null });
  const [currentExposure, setCurrentExposure] = useState<number>(0);

  // Classification panel
  const [criteriaChecked, setCriteriaChecked] = useState<Record<string, boolean>>({});
  const [classification, setClassification] = useState<Classification>('pending');

  // Dialogs
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [returnToSubmitter, setReturnToSubmitter] = useState(true);
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    if (!leaseId || !workspace?.id) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const [leaseResult, wsResult] = await Promise.all([
          supabase
            .from('leases')
            .select(
              'id, request_title, requesting_department, asset_type, vendor_name, monthly_payment, term_months, escalation_rate, lease_start, lease_end, calc_total_commitment, calc_pv_liability, calc_straight_line_exp, calc_cash_pl_delta, lease_classification, covenant_flagged, lifecycle_status, financial_returned_to_submitter, manager_approved_by, manager_approved_at, financial_approved_by, storage_path, filename, requestor_id, uploaded_at, created_at',
            )
            .eq('id', leaseId)
            .single(),
          (supabase as any)
            .from('workspaces')
            .select('discount_rate, covenant_threshold')
            .eq('id', workspace.id)
            .single(),
        ]);

        if (leaseResult.error || !leaseResult.data) {
          toast.error('Could not load lease');
          navigate('/app/approvals');
          return;
        }

        const leaseData = leaseResult.data as LeaseDetail;

        // Fetch user profiles
        const userIds = [leaseData.requestor_id, leaseData.manager_approved_by].filter(Boolean) as string[];
        let profileMap: Record<string, { email: string; name: string }> = {};
        if (userIds.length) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, email, first_name, last_name')
            .in('id', userIds);
          for (const p of profiles || []) {
            profileMap[p.id] = {
              email: p.email || '',
              name: p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.email || '',
            };
          }
        }

        setLease({
          ...leaseData,
          requestorName: leaseData.requestor_id ? profileMap[leaseData.requestor_id]?.name : undefined,
          requestorEmail: leaseData.requestor_id ? profileMap[leaseData.requestor_id]?.email : undefined,
          managerName: leaseData.manager_approved_by ? profileMap[leaseData.manager_approved_by]?.name : undefined,
        });

        if (wsResult.data) {
          setWsSettings({
            discountRate: (wsResult.data as any).discount_rate ?? 5.5,
            covenantThreshold: (wsResult.data as any).covenant_threshold ?? null,
          });
        }

        // Current approved finance lease exposure (excluding this one)
        const { data: exposureData } = await supabase
          .from('leases')
          .select('calc_total_commitment')
          .eq('workspace_id', workspace.id)
          .eq('lease_classification', 'finance')
          // Phase 3: include chain post_concept_pre_signator + signator
          // stages + executed equivalent (active is identical).
          .in('lifecycle_status', [
            'approved', 'executed', 'active',
            'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
          ])
          .neq('id', leaseId);
        const total = (exposureData || []).reduce(
          (sum: number, l: any) => sum + (l.calc_total_commitment || 0),
          0,
        );
        setCurrentExposure(total);

        // Initialize classification from lease
        if (leaseData.lease_classification && leaseData.lease_classification !== 'pending') {
          setClassification(leaseData.lease_classification as Classification);
        }
      } catch (err) {
        console.error(err);
        toast.error('Error loading financial review');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [leaseId, workspace?.id]);

  const anyFinanceCriteria = Object.values(criteriaChecked).some(Boolean);
  const covenantHeadroom =
    wsSettings.covenantThreshold != null
      ? wsSettings.covenantThreshold - currentExposure - (lease?.calc_total_commitment || 0)
      : null;
  const wouldExceedCovenant = covenantHeadroom != null && covenantHeadroom < 0;

  const handleApprove = async () => {
    if (!lease || !user?.id || classification === 'pending') return;
    setIsActing(true);
    const now = new Date().toISOString();
    try {
      await supabase
        .from('leases')
        .update({
          lifecycle_status: 'approved',
          financial_approved_by: user.id,
          financial_approved_at: now,
          lease_classification: classification,
          lease_classification_set_by: user.id,
          lease_classification_set_at: now,
          status_changed_at: now,
        } as any)
        .eq('id', lease.id);

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'approval',
        from_status: 'under_review',
        to_status: 'approved',
        details: {
          role: 'financial_approver',
          action: 'financial_approved',
          classification,
          covenant_headroom: covenantHeadroom,
        },
      } as any);

      // Notify submitter
      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: null,
        activity_type: 'comment',
        details: {
          notification_type: 'notify_submitter_approved',
          message: `Your commitment request "${lease.request_title}" has been approved (${classification} lease).`,
        },
      } as any);

      toast.success('Commitment approved');
      setApproveDialogOpen(false);
      navigate('/app/approvals');
    } catch (err) {
      console.error(err);
      toast.error('Failed to approve');
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    if (!lease || !user?.id || !rejectReason.trim()) return;
    setIsActing(true);
    const now = new Date().toISOString();
    try {
      if (returnToSubmitter) {
        await supabase
          .from('leases')
          .update({
            lifecycle_status: 'submitted',
            financial_rejection_reason: rejectReason.trim(),
            financial_returned_to_submitter: true,
            status_changed_at: now,
          } as any)
          .eq('id', lease.id);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: user.id,
          activity_type: 'send_back',
          from_status: 'under_review',
          to_status: 'submitted',
          details: { role: 'financial_approver', action: 'financial_returned', reason: rejectReason.trim() },
        } as any);

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_returned',
            message: `Your commitment request "${lease.request_title}" has been returned for revision. Reason: ${rejectReason.trim()}`,
          },
        } as any);

        toast.success('Returned to submitter for revision');
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

        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_rejected',
            message: `Your commitment request "${lease.request_title}" has been rejected. Reason: ${rejectReason.trim()}`,
          },
        } as any);

        toast.success('Request rejected');
      }

      setRejectDialogOpen(false);
      navigate('/app/approvals');
    } catch (err) {
      console.error(err);
      toast.error('Failed to submit rejection');
    } finally {
      setIsActing(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title="Financial Review" />
        <div className="p-6 space-y-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-lg" />)}
        </div>
      </AppLayout>
    );
  }

  if (!lease) return null;

  // Phase 3: include chain in_concept_review equivalent.
  const canAct = isFinancialApprover &&
    (lease.lifecycle_status === 'under_review' || lease.lifecycle_status === 'concept_under_review');

  return (
    <AppLayout>
      <AppHeader
        title="Financial Review"
        subtitle={lease.request_title || 'Commitment Request'}
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back to Approvals
          </Button>
        }
      />

      <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
        {!canAct && (
          <div className="rounded-lg border border-muted bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            This review is in <strong>{displayLabel(lease.lifecycle_status as LifecycleStatus)}</strong> status.
            {!isFinancialApprover && ' You do not have the Financial Approver role.'}
          </div>
        )}

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left — Commitment Summary */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Commitment Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-y-2">
                  <span className="text-muted-foreground">Asset Type</span>
                  <span className="capitalize font-medium">{lease.asset_type || '—'}</span>
                  <span className="text-muted-foreground">Description</span>
                  <span className="font-medium">{lease.request_title || '—'}</span>
                  <span className="text-muted-foreground">Vendor</span>
                  <span className="font-medium">{lease.vendor_name || '—'}</span>
                  <span className="text-muted-foreground">Department</span>
                  <span className="font-medium">{lease.requesting_department || '—'}</span>
                  <span className="text-muted-foreground">Monthly Payment</span>
                  <span className="font-medium">{fmt(lease.monthly_payment)}</span>
                  <span className="text-muted-foreground">Term</span>
                  <span className="font-medium">{lease.term_months ? `${lease.term_months} months` : '—'}</span>
                  <span className="text-muted-foreground">Escalation Rate</span>
                  <span className="font-medium">{lease.escalation_rate != null ? `${lease.escalation_rate}% / yr` : '—'}</span>
                  <span className="text-muted-foreground">Start Date</span>
                  <span className="font-medium">
                    {lease.lease_start ? format(new Date(lease.lease_start), 'MMM d, yyyy') : '—'}
                  </span>
                  <span className="text-muted-foreground">End Date</span>
                  <span className="font-medium">
                    {lease.lease_end ? format(new Date(lease.lease_end), 'MMM d, yyyy') : '—'}
                  </span>
                </div>

                {lease.filename && (
                  <>
                    <Separator />
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      <span className="text-xs truncate">{lease.filename}</span>
                    </div>
                  </>
                )}

                <Separator />

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Submitted by</p>
                  <p className="font-medium">{lease.requestorName || lease.requestorEmail || '—'}</p>
                  <p className="text-xs text-muted-foreground">
                    {lease.uploaded_at
                      ? format(new Date(lease.uploaded_at), "MMM d, yyyy 'at' h:mm a")
                      : '—'}
                  </p>
                </div>

                {lease.manager_approved_by && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Manager approval</p>
                      <p className="font-medium">{lease.managerName || lease.manager_approved_by}</p>
                      {lease.manager_approved_at && (
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(lease.manager_approved_at), "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Per-lease IBR override (ASC 842 compliance) */}
            {lease?.id && workspace?.id && (
              <LeaseDiscountRateCard
                leaseId={lease.id}
                workspaceId={workspace.id}
                canEdit={canEditDiscountRate}
              />
            )}
          </div>

          {/* Right — Financial Impact */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  Financial Impact
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Total Cash Commitment', value: fmt(lease.calc_total_commitment), highlight: true },
                    { label: 'PV Liability (ASC 842)', value: fmt(lease.calc_pv_liability), highlight: true },
                    { label: 'Monthly SL Expense', value: fmtDec(lease.calc_straight_line_exp), highlight: false },
                    { label: 'Cash vs. P&L Delta', value: fmtDec(lease.calc_cash_pl_delta), highlight: false },
                  ].map(({ label, value, highlight }) => (
                    <div
                      key={label}
                      className={`rounded-lg border p-3 ${highlight ? 'border-primary/30 bg-primary/5' : 'bg-muted/40'}`}
                    >
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="text-base font-bold mt-0.5">{value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Discount rate: {wsSettings.discountRate}% (incremental borrowing rate)
                </p>

                {/* Covenant section */}
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Covenant Flag</span>
                    <Badge
                      variant={lease.covenant_flagged ? 'destructive' : 'outline'}
                      className="text-xs"
                    >
                      {lease.covenant_flagged ? 'Flagged' : 'Not flagged'}
                    </Badge>
                  </div>

                  {wsSettings.covenantThreshold != null && (
                    <div className="space-y-1 rounded-lg border p-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Covenant threshold</span>
                        <span className="font-medium">{fmt(wsSettings.covenantThreshold)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Existing finance exposure</span>
                        <span className="font-medium">{fmt(currentExposure)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">This commitment</span>
                        <span className="font-medium">{fmt(lease.calc_total_commitment)}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between font-semibold">
                        <span>Headroom remaining</span>
                        <span className={covenantHeadroom != null && covenantHeadroom < 0 ? 'text-destructive' : 'text-success'}>
                          {fmt(covenantHeadroom)}
                        </span>
                      </div>
                    </div>
                  )}

                  {wouldExceedCovenant && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>
                        Adding this commitment would exceed the covenant threshold by {fmt(Math.abs(covenantHeadroom!))}.
                        Approving may trigger a covenant breach.
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Classification Panel */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lease Classification — Financial Approver Determination</CardTitle>
            <CardDescription>
              Review the ASC 842 criteria below. If any criterion applies, classification as a finance lease may be required.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* ASC 842 Criteria */}
            <div className="space-y-3">
              {ASC842_CRITERIA.map((c) => (
                <div key={c.id} className="flex items-start gap-3">
                  <Checkbox
                    id={c.id}
                    checked={!!criteriaChecked[c.id]}
                    onCheckedChange={(checked) =>
                      setCriteriaChecked((prev) => ({ ...prev, [c.id]: !!checked }))
                    }
                    disabled={!canAct}
                  />
                  <label
                    htmlFor={c.id}
                    className="text-sm leading-snug cursor-pointer select-none"
                  >
                    {c.label}
                  </label>
                </div>
              ))}
            </div>

            {anyFinanceCriteria && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                One or more finance lease indicators present. Classification as a finance lease may be required.
              </div>
            )}

            <Separator />

            {/* Classification selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Classification</Label>
              <Select
                value={classification}
                onValueChange={(v) => setClassification(v as Classification)}
                disabled={!canAct}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="operating">Operating Lease</SelectItem>
                  <SelectItem value="finance">Finance Lease</SelectItem>
                  <SelectItem value="pending" disabled>Pending (must select to approve)</SelectItem>
                </SelectContent>
              </Select>
              {classification === 'pending' && canAct && (
                <p className="text-xs text-destructive">
                  You must set classification to Operating or Finance before approving.
                </p>
              )}
            </div>

            {/* Action buttons */}
            {canAct && (
              <div className="flex flex-wrap gap-3 pt-2">
                <Button
                  onClick={() => setApproveDialogOpen(true)}
                  disabled={classification === 'pending'}
                  className="flex-1 sm:flex-none"
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Approve
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRejectDialogOpen(true)}
                  className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Approve Confirmation Dialog */}
      <Dialog open={approveDialogOpen} onOpenChange={(o) => !o && setApproveDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Approval</DialogTitle>
            <DialogDescription>
              You are approving this commitment. Please confirm the details below.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Classification set to</span>
              <Badge variant={classification === 'finance' ? 'default' : 'secondary'} className="capitalize">
                {classification} Lease
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total commitment</span>
              <span className="font-semibold">{fmt(lease?.calc_total_commitment)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Covenant status</span>
              <span className={wouldExceedCovenant ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                {wouldExceedCovenant ? 'Would exceed threshold' : wsSettings.covenantThreshold != null ? 'Within threshold' : 'No threshold set'}
              </span>
            </div>
          </div>
          {wouldExceedCovenant && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              Warning: approving this commitment will exceed your covenant threshold.
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setApproveDialogOpen(false)} disabled={isActing}>
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={isActing}>
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={(o) => { if (!o) { setRejectDialogOpen(false); setRejectReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this request</DialogTitle>
            <DialogDescription>
              Provide a reason. You can return it to the submitter for revision or reject it finally.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="fin-reject-reason" className="text-sm font-medium">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="fin-reject-reason"
                className="mt-2"
                rows={4}
                placeholder="Explain the reason for rejection…"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Return to submitter for revision</p>
                <p className="text-xs text-muted-foreground">
                  {returnToSubmitter
                    ? 'Submitter can edit and resubmit'
                    : 'Final rejection — cannot be resubmitted'}
                </p>
              </div>
              <Switch
                checked={returnToSubmitter}
                onCheckedChange={setReturnToSubmitter}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => { setRejectDialogOpen(false); setRejectReason(''); }}
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
              {returnToSubmitter ? (
                <><RotateCcw className="h-4 w-4 mr-2" />Return for Revision</>
              ) : (
                <><XCircle className="h-4 w-4 mr-2" />Final Rejection</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
