import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { AppLayout } from '@/components/layout/AppLayout';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';

import { LockedHeader } from './LockedHeader';
import { SectionCard } from './SectionCard';
import { LabelValueGrid, type LabelValueRow } from './LabelValueGrid';
import { VendorCard } from './VendorCard';
import { AuditTimelineCard } from './AuditTimelineCard';

import { RentScheduleTable, type RentScheduleEntry } from '@/components/leases/RentScheduleTable';
import { AmendmentsList } from '@/components/leases/AmendmentsList';
import { SummaryShareControls } from '@/components/summary/SummaryShareControls';

interface PendingUnlockRequest {
  id: string;
  status: string;
  request_reason: string | null;
  created_at: string;
}

interface Props {
  lease: any;
  /** Callback to ask the parent to re-fetch the lease (after unlock or vendor save). */
  refetchLease: () => void;
}

const fmtDate = (d: string | null | undefined) =>
  d ? format(new Date(d), 'MMM d, yyyy') : null;

const fmtCurrency = (n: number | null | undefined, currency = 'USD') =>
  n == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

const fmtPercent = (n: number | null | undefined) =>
  n == null ? null : `${n.toFixed(2)}%`;

const fmtBool = (b: boolean | null | undefined, t: (k: string) => string) =>
  b == null ? null : b ? t('common.yes') : t('common.no');

const extractedValue = (extracted: any, key: string): string | null => {
  const node = extracted?.[key];
  if (!node) return null;
  if (typeof node === 'string') return node || null;
  if (typeof node === 'object' && 'value' in node) return node.value ?? null;
  return null;
};

export function LockedLeaseDetail({ lease, refetchLease }: Props) {
  const { t } = useAppTranslation();
  const { userRole } = useApp();
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const [pendingUnlockRequest, setPendingUnlockRequest] = useState<PendingUnlockRequest | null>(null);
  const [isRequestingUnlock, setIsRequestingUnlock] = useState(false);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [risks, setRisks] = useState<any[]>([]);

  // Fetch unlock-request status, rent schedule, and risks
  useEffect(() => {
    if (!lease?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const [unlockRes, rentRes, riskRes] = await Promise.all([
          (supabase as any)
            .from('lease_unlock_requests')
            .select('id, status, request_reason, created_at')
            .eq('lease_id', lease.id)
            .eq('status', 'pending')
            .maybeSingle(),
          supabase.from('rent_schedules').select('*').eq('lease_id', lease.id).order('period_start'),
          supabase.from('risks').select('*').eq('lease_id', lease.id),
        ]);
        if (cancelled) return;
        setPendingUnlockRequest((unlockRes.data ?? null) as PendingUnlockRequest | null);
        setRentSchedule((rentRes.data ?? []) as RentScheduleEntry[]);
        setRisks((riskRes.data ?? []) as any[]);
      } catch (err) {
        console.error('LockedLeaseDetail fetch error:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]);

  const handleRequestUnlock = useCallback(async () => {
    if (!lease) return;
    setIsRequestingUnlock(true);
    try {
      const { data, error } = await supabase.functions.invoke('request-lease-unlock', {
        body: { leaseId: lease.id },
      });
      if (error || !data?.ok) throw new Error(error?.message || data?.error || 'Request failed');
      toast.success(t('locked_lease.toast.unlock_requested'));
      refetchLease();
      // Re-fetch unlock state too
      const { data: u } = await (supabase as any)
        .from('lease_unlock_requests')
        .select('id, status, request_reason, created_at')
        .eq('lease_id', lease.id)
        .eq('status', 'pending')
        .maybeSingle();
      setPendingUnlockRequest((u ?? null) as PendingUnlockRequest | null);
    } catch (err: any) {
      toast.error(err?.message ?? t('locked_lease.toast.unlock_request_failed'));
    } finally {
      setIsRequestingUnlock(false);
    }
  }, [lease, refetchLease, t]);

  const handleAdminUnlock = useCallback(async () => {
    if (!lease) return;
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: pendingUnlockRequest?.id
          ? { action: 'approve_unlock_request', unlockRequestId: pendingUnlockRequest.id }
          : { action: 'direct_unlock', leaseId: lease.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t('locked_lease.toast.unlocked'));
      refetchLease();
    } catch (err: any) {
      toast.error(err?.message ?? t('locked_lease.toast.unlock_failed'));
    }
  }, [lease, pendingUnlockRequest, refetchLease, t]);

  const handleDenyUnlock = useCallback(async () => {
    if (!pendingUnlockRequest?.id) return;
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: { action: 'reject_unlock_request', unlockRequestId: pendingUnlockRequest.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t('locked_lease.toast.unlock_denied'));
      setPendingUnlockRequest(null);
      refetchLease();
    } catch (err: any) {
      toast.error(err?.message ?? t('locked_lease.toast.unlock_deny_failed'));
    }
  }, [pendingUnlockRequest, refetchLease, t]);

  const extracted = lease?.extracted_json ?? null;

  // ---- Section row builders --------------------------------------------------

  const keyInfoRows: LabelValueRow[] = useMemo(() => [
    { label: t('locked_lease.key_info.title'), value: lease.request_title },
    { label: t('locked_lease.key_info.asset_type'), value: lease.asset_type },
    { label: t('locked_lease.key_info.intake_source'), value: lease.intake_source },
    { label: t('locked_lease.key_info.requesting_department'), value: lease.requesting_department },
    { label: t('locked_lease.key_info.created'), value: fmtDate(lease.created_at) },
    { label: t('locked_lease.key_info.approved'), value: fmtDate(lease.financial_approved_at) },
  ], [lease, t]);

  const locationRows: LabelValueRow[] = useMemo(() => {
    const city = extractedValue(extracted, 'city');
    const state = extractedValue(extracted, 'state');
    const zip = extractedValue(extracted, 'zip') ?? extractedValue(extracted, 'postal_code');
    return [
      { label: t('locked_lease.location.address'), value: lease.property_address, fullWidth: true },
      { label: t('locked_lease.location.city'), value: city, aiExtracted: !!city },
      { label: t('locked_lease.location.state'), value: state, aiExtracted: !!state },
      { label: t('locked_lease.location.zip'), value: zip, aiExtracted: !!zip },
    ];
  }, [lease, extracted, t]);

  const datesRows: LabelValueRow[] = useMemo(() => [
    { label: t('locked_lease.dates.commencement'), value: fmtDate(lease.lease_start) },
    { label: t('locked_lease.dates.expiration'), value: fmtDate(lease.lease_end) },
    { label: t('locked_lease.dates.rent_commencement'), value: fmtDate(lease.rent_commencement_date) },
    { label: t('locked_lease.dates.term_months'), value: lease.term_months },
    { label: t('locked_lease.dates.month_to_month'), value: fmtBool(lease.month_to_month, t) },
  ], [lease, t]);

  const rentRows: LabelValueRow[] = useMemo(() => [
    { label: t('locked_lease.rent.monthly_payment'), value: fmtCurrency(lease.monthly_payment) },
    { label: t('locked_lease.rent.executed_monthly'), value: fmtCurrency(lease.executed_monthly_payment) },
    { label: t('locked_lease.rent.security_deposit'), value: lease.security_deposit },
    { label: t('locked_lease.rent.total_commitment'), value: fmtCurrency(lease.calc_total_commitment) },
    { label: t('locked_lease.rent.pv_liability'), value: fmtCurrency(lease.calc_pv_liability) },
    { label: t('locked_lease.rent.straight_line_exp'), value: fmtCurrency(lease.calc_straight_line_exp) },
  ], [lease, t]);

  const escalationRows: LabelValueRow[] = useMemo(() => [
    { label: t('locked_lease.escalations.rate'), value: fmtPercent(lease.escalation_rate) },
    { label: t('locked_lease.escalations.needs_review'), value: fmtBool(lease.needs_escalation_review, t) },
    { label: t('locked_lease.escalations.clauses'), value: lease.escalation_clauses, fullWidth: true },
  ], [lease, t]);

  const optionsRows: LabelValueRow[] = useMemo(() => {
    const purchaseOption = extractedValue(extracted, 'purchase_option');
    return [
      { label: t('locked_lease.options.renewal_options'), value: lease.renewal_options, fullWidth: true },
      { label: t('locked_lease.options.termination_clauses'), value: lease.termination_clauses, fullWidth: true },
      { label: t('locked_lease.options.purchase_option'), value: purchaseOption, aiExtracted: !!purchaseOption, fullWidth: true },
    ];
  }, [lease, extracted, t]);

  return (
    <AppLayout>
      <div className="bg-muted/20 min-h-screen pb-12">
        <LockedHeader
          title={lease.request_title || lease.property_address || lease.filename || t('locked_lease.untitled')}
          subtitle={lease.requesting_department}
          lifecycleStatus={lease.lifecycle_status ?? null}
          isAdmin={isAdmin}
          pendingUnlockRequest={pendingUnlockRequest}
          isRequestingUnlock={isRequestingUnlock}
          onRequestUnlock={handleRequestUnlock}
          onApproveUnlock={handleAdminUnlock}
          onDenyUnlock={handleDenyUnlock}
          onAdminUnlock={handleAdminUnlock}
        />

        <div className="max-w-6xl mx-auto px-6 py-6 space-y-4">
          <SectionCard title={t('locked_lease.key_info.section_title')}>
            <LabelValueGrid rows={keyInfoRows} />
          </SectionCard>

          <SectionCard title={t('locked_lease.location.section_title')}>
            <LabelValueGrid rows={locationRows} />
          </SectionCard>

          <SectionCard title={t('locked_lease.dates.section_title')}>
            <LabelValueGrid rows={datesRows} />
          </SectionCard>

          <SectionCard title={t('locked_lease.rent.section_title')}>
            <LabelValueGrid rows={rentRows} />
            {rentSchedule.length > 0 && (
              <div className="mt-6">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  {t('locked_lease.rent.schedule_title')}
                </h4>
                <RentScheduleTable
                  rentSchedule={rentSchedule}
                  currentMonthlyRent={lease.monthly_payment ?? null}
                  rentEscalationType={lease.rent_escalation_type ?? null}
                  isLocked={true}
                />
              </div>
            )}
          </SectionCard>

          <SectionCard title={t('locked_lease.escalations.section_title')}>
            <LabelValueGrid rows={escalationRows} />
          </SectionCard>

          <SectionCard title={t('locked_lease.options.section_title')}>
            <LabelValueGrid rows={optionsRows} />
          </SectionCard>

          {/* Vendor — the only editable card when locked */}
          <VendorCard
            leaseId={lease.id}
            initial={{
              vendor_name: lease.vendor_name ?? null,
              vendor_phone: lease.vendor_phone ?? null,
              vendor_address_line1: lease.vendor_address_line1 ?? null,
              vendor_address_line2: lease.vendor_address_line2 ?? null,
              vendor_city: lease.vendor_city ?? null,
              vendor_state: lease.vendor_state ?? null,
              vendor_zip: lease.vendor_zip ?? null,
            }}
            onSaved={refetchLease}
          />

          <SectionCard title={t('locked_lease.risks.section_title')}>
            {risks.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">{t('locked_lease.risks.empty_hint')}</p>
            ) : (
              <ul className="space-y-3">
                {risks.map((r) => (
                  <li key={r.id} className="border-l-2 border-amber-400 pl-3 py-1">
                    <p className="text-sm font-medium text-foreground">{r.title || r.risk_type}</p>
                    {r.description && <p className="text-xs text-muted-foreground mt-0.5">{r.description}</p>}
                    {r.severity && (
                      <span className="inline-block mt-1 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        {r.severity}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={t('locked_lease.documents.section_title')}>
            <AmendmentsList parentLeaseId={lease.id} />
          </SectionCard>

          <AuditTimelineCard leaseId={lease.id} workspaceId={lease.workspace_id} />

          {/* Summary share controls (already-shipped feature) */}
          <SectionCard title={t('locked_lease.share.section_title')} defaultOpen={false}>
            <SummaryShareControls leaseId={lease.id} lifecycleStatus={lease.lifecycle_status ?? ''} />
          </SectionCard>
        </div>
      </div>
    </AppLayout>
  );
}
