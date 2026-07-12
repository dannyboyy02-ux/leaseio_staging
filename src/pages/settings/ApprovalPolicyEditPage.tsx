import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  Save,
  ArrowLeft,
  ChevronDown,
  FlaskConical,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { validatePolicy } from './approvalPolicyValidation';
import { ApprovalPolicyTestDialog } from '@/components/settings/ApprovalPolicyTestDialog';
import { MatchCriteriaSentence } from './MatchCriteriaSentence';
import { ChainDiagram, seedSingleEmptyStep, type ChainStep } from './ChainDiagram';
import { buildAssetTypeOptions } from '@/lib/assetTypes';

// ───────────────────────────────────────────────────────────────────────────
// Constants — FUNCTIONAL_ROLE_OPTIONS now lives in ChainDiagram (its only
// consumer post-P1.3). Asset-type options are built here via
// buildAssetTypeOptions(workspace asset_type_config) and passed down to both
// MatchCriteriaSentence and ApprovalPolicyTestDialog (single source in
// src/lib/assetTypes.ts, canonicalized by canonicalAssetType). LEASE_TYPE_OPTIONS
// still lives in each of those consumers.
// ───────────────────────────────────────────────────────────────────────────

type SodMode = 'inherit' | 'allow' | 'require';

interface PolicyForm {
  name: string;
  description: string;
  priority: number;
  is_active: boolean;
  is_default_fallback: boolean;
  match_asset_types: string[];
  match_lease_types: string[];
  match_departments: string[];
  match_regions: string[];
  match_min_annual_cost: string;
  match_max_annual_cost: string;
  sod_mode: SodMode;
  /** #111 C6 — per-policy SLA in days. Empty string = use the default (7). */
  sla_days: string;
}

const emptyForm = (): PolicyForm => ({
  name: '',
  description: '',
  priority: 100,
  is_active: true,
  is_default_fallback: false,
  match_asset_types: [],
  match_lease_types: [],
  match_departments: [],
  match_regions: [],
  match_min_annual_cost: '',
  match_max_annual_cost: '',
  sod_mode: 'inherit',
  sla_days: '',
});

const newUiId = () => `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export default function ApprovalPolicyEditPage() {
  const { workspace } = useApp();
  const { t } = useAppTranslation();
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !routeId || routeId === 'new';

  const [form, setForm] = useState<PolicyForm>(emptyForm());
  // For a brand-new rule, seed one empty approver slot per stage so the
  // diagram has visible scaffolding (the dashed "Choose an approver…" CTA)
  // instead of a blank "Add the first approver" row. Per visual contract §4.
  const [conceptSteps, setConceptSteps] = useState<ChainStep[]>(() =>
    isNew ? seedSingleEmptyStep() : [],
  );
  const [signatorSteps, setSignatorSteps] = useState<ChainStep[]>(() =>
    isNew ? seedSingleEmptyStep() : [],
  );
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Workspace-curated suggestion lists for departments/regions, plus the
  // workspace's separation-of-duties default so we can label the Inherit option.
  const wsExtras = useQuery({
    queryKey: ['ws-extras-for-policy-editor', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from('workspaces')
        .select('separation_of_duties_default, department_options, region_options, asset_type_config')
        .eq('id', workspace!.id)
        .maybeSingle();
      return {
        sodDefault: Boolean((data as any)?.separation_of_duties_default ?? true),
        departments: ((data as any)?.department_options ?? []) as string[],
        regions: ((data as any)?.region_options ?? []) as string[],
        assetTypes: ((data as any)?.asset_type_config ?? []) as string[],
      };
    },
  });

  const members = useQuery({
    queryKey: ['ws-members-for-policy-editor', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspace!.id);
      const userIds = (rows ?? []).map((r: any) => r.user_id);
      if (userIds.length === 0) return [] as Array<{ id: string; label: string }>;
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', userIds);
      return (profiles ?? []).map((p: any) => ({
        id: p.id,
        label: p.first_name && p.last_name ? `${p.first_name} ${p.last_name} (${p.email})` : p.email,
      }));
    },
  });

  // Asset-type options for the rule builder + sample-request tester: the four
  // built-ins plus any workspace-configured Asset Type (Lease Configuration).
  // Falls back to built-ins until the workspace row loads.
  const assetTypeOptions = buildAssetTypeOptions(wsExtras.data?.assetTypes);

  // Load existing policy (and steps) for edit mode.
  useEffect(() => {
    if (isNew || !routeId || !workspace?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: p, error: pErr } = await supabase
          .from('approval_policies')
          .select('*')
          .eq('id', routeId)
          .eq('workspace_id', workspace.id)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!p) {
          toast.error(t('policy_editor.toast_not_found'));
          navigate('/app/settings/approval-policies', { replace: true });
          return;
        }

        const { data: stepsData, error: sErr } = await supabase
          .from('approval_chain_steps')
          .select('stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required')
          .eq('policy_id', routeId)
          .order('step_order');
        if (sErr) throw sErr;

        if (cancelled) return;
        const sodMode: SodMode =
          (p as any).separation_of_duties_override === null
            ? 'inherit'
            : (p as any).separation_of_duties_override
            ? 'require'
            : 'allow';
        setForm({
          name: (p as any).name,
          description: (p as any).description ?? '',
          priority: (p as any).priority,
          is_active: (p as any).is_active,
          is_default_fallback: (p as any).is_default_fallback,
          match_asset_types: (p as any).match_asset_types ?? [],
          match_lease_types: (p as any).match_lease_types ?? [],
          match_departments: (p as any).match_departments ?? [],
          match_regions: (p as any).match_regions ?? [],
          match_min_annual_cost:
            (p as any).match_min_annual_cost == null ? '' : String((p as any).match_min_annual_cost),
          match_max_annual_cost:
            (p as any).match_max_annual_cost == null ? '' : String((p as any).match_max_annual_cost),
          sod_mode: sodMode,
          sla_days: (p as any).sla_days == null ? '' : String((p as any).sla_days),
        });
        const concept: ChainStep[] = [];
        const signator: ChainStep[] = [];
        for (const s of stepsData ?? []) {
          const step: ChainStep = {
            uiId: newUiId(),
            step_order: (s as any).step_order,
            parallel_group: (s as any).parallel_group ?? 1,
            approver_user_id: (s as any).approver_user_id ?? null,
            approver_role: (s as any).approver_role ?? null,
            delegate_user_id: (s as any).delegate_user_id ?? null,
            delegate_after_days: (s as any).delegate_after_days ?? null,
            is_required: (s as any).is_required ?? true,
          };
          if ((s as any).stage === 'signator') signator.push(step);
          else concept.push(step);
        }
        setConceptSteps(concept);
        setSignatorSteps(signator);
      } catch (err: any) {
        toast.error(err?.message ?? t('policy_editor.toast_load_failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isNew, routeId, workspace?.id, navigate]);

  const save = async () => {
    if (!workspace?.id) return;
    const err = validatePolicy(form, conceptSteps, signatorSteps, {
      workspaceSodDefault: wsExtras.data?.sodDefault ?? true,
    });
    if (err) {
      toast.error(err);
      return;
    }
    if (form.sla_days.trim() !== '') {
      const slaNum = Number(form.sla_days);
      if (!Number.isInteger(slaNum) || slaNum <= 0) {
        toast.error(t('policy_editor.toast_sla_invalid'));
        return;
      }
    }
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error(t('policy_editor.toast_not_signed_in'));

      const sodOverride: boolean | null =
        form.sod_mode === 'inherit' ? null : form.sod_mode === 'require' ? true : false;

      const payload = {
        workspace_id: workspace.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        is_active: form.is_active,
        is_default_fallback: form.is_default_fallback,
        match_asset_types: form.match_asset_types,
        match_lease_types: form.match_lease_types,
        match_departments: form.match_departments,
        match_regions: form.match_regions,
        match_min_annual_cost:
          form.match_min_annual_cost.trim() === '' ? null : parseFloat(form.match_min_annual_cost),
        match_max_annual_cost:
          form.match_max_annual_cost.trim() === '' ? null : parseFloat(form.match_max_annual_cost),
        separation_of_duties_override: sodOverride,
        // #111 C6 — per-policy SLA. Empty → null (logic falls back to 7).
        sla_days: form.sla_days.trim() === '' ? null : parseInt(form.sla_days, 10),
        updated_by: userId,
      } as any;

      let policyId = routeId && !isNew ? routeId : null;

      if (isNew) {
        const { data: inserted, error: insertErr } = await supabase
          .from('approval_policies')
          .insert({ ...payload, created_by: userId } as any)
          .select('id')
          .single();
        if (insertErr) throw insertErr;
        policyId = (inserted as any).id;
      } else {
        const { error: updateErr } = await supabase
          .from('approval_policies')
          .update(payload)
          .eq('id', policyId!);
        if (updateErr) throw updateErr;
      }

      const stepsPayload = [
        ...conceptSteps.map((s) => ({ ...stripUiId(s), stage: 'concept' })),
        ...signatorSteps.map((s) => ({ ...stripUiId(s), stage: 'signator' })),
      ];

      const { error: rpcErr } = await supabase.rpc('apply_policy_steps', {
        p_policy_id: policyId!,
        p_steps: stepsPayload as any,
      });
      if (rpcErr) throw rpcErr;

      toast.success(isNew ? t('policy_editor.toast_created') : t('policy_editor.toast_saved'));
      navigate('/app/settings/approval-policies');
    } catch (err: any) {
      toast.error(err?.message ?? t('policy_editor.toast_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title={t('policy_editor.header_title')} />
        <div className="container mx-auto p-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader title={isNew ? t('policy_editor.header_new') : t('policy_editor.header_edit')} />
      <div className="container mx-auto p-6 space-y-6 max-w-4xl">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app/settings/approval-policies')}
            className="text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            {t('policy_editor.all_rules')}
          </Button>
        </div>

        {/* Name your rule */}
        <Card>
          <CardHeader>
            <CardTitle>{t('policy_editor.name_card_title')}</CardTitle>
            <CardDescription>{t('policy_editor.name_card_desc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="approval-rule-name">{t('policy_editor.name_label')}</Label>
              {/*
                autoComplete="off" + a non-standard name attribute defeats
                Chrome's heuristic that pre-fills bare text inputs with the
                user's saved profile first name (the "Daniel" autofill bug
                noted in the visual contract addendum §4).
              */}
              <Input
                id="approval-rule-name"
                name="approval-rule-name-do-not-autofill"
                autoComplete="off"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('policy_editor.name_placeholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="approval-rule-description">{t('policy_editor.description_label')}</Label>
              <Textarea
                id="approval-rule-description"
                name="approval-rule-description-do-not-autofill"
                autoComplete="off"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder={t('policy_editor.description_placeholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('policy_editor.active_label')}</Label>
              <div className="flex items-center gap-2 h-10">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                />
                <span className="text-xs text-muted-foreground">
                  {form.is_active ? t('policy_editor.active_on') : t('policy_editor.active_off')}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* When does this rule apply? */}
        <Card>
          <CardHeader>
            <CardTitle>{t('policy_editor.when_card_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <MatchCriteriaSentence
              state={{
                match_asset_types: form.match_asset_types,
                match_lease_types: form.match_lease_types,
                match_departments: form.match_departments,
                match_regions: form.match_regions,
                match_min_annual_cost: form.match_min_annual_cost,
                match_max_annual_cost: form.match_max_annual_cost,
              }}
              onChange={(next) => setForm({ ...form, ...next })}
              departmentSuggestions={wsExtras.data?.departments ?? []}
              regionSuggestions={wsExtras.data?.regions ?? []}
              assetTypeOptions={assetTypeOptions}
            />
          </CardContent>
        </Card>

        {/* Who needs to approve? — both stages in one card with an
            inter-stage vertical connector per visual contract addendum §5. */}
        <Card>
          <CardHeader>
            <CardTitle>{t('policy_editor.who_card_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ChainDiagram
              caption={{
                badge: '1',
                primary: t('policy_editor.stage1_primary'),
                secondary: t('policy_editor.stage1_secondary'),
              }}
              steps={conceptSteps}
              setSteps={setConceptSteps}
              memberOptions={members.data ?? []}
            />

            {/* Inter-stage connector — 24px vertical line, addendum §5 */}
            <div className="flex justify-center py-2">
              <div className="w-px h-6 bg-border" aria-hidden />
            </div>

            <ChainDiagram
              caption={{
                badge: '2',
                primary: t('policy_editor.stage2_primary'),
                secondary: t('policy_editor.stage2_secondary'),
              }}
              steps={signatorSteps}
              setSteps={setSignatorSteps}
              memberOptions={members.data ?? []}
            />
          </CardContent>
        </Card>

        {/* Advanced settings — most admins won't need to change these */}
        <Card>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-muted/30 rounded-t-lg transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{t('policy_editor.advanced_title')}</CardTitle>
                    <CardDescription>{t('policy_editor.advanced_desc')}</CardDescription>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                  />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-6 pt-2">
                {/* When two rules fit, which wins? */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('policy_editor.priority_label')}</Label>
                  <Input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value || '0', 10) })}
                    min={1}
                  />
                  <p className="text-[10px] text-muted-foreground">{t('policy_editor.priority_help')}</p>
                </div>

                {/* Approval SLA — #111 C6 */}
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="approval-rule-sla">{t('policy_editor.sla_label')}</Label>
                  <Input
                    id="approval-rule-sla"
                    type="number"
                    min={1}
                    placeholder="7"
                    value={form.sla_days}
                    onChange={(e) => setForm({ ...form, sla_days: e.target.value })}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('policy_editor.sla_help')}
                  </p>
                </div>

                {/* Use this rule when no other rule fits */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('policy_editor.fallback_label')}</Label>
                  <div className="flex items-center gap-2 h-10">
                    <Switch
                      checked={form.is_default_fallback}
                      onCheckedChange={(v) => setForm({ ...form, is_default_fallback: v })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {form.is_default_fallback ? t('policy_editor.fallback_on') : t('policy_editor.fallback_off')}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{t('policy_editor.fallback_help')}</p>
                </div>

                {/* Can the same person fill multiple roles? */}
                <div className="space-y-2">
                  <Label className="text-xs">{t('policy_editor.sod_label')}</Label>
                  <p className="text-[10px] text-muted-foreground">
                    {t('policy_editor.sod_default_prefix')}{' '}
                    <strong>{wsExtras.data?.sodDefault ? t('policy_editor.sod_default_on') : t('policy_editor.sod_default_off')}</strong>.
                  </p>
                  <RadioGroup value={form.sod_mode} onValueChange={(v) => setForm({ ...form, sod_mode: v as SodMode })}>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="inherit" id="sod-inherit" />
                      <Label htmlFor="sod-inherit" className="font-normal text-sm cursor-pointer">
                        {t('policy_editor.sod_inherit_prefix')}{' '}
                        <strong>{wsExtras.data?.sodDefault ? t('policy_editor.sod_currently_require') : t('policy_editor.sod_currently_allow')}</strong>)
                      </Label>
                    </div>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="allow" id="sod-allow" />
                      <Label htmlFor="sod-allow" className="font-normal text-sm cursor-pointer">
                        {t('policy_editor.sod_allow_label')}
                      </Label>
                    </div>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="require" id="sod-require" />
                      <Label htmlFor="sod-require" className="font-normal text-sm cursor-pointer">
                        {t('policy_editor.sod_require_label')}
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        {/* Test / Save / Cancel */}
        <div className="flex flex-wrap justify-end gap-2 sticky bottom-0 bg-background/95 backdrop-blur py-4 -mx-6 px-6 border-t">
          <Button
            variant="outline"
            onClick={() => setTestOpen(true)}
            disabled={saving || !workspace?.id}
          >
            <FlaskConical className="h-4 w-4 mr-1.5" />
            {t('policy_editor.try_sample')}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => navigate('/app/settings/approval-policies')} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                {t('workspace.autosave.saving')}
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1.5" />
                {isNew ? t('policy_editor.create_rule') : t('policy_editor.save_rule')}
              </>
            )}
          </Button>
        </div>
      </div>

      <ApprovalPolicyTestDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        workspaceId={workspace?.id ?? null}
        assetTypeOptions={assetTypeOptions}
      />
    </AppLayout>
  );
}

function stripUiId(s: ChainStep) {
  const { uiId, ...rest } = s;
  return rest;
}
