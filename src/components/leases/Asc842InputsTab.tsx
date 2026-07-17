// ASC 842 Inputs tab — full per-lease capture for measurement,
// classification, term assessment, and disclosure.
//
// Mounted as the LAST tab in LeaseReview and between Risks and Documents
// in LockedLeaseDetail (forceMount — local
// state must survive tab switches; a user flips to Documents to check the
// lease PDF mid-entry and back) and in LockedLeaseDetail. The fields here
// are NOT extracted by the AI pipeline; they require human capture per
// lease for the disclosure report to be useful (vs. a vanity artifact).
//
// Structure (2026-07-17 polish pass):
//   • Summary strip — derived classification (live from the five
//     ASC 842-10-25-2 tests), discount rate, effective term, and
//     section-completion count. The only computed layer on the tab;
//     visually distinct from the capture cards below it.
//   • Five capture sections matching the canonical measurement model.
//   • Sticky save bar — dirty-aware (Save disabled until something
//     changed), last-saved attribution, and the "Generate disclosure
//     report" door (the report this tab exists to feed).
//
// Audit trail: every save writes asc842_inputs_updated to lease_activity_log.
// NULL on a numeric field = "not yet captured" (distinct from 0/false which
// means "captured as zero/false"). A LOAD ERROR renders a retry state, never
// the editable form — otherwise a Save would upsert NULLs over existing data.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, FileText, Loader2, RefreshCw, Save, Scale, SlidersHorizontal, Timer, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate } from '@/lib/dateFormatters';
import { useGenerateLeaseReport } from '@/hooks/useGenerateLeaseReport';

interface Props {
  leaseId: string;
  workspaceId: string;
  canEdit: boolean;
  /** leases.discount_rate, for the summary strip (set via the Discount Rate card). */
  discountRate?: number | null;
  /** leases.term_months, for the effective-term chip. */
  baseTermMonths?: number | null;
  /** Current lifecycle_status — drives the pre-execution / post-finalize context notes. */
  lifecycleStatus?: string | null;
  /** generate-lease-report only accepts finalized (model-locked) leases —
   *  the door is shown disabled with an honest hint until then. */
  reportAvailable?: boolean;
  /** Rendered between the capture sections and the sticky save bar so the
   *  bar's containing block covers the discount-rate card too. */
  discountRateSlot?: React.ReactNode;
}

type State = {
  // Right-of-Use Asset Adjustments
  tenant_improvement_allowance: string;
  tenant_improvement_allowance_basis: string;
  initial_direct_costs: string;
  initial_direct_costs_basis: string;
  prepaid_rent: string;
  prepaid_rent_basis: string;
  lease_incentives_received: string;
  lease_incentives_received_basis: string;
  // Lease Liability Inputs
  residual_value_guarantee: string;
  residual_value_guarantee_basis: string;
  purchase_option_present: boolean | null;
  purchase_option_price: string;
  purchase_option_reasonably_certain: boolean | null;
  purchase_option_basis: string;
  termination_penalty_amount: string;
  termination_penalty_reasonably_certain: boolean | null;
  termination_penalty_basis: string;
  // Classification
  ownership_transfers_at_end: boolean | null;
  bargain_purchase_option: boolean | null;
  major_part_economic_life: boolean | null;
  major_part_economic_life_pct: string;
  pv_substantially_all_fair_value: boolean | null;
  pv_to_fair_value_pct: string;
  asset_fair_value: string;
  specialized_asset_no_alt_use: boolean | null;
  classification_criteria_basis: string;
  // Term
  renewal_options_rc_term_months: string;
  renewal_options_rc_basis: string;
  short_term_lease_election: boolean | null;
  short_term_lease_election_basis: string;
  // Disclosure
  variable_payments_description: string;
  variable_payments_estimated_annual: string;
  sublease_income_annual: string;
  sublease_basis: string;
  // Meta
  has_row: boolean;
  last_updated_at: string | null;
  last_updated_by_label: string | null;
};

const EMPTY: State = {
  tenant_improvement_allowance: '',
  tenant_improvement_allowance_basis: '',
  initial_direct_costs: '',
  initial_direct_costs_basis: '',
  prepaid_rent: '',
  prepaid_rent_basis: '',
  lease_incentives_received: '',
  lease_incentives_received_basis: '',
  residual_value_guarantee: '',
  residual_value_guarantee_basis: '',
  purchase_option_present: null,
  purchase_option_price: '',
  purchase_option_reasonably_certain: null,
  purchase_option_basis: '',
  termination_penalty_amount: '',
  termination_penalty_reasonably_certain: null,
  termination_penalty_basis: '',
  ownership_transfers_at_end: null,
  bargain_purchase_option: null,
  major_part_economic_life: null,
  major_part_economic_life_pct: '',
  pv_substantially_all_fair_value: null,
  pv_to_fair_value_pct: '',
  asset_fair_value: '',
  specialized_asset_no_alt_use: null,
  classification_criteria_basis: '',
  renewal_options_rc_term_months: '',
  renewal_options_rc_basis: '',
  short_term_lease_election: null,
  short_term_lease_election_basis: '',
  variable_payments_description: '',
  variable_payments_estimated_annual: '',
  sublease_income_annual: '',
  sublease_basis: '',
  has_row: false,
  last_updated_at: null,
  last_updated_by_label: null,
};

// Meta keys excluded from dirty comparison / completion counting.
const META_KEYS: Array<keyof State> = ['has_row', 'last_updated_at', 'last_updated_by_label'];

function fieldsOf(state: State): string {
  const entries = Object.entries(state).filter(([k]) => !META_KEYS.includes(k as keyof State));
  entries.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function n(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function s(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}

function fromDb(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function fromDbStr(value: string | null | undefined): string {
  return value ?? '';
}

// Lifecycle states where the lease is still pre-execution — most ASC 842
// inputs are only knowable at signing, so the tab says so instead of
// presenting 40 unanswerable fields without context.
const PRE_EXECUTION_STATES = new Set([
  'draft', 'submitted', 'under_review', 'approved', 'concept_submitted',
  'concept_under_review', 'in_negotiation', 'final_review', 'pending_counter_signature',
]);

export function Asc842InputsTab({
  leaseId,
  workspaceId,
  canEdit,
  discountRate = null,
  baseTermMonths = null,
  lifecycleStatus = null,
  reportAvailable = false,
  discountRateSlot = null,
}: Props) {
  const { t } = useAppTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const [state, setState] = useState<State>(EMPTY);
  const [savedSnapshot, setSavedSnapshot] = useState<string>(fieldsOf(EMPTY));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const { generate: generateReport, isWorking: generatingReport } = useGenerateLeaseReport();

  const dirty = fieldsOf(state) !== savedSnapshot;

  // Hard-navigation guard (reload / tab close / external link): the browser
  // confirm is the only hook available under BrowserRouter. In-app route
  // changes are not yet blocked — needs the data-router migration (filed).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data, error } = await supabase
          .from('lease_asc842_inputs')
          .select('*')
          .eq('lease_id', leaseId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[Asc842InputsTab] load error', error);
          // Render the retry state, NOT the editable form — saving over a
          // failed load would upsert NULLs over existing captured data.
          setLoadError(error.message);
          setLoading(false);
          return;
        }
        if (!data) {
          setState(EMPTY);
          setSavedSnapshot(fieldsOf(EMPTY));
          setLoading(false);
          return;
        }
        const r = data as any;
        let label: string | null = null;
        if (r.last_updated_by) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', r.last_updated_by)
            .maybeSingle();
          if (cancelled) return;
          label = (profile as any)?.full_name || (profile as any)?.email || null;
        }
        const loaded: State = {
          tenant_improvement_allowance: fromDb(r.tenant_improvement_allowance),
          tenant_improvement_allowance_basis: fromDbStr(r.tenant_improvement_allowance_basis),
          initial_direct_costs: fromDb(r.initial_direct_costs),
          initial_direct_costs_basis: fromDbStr(r.initial_direct_costs_basis),
          prepaid_rent: fromDb(r.prepaid_rent),
          prepaid_rent_basis: fromDbStr(r.prepaid_rent_basis),
          lease_incentives_received: fromDb(r.lease_incentives_received),
          lease_incentives_received_basis: fromDbStr(r.lease_incentives_received_basis),
          residual_value_guarantee: fromDb(r.residual_value_guarantee),
          residual_value_guarantee_basis: fromDbStr(r.residual_value_guarantee_basis),
          purchase_option_present: r.purchase_option_present,
          purchase_option_price: fromDb(r.purchase_option_price),
          purchase_option_reasonably_certain: r.purchase_option_reasonably_certain,
          purchase_option_basis: fromDbStr(r.purchase_option_basis),
          termination_penalty_amount: fromDb(r.termination_penalty_amount),
          termination_penalty_reasonably_certain: r.termination_penalty_reasonably_certain,
          termination_penalty_basis: fromDbStr(r.termination_penalty_basis),
          ownership_transfers_at_end: r.ownership_transfers_at_end,
          bargain_purchase_option: r.bargain_purchase_option,
          major_part_economic_life: r.major_part_economic_life,
          major_part_economic_life_pct: fromDb(r.major_part_economic_life_pct),
          pv_substantially_all_fair_value: r.pv_substantially_all_fair_value,
          pv_to_fair_value_pct: fromDb(r.pv_to_fair_value_pct),
          asset_fair_value: fromDb(r.asset_fair_value),
          specialized_asset_no_alt_use: r.specialized_asset_no_alt_use,
          classification_criteria_basis: fromDbStr(r.classification_criteria_basis),
          renewal_options_rc_term_months: fromDb(r.renewal_options_rc_term_months),
          renewal_options_rc_basis: fromDbStr(r.renewal_options_rc_basis),
          short_term_lease_election: r.short_term_lease_election,
          short_term_lease_election_basis: fromDbStr(r.short_term_lease_election_basis),
          variable_payments_description: fromDbStr(r.variable_payments_description),
          variable_payments_estimated_annual: fromDb(r.variable_payments_estimated_annual),
          sublease_income_annual: fromDb(r.sublease_income_annual),
          sublease_basis: fromDbStr(r.sublease_basis),
          has_row: true,
          last_updated_at: r.last_updated_at,
          last_updated_by_label: label,
        };
        setState(loaded);
        setSavedSnapshot(fieldsOf(loaded));
        setLoading(false);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[Asc842InputsTab] load threw', e);
        if (!cancelled) {
          setLoadError(e?.message ?? t('leases.errors.load_failed'));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, reloadNonce]);

  function update<K extends keyof State>(key: K, value: State[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  // ── Derived summary ────────────────────────────────────────────────
  const classificationTests: Array<boolean | null> = [
    state.ownership_transfers_at_end,
    state.bargain_purchase_option,
    state.major_part_economic_life,
    state.pv_substantially_all_fair_value,
    state.specialized_asset_no_alt_use,
  ];
  const testsMet = classificationTests.filter((v) => v === true).length;
  const testsAssessed = classificationTests.filter((v) => v !== null).length;
  const classification: 'finance' | 'operating' | 'partial' =
    testsMet > 0 ? 'finance' : testsAssessed === classificationTests.length ? 'operating' : 'partial';

  const renewalMonths = n(state.renewal_options_rc_term_months);
  const effectiveTermMonths =
    baseTermMonths != null ? baseTermMonths + (renewalMonths ?? 0) : null;

  const sectionCompletion = useMemo(() => {
    const nonEmpty = (v: string) => v.trim() !== '';
    const sections: boolean[] = [
      // 1. ROU adjustments
      [state.tenant_improvement_allowance, state.initial_direct_costs, state.prepaid_rent, state.lease_incentives_received].some(nonEmpty),
      // 2. Liability inputs
      [state.residual_value_guarantee, state.purchase_option_price, state.termination_penalty_amount].some(nonEmpty) ||
        state.purchase_option_present !== null || state.termination_penalty_reasonably_certain !== null,
      // 3. Classification
      testsAssessed > 0,
      // 4. Term assessment
      nonEmpty(state.renewal_options_rc_term_months) || state.short_term_lease_election !== null,
      // 5. Disclosure / variable payments
      [state.variable_payments_description, state.variable_payments_estimated_annual, state.sublease_income_annual].some(nonEmpty),
    ];
    return { done: sections.filter(Boolean).length, total: sections.length };
  }, [state, testsAssessed]);

  const isPreExecution = lifecycleStatus != null && PRE_EXECUTION_STATES.has(lifecycleStatus);
  const isFinalized = lifecycleStatus === 'active';

  // ── Report generation (the door this tab feeds) ────────────────────
  const handleGenerateReport = useCallback(async () => {
    if (dirty) {
      toast.message(t('leases.asc842.save_before_report'));
      return;
    }
    try {
      const result = await generateReport(leaseId);
      toast.success(t('leases.asc842.report_ready'));
      navigate(`/app/leases/${leaseId}/reports/${result.reportId}`);
    } catch (e: any) {
      toast.error(e?.message ?? t('leases.asc842.report_failed'));
    }
  }, [dirty, generateReport, leaseId, navigate, t]);

  async function handleSave() {
    setSaving(true);
    // Snapshot what this save actually persists (the click-time state the
    // payload below reads). Setting the saved-snapshot from post-save state
    // instead would absorb anything typed WHILE the upsert was in flight —
    // marking it "saved" without ever writing it (integrity review HIGH).
    const snapshotAtSave = fieldsOf(state);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t('leases.errors.not_authenticated'));

      const payload = {
        lease_id: leaseId,
        workspace_id: workspaceId,
        tenant_improvement_allowance: n(state.tenant_improvement_allowance),
        tenant_improvement_allowance_basis: s(state.tenant_improvement_allowance_basis),
        initial_direct_costs: n(state.initial_direct_costs),
        initial_direct_costs_basis: s(state.initial_direct_costs_basis),
        prepaid_rent: n(state.prepaid_rent),
        prepaid_rent_basis: s(state.prepaid_rent_basis),
        lease_incentives_received: n(state.lease_incentives_received),
        lease_incentives_received_basis: s(state.lease_incentives_received_basis),
        residual_value_guarantee: n(state.residual_value_guarantee),
        residual_value_guarantee_basis: s(state.residual_value_guarantee_basis),
        purchase_option_present: state.purchase_option_present,
        purchase_option_price: n(state.purchase_option_price),
        purchase_option_reasonably_certain: state.purchase_option_reasonably_certain,
        purchase_option_basis: s(state.purchase_option_basis),
        termination_penalty_amount: n(state.termination_penalty_amount),
        termination_penalty_reasonably_certain: state.termination_penalty_reasonably_certain,
        termination_penalty_basis: s(state.termination_penalty_basis),
        ownership_transfers_at_end: state.ownership_transfers_at_end,
        bargain_purchase_option: state.bargain_purchase_option,
        major_part_economic_life: state.major_part_economic_life,
        major_part_economic_life_pct: n(state.major_part_economic_life_pct),
        pv_substantially_all_fair_value: state.pv_substantially_all_fair_value,
        pv_to_fair_value_pct: n(state.pv_to_fair_value_pct),
        asset_fair_value: n(state.asset_fair_value),
        specialized_asset_no_alt_use: state.specialized_asset_no_alt_use,
        classification_criteria_basis: s(state.classification_criteria_basis),
        renewal_options_rc_term_months: n(state.renewal_options_rc_term_months),
        renewal_options_rc_basis: s(state.renewal_options_rc_basis),
        short_term_lease_election: state.short_term_lease_election,
        short_term_lease_election_basis: s(state.short_term_lease_election_basis),
        variable_payments_description: s(state.variable_payments_description),
        variable_payments_estimated_annual: n(state.variable_payments_estimated_annual),
        sublease_income_annual: n(state.sublease_income_annual),
        sublease_basis: s(state.sublease_basis),
        last_updated_by: user.id,
      };

      const { error } = await supabase
        .from('lease_asc842_inputs')
        .upsert(payload, { onConflict: 'lease_id' });
      if (error) throw new Error(error.message);

      const { error: logError } = await supabase
        .from('lease_activity_log')
        .insert({
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'asc842_inputs_updated',
          details: { saved_at: new Date().toISOString() },
        });
      if (logError) {
        // eslint-disable-next-line no-console
        console.warn('[Asc842InputsTab] activity log insert failed', logError);
      }

      toast.success(t('leases.asc842.saved'));
      // Plain statement, from the click-time snapshot: edits made during the
      // round-trip stay dirty (Save re-enables) instead of being absorbed.
      setSavedSnapshot(snapshotAtSave);
      setState((prev) => ({
        ...prev,
        has_row: true,
        last_updated_at: new Date().toISOString(),
        last_updated_by_label: user.email ?? null,
      }));
    } catch (e: any) {
      toast.error(e?.message ?? t('leases.errors.save_failed'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="pt-6 flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t('leases.asc842.load_error')}
          </div>
          <p className="text-xs text-muted-foreground">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => setReloadNonce((v) => v + 1)}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('common.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ─── Summary strip — the computed layer ─── */}
      <Card className="border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">{t('leases.asc842.title')}</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            {t('leases.asc842.intro')}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('leases.asc842.summary_classification')}</p>
              <Badge
                variant={classification === 'partial' ? 'outline' : 'default'}
                className={cn(
                  'mt-1',
                  classification === 'finance' && 'bg-blue-700 hover:bg-blue-700',
                  classification === 'operating' && 'bg-emerald-700 hover:bg-emerald-700',
                )}
              >
                {classification === 'finance'
                  ? t('leases.asc842.class_finance')
                  : classification === 'operating'
                    ? t('leases.asc842.class_operating')
                    : t('leases.asc842.class_partial')}
              </Badge>
              <p className="text-[10px] text-muted-foreground mt-1">
                {classification === 'finance'
                  ? t('leases.asc842.class_finance_reason', { count: testsMet })
                  : classification === 'operating'
                    ? t('leases.asc842.class_operating_reason')
                    : t('leases.asc842.class_partial_reason', { assessed: testsAssessed })}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('leases.asc842.summary_discount_rate')}</p>
              <p className="text-sm font-semibold mt-1 tabular-nums">
                {discountRate != null ? `${discountRate}%` : t('leases.asc842.summary_not_set')}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{t('leases.asc842.summary_discount_hint')}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('leases.asc842.summary_effective_term')}</p>
              <p className="text-sm font-semibold mt-1 tabular-nums">
                {effectiveTermMonths != null
                  ? t('leases.asc842.summary_term_months', { months: effectiveTermMonths })
                  : t('leases.asc842.summary_not_set')}
              </p>
              {renewalMonths != null && renewalMonths > 0 && baseTermMonths != null && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {t('leases.asc842.summary_term_breakdown', { base: baseTermMonths, renewal: renewalMonths })}
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('leases.asc842.summary_completion')}</p>
              <p className="text-sm font-semibold mt-1 tabular-nums">
                {t('leases.asc842.sections_captured', { done: sectionCompletion.done, total: sectionCompletion.total })}
              </p>
            </div>
          </div>
          {isPreExecution && (
            <p className="text-xs text-muted-foreground mt-3">{t('leases.asc842.pre_execution_hint')}</p>
          )}
          {isFinalized && canEdit && (
            <p className="text-xs text-muted-foreground mt-3">{t('leases.asc842.editable_after_lock_note')}</p>
          )}
          {!canEdit && (
            <p className="text-xs text-muted-foreground mt-3">{t('leases.asc842.readonly_note')}</p>
          )}
        </CardContent>
      </Card>

      {/* ─── 1. Right-of-Use Asset Adjustments ─── */}
      <AscSectionCard
        icon={Building2}
        title={t('leases.asc842.rou_title')}
        description={t('leases.asc842.rou_desc')}
      >
        <NumberWithBasis
          label={t('leases.asc842.tia_label')}
          help={t('leases.asc842.tia_help')}
          valueKey="tenant_improvement_allowance"
          basisKey="tenant_improvement_allowance_basis"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <NumberWithBasis
          label={t('leases.asc842.idc_label')}
          help={t('leases.asc842.idc_help')}
          valueKey="initial_direct_costs"
          basisKey="initial_direct_costs_basis"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <NumberWithBasis
          label={t('leases.asc842.prepaid_label')}
          help={t('leases.asc842.prepaid_help')}
          valueKey="prepaid_rent"
          basisKey="prepaid_rent_basis"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <NumberWithBasis
          label={t('leases.asc842.incentives_label')}
          help={t('leases.asc842.incentives_help')}
          valueKey="lease_incentives_received"
          basisKey="lease_incentives_received_basis"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
      </AscSectionCard>

      {/* ─── 2. Lease Liability Inputs ─── */}
      <AscSectionCard
        icon={Scale}
        title={t('leases.asc842.liability_title')}
        description={t('leases.asc842.liability_desc')}
      >
        <NumberWithBasis
          label={t('leases.asc842.rvg_label')}
          help={t('leases.asc842.rvg_help')}
          valueKey="residual_value_guarantee"
          basisKey="residual_value_guarantee_basis"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />

        <Separator />

        <TriStateField
          label={t('leases.asc842.po_present_label')}
          stateKey="purchase_option_present"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        {state.purchase_option_present === true && (
          <div className="pl-4 border-l-2 border-muted space-y-4">
            <NumberField
              label={t('leases.asc842.po_price_label')}
              stateKey="purchase_option_price"
              state={state}
              update={update}
              canEdit={canEdit}
              unit="$"
            />
            <TriStateField
              label={t('leases.asc842.po_rc_label')}
              help={t('leases.asc842.po_rc_help')}
              stateKey="purchase_option_reasonably_certain"
              state={state}
              update={update}
              canEdit={canEdit}
            />
            <TextareaField
              label={t('leases.asc842.po_basis_label')}
              stateKey="purchase_option_basis"
              state={state}
              update={update}
              canEdit={canEdit}
            />
          </div>
        )}

        <Separator />

        <NumberField
          label={t('leases.asc842.term_penalty_label')}
          stateKey="termination_penalty_amount"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <TriStateField
          label={t('leases.asc842.term_penalty_rc_label')}
          help={t('leases.asc842.term_penalty_rc_help')}
          stateKey="termination_penalty_reasonably_certain"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <TextareaField
          label={t('leases.asc842.term_penalty_basis_label')}
          stateKey="termination_penalty_basis"
          state={state}
          update={update}
          canEdit={canEdit}
        />
      </AscSectionCard>

      {/* ─── 3. Classification Criteria ─── */}
      <AscSectionCard
        icon={SlidersHorizontal}
        title={t('leases.asc842.class_title')}
        description={t('leases.asc842.class_desc')}
      >
        <TriStateField
          label={t('leases.asc842.class_1')}
          stateKey="ownership_transfers_at_end"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <TriStateField
          label={t('leases.asc842.class_2')}
          stateKey="bargain_purchase_option"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <div className="space-y-2">
          <TriStateField
            label={t('leases.asc842.class_3')}
            stateKey="major_part_economic_life"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <div className="pl-4 border-l-2 border-muted">
            <NumberField
              label={t('leases.asc842.class_3_pct')}
              stateKey="major_part_economic_life_pct"
              state={state}
              update={update}
              canEdit={canEdit}
              unit="%"
            />
          </div>
        </div>
        <div className="space-y-2">
          <TriStateField
            label={t('leases.asc842.class_4')}
            stateKey="pv_substantially_all_fair_value"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <div className="pl-4 border-l-2 border-muted space-y-2">
            <NumberField
              label={t('leases.asc842.class_4_pct')}
              stateKey="pv_to_fair_value_pct"
              state={state}
              update={update}
              canEdit={canEdit}
              unit="%"
            />
            <NumberField
              label={t('leases.asc842.class_4_fv')}
              stateKey="asset_fair_value"
              state={state}
              update={update}
              canEdit={canEdit}
              unit="$"
            />
          </div>
        </div>
        <TriStateField
          label={t('leases.asc842.class_5')}
          stateKey="specialized_asset_no_alt_use"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <TextareaField
          label={t('leases.asc842.class_basis_label')}
          help={t('leases.asc842.class_basis_help')}
          stateKey="classification_criteria_basis"
          state={state}
          update={update}
          canEdit={canEdit}
        />
      </AscSectionCard>

      {/* ─── 4. Term Assessment ─── */}
      <AscSectionCard
        icon={Timer}
        title={t('leases.asc842.term_title')}
        description={t('leases.asc842.term_desc')}
      >
        <NumberField
          label={t('leases.asc842.renewal_months_label')}
          help={t('leases.asc842.renewal_months_help')}
          stateKey="renewal_options_rc_term_months"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <TextareaField
          label={t('leases.asc842.renewal_basis_label')}
          stateKey="renewal_options_rc_basis"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <Separator />
        <TriStateField
          label={t('leases.asc842.st_election_label')}
          help={t('leases.asc842.st_election_help')}
          stateKey="short_term_lease_election"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        {state.short_term_lease_election === true && (
          <div className="pl-4 border-l-2 border-muted">
            <TextareaField
              label={t('leases.asc842.st_election_basis_label')}
              stateKey="short_term_lease_election_basis"
              state={state}
              update={update}
              canEdit={canEdit}
            />
          </div>
        )}
      </AscSectionCard>

      {/* ─── 5. Disclosure / Variable Payments ─── */}
      <AscSectionCard
        icon={FileText}
        title={t('leases.asc842.disc_title')}
        description={t('leases.asc842.disc_desc')}
      >
        <TextareaField
          label={t('leases.asc842.var_desc_label')}
          help={t('leases.asc842.var_desc_help')}
          stateKey="variable_payments_description"
          state={state}
          update={update}
          canEdit={canEdit}
        />
        <NumberField
          label={t('leases.asc842.var_annual_label')}
          stateKey="variable_payments_estimated_annual"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <Separator />
        <NumberField
          label={t('leases.asc842.sublease_income_label')}
          help={t('leases.asc842.sublease_income_help')}
          stateKey="sublease_income_annual"
          state={state}
          update={update}
          canEdit={canEdit}
          unit="$"
        />
        <TextareaField
          label={t('leases.asc842.sublease_basis_label')}
          stateKey="sublease_basis"
          state={state}
          update={update}
          canEdit={canEdit}
        />
      </AscSectionCard>

      {/* Discount rate lives INSIDE the sticky bar's containing block so the
          bar still guards the tab's most important input. */}
      {discountRateSlot}

      {/* ─── Sticky save bar — always reachable, dirty-aware ─── */}
      <div className="sticky bottom-0 z-10 -mx-1 px-1">
        <div className="rounded-lg border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 pl-4 pr-20 py-3 flex flex-wrap items-center justify-between gap-3 shadow-sm">
          <div className="text-xs text-muted-foreground min-w-0">
            {dirty ? (
              <span className="text-amber-700 font-medium">{t('leases.asc842.unsaved_changes')}</span>
            ) : state.last_updated_at ? (
              state.last_updated_by_label
                ? t('leases.asc842.last_updated_by', {
                    date: formatLocalizedDate(state.last_updated_at, language, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
                    name: state.last_updated_by_label,
                  })
                : t('leases.asc842.last_updated', {
                    date: formatLocalizedDate(state.last_updated_at, language, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
                  })
            ) : (
              t('leases.asc842.never_saved')
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* The report fn only accepts finalized (model-locked) leases —
                pre-finalize the door shows disabled with an honest hint
                instead of 4xx-ing with a raw server string. */}
            {canEdit ? (
              <Button
                variant="outline"
                onClick={handleGenerateReport}
                disabled={generatingReport || !reportAvailable}
                title={
                  !reportAvailable
                    ? t('leases.asc842.report_after_finalize')
                    : dirty
                      ? t('leases.asc842.save_before_report')
                      : undefined
                }
              >
                {generatingReport ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                {generatingReport ? t('leases.asc842.generating_report') : t('leases.asc842.generate_report')}
              </Button>
            ) : reportAvailable ? (
              <p className="text-xs text-muted-foreground">{t('leases.asc842.report_viewer_hint')}</p>
            ) : null}
            {canEdit && (
              <Button onClick={handleSave} disabled={saving || !dirty}>
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {saving ? t('leases.asc842.saving') : t('leases.asc842.save_button')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section shell — matches the SectionCard treatment the other tabs use ──

function AscSectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="pb-3 bg-muted/30 border-b">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Icon size={14} className="text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">{children}</CardContent>
    </Card>
  );
}

// ─── Field helpers ───────────────────────────────────────────────────

interface FieldCommonProps {
  state: State;
  update: <K extends keyof State>(key: K, value: State[K]) => void;
  canEdit: boolean;
  label: string;
  help?: string;
}

function NumberField({
  state,
  update,
  canEdit,
  label,
  help,
  stateKey,
  unit,
}: FieldCommonProps & {
  stateKey: keyof State;
  /** "$" renders an in-input prefix (drawer convention); "%" an in-input suffix. */
  unit?: '$' | '%';
}) {
  const value = String(state[stateKey] ?? '');
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="relative max-w-xs">
        {unit === '$' && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
        )}
        <Input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => update(stateKey, e.target.value as any)}
          disabled={!canEdit}
          className={cn('tabular-nums', unit === '$' && 'pl-7', unit === '%' && 'pr-8')}
        />
        {unit === '%' && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">%</span>
        )}
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function TextareaField({
  state,
  update,
  canEdit,
  label,
  help,
  stateKey,
}: FieldCommonProps & {
  stateKey: keyof State;
}) {
  const value = String(state[stateKey] ?? '');
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Textarea
        rows={2}
        value={value}
        onChange={(e) => update(stateKey, e.target.value as any)}
        disabled={!canEdit}
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

// Three explicit states, three explicit buttons. The previous checkbox
// could not display (or in practice record) "No" — the most common answer
// on the classification tests — so the control now shows all three.
function TriStateField({
  state,
  update,
  canEdit,
  label,
  help,
  stateKey,
}: FieldCommonProps & {
  stateKey: keyof State;
}) {
  const { t } = useAppTranslation();
  const value = state[stateKey] as boolean | null;
  const options: Array<{ v: boolean | null; label: string }> = [
    { v: true, label: t('common.yes') },
    { v: false, label: t('common.no') },
    { v: null, label: t('leases.asc842.not_assessed') },
  ];
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="inline-flex rounded-md border overflow-hidden" role="group" aria-label={label}>
        {options.map((opt, i) => {
          const selected = value === opt.v;
          return (
            <button
              key={String(opt.v)}
              type="button"
              disabled={!canEdit}
              aria-pressed={selected}
              onClick={() => update(stateKey, opt.v as any)}
              className={cn(
                'px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                i > 0 && 'border-l',
                selected
                  ? opt.v === true
                    ? 'bg-blue-700 text-white'
                    : opt.v === false
                      ? 'bg-foreground text-background'
                      : 'bg-muted text-foreground'
                  : 'bg-background text-muted-foreground hover:bg-muted/50',
                !canEdit && 'opacity-60 cursor-not-allowed',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function NumberWithBasis({
  state,
  update,
  canEdit,
  label,
  help,
  valueKey,
  basisKey,
  unit,
}: FieldCommonProps & {
  valueKey: keyof State;
  basisKey: keyof State;
  unit?: '$' | '%';
}) {
  const { t } = useAppTranslation();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <div className="relative">
          {unit === '$' && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
          )}
          <Input
            type="number"
            step="0.01"
            value={String(state[valueKey] ?? '')}
            onChange={(e) => update(valueKey, e.target.value as any)}
            disabled={!canEdit}
            className={cn('tabular-nums', unit === '$' && 'pl-7')}
          />
        </div>
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="sm:col-span-2 space-y-1">
        <Label className="text-xs">{t('leases.asc842.basis_label')}</Label>
        <Textarea
          rows={2}
          value={String(state[basisKey] ?? '')}
          onChange={(e) => update(basisKey, e.target.value as any)}
          disabled={!canEdit}
          placeholder={t('leases.asc842.basis_placeholder')}
        />
      </div>
    </div>
  );
}
