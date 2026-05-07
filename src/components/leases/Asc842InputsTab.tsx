// ASC 842 Inputs tab — full per-lease capture for measurement,
// classification, term assessment, and disclosure.
//
// Mounted in LeaseReview between Risks and Documents. The fields here
// are NOT extracted by the AI pipeline; they require human capture per
// lease for the disclosure report to be useful (vs. a vanity artifact).
//
// Five sections matching the canonical ASC 842 measurement model:
//   1. Right-of-Use Asset Adjustments (TI, IDC, prepaid rent, incentives)
//   2. Lease Liability Inputs (RVG, purchase option, termination penalty)
//   3. Classification Criteria (the 5 ASC 842-10-25-2 finance-lease tests)
//   4. Term Assessment (renewal options reasonably certain, short-term election)
//   5. Disclosure / Variable Payments (variable rent, sublease income)
//
// Audit trail: every save writes asc842_inputs_updated to lease_activity_log
// with the field-level diff. NULL on a numeric field = "not yet captured"
// (distinct from 0/false which means "captured as zero/false").

import { useEffect, useState } from 'react';
import { Loader2, Save, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';

interface Props {
  leaseId: string;
  workspaceId: string;
  canEdit: boolean;
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

export function Asc842InputsTab({ leaseId, workspaceId, canEdit }: Props) {
  const [state, setState] = useState<State>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
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
          toast.error(error.message);
          setLoading(false);
          return;
        }
        if (!data) {
          setState(EMPTY);
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
        setState({
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
        });
        setLoading(false);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[Asc842InputsTab] load threw', e);
        toast.error(e?.message ?? 'Load failed');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId]);

  function update<K extends keyof State>(key: K, value: State[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

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

      toast.success('ASC 842 inputs saved');
      setState((prev) => ({
        ...prev,
        has_row: true,
        last_updated_at: new Date().toISOString(),
        last_updated_by_label: user.email ?? null,
      }));
    } catch (e: any) {
      toast.error(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground p-4">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Info className="h-4 w-4 text-blue-700" />
                ASC 842 Per-Lease Inputs
              </CardTitle>
              <CardDescription className="mt-1">
                These values are NOT extracted by the AI pipeline. Capture
                them per lease so the disclosure report is auditable. NULL
                = not yet captured (different from zero, which means
                "captured as zero").
              </CardDescription>
            </div>
            {state.has_row ? (
              <Badge variant="default">Captured</Badge>
            ) : (
              <Badge variant="outline">Not captured</Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* ─── 1. Right-of-Use Asset Adjustments ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Right-of-Use Asset Adjustments</CardTitle>
          <CardDescription>
            ROU asset = lease liability + prepaid rent + initial direct costs
            − lease incentives − tenant improvement allowance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberWithBasis
            label="Tenant improvement allowance"
            help="Lessor cash to fit out the space. Reduces ROU asset (ASC 842-20-25-1)."
            valueKey="tenant_improvement_allowance"
            basisKey="tenant_improvement_allowance_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <NumberWithBasis
            label="Initial direct costs (IDC)"
            help="Costs incremental to obtaining the lease (commissions, legal). Increases ROU (ASC 842-20-30-5)."
            valueKey="initial_direct_costs"
            basisKey="initial_direct_costs_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <NumberWithBasis
            label="Prepaid rent (at or before commencement)"
            help="Rent paid before commencement. Added to the ROU asset."
            valueKey="prepaid_rent"
            basisKey="prepaid_rent_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <NumberWithBasis
            label="Lease incentives received"
            help="Other incentives from lessor (free-rent periods, moving allowances). Reduces ROU."
            valueKey="lease_incentives_received"
            basisKey="lease_incentives_received_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {/* ─── 2. Lease Liability Inputs ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Lease Liability Inputs</CardTitle>
          <CardDescription>
            Components included in the lease liability beyond the rent
            schedule.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberWithBasis
            label="Residual value guarantee (RVG)"
            help="Maximum amount lessee may have to pay at end of lease. Included in lease liability for finance leases (and operating if RC of being paid)."
            valueKey="residual_value_guarantee"
            basisKey="residual_value_guarantee_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />

          <Separator />

          <BooleanField
            label="Purchase option present?"
            stateKey="purchase_option_present"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          {state.purchase_option_present === true && (
            <>
              <NumberField
                label="Purchase option price"
                stateKey="purchase_option_price"
                state={state}
                update={update}
                canEdit={canEdit}
              />
              <BooleanField
                label="Reasonably certain to exercise?"
                help="If true, the option price is added to the lease liability (ASC 842-10-30-5)."
                stateKey="purchase_option_reasonably_certain"
                state={state}
                update={update}
                canEdit={canEdit}
              />
              <TextareaField
                label="Basis (why or why not RC)"
                stateKey="purchase_option_basis"
                state={state}
                update={update}
                canEdit={canEdit}
              />
            </>
          )}

          <Separator />

          <NumberField
            label="Termination penalty (if early termination)"
            stateKey="termination_penalty_amount"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <BooleanField
            label="Reasonably certain lessee will terminate early?"
            help="If true, the penalty is included in the lease liability."
            stateKey="termination_penalty_reasonably_certain"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <TextareaField
            label="Termination basis"
            stateKey="termination_penalty_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {/* ─── 3. Classification Criteria ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            Classification Criteria — ASC 842-10-25-2
          </CardTitle>
          <CardDescription>
            Any ONE of these tests met → finance lease classification.
            Otherwise operating.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <BooleanField
            label="1. Ownership transfers to lessee at end of term"
            stateKey="ownership_transfers_at_end"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <BooleanField
            label="2. Bargain purchase option lessee is RC to exercise"
            stateKey="bargain_purchase_option"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <div className="space-y-2">
            <BooleanField
              label="3. Lease term is for the major part of remaining economic life (≥75%)"
              stateKey="major_part_economic_life"
              state={state}
              update={update}
              canEdit={canEdit}
            />
            <NumberField
              label="    % of remaining economic life"
              stateKey="major_part_economic_life_pct"
              state={state}
              update={update}
              canEdit={canEdit}
              suffix="%"
            />
          </div>
          <div className="space-y-2">
            <BooleanField
              label="4. PV of payments ≥ substantially all of fair value (≥90%)"
              stateKey="pv_substantially_all_fair_value"
              state={state}
              update={update}
              canEdit={canEdit}
            />
            <NumberField
              label="    PV / fair value %"
              stateKey="pv_to_fair_value_pct"
              state={state}
              update={update}
              canEdit={canEdit}
              suffix="%"
            />
            <NumberField
              label="    Asset fair value at commencement"
              stateKey="asset_fair_value"
              state={state}
              update={update}
              canEdit={canEdit}
            />
          </div>
          <BooleanField
            label="5. Specialized asset with no alternative use to lessor"
            stateKey="specialized_asset_no_alt_use"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <TextareaField
            label="Overall classification basis"
            help="Document the determination so an auditor can follow the reasoning."
            stateKey="classification_criteria_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {/* ─── 4. Term Assessment ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Term Assessment</CardTitle>
          <CardDescription>
            Renewal options "reasonably certain" to be exercised extend
            the lease term used in PV. Short-term leases (≤12 months,
            no purchase option RC) can be excluded from recognition.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberField
            label="Reasonably-certain renewal term to add (months)"
            help="If you've assessed renewal options as RC, enter the additional months they add to the lease term."
            stateKey="renewal_options_rc_term_months"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <TextareaField
            label="Basis for reasonably-certain assessment (≥10 chars if extending)"
            stateKey="renewal_options_rc_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <Separator />
          <BooleanField
            label="Short-term lease election (ASC 842-20-25-2)"
            help="Election made at lease inception to not recognize ROU/liability for a 12-month-or-less lease with no RC purchase option."
            stateKey="short_term_lease_election"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          {state.short_term_lease_election === true && (
            <TextareaField
              label="Election basis"
              stateKey="short_term_lease_election_basis"
              state={state}
              update={update}
              canEdit={canEdit}
            />
          )}
        </CardContent>
      </Card>

      {/* ─── 5. Disclosure / Variable Payments ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Disclosure / Variable Payments</CardTitle>
          <CardDescription>
            Variable payments not based on an index/rate are excluded
            from the lease liability but disclosed under ASC 842-20-50.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TextareaField
            label="Variable payments description"
            help="e.g., percentage rent, usage-based, CPI adjustments after commencement."
            stateKey="variable_payments_description"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <NumberField
            label="Estimated annual variable payments"
            stateKey="variable_payments_estimated_annual"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <Separator />
          <NumberField
            label="Sublease income (annual)"
            help="If the lessee has subleased the asset, enter sublease income for disclosure."
            stateKey="sublease_income_annual"
            state={state}
            update={update}
            canEdit={canEdit}
          />
          <TextareaField
            label="Sublease basis"
            stateKey="sublease_basis"
            state={state}
            update={update}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {/* Save */}
      <Card>
        <CardContent className="pt-6 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {state.last_updated_at
              ? `Last updated ${new Date(state.last_updated_at).toLocaleString()}${state.last_updated_by_label ? ` by ${state.last_updated_by_label}` : ''}`
              : 'Never saved.'}
          </div>
          <Button onClick={handleSave} disabled={!canEdit || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {saving ? 'Saving…' : 'Save ASC 842 Inputs'}
          </Button>
        </CardContent>
      </Card>
      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          Read-only — only workspace admins, editors, or the owner can
          edit ASC 842 inputs.
        </p>
      )}
    </div>
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
  suffix,
}: FieldCommonProps & {
  stateKey: keyof State;
  suffix?: string;
}) {
  const value = String(state[stateKey] ?? '');
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => update(stateKey, e.target.value as any)}
          disabled={!canEdit}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
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

function BooleanField({
  state,
  update,
  canEdit,
  label,
  help,
  stateKey,
}: FieldCommonProps & {
  stateKey: keyof State;
}) {
  const value = state[stateKey] as boolean | null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Checkbox
          checked={value === true}
          disabled={!canEdit}
          onCheckedChange={(checked) =>
            update(stateKey, (checked === true ? true : value === true ? null : false) as any)
          }
        />
        <Label className="text-xs cursor-pointer" onClick={() => {
          if (!canEdit) return;
          // Tri-state cycle: null → true → false → null
          const next = value === null ? true : value === true ? false : null;
          update(stateKey, next as any);
        }}>
          {label}
        </Label>
        <Badge variant="outline" className="text-xs">
          {value === true ? 'Yes' : value === false ? 'No' : 'Not assessed'}
        </Badge>
      </div>
      {help && <p className="text-xs text-muted-foreground ml-7">{help}</p>}
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
}: FieldCommonProps & {
  valueKey: keyof State;
  basisKey: keyof State;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <Input
          type="number"
          step="0.01"
          value={String(state[valueKey] ?? '')}
          onChange={(e) => update(valueKey, e.target.value as any)}
          disabled={!canEdit}
        />
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="md:col-span-2 space-y-1">
        <Label className="text-xs">Basis</Label>
        <Textarea
          rows={2}
          value={String(state[basisKey] ?? '')}
          onChange={(e) => update(basisKey, e.target.value as any)}
          disabled={!canEdit}
          placeholder="Document the source/methodology for audit trail"
        />
      </div>
    </div>
  );
}
