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
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { localizedStatusLabel } from '@/lib/lifecycleLabels';
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
  requestorName?: string;
  requestorEmail?: string;
  managerName?: string;
}

type Classification = 'operating' | 'finance' | 'pending';

// Labels come from the i18n catalog: approvals.financial.criteria.<id>
const ASC842_CRITERIA = [
  { id: 'ownership' },
  { id: 'purchase_option' },
  { id: 'major_part' },
  { id: 'pv_substantially_all' },
  { id: 'specialized' },
];

export default function FinancialReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { user, workspace, userFunctionalRoles, userRole } = useApp();
  const { language, t } = useLanguage();
  const fmt = (n: number | null | undefined) => formatLocalizedCurrency(n, language);
  const fmtDec = (n: number | null | undefined) =>
    formatLocalizedCurrency(n, language, { cents: true });
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
              'id, request_title, requesting_department, asset_type, vendor_name, monthly_payment, term_months, escalation_rate, lease_start, lease_end, calc_total_commitment, calc_pv_liability, calc_straight_line_exp, calc_cash_pl_delta, lease_classification, covenant_flagged, lifecycle_status, financial_returned_to_submitter, manager_approved_by, manager_approved_at, financial_approved_by, storage_path, filename, requestor_id, uploaded_at',
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
          toast.error(t('approvals.financial.load_failed'));
          navigate('/app/approvals');
          return;
        }

        const leaseData = leaseResult.data as LeaseDetail;

        // Fetch user profiles
        const userIds = [leaseData.requestor_id, leaseData.manager_approved_by].filter(Boolean) as string[];
        const profileMap: Record<string, { email: string; name: string }> = {};
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
        toast.error(t('approvals.financial.load_error'));
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
    try {
      // P1-11: lifecycle/approval columns are guarded by a DB trigger
      // (migration 20260515010000). The actual transition lives in the
      // legacy-lease-action edge function under service-role credentials;
      // the browser only invokes it and the audit-log notification row.
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: {
          action: 'financial_approve',
          leaseId: lease.id,
          classification,
        },
      });
      if (error) throw new Error(error.message ?? t('approvals.errors.approval_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);

      // Notification row — not a workflow column, browser can still write it.
      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: null,
        activity_type: 'comment',
        details: {
          notification_type: 'notify_submitter_approved',
          // P1-4: without recipient_ids, dispatch-notifications skips the row and
          // the requestor never hears their own request's outcome. The requestor
          // is the person to notify here.
          recipient_ids: lease.requestor_id ? [lease.requestor_id] : [],
          message: `Your commitment request "${lease.request_title}" has been approved (${classification} lease).`,
          covenant_headroom: covenantHeadroom,
        },
      } as any);

      toast.success(t('approvals.common.commitment_approved'));
      setApproveDialogOpen(false);
      navigate('/app/approvals');
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : t('approvals.errors.failed_to_approve');
      toast.error(msg);
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    if (!lease || !user?.id || !rejectReason.trim()) return;
    setIsActing(true);
    try {
      // P1-11: lifecycle/approval columns are guarded by a DB trigger.
      // Edge function performs the transition + main activity-log row;
      // browser still writes the notification-comment row.
      const action = returnToSubmitter ? 'financial_send_back' : 'financial_reject';
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: {
          action,
          leaseId: lease.id,
          reason: rejectReason.trim(),
        },
      });
      if (error) throw new Error(error.message ?? t('approvals.errors.rejection_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);

      if (returnToSubmitter) {
        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_returned',
            recipient_ids: lease.requestor_id ? [lease.requestor_id] : [],
            message: `Your commitment request "${lease.request_title}" has been returned for revision. Reason: ${rejectReason.trim()}`,
          },
        } as any);

        toast.success(t('approvals.financial.returned_toast'));
      } else {
        await supabase.from('lease_activity_log').insert({
          lease_id: lease.id,
          user_id: null,
          activity_type: 'comment',
          details: {
            notification_type: 'notify_submitter_rejected',
            recipient_ids: lease.requestor_id ? [lease.requestor_id] : [],
            message: `Your commitment request "${lease.request_title}" has been rejected. Reason: ${rejectReason.trim()}`,
          },
        } as any);

        toast.success(t('approvals.common.request_rejected'));
      }

      setRejectDialogOpen(false);
      navigate('/app/approvals');
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : t('approvals.financial.reject_submit_failed');
      toast.error(msg);
    } finally {
      setIsActing(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title={t('approvals.financial.title')} />
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
        title={t('approvals.financial.title')}
        subtitle={lease.request_title || t('approvals.financial.commitment_request')}
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            {t('approvals.financial.back_to_approvals')}
          </Button>
        }
      />

      <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
        {!canAct && (
          <div className="rounded-lg border border-muted bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            {t('approvals.financial.review_status_before')}<strong>{localizedStatusLabel(lease.lifecycle_status as LifecycleStatus)}</strong>{t('approvals.financial.review_status_after')}
            {!isFinancialApprover && ` ${t('approvals.financial.not_financial_approver')}`}
          </div>
        )}

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left — Commitment Summary */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t('approvals.financial.commitment_summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-y-2">
                  <span className="text-muted-foreground">{t('workflow.request.asset_type')}</span>
                  <span className="capitalize font-medium">{lease.asset_type || '—'}</span>
                  <span className="text-muted-foreground">{t('workflow.request.description')}</span>
                  <span className="font-medium">{lease.request_title || '—'}</span>
                  <span className="text-muted-foreground">{t('workflow.request.vendor')}</span>
                  <span className="font-medium">{lease.vendor_name || '—'}</span>
                  <span className="text-muted-foreground">{t('approvals.financial.department')}</span>
                  <span className="font-medium">{lease.requesting_department || '—'}</span>
                  <span className="text-muted-foreground">{t('workflow.request.monthly_payment')}</span>
                  <span className="font-medium">{fmt(lease.monthly_payment)}</span>
                  <span className="text-muted-foreground">{t('approvals.financial.term')}</span>
                  <span className="font-medium">{lease.term_months ? t('workflow.impact.n_months', { count: lease.term_months }) : '—'}</span>
                  <span className="text-muted-foreground">{t('approvals.financial.escalation_rate')}</span>
                  <span className="font-medium">{lease.escalation_rate != null ? t('approvals.financial.pct_per_year', { rate: lease.escalation_rate }) : '—'}</span>
                  <span className="text-muted-foreground">{t('workflow.request.start_date')}</span>
                  <span className="font-medium">
                    {lease.lease_start ? format(new Date(lease.lease_start), 'MMM d, yyyy') : '—'}
                  </span>
                  <span className="text-muted-foreground">{t('workflow.summary.end_date')}</span>
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
                  <p className="text-xs text-muted-foreground">{t('approvals.financial.submitted_by')}</p>
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
                      <p className="text-xs text-muted-foreground">{t('approvals.financial.manager_approval')}</p>
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
                  {t('workflow.impact.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: t('workflow.impact.total_cash_commitment'), value: fmt(lease.calc_total_commitment), highlight: true },
                    { label: t('approvals.financial.pv_liability_asc842'), value: fmt(lease.calc_pv_liability), highlight: true },
                    { label: t('approvals.financial.monthly_sl_expense'), value: fmtDec(lease.calc_straight_line_exp), highlight: false },
                    { label: t('workflow.impact.cash_pl_delta'), value: fmtDec(lease.calc_cash_pl_delta), highlight: false },
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
                  {t('approvals.financial.discount_rate_note', { rate: wsSettings.discountRate })}
                </p>

                {/* Covenant section */}
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{t('approvals.financial.covenant_flag')}</span>
                    <Badge
                      variant={lease.covenant_flagged ? 'destructive' : 'outline'}
                      className="text-xs"
                    >
                      {lease.covenant_flagged ? t('approvals.financial.flagged') : t('approvals.financial.not_flagged')}
                    </Badge>
                  </div>

                  {wsSettings.covenantThreshold != null && (
                    <div className="space-y-1 rounded-lg border p-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('approvals.financial.covenant_threshold')}</span>
                        <span className="font-medium">{fmt(wsSettings.covenantThreshold)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('approvals.financial.existing_exposure')}</span>
                        <span className="font-medium">{fmt(currentExposure)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('approvals.financial.this_commitment')}</span>
                        <span className="font-medium">{fmt(lease.calc_total_commitment)}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between font-semibold">
                        <span>{t('approvals.financial.headroom_remaining')}</span>
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
                        {t('approvals.financial.exceed_warning', { amount: fmt(Math.abs(covenantHeadroom!)) })}
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
            <CardTitle className="text-base">{t('approvals.financial.classification_title')}</CardTitle>
            <CardDescription>
              {t('approvals.financial.classification_desc')}
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
                    {t(`approvals.financial.criteria.${c.id}`)}
                  </label>
                </div>
              ))}
            </div>

            {anyFinanceCriteria && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                {t('approvals.financial.indicators_warning')}
              </div>
            )}

            <Separator />

            {/* Classification selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('approvals.financial.classification')}</Label>
              <Select
                value={classification}
                onValueChange={(v) => setClassification(v as Classification)}
                disabled={!canAct}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="operating">{t('workflow.classification.operating')}</SelectItem>
                  <SelectItem value="finance">{t('workflow.classification.finance')}</SelectItem>
                  <SelectItem value="pending" disabled>{t('approvals.financial.classification_pending_option')}</SelectItem>
                </SelectContent>
              </Select>
              {classification === 'pending' && canAct && (
                <p className="text-xs text-destructive">
                  {t('approvals.financial.classification_required')}
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
                  {t('approval.approve')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRejectDialogOpen(true)}
                  className="flex-1 sm:flex-none text-destructive hover:text-destructive"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  {t('approval.reject')}
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
            <DialogTitle>{t('approvals.financial.confirm_approval_title')}</DialogTitle>
            <DialogDescription>
              {t('approvals.financial.confirm_approval_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('approvals.financial.classification_set_to')}</span>
              <Badge variant={classification === 'finance' ? 'default' : 'secondary'} className="capitalize">
                {classification === 'finance'
                  ? t('workflow.classification.finance')
                  : t('workflow.classification.operating')}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('approvals.financial.total_commitment')}</span>
              <span className="font-semibold">{fmt(lease?.calc_total_commitment)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('approvals.financial.covenant_status')}</span>
              <span className={wouldExceedCovenant ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                {wouldExceedCovenant
                  ? t('approvals.financial.would_exceed')
                  : wsSettings.covenantThreshold != null
                  ? t('approvals.financial.within_threshold')
                  : t('approvals.financial.no_threshold')}
              </span>
            </div>
          </div>
          {wouldExceedCovenant && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              {t('approvals.financial.approve_exceed_warning')}
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setApproveDialogOpen(false)} disabled={isActing}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleApprove} disabled={isActing}>
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('approvals.financial.confirm_approval_title')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={(o) => { if (!o) { setRejectDialogOpen(false); setRejectReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('approvals.financial.reject_title')}</DialogTitle>
            <DialogDescription>
              {t('approvals.financial.reject_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="fin-reject-reason" className="text-sm font-medium">
                {t('audit.reason')} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="fin-reject-reason"
                className="mt-2"
                rows={4}
                placeholder={t('approvals.financial.reject_reason_placeholder')}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t('approvals.financial.return_to_submitter')}</p>
                <p className="text-xs text-muted-foreground">
                  {returnToSubmitter
                    ? t('approvals.financial.return_hint')
                    : t('approvals.financial.final_hint')}
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
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={isActing || !rejectReason.trim()}
            >
              {isActing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {returnToSubmitter ? (
                <><RotateCcw className="h-4 w-4 mr-2" />{t('approvals.financial.return_for_revision')}</>
              ) : (
                <><XCircle className="h-4 w-4 mr-2" />{t('approvals.financial.final_rejection')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
