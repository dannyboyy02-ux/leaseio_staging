import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  Save,
  ArrowLeft,
  ChevronDown,
  AlertTriangle,
  Users,
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
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { validatePolicy } from './approvalPolicyValidation';
import { MatchCriteriaSentence } from './MatchCriteriaSentence';
import { ChainDiagram, seedSingleEmptyStep, type ChainStep } from './ChainDiagram';
import { buildAssetTypeOptions } from '@/lib/assetTypes';
import {
  buildRoleHolderMap,
  describeChain,
  describeRetiredCriteria,
  joinAnd,
} from '@/lib/approvalDescribe';

// ───────────────────────────────────────────────────────────────────────────
// Constants — FUNCTIONAL_ROLE_OPTIONS now lives in ChainDiagram (its only
// consumer post-P1.3). Asset-type options are built here via
// buildAssetTypeOptions(workspace asset_type_config) and passed down to both
// MatchCriteriaSentence and ApprovalPolicyTestDialog (single source in
// src/lib/assetTypes.ts, canonicalized by canonicalAssetType). LEASE_TYPE_OPTIONS
// still lives in each of those consumers.
// ───────────────────────────────────────────────────────────────────────────

type SodMode = 'inherit' | 'allow' | 'require';

/**
 * NOTE ON `priority` AND `is_default_fallback` — both are absent on purpose.
 *
 * `priority` is written by exactly ONE path: the `set_approval_policy_order`
 * RPC, driven from the rules list ("check this rule earlier / later"). This
 * form used to send `priority` in its save payload too, which made the editor
 * a second, unsanctioned writer of a column whose whole correctness argument
 * is that a single transaction owns the workspace's total order. Two writers =
 * two admins can interleave into an order neither chose. Order is not a
 * property of a rule; it is a property of the SET, so it is not in this form.
 *
 * `is_default_fallback` was retired as a routing mechanism (D-Q1, migration
 * 20260719120100). The column is inert — the engine no longer consults it —
 * so a switch labelled "use this rule when no other rule fits" would promise
 * behaviour that cannot happen. The column is left in the database (authored
 * data is not destroyed); it is simply no longer an editable control.
 */
interface PolicyForm {
  name: string;
  description: string;
  is_active: boolean;
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
  is_active: true,
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
  const { t, language } = useAppTranslation();
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
  // Stage 2 seeds EMPTY, not with a slot. The engine inherits the stage-1
  // approvers when no signature step is authored (materializeSignatorInheritance),
  // and validation requires only stage 1 — so seeding a dashed slot here made
  // an optional stage read as mandatory and hid the inheritance entirely.
  // The savedSnapshot baseline below seeds identically, or every new rule
  // would open dirty.
  const [signatorSteps, setSignatorSteps] = useState<ChainStep[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Baseline for the dirty comparison (#174/#169 + #177b). New rule: the
  // seeded scaffold serializes identically to the initial state (uiIds are
  // stripped, and blankStep is otherwise deterministic). Edit rule: set
  // after load. serializePolicy is a hoisted function declaration (bottom
  // of file), so the lazy initializer may call it.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(() =>
    isNew ? serializePolicy(emptyForm(), seedSingleEmptyStep(), []) : null,
  );
  const draftSerialized = serializePolicy(form, conceptSteps, signatorSteps);
  // Nothing is dirty before an edit-mode load completes (savedSnapshot null).
  const isDirty = savedSnapshot !== null && draftSerialized !== savedSnapshot;
  const { bypass } = useUnsavedChangesGuard(isDirty);

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

  // Who actually holds each functional role. This is what turns "Anyone with
  // role" into a person's name everywhere on this page — the chain chips and
  // the answer strip both resolve through it. A role NOBODY holds is the most
  // consequential thing this page can tell an admin (the request silently
  // stops), so the map is loaded here rather than left undefined.
  const roleHolders = useQuery({
    queryKey: ['ws-role-holders-for-policy-editor', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from('workspace_roles')
        .select('user_id, role')
        .eq('workspace_id', workspace!.id);
      return buildRoleHolderMap((data ?? []) as Array<{ role: string; user_id: string }>);
    },
  });

  // Asset-type options for the rule builder + sample-request tester: the four
  // built-ins plus any workspace-configured Asset Type (Lease Configuration).
  // Falls back to built-ins until the workspace row loads.
  const assetTypeOptions = buildAssetTypeOptions(wsExtras.data?.assetTypes);

  const memberOptions = members.data ?? [];
  const roleHolderMap = roleHolders.data;

  // THE LIVE ANSWER. Computed from the DRAFT, so "what does this rule do?" is
  // answerable before saving — which is what retired the sample-tester modal
  // and its save-first apology. describeChain is the same function the rules
  // list and the hero use, so the four surfaces cannot word this differently.
  // `language` is in the dep list because describeChain renders through the
  // i18next singleton at call time (module contract).
  const answer = useMemo(
    () =>
      describeChain(
        [
          ...conceptSteps.map((s) => ({ ...s, stage: 'concept' as const })),
          ...signatorSteps.map((s) => ({ ...s, stage: 'signator' as const })),
        ],
        memberOptions,
        roleHolderMap,
      ),
    [conceptSteps, signatorSteps, memberOptions, roleHolderMap, language],
  );

  // D-Q2: region / lease type are retired from authoring. Authored values are
  // preserved and shown read-only with the reason + a one-click removal.
  const retired = useMemo(
    () =>
      describeRetiredCriteria({
        match_regions: form.match_regions,
        match_lease_types: form.match_lease_types,
      }),
    [form.match_regions, form.match_lease_types, language],
  );

  // Stage 2 with no authored steps is the INHERITED state, not an empty one:
  // the engine clones stage 1 into the signature stage at chain creation.
  const signatureInherited = signatorSteps.length === 0;
  const inheritedSignerNames = answer.stages.find((s) => s.stage === 'concept')?.names ?? [];

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
        // Hoisted into a local so the post-load snapshot (below) serializes
        // the exact object the form state receives.
        const loadedForm: PolicyForm = {
          name: (p as any).name,
          description: (p as any).description ?? '',
          is_active: (p as any).is_active,
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
        };
        setForm(loadedForm);
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
        setSavedSnapshot(serializePolicy(loadedForm, concept, signator));
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

      // `priority` is DELIBERATELY not in this payload — see the PolicyForm
      // note. A new rule takes its position from the insert default; an
      // existing rule keeps whatever the ordering RPC last set. Neither is
      // this form's business. `is_default_fallback` is likewise omitted so
      // the inert authored value is preserved rather than rewritten.
      const payload = {
        workspace_id: workspace.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        is_active: form.is_active,
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
      // One-shot skip for this known-safe post-save navigation — it fires
      // before React re-renders the snapshot state, so the guard would
      // otherwise still see the pre-save dirty comparison.
      bypass();
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

        {/* ── Live answer strip ──────────────────────────────────────────
            Always visible, no card chrome. This is the page's whole point:
            the admin can read what the rule DOES before saving it. It is
            computed locally from draft state, so it is truthful for an
            unsaved rule — which is exactly what the old modal tester could
            never be (preview_policy_resolution only sees saved rows). */}
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('policy_editor.hero.heading')}
          </p>
          <p
            className={
              answer.blocked
                ? 'mt-1 flex items-start gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-200'
                : 'mt-1 text-sm font-medium text-foreground'
            }
          >
            {answer.blocked && (
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            )}
            <span>{answer.sentence}</span>
          </p>
          {/* Cautions that do NOT block outright (one dead step among several)
              still get said — silence here is how an unfilled role becomes a
              request that stalls with nobody noticing. */}
          {!answer.blocked && answer.cautions.length > 0 && (
            <ul className="mt-2 space-y-1">
              {answer.cautions.map((c, i) => (
                <li
                  key={`${c.kind}-${c.role ?? i}`}
                  className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          )}
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
          <CardContent className="space-y-3">
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
              allowLeaseTypeAuthoring={false}
              showRegionPill={false}
            />

            {/* D-Q2 — retired criteria, read-only.
                A lease request never carries a region or a lease type, so a
                rule filtered on either can never match anything. The values
                are NOT deleted behind the admin's back: they are shown, the
                consequence is stated in plain language, and removing them is
                one click. */}
            {retired.usesRetiredCriteria && (
              <div className="rounded-md border border-amber-400/60 dark:border-amber-500/50 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300"
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
                      {retired.warning}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {retired.dimensions.includes('region') && (
                        <span>
                          <span className="font-medium">
                            {t('policy_editor.retired.region_label')}:
                          </span>{' '}
                          {joinAnd(retired.regions)}
                        </span>
                      )}
                      {retired.dimensions.includes('lease_type') && (
                        <span>
                          <span className="font-medium">
                            {t('policy_editor.retired.lease_type_label')}:
                          </span>{' '}
                          {joinAnd(retired.leaseTypes)}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {t('policy_editor.retired.readonly_hint')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-5">
                  {retired.dimensions.includes('region') && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setForm({ ...form, match_regions: [] })}
                    >
                      {t('policy_editor.retired.remove_region')}
                    </Button>
                  )}
                  {retired.dimensions.includes('lease_type') && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setForm({ ...form, match_lease_types: [] })}
                    >
                      {t('policy_editor.retired.remove_lease_type')}
                    </Button>
                  )}
                  {retired.dimensions.length > 1 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        setForm({ ...form, match_regions: [], match_lease_types: [] })
                      }
                    >
                      {t('policy_editor.retired.remove_both')}
                    </Button>
                  )}
                </div>
              </div>
            )}
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
              memberOptions={memberOptions}
              roleHolders={roleHolderMap}
            />

            {/* Inter-stage connector — 24px vertical line, addendum §5 */}
            <div className="flex justify-center py-2">
              <div className="w-px h-6 bg-border" aria-hidden />
            </div>

            {/* Stage 2 is OPTIONAL and now says so.
                The engine inherits the stage-1 approvers when no signature
                step is authored, and validation requires only stage 1. This
                stage therefore keeps its circled "2" and its caption — the
                signing step genuinely happens — but its RESTING state is a
                resolved statement ("the same people sign"), not a dashed
                empty slot that reads mandatory. An inherited signer is never
                rendered as though someone chose it: that difference is
                exactly what an audit asks about. */}
            <ChainDiagram
              caption={{
                badge: '2',
                primary: t('policy_editor.stage2_primary'),
                secondary: t('policy_editor.stage2_secondary'),
              }}
              steps={signatorSteps}
              setSteps={setSignatorSteps}
              memberOptions={memberOptions}
              roleHolders={roleHolderMap}
            >
              {signatureInherited ? (
                <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 space-y-2">
                  <p className="text-sm flex items-start gap-2">
                    <Users className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
                    <span>
                      {inheritedSignerNames.length > 0
                        ? t('policy_editor.describe.stage2_same_people', {
                            names: joinAnd(inheritedSignerNames),
                          })
                        : t('policy_editor.describe.stage2_inherited_note')}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('policy_editor.stage2_optin_desc')}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setSignatorSteps(seedSingleEmptyStep())}
                  >
                    {t('policy_editor.stage2_optin_add')}
                  </Button>
                </div>
              ) : undefined}
            </ChainDiagram>
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
                {/* The priority <Input> that used to sit here is gone: when
                    two rules fit, the answer is "the one checked first", and
                    that is set by moving rules on the rules list, not by
                    typing an integer here. Its two locale keys
                    (priority_label / priority_help) were deleted. */}

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

                {/* The "use this rule when no other rule fits" switch is gone
                    too: D-Q1 retired is_default_fallback as a routing
                    mechanism (migration 20260719120100), so the engine no
                    longer consults it. A control that cannot change routing
                    does not belong on a governance surface. */}

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

        {/* Save / Cancel. No test button: the answer strip at the top of the
            page already says what this rule does, computed from the draft, so
            there is nothing to save-then-test. */}
        <div className="flex flex-wrap items-center justify-end gap-2 sticky bottom-0 bg-background/95 backdrop-blur py-4 -mx-6 px-6 border-t">
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
    </AppLayout>
  );
}

function stripUiId(s: ChainStep) {
  const { uiId, ...rest } = s;
  return rest;
}

// #174/#169 + #177b — canonical serialization of the editor's draft. uiIds
// are stripped so the random seeded ids don't poison the comparison. ONE
// snapshot mechanism serves BOTH the unsaved-changes guard (isDirty) and the
// sample tester's save-first gate (testerStale). Function declaration (not
// const) so the savedSnapshot lazy initializer above can call it via hoisting.
function serializePolicy(form: PolicyForm, concept: ChainStep[], signator: ChainStep[]) {
  return JSON.stringify({ form, concept: concept.map(stripUiId), signator: signator.map(stripUiId) });
}
