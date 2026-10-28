// ─────────────────────────────────────────────────────────────────────────
// "Who approves what" — the approval-rules list.
//
// THE THESIS: I describe a lease, the page names the people who must sign off
// on it, and the rules underneath are the EXPLANATION for that answer. So the
// answer strip is a permanent hero (never a modal, never a "Run" button), and
// every rule row ends in the people rather than in metadata.
//
// This page composes; it does not implement. Matching comes from the same
// `preview_policy_resolution` RPC the engine agrees with, approver prose comes
// from `approvalDescribe` (which can never emit a raw UUID), and order is
// written ONLY through `set_approval_policy_order`.
//
// GONE FROM THIS SCREEN (deliberately, all of it):
//  • the `priority N` badge and every user-facing integer derived from it —
//    position is expressed as position, and only when it decides something;
//  • the ⭐ default-fallback badge — the flag is retired from the engine, and
//    the permanent "Everything else" row is the real catch-all;
//  • the sample-request MODAL (ApprovalPolicyTestDialog) — the hero answers
//    continuously, so a dialog that answers on demand is strictly worse;
//  • "No approval rules yet" — a workspace with zero rules is already routing
//    every request somewhere, and this screen's first duty is to say where.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { buildAssetTypeOptions } from '@/lib/assetTypes';
import {
  describeOverlapStatus,
  findShadowedRules,
  type DescribableStep,
} from '@/lib/approvalDescribe';
import { engineOrder } from '@/lib/approvalPolicyOrder';
import type { HeroSeedRule } from '@/lib/approvalHeroSeed';
import { useApprovalAnswerContext } from '@/hooks/useApprovalAnswerContext';
import { useApprovalRuleOrder } from '@/hooks/useApprovalRuleOrder';
import { ApprovalAnswerStrip } from '@/components/settings/ApprovalAnswerStrip';
import { ApprovalRuleRow } from '@/components/settings/ApprovalRuleRow';
import { ApprovalEverythingElseRow } from '@/components/settings/ApprovalEverythingElseRow';
import {
  ApprovalRuleDeleteDialog,
  type DeletableRule,
} from '@/components/settings/ApprovalRuleDeleteDialog';

/** Exactly the columns this screen reads. `priority` and `created_at` are read
 *  but never SHOWN — they only reproduce the engine's total order. */
type Policy = {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  created_at: string;
  match_asset_types: string[];
  match_departments: string[];
  match_regions: string[];
  match_lease_types: string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
};

type StepRow = DescribableStep & { policy_id: string };

const POLICY_COLUMNS =
  'id, name, is_active, priority, created_at, match_asset_types, match_departments, match_regions, match_lease_types, match_min_annual_cost, match_max_annual_cost';

/** Where a solo admin can actually name the default approvers. The
 *  `members.length > 1` gate that used to hide this editor is fixed (D-Q3), so
 *  this CTA can no longer dead-end for the user most likely to need it. */
const APPROVAL_ROLES_HREF = '/app/settings/workspaces/users?highlight=approval-roles';

export default function ApprovalPoliciesListPage() {
  const { workspace } = useApp();
  const workspaceId = workspace?.id ?? null;
  const navigate = useNavigate();
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeletableRule | null>(null);

  // ── reads ─────────────────────────────────────────────────────────────
  const policiesQuery = useQuery<Policy[]>({
    queryKey: ['approval-policies', workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('approval_policies')
        .select(POLICY_COLUMNS)
        .eq('workspace_id', workspaceId!)
        // The engine's EXACT total order. The `id` key is not cosmetic: without
        // it, two rules sharing (priority, created_at) can render in an order
        // the engine will not honour.
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as Policy[];
    },
  });

  // Sorted client-side too, so the displayed order is provably the comparator
  // the engine uses rather than whatever the server happened to return.
  const policies = useMemo(() => engineOrder(policiesQuery.data ?? []), [policiesQuery.data]);

  // #208 — this MUST mirror the engine, which loads rules with
  // .eq("is_active", true) and returns `no_policies` when none remain
  // (resolve-approval-chain:373/377). `policies` deliberately INCLUDES paused
  // rules — the row menu toggles is_active, so they have to stay listed — which
  // means policies.length can never be the active-rule predicate. Using it told
  // an admin their requests were BLOCKED in the exact state the engine
  // AUTO-APPROVES: the worst possible copy error on this page.
  const hasActiveRules = useMemo(() => policies.some((p) => p.is_active), [policies]);
  const policyIds = useMemo(() => policies.map((p) => p.id), [policies]);
  const policyIdKey = policyIds.join(',');

  const stepsQuery = useQuery<StepRow[]>({
    queryKey: ['approval-policy-steps', workspaceId, policyIdKey],
    enabled: !!workspaceId && policyIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('approval_chain_steps')
        .select(
          'policy_id, stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required',
        )
        .in('policy_id', policyIds);
      if (error) throw error;
      return (data ?? []) as unknown as StepRow[];
    },
  });

  const stepsByPolicy = useMemo(() => {
    const map = new Map<string, DescribableStep[]>();
    for (const step of stepsQuery.data ?? []) {
      const list = map.get(step.policy_id);
      if (list) list.push(step);
      else map.set(step.policy_id, [step]);
    }
    return map;
  }, [stepsQuery.data]);

  const workspaceQuery = useQuery({
    queryKey: ['workspace-approval-settings', workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspaces')
        .select('separation_of_duties_default, covenant_threshold')
        .eq('id', workspaceId!)
        .maybeSingle();
      if (error) throw error;
      return {
        sodDefault: Boolean((data as any)?.separation_of_duties_default ?? true),
        covenantThreshold: ((data as any)?.covenant_threshold ?? null) as number | null,
      };
    },
  });

  // The hero's rules, in the order it must see them. Handing them over means
  // the strip does not pay for a second copy of a list this page already has.
  const heroRules = useMemo<HeroSeedRule[]>(
    () =>
      policies.map((p) => ({
        id: p.id,
        is_active: p.is_active,
        match_asset_types: p.match_asset_types,
        match_departments: p.match_departments,
        match_min_annual_cost: p.match_min_annual_cost,
        match_max_annual_cost: p.match_max_annual_cost,
      })),
    [policies],
  );

  // Members, role holders and the approval threshold. Same query keys as the
  // strip's own call, so React Query serves both from one fetch.
  const ctx = useApprovalAnswerContext(workspaceId, heroRules);
  const assetTypeOptions = useMemo(
    () => buildAssetTypeOptions(ctx.assetTypeConfig),
    [ctx.assetTypeConfig],
  );

  // ── ordering ──────────────────────────────────────────────────────────
  const overlap = useMemo(() => findShadowedRules(policies), [policies]);
  const names = useMemo(
    () => new Map(policies.map((p) => [p.id, p.name] as const)),
    [policies],
  );
  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['approval-policies', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['approval-answer-rules', workspaceId] });
  }, [queryClient, workspaceId]);
  const focusRow = useCallback((id: string) => {
    // Focus returns to the row that MOVED, not to the top of the list. The
    // row's overlay link is addressable by its edit href, so no extra id
    // plumbing is needed through the row component.
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`a[href="/app/settings/approval-policies/${id}"]`)
        ?.focus();
    });
  }, []);
  const order = useApprovalRuleOrder({
    workspaceId,
    orderedIds: policyIds,
    names,
    onReload: reload,
    onMoved: focusRow,
  });

  // ── writes ────────────────────────────────────────────────────────────
  const toggleSodDefault = async (next: boolean) => {
    if (!workspaceId) return;
    const { error } = await supabase
      .from('workspaces')
      .update({ separation_of_duties_default: next } as any)
      .eq('id', workspaceId);
    if (error) {
      toast.error(t('policy_editor.list.toast_sod_failed'));
      return;
    }
    queryClient.setQueryData(
      ['workspace-approval-settings', workspaceId],
      (prev: { sodDefault: boolean; covenantThreshold: number | null } | undefined) => ({
        sodDefault: next,
        covenantThreshold: prev?.covenantThreshold ?? null,
      }),
    );
    toast.success(
      next ? t('policy_editor.list.toast_sod_on') : t('policy_editor.list.toast_sod_off'),
    );
  };

  const setPaused = async (policy: Policy, nextActive: boolean) => {
    setBusyId(policy.id);
    const { error } = await supabase
      .from('approval_policies')
      .update({ is_active: nextActive } as any)
      .eq('id', policy.id);
    setBusyId(null);
    if (error) {
      toast.error(error.message || t('policy_editor.list.toast_rule_update_failed'));
      return;
    }
    if (!nextActive) toast.success(t('policy_editor.list.toast_turned_off'));
    reload();
  };

  /** D-Q4: only ever reached once the dialog's evidence check has confirmed
   *  this rule never routed a request. */
  const hardDelete = async (rule: DeletableRule) => {
    const { error } = await supabase.from('approval_policies').delete().eq('id', rule.id);
    if (error) {
      toast.error(t('policy_editor.list.toast_delete_failed'));
      return;
    }
    toast.success(t('policy_editor.list.toast_deleted'));
    reload();
  };

  const turnOffInstead = async (rule: DeletableRule) => {
    const target = policies.find((p) => p.id === rule.id);
    if (target) await setPaused(target, false);
  };

  return (
    <AppLayout>
      {/* #211 — the primary action lives in AppHeader's `actions` slot, the
          same place every other page in the app puts it. It used to render
          TWICE on this page (default variant here, `sm`/outline again in the
          rules card) which read as two different controls. */}
      <AppHeader
        title={t('workspace.rules.title')}
        actions={
          <Button onClick={() => navigate('/app/settings/approval-policies/new')}>
            <Plus className="h-4 w-4 mr-1.5" />
            {t('policy_editor.list.new_rule')}
          </Button>
        }
      />
      {/* #211 — was `container mx-auto max-w-4xl p-6`, which made this page's
          content column 128px narrower than every other app page and jump as
          the user walked the nav. `default` (max-w-5xl) is the documented tier
          for settings/config pages. The pageLayoutAdoption pin allowlisted this
          file as "migrate with that rework" — this is that rework. */}
      <PageLayout>
        {/* This page sits outside the Settings shell, so without an explicit
            back link the user who arrived from Settings → Approval Rules has
            no way back but the browser button. Mirrors the WorkspacesSection
            back-link pattern. */}
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={() => navigate('/app/settings/workspaces/approval_policies')}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          {t('workspace.back_to_workspace_settings')}
        </Button>
        {/* 1 — THE TEACHING LINE. The primary action moved to AppHeader's
            `actions` slot (#211), so this is a single paragraph now — the
            flex row it used to share with a button is gone, not left behind
            as a one-child wrapper. */}
        <p className="min-w-0 text-sm text-muted-foreground">
          {t('policy_editor.list.page_teaching')}
        </p>

        {/* 2 — THE HERO. Permanent, seeded from this workspace's own leases, and
            answering before anything is touched. `onOpenRule` is the one-click
            path from a wrong answer to the rule that produced it. */}
        <ApprovalAnswerStrip
          workspaceId={workspaceId}
          rules={heroRules}
          assetTypeOptions={assetTypeOptions}
          onOpenRule={(ruleId) => navigate(`/app/settings/approval-policies/${ruleId}`)}
          onPickDefaultApprovers={() => navigate(APPROVAL_ROLES_HREF)}
        />

        {/* 3 — HOW REQUESTS ARE ROUTED. */}
        <Card>
          <CardHeader className="space-y-1.5">
            <CardTitle>{t('policy_editor.order.heading')}</CardTitle>
            <CardDescription>{t('policy_editor.order.help')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 3a — ONE overlap status line. When no two checked rules can
                co-match, ordering decides nothing and the ordinals below are
                not rendered at all. */}
            {!policiesQuery.isError && policies.length > 0 && (
              <p className="text-xs text-muted-foreground break-words">
                {describeOverlapStatus(overlap)}
              </p>
            )}

            {/* A failed fetch used to render as "No approval rules yet" — on a
                routing screen that is a dangerous lie. */}
            {policiesQuery.isError ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 space-y-2">
                <p className="flex items-start gap-1.5 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{t('policy_editor.list.load_error_title')}</span>
                </p>
                <p className="text-xs text-destructive/90">
                  {t('policy_editor.list.load_error_body')}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => void policiesQuery.refetch()}
                >
                  {t('policy_editor.list.retry')}
                </Button>
              </div>
            ) : policiesQuery.isPending || !ctx.directoryReady ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : (
              <>
                {/* 6 — There is no "empty". A workspace with zero rules is
                    already routing every request somewhere, and this line says
                    where before the Everything-else row shows the people. */}
                {policies.length === 0 && (
                  <p className="text-sm text-muted-foreground break-words">
                    {t('policy_editor.list.empty_now_routing')}
                  </p>
                )}

                <ul role="list" className="space-y-2">
                  {policies.map((p, i) => (
                    <ApprovalRuleRow
                      key={p.id}
                      policy={p}
                      steps={stepsByPolicy.get(p.id) ?? []}
                      members={ctx.members}
                      roleHolders={ctx.roleHolders}
                      overlap={overlap.byRuleId.get(p.id) ?? null}
                      /* 4 — POSITION, NEVER A NUMBER: the ordinal is omitted
                         entirely when no two checked rules can co-match. */
                      ordinal={overlap.anyOverlap ? i + 1 : undefined}
                      ordinalTotal={overlap.anyOverlap ? policies.length : undefined}
                      assetTypeOptions={assetTypeOptions}
                      editHref={`/app/settings/approval-policies/${p.id}`}
                      canMoveUp={i > 0}
                      canMoveDown={i < policies.length - 1}
                      busy={order.busy || busyId === p.id}
                      onMoveUp={() => order.move('up', p.id)}
                      onMoveDown={() => order.move('down', p.id)}
                      onMoveToTop={() => order.move('top', p.id)}
                      onMoveToBottom={() => order.move('bottom', p.id)}
                      onTogglePaused={(next) => void setPaused(p, next)}
                      onDelete={() => setPendingDelete({ id: p.id, name: p.name })}
                      className="scroll-mt-24"
                    />
                  ))}

                  {/* 3 — ALWAYS LAST, ALWAYS PRESENT. The whole list is gated
                      on `directoryReady` above, so the role map is resolved by
                      the time this renders — an empty map would tell an admin
                      that nobody reviews lease requests when someone does. */}
                  <ApprovalEverythingElseRow
                    id="approval-everything-else"
                    members={ctx.members}
                    roleHolders={ctx.roleHolders}
                    approvalThreshold={ctx.approvalThreshold}
                    covenantThreshold={workspaceQuery.data?.covenantThreshold ?? null}
                    hasAnyRules={hasActiveRules}
                    wideGutter={overlap.anyOverlap}
                    onPickApprovers={() => navigate(APPROVAL_ROLES_HREF)}
                    className="scroll-mt-24"
                  />

                </ul>

                {/* One announcement per settled reorder — the moved rule is
                    named, and so is where it landed. */}
                <div aria-live="polite" aria-atomic="true" className="sr-only">
                  {order.announcement}
                </div>
                {order.busy && (
                  <p className="text-xs text-muted-foreground">{t('policy_editor.order.saving')}</p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* 7 — SEPARATION OF DUTIES, DEMOTED. Advanced, rare, and off by
            default: one muted line below the card rather than the first card on
            the screen. It stays on THIS page because it constrains the rules on
            this page. */}
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground break-words">
              {t('policy_editor.sod_label')}
            </p>
            <p className="text-xs text-muted-foreground/80 mt-0.5 break-words">
              {t('policy_editor.list.sod_toggle_desc')}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:shrink-0">
            <span className="text-xs text-muted-foreground">
              {workspaceQuery.data?.sodDefault
                ? t('policy_editor.list.sod_on')
                : t('policy_editor.list.sod_off')}
            </span>
            <Switch
              checked={Boolean(workspaceQuery.data?.sodDefault)}
              onCheckedChange={(v) => void toggleSodDefault(v)}
              disabled={workspaceQuery.isPending}
              aria-label={t('policy_editor.sod_label')}
            />
          </div>
        </div>
      </PageLayout>

      {/* 8 — D-Q4: the dialog asks the database whether this rule ever routed a
          request before it offers to delete anything. */}
      <ApprovalRuleDeleteDialog
        rule={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirmDelete={hardDelete}
        onTurnOff={turnOffInstead}
      />
    </AppLayout>
  );
}
