import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, FlaskConical, Edit3, Copy, Archive, Loader2, Star } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ApprovalPolicyTestDialog } from '@/components/settings/ApprovalPolicyTestDialog';

type Policy = {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  match_asset_types: string[];
  match_departments: string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
  match_regions: string[];
  match_lease_types: string[];
  is_default_fallback: boolean;
  is_active: boolean;
  updated_at: string;
};

const fmtMoney = (n: number | null): string =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const matchSummary = (p: Policy): { label: string; value: string }[] => {
  const out: { label: string; value: string }[] = [];
  if (p.match_asset_types.length) out.push({ label: 'Asset', value: p.match_asset_types.join(', ') });
  if (p.match_lease_types.length) out.push({ label: 'Type', value: p.match_lease_types.join(', ') });
  if (p.match_departments.length) out.push({ label: 'Dept', value: p.match_departments.join(', ') });
  if (p.match_regions.length) out.push({ label: 'Region', value: p.match_regions.join(', ') });
  const min = p.match_min_annual_cost;
  const max = p.match_max_annual_cost;
  if (min != null || max != null) {
    out.push({
      label: 'Annual',
      value: `${min != null ? fmtMoney(min) : '—'} – ${max != null ? fmtMoney(max) : '—'}`,
    });
  }
  return out;
};

export default function ApprovalPoliciesListPage() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [testOpen, setTestOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const policiesQuery = useQuery<Policy[]>({
    queryKey: ['approval-policies', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('approval_policies')
        .select(
          'id, name, description, priority, match_asset_types, match_departments, match_min_annual_cost, match_max_annual_cost, match_regions, match_lease_types, is_default_fallback, is_active, updated_at'
        )
        .eq('workspace_id', workspace!.id)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Policy[];
    },
  });

  const sodQuery = useQuery({
    queryKey: ['workspace-sod-default', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspaces')
        .select('separation_of_duties_default')
        .eq('id', workspace!.id)
        .maybeSingle();
      if (error) throw error;
      return Boolean((data as any)?.separation_of_duties_default ?? true);
    },
  });

  const sortedPolicies = useMemo(() => policiesQuery.data ?? [], [policiesQuery.data]);

  const toggleSodDefault = async (next: boolean) => {
    if (!workspace?.id) return;
    const { error } = await supabase
      .from('workspaces')
      .update({ separation_of_duties_default: next } as any)
      .eq('id', workspace.id);
    if (error) {
      toast.error('Failed to update workspace setting');
      return;
    }
    queryClient.setQueryData(['workspace-sod-default', workspace.id], next);
    toast.success(`Workspace default for distinct approvers: ${next ? 'ON' : 'OFF'}`);
  };

  const toggleActive = async (policy: Policy, next: boolean) => {
    setBusyId(policy.id);
    const { error } = await supabase
      .from('approval_policies')
      .update({ is_active: next } as any)
      .eq('id', policy.id);
    setBusyId(null);
    if (error) {
      // The partial unique index will reject if turning a non-default on while
      // another default is also active — surface a helpful message.
      toast.error(error.message || 'Failed to update rule');
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['approval-policies', workspace?.id] });
  };

  const duplicate = async (policy: Policy) => {
    if (!workspace?.id) return;
    setBusyId(policy.id);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Not signed in');

      const { data: newPolicy, error: insertErr } = await supabase
        .from('approval_policies')
        .insert({
          workspace_id: workspace.id,
          name: `${policy.name} (copy)`,
          description: policy.description,
          priority: policy.priority,
          match_asset_types: policy.match_asset_types,
          match_departments: policy.match_departments,
          match_min_annual_cost: policy.match_min_annual_cost,
          match_max_annual_cost: policy.match_max_annual_cost,
          match_regions: policy.match_regions,
          match_lease_types: policy.match_lease_types,
          is_default_fallback: false,
          is_active: false,
          created_by: userId,
          updated_by: userId,
        } as any)
        .select('id')
        .single();
      if (insertErr) throw insertErr;

      const { data: steps, error: stepsErr } = await supabase
        .from('approval_chain_steps')
        .select('stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required')
        .eq('policy_id', policy.id);
      if (stepsErr) throw stepsErr;

      if (steps && steps.length > 0) {
        const { error: rpcErr } = await supabase.rpc('apply_policy_steps', {
          p_policy_id: (newPolicy as any).id,
          p_steps: steps as any,
        });
        if (rpcErr) throw rpcErr;
      }

      toast.success('Rule duplicated. Edit and activate when ready.');
      queryClient.invalidateQueries({ queryKey: ['approval-policies', workspace.id] });
      navigate(`/app/settings/approval-policies/${(newPolicy as any).id}`);
    } catch (err: any) {
      toast.error(err?.message || 'Duplicate failed');
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (policy: Policy) => {
    if (!confirm(`Archive rule "${policy.name}"? It will be deactivated and stop matching new requests.`)) return;
    await toggleActive(policy, false);
  };

  return (
    <AppLayout>
      <AppHeader title="Approval Rules" />
      <div className="container mx-auto p-6 space-y-6">
        {/* Workspace default for distinct approvers */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium">Can the same person fill multiple roles?</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When ON, every approval chain must use distinct users at each step. Individual rules can override this.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {sodQuery.data ? 'ON — distinct users required' : 'OFF — same user allowed'}
                </span>
                <Switch
                  checked={Boolean(sodQuery.data)}
                  onCheckedChange={toggleSodDefault}
                  disabled={sodQuery.isPending}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Rules list */}
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Rules</CardTitle>
              <CardDescription>
                Rules are checked in priority order — the first rule whose conditions all match a new request wins. If
                nothing matches, the fallback rule is used.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
                <FlaskConical className="h-4 w-4 mr-1.5" />
                Try it on a sample request
              </Button>
              <Button
                size="sm"
                onClick={() => navigate('/app/settings/approval-policies/new')}
              >
                <Plus className="h-4 w-4 mr-1.5" />
                New rule
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {policiesQuery.isPending ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : sortedPolicies.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <p>No approval rules yet.</p>
                <p className="mt-1">
                  Click <strong>New rule</strong> to define the first one.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedPolicies.map((p) => {
                  const chips = matchSummary(p);
                  return (
                    <div
                      key={p.id}
                      className={`rounded-md border p-3 ${p.is_active ? '' : 'opacity-60'}`}
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm truncate">{p.name}</p>
                            <Badge variant="outline" className="text-xs">
                              priority {p.priority}
                            </Badge>
                            {p.is_default_fallback && (
                              <Badge className="text-xs bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-300">
                                <Star className="h-3 w-3 mr-1" />
                                Default fallback
                              </Badge>
                            )}
                          </div>
                          {p.description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{p.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {chips.length === 0 ? (
                              <span className="text-xs text-muted-foreground italic">Matches all requests</span>
                            ) : (
                              chips.map((c) => (
                                <Badge key={c.label} variant="secondary" className="text-[10px] font-normal">
                                  <span className="font-semibold mr-1">{c.label}:</span>
                                  {c.value}
                                </Badge>
                              ))
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-2">
                            Updated {fmtDate(p.updated_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="flex items-center gap-1.5">
                            <Switch
                              checked={p.is_active}
                              onCheckedChange={(v) => toggleActive(p, v)}
                              disabled={busyId === p.id}
                            />
                            <span className="text-xs text-muted-foreground">{p.is_active ? 'Active' : 'Inactive'}</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => navigate(`/app/settings/approval-policies/${p.id}`)}
                            title="Edit"
                          >
                            <Edit3 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => duplicate(p)}
                            disabled={busyId === p.id}
                            title="Duplicate"
                          >
                            {busyId === p.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </Button>
                          {p.is_active && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => archive(p)}
                              disabled={busyId === p.id}
                              title="Archive"
                            >
                              <Archive className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ApprovalPolicyTestDialog open={testOpen} onOpenChange={setTestOpen} workspaceId={workspace?.id ?? null} />
    </AppLayout>
  );
}
