import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  Save,
  ArrowLeft,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
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
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { validatePolicy } from './approvalPolicyValidation';
import { ApprovalPolicyTestDialog } from '@/components/settings/ApprovalPolicyTestDialog';

// ───────────────────────────────────────────────────────────────────────────
// Constants — keep aligned with leases.asset_type / leases.lease_type CHECK
// constraints so matched values pass the resolver later.
// ───────────────────────────────────────────────────────────────────────────

const ASSET_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'property', label: 'Property (Real Estate)' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'other', label: 'Other' },
];

const LEASE_TYPE_OPTIONS: string[] = ['Real Estate', 'Equipment'];

const FUNCTIONAL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'submitter', label: 'Submitter' },
  { value: 'manager_approver', label: 'Manager approver' },
  { value: 'financial_approver', label: 'Financial approver' },
  { value: 'signator', label: 'Signator' },
  { value: 'admin', label: 'Admin' },
];

type SodMode = 'inherit' | 'allow' | 'require';

interface ChainStep {
  // Local UI id only — not persisted. Server assigns its own.
  uiId: string;
  step_order: number;
  parallel_group: number;
  // Exactly one of these is set:
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days: number | null;
  is_required: boolean;
}

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
});

const newUiId = () => `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const blankStep = (existing: ChainStep[]): ChainStep => ({
  uiId: newUiId(),
  step_order: existing.length + 1,
  parallel_group: 1,
  approver_user_id: null,
  approver_role: 'manager_approver',
  delegate_user_id: null,
  delegate_after_days: null,
  is_required: true,
});

// ───────────────────────────────────────────────────────────────────────────
// Reusable: chip-style multi-select with curated suggestions + free-text add.
// ───────────────────────────────────────────────────────────────────────────

function ChipMultiSelect({
  values,
  onChange,
  suggestions,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const remaining = suggestions.filter((s) => !values.includes(s));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {values.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">No filter — matches any</span>
        ) : (
          values.map((v) => (
            <Badge key={v} variant="secondary" className="text-xs gap-1">
              {v}
              <button onClick={() => remove(v)} className="hover:text-destructive">
                <X size={10} />
              </button>
            </Badge>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder={placeholder}
          className="h-8 text-sm"
        />
        <Button variant="outline" size="sm" onClick={() => add(draft)} disabled={!draft.trim()}>
          <Plus size={12} className="mr-1" />
          Add
        </Button>
      </div>
      {remaining.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[10px] text-muted-foreground self-center">Suggestions:</span>
          {remaining.slice(0, 8).map((s) => (
            <button
              key={s}
              onClick={() => add(s)}
              className="text-[10px] px-1.5 py-0.5 rounded border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export default function ApprovalPolicyEditPage() {
  const { workspace } = useApp();
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !routeId || routeId === 'new';

  const [form, setForm] = useState<PolicyForm>(emptyForm());
  const [conceptSteps, setConceptSteps] = useState<ChainStep[]>([]);
  const [signatorSteps, setSignatorSteps] = useState<ChainStep[]>([]);
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
        .select('separation_of_duties_default, department_options, region_options')
        .eq('id', workspace!.id)
        .maybeSingle();
      return {
        sodDefault: Boolean((data as any)?.separation_of_duties_default ?? true),
        departments: ((data as any)?.department_options ?? []) as string[],
        regions: ((data as any)?.region_options ?? []) as string[],
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
          toast.error('Rule not found.');
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
        toast.error(err?.message ?? 'Failed to load rule');
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
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Not signed in');

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

      toast.success(isNew ? 'Rule created.' : 'Rule saved.');
      navigate('/app/settings/approval-policies');
    } catch (err: any) {
      toast.error(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title="Approval Rule" />
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
      <AppHeader title={isNew ? 'New approval rule' : 'Edit approval rule'} />
      <div className="container mx-auto p-6 space-y-6 max-w-4xl">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app/settings/approval-policies')}
            className="text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            All rules
          </Button>
        </div>

        {/* Name your rule */}
        <Card>
          <CardHeader>
            <CardTitle>Name your rule</CardTitle>
            <CardDescription>Give it a clear name so other admins know when it should apply.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Real estate over $500K"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description (optional)</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder="Notes for other admins."
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Active</Label>
              <div className="flex items-center gap-2 h-10">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                />
                <span className="text-xs text-muted-foreground">
                  {form.is_active ? 'On — this rule is in use' : 'Off — this rule is paused'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* When does this rule apply? */}
        <Card>
          <CardHeader>
            <CardTitle>When does this rule apply?</CardTitle>
            <CardDescription>
              This rule applies when ALL filled-in conditions are satisfied. Leave a condition empty to match anything.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <Label className="text-xs">Asset types</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                {ASSET_TYPE_OPTIONS.map((o) => {
                  const checked = form.match_asset_types.includes(o.value);
                  return (
                    <label
                      key={o.value}
                      className="flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(form.match_asset_types);
                          if (v) next.add(o.value);
                          else next.delete(o.value);
                          setForm({ ...form, match_asset_types: Array.from(next) });
                        }}
                      />
                      <span className="text-xs">{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <Label className="text-xs">Lease types</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                {LEASE_TYPE_OPTIONS.map((o) => {
                  const checked = form.match_lease_types.includes(o);
                  return (
                    <label
                      key={o}
                      className="flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(form.match_lease_types);
                          if (v) next.add(o);
                          else next.delete(o);
                          setForm({ ...form, match_lease_types: Array.from(next) });
                        }}
                      />
                      <span className="text-xs">{o}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <Label className="text-xs">Departments</Label>
              <div className="mt-2">
                <ChipMultiSelect
                  values={form.match_departments}
                  onChange={(v) => setForm({ ...form, match_departments: v })}
                  suggestions={wsExtras.data?.departments ?? []}
                  placeholder="Add a department…"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Regions</Label>
              <div className="mt-2">
                <ChipMultiSelect
                  values={form.match_regions}
                  onChange={(v) => setForm({ ...form, match_regions: v })}
                  suggestions={wsExtras.data?.regions ?? []}
                  placeholder="Add a region…"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Min annual cost (USD)</Label>
                <Input
                  type="number"
                  value={form.match_min_annual_cost}
                  onChange={(e) => setForm({ ...form, match_min_annual_cost: e.target.value })}
                  placeholder="Any"
                  inputMode="decimal"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Max annual cost (USD)</Label>
                <Input
                  type="number"
                  value={form.match_max_annual_cost}
                  onChange={(e) => setForm({ ...form, match_max_annual_cost: e.target.value })}
                  placeholder="Any"
                  inputMode="decimal"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 1 — Concept chain */}
        <ChainEditor
          title="Step 1: Get the green light"
          description="Before any paperwork starts. Who approves the request itself?"
          steps={conceptSteps}
          setSteps={setConceptSteps}
          memberOptions={members.data ?? []}
        />

        {/* Step 2 — Signator chain */}
        <ChainEditor
          title="Step 2: Sign the deal"
          description="After negotiation is done. The person whose signature legally binds the company."
          steps={signatorSteps}
          setSteps={setSignatorSteps}
          memberOptions={members.data ?? []}
        />

        {/* Advanced settings — most admins won't need to change these */}
        <Card>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-muted/30 rounded-t-lg transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Advanced settings</CardTitle>
                    <CardDescription>Most admins don't need to change these.</CardDescription>
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
                  <Label className="text-xs">When two rules fit, which wins?</Label>
                  <Input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value || '0', 10) })}
                    min={1}
                  />
                  <p className="text-[10px] text-muted-foreground">Higher number wins when multiple rules match the same request.</p>
                </div>

                {/* Use this rule when no other rule fits */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Use this rule when no other rule fits</Label>
                  <div className="flex items-center gap-2 h-10">
                    <Switch
                      checked={form.is_default_fallback}
                      onCheckedChange={(v) => setForm({ ...form, is_default_fallback: v })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {form.is_default_fallback ? 'On — this is the workspace fallback' : 'Off'}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Only one rule per workspace can be the fallback.</p>
                </div>

                {/* Can the same person fill multiple roles? */}
                <div className="space-y-2">
                  <Label className="text-xs">Can the same person fill multiple roles?</Label>
                  <p className="text-[10px] text-muted-foreground">
                    Workspace default is <strong>{wsExtras.data?.sodDefault ? 'ON (require distinct users)' : 'OFF (allow same user)'}</strong>.
                  </p>
                  <RadioGroup value={form.sod_mode} onValueChange={(v) => setForm({ ...form, sod_mode: v as SodMode })}>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="inherit" id="sod-inherit" />
                      <Label htmlFor="sod-inherit" className="font-normal text-sm cursor-pointer">
                        Use the workspace default (currently:{' '}
                        <strong>{wsExtras.data?.sodDefault ? 'require distinct users' : 'allow same user'}</strong>)
                      </Label>
                    </div>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="allow" id="sod-allow" />
                      <Label htmlFor="sod-allow" className="font-normal text-sm cursor-pointer">
                        Allow the same person in multiple roles
                      </Label>
                    </div>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="require" id="sod-require" />
                      <Label htmlFor="sod-require" className="font-normal text-sm cursor-pointer">
                        Require distinct users
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
            Try it on a sample request
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => navigate('/app/settings/approval-policies')} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1.5" />
                {isNew ? 'Create rule' : 'Save rule'}
              </>
            )}
          </Button>
        </div>
      </div>

      <ApprovalPolicyTestDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        workspaceId={workspace?.id ?? null}
      />
    </AppLayout>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Chain editor — used twice (concept + signator)
// ───────────────────────────────────────────────────────────────────────────

function ChainEditor({
  title,
  description,
  steps,
  setSteps,
  memberOptions,
}: {
  title: string;
  description: string;
  steps: ChainStep[];
  setSteps: (s: ChainStep[]) => void;
  memberOptions: Array<{ id: string; label: string }>;
}) {
  const addStep = () => setSteps([...steps, blankStep(steps)]);
  const remove = (uiId: string) => setSteps(steps.filter((s) => s.uiId !== uiId));
  const update = (uiId: string, patch: Partial<ChainStep>) =>
    setSteps(steps.map((s) => (s.uiId === uiId ? { ...s, ...patch } : s)));
  const move = (uiId: string, dir: -1 | 1) => {
    const i = steps.findIndex((s) => s.uiId === uiId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const swapped = [...steps];
    [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    // Re-sequence step_order to match new positions; preserve parallel_group.
    setSteps(swapped.map((s, idx) => ({ ...s, step_order: idx + 1 })));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={addStep}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add approver
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No approvers yet — add at least one.</p>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Approvers are checked in order. Two approvers in the same group act at the same time.
          </p>
        )}
        {steps.map((s, i) => {
          const useRole = !!s.approver_role;
          return (
            <div key={s.uiId} className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Approver {s.step_order}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => move(s.uiId, -1)}
                    disabled={i === 0}
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => move(s.uiId, 1)}
                    disabled={i === steps.length - 1}
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(s.uiId)}
                    title="Remove step"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/*
                Position is set by the up/down arrows above (state auto-resequences
                step_order on swap), so the explicit "Step order" input is gone in
                P1.1. parallel_group stays visible until P1.3 replaces it with
                side-by-side rendering.
              */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide">Group</Label>
                  <Input
                    type="number"
                    value={s.parallel_group}
                    onChange={(e) => update(s.uiId, { parallel_group: parseInt(e.target.value || '1', 10) })}
                    className="h-8 text-sm"
                    min={1}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Same group = act at the same time. Different group = act in sequence.
                  </p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-[10px] uppercase tracking-wide">Who approves?</Label>
                  <RadioGroup
                    value={useRole ? 'role' : 'user'}
                    onValueChange={(v) => {
                      if (v === 'role') update(s.uiId, { approver_user_id: null, approver_role: s.approver_role ?? 'manager_approver' });
                      else update(s.uiId, { approver_role: null, approver_user_id: s.approver_user_id ?? null });
                    }}
                    className="flex gap-3"
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="user" id={`${s.uiId}-user`} />
                      <Label htmlFor={`${s.uiId}-user`} className="text-xs font-normal cursor-pointer">
                        A specific person
                      </Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="role" id={`${s.uiId}-role`} />
                      <Label htmlFor={`${s.uiId}-role`} className="text-xs font-normal cursor-pointer">
                        Anyone with a role
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {useRole ? (
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wide">Role</Label>
                    <Select
                      value={s.approver_role ?? ''}
                      onValueChange={(v) => update(s.uiId, { approver_role: v })}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {FUNCTIONAL_ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wide">User</Label>
                    <Select
                      value={s.approver_user_id ?? ''}
                      onValueChange={(v) => update(s.uiId, { approver_user_id: v })}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select user" />
                      </SelectTrigger>
                      <SelectContent>
                        {memberOptions.length === 0 ? (
                          <div className="px-2 py-1 text-xs text-muted-foreground">
                            No workspace members loaded
                          </div>
                        ) : (
                          memberOptions.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex items-center gap-2 pt-5">
                  <Switch
                    checked={s.is_required}
                    onCheckedChange={(v) => update(s.uiId, { is_required: v })}
                  />
                  <span className="text-xs text-muted-foreground">{s.is_required ? 'Required' : 'Optional'}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide">Backup approver (optional)</Label>
                  <Select
                    value={s.delegate_user_id ?? '__none__'}
                    onValueChange={(v) => update(s.uiId, { delegate_user_id: v === '__none__' ? null : v })}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="No backup" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No backup</SelectItem>
                      {memberOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide">Backup approver if no answer in N days</Label>
                  <Input
                    type="number"
                    value={s.delegate_after_days ?? ''}
                    onChange={(e) =>
                      update(s.uiId, {
                        delegate_after_days: e.target.value === '' ? null : parseInt(e.target.value, 10),
                      })
                    }
                    placeholder="—"
                    className="h-8 text-sm"
                    min={1}
                    disabled={!s.delegate_user_id}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function stripUiId(s: ChainStep) {
  const { uiId, ...rest } = s;
  return rest;
}
