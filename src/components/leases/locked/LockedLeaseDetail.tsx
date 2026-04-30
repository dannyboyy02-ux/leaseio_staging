import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

/**
 * Security deposit is stored as TEXT. Try to parse a numeric amount and
 * format it as currency; fall back to the raw string for descriptive
 * values like "two months' rent".
 */
const fmtSecurityDeposit = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return raw;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return raw;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
};

/**
 * Find the rent-schedule entry whose period covers today and return its
 * monthly_amount. The leases.current_monthly_rent column is unreliable —
 * for many records it stores the initial base rent rather than the truly
 * current figure after escalations — so the schedule is the source of
 * truth.
 *
 * Falls back to the first entry if the lease hasn't started yet, or the
 * last entry if it has expired. Returns null only if the schedule itself
 * is empty.
 */
const currentRentFromSchedule = (
  schedule: RentScheduleEntry[]
): number | null => {
  if (!schedule || schedule.length === 0) return null;
  const todayMs = Date.now();

  const covers = schedule.find((row) => {
    if (!row.period_start) return false;
    const start = new Date(row.period_start).getTime();
    if (Number.isNaN(start) || start > todayMs) return false;
    if (!row.period_end) return true;
    const end = new Date(row.period_end).getTime();
    return !Number.isNaN(end) && end >= todayMs;
  });
  if (covers?.monthly_amount != null) return covers.monthly_amount;

  // Lease hasn't started yet → show first scheduled period
  const firstStart = schedule[0]?.period_start
    ? new Date(schedule[0].period_start).getTime()
    : null;
  if (firstStart != null && firstStart > todayMs && schedule[0]?.monthly_amount != null) {
    return schedule[0].monthly_amount;
  }

  // Otherwise lease is past its last scheduled entry → show last period's amount
  const last = schedule[schedule.length - 1];
  return last?.monthly_amount ?? null;
};

/**
 * Whole months between today and lease_end (positive only). Returns null
 * if no end date or lease is already expired.
 */
const remainingMonths = (leaseEnd: string | null | undefined): number | null => {
  if (!leaseEnd) return null;
  const end = new Date(leaseEnd);
  if (Number.isNaN(end.getTime())) return null;
  const now = new Date();
  if (end <= now) return 0;
  const months =
    (end.getFullYear() - now.getFullYear()) * 12 +
    (end.getMonth() - now.getMonth()) +
    (end.getDate() >= now.getDate() ? 0 : -1);
  return Math.max(0, months);
};

export function LockedLeaseDetail({ lease, refetchLease }: Props) {
  const { t } = useAppTranslation();
  const { userRole } = useApp();
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const [pendingUnlockRequest, setPendingUnlockRequest] = useState<PendingUnlockRequest | null>(null);
  const [isRequestingUnlock, setIsRequestingUnlock] = useState(false);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [risks, setRisks] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'general' | 'vendor' | 'rent' | 'options' | 'risks' | 'documents'>('general');

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

  const propertyRows: LabelValueRow[] = useMemo(() => {
    const city = extractedValue(extracted, 'city');
    const state = extractedValue(extracted, 'state');
    const zip = extractedValue(extracted, 'zip') ?? extractedValue(extracted, 'postal_code');
    return [
      { label: t('locked_lease.property.address'), value: lease.property_address, fullWidth: true },
      { label: t('locked_lease.property.city'), value: city, aiExtracted: !!city },
      { label: t('locked_lease.property.state'), value: state, aiExtracted: !!state },
      { label: t('locked_lease.property.zip'), value: zip, aiExtracted: !!zip },
      { label: t('locked_lease.property.asset_type'), value: lease.asset_type },
      { label: t('locked_lease.property.requesting_department'), value: lease.requesting_department },
      { label: t('locked_lease.property.intake_source'), value: lease.intake_source },
    ];
  }, [lease, extracted, t]);

  const timingRows: LabelValueRow[] = useMemo(() => {
    const months = remainingMonths(lease.lease_end);
    const remaining = months == null
      ? null
      : `${months} ${months === 1 ? t('locked_lease.rent.month') : t('locked_lease.rent.months')}`;
    return [
      { label: t('locked_lease.timing.commencement'), value: fmtDate(lease.lease_start) },
      { label: t('locked_lease.timing.rent_commencement'), value: fmtDate(lease.rent_commencement_date) },
      { label: t('locked_lease.timing.expiration'), value: fmtDate(lease.lease_end) },
      { label: t('locked_lease.timing.term_months'), value: lease.term_months },
      { label: t('locked_lease.timing.remaining'), value: remaining },
      { label: t('locked_lease.timing.month_to_month'), value: fmtBool(lease.month_to_month, t) },
      { label: t('locked_lease.timing.approved'), value: fmtDate(lease.financial_approved_at) },
    ];
  }, [lease, t]);

  const currentMonthlyRent = useMemo(
    () => currentRentFromSchedule(rentSchedule) ?? lease.current_monthly_rent ?? null,
    [rentSchedule, lease.current_monthly_rent]
  );

  const rentRows: LabelValueRow[] = useMemo(() => {
    const annual = currentMonthlyRent != null ? currentMonthlyRent * 12 : null;
    const months = remainingMonths(lease.lease_end);
    return [
      { label: t('locked_lease.rent.monthly_rent'), value: fmtCurrency(currentMonthlyRent) },
      { label: t('locked_lease.rent.annual_rent'), value: fmtCurrency(annual) },
      { label: t('locked_lease.rent.security_deposit'), value: fmtSecurityDeposit(lease.security_deposit) },
      {
        label: t('locked_lease.rent.remaining_months'),
        value: months == null ? null : `${months} ${months === 1 ? t('locked_lease.rent.month') : t('locked_lease.rent.months')}`,
      },
    ];
  }, [currentMonthlyRent, lease, t]);

  const escalationRows: LabelValueRow[] = useMemo(() => [
    { label: t('locked_lease.escalations.rate'), value: fmtPercent(lease.escalation_rate) },
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

        <div className="max-w-6xl mx-auto px-6 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="mb-4 justify-start overflow-x-auto">
              <TabsTrigger value="general">{t('locked_lease.tabs.general')}</TabsTrigger>
              <TabsTrigger value="vendor">{t('locked_lease.tabs.vendor')}</TabsTrigger>
              <TabsTrigger value="rent">{t('locked_lease.tabs.rent')}</TabsTrigger>
              <TabsTrigger value="options">{t('locked_lease.tabs.options')}</TabsTrigger>
              <TabsTrigger value="risks">{t('locked_lease.tabs.risks')}</TabsTrigger>
              <TabsTrigger value="documents">{t('locked_lease.tabs.documents')}</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-4 mt-0">
              <SectionCard title={t('locked_lease.property.section_title')}>
                <LabelValueGrid rows={propertyRows} />
              </SectionCard>

              <SectionCard title={t('locked_lease.timing.section_title')}>
                <LabelValueGrid rows={timingRows} />
              </SectionCard>

              <AuditTimelineCard leaseId={lease.id} workspaceId={lease.workspace_id} />

              <SectionCard title={t('locked_lease.share.section_title')} defaultOpen={false}>
                <SummaryShareControls leaseId={lease.id} lifecycleStatus={lease.lifecycle_status ?? ''} />
              </SectionCard>
            </TabsContent>

            <TabsContent value="vendor" className="space-y-4 mt-0">
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
            </TabsContent>

            <TabsContent value="rent" className="space-y-4 mt-0">
              <SectionCard title={t('locked_lease.rent.section_title')}>
                <LabelValueGrid rows={rentRows} />
                {rentSchedule.length > 0 && (
                  <div className="mt-6">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      {t('locked_lease.rent.schedule_title')}
                    </h4>
                    <RentScheduleTable
                      rentSchedule={rentSchedule}
                      currentMonthlyRent={currentMonthlyRent}
                      rentEscalationType={lease.rent_escalation_type ?? null}
                      isLocked={true}
                    />
                  </div>
                )}
              </SectionCard>

              <SectionCard title={t('locked_lease.escalations.section_title')}>
                <LabelValueGrid rows={escalationRows} />
              </SectionCard>
            </TabsContent>

            <TabsContent value="options" className="space-y-4 mt-0">
              <SectionCard title={t('locked_lease.options.section_title')}>
                <LabelValueGrid rows={optionsRows} />
              </SectionCard>
            </TabsContent>

            <TabsContent value="risks" className="space-y-4 mt-0">
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
            </TabsContent>

            <TabsContent value="documents" className="space-y-4 mt-0">
              <SectionCard title={t('locked_lease.documents.section_title')}>
                <AmendmentsList parentLeaseId={lease.id} />
              </SectionCard>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </AppLayout>
  );
}
