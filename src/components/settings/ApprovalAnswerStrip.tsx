// ─────────────────────────────────────────────────────────────────────────
// ApprovalAnswerStrip — the permanent "answer strip" hero.
//
// THE THESIS (spec: mentalModel): "I describe a lease, the page names the
// people who must sign off on it, and the rules underneath are the explanation
// for that answer." So this strip ANSWERS BEFORE THE USER TOUCHES ANYTHING —
// it seeds itself from the workspace's own recent leases and resolves on mount.
// A blank box with a Run button would make the admin do the work of proving the
// page's own claim.
//
// IT NEVER RE-IMPLEMENTS MATCHING. Every answer comes from the same
// `preview_policy_resolution` RPC the request form and the engine agree with.
// Matching logic in the client would be a second source of routing truth and
// would drift from the engine the first time either changed.
//
// SELF-CONTAINED BY DESIGN: it owns its queries so both the rules list page and
// (later) the editor can mount it with a workspace id and two callbacks. The
// optional `rules` / `assetTypeOptions` props exist only so a parent that has
// already fetched them can hand them over instead of paying for them twice.
//
// REGION / LEASE TYPE ARE NOT INPUTS (D-Q2). Intake collects neither —
// LeaseRequestForm sends `p_region: ''` and `p_lease_type: ''` — so a hero that
// offered them would answer a what-if a real request can never produce. This
// strip sends '' for both, exactly like intake.
//
// i18n: describeApprover/describeChain render through the i18next singleton at
// CALL TIME, so nothing here memoizes their output. The panel re-renders on a
// language change and the prose follows.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useApprovalAnswerContext } from '@/hooks/useApprovalAnswerContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { buildAssetTypeOptions, type AssetTypeOption } from '@/lib/assetTypes';
import {
  buildHeroSeed,
  seedFromRule,
  shouldReseedFromRule,
  topActiveRule,
  type HeroInputs,
  type HeroSeedSource,
  type HeroSeedRule,
} from '@/lib/approvalHeroSeed';
import { ApprovalAnswerInputs } from '@/components/settings/ApprovalAnswerInputs';
import { ApprovalAnswerPanel } from '@/components/settings/ApprovalAnswerPanel';
import type { PreviewResolution } from '@/components/settings/approvalAnswerTypes';

export interface ApprovalAnswerStripProps {
  /** Null while the workspace is still resolving; the strip renders its
   *  skeleton and makes no calls. */
  workspaceId: string | null;
  /** The because-line's rule name is a BUTTON; this is what it does. Omit it
   *  and the name renders as plain text rather than a dead control. */
  onOpenRule?: (ruleId: string) => void;
  /** Invoked by the "Pick who approves" action when nothing would route the
   *  request. The list page scrolls to and focuses the Everything-else CTA. */
  onPickDefaultApprovers?: () => void;
  /** The workspace's rules IN ENGINE ORDER (priority DESC, created_at ASC,
   *  id ASC). Pass what the page already fetched; omitted, the strip fetches a
   *  minimal copy itself. Order is load-bearing — it decides the fallback seed
   *  and the "rules exist" distinction, so an unsorted array is a bug. */
  rules?: HeroSeedRule[];
  /** Workspace-resolved asset options; defaults to the built-ins plus the
   *  workspace's own Asset Types once the settings row loads. */
  assetTypeOptions?: AssetTypeOption[];
  /** 'card' (default) draws its own Card; 'bare' renders the contents only,
   *  for embedding inside an existing card (the editor's live strip). */
  variant?: 'card' | 'bare';
  className?: string;
}

const DEBOUNCE_MS = 300;

export function ApprovalAnswerStrip({
  workspaceId,
  onOpenRule,
  onPickDefaultApprovers,
  rules: rulesProp,
  assetTypeOptions: assetOptionsProp,
  variant = 'card',
  className,
}: ApprovalAnswerStripProps) {
  const { t, language } = useAppTranslation();
  const enabled = !!workspaceId;
  // Unique per instance: the list page and the editor's live strip can both be
  // mounted, and duplicate input ids would break every label association.
  const uid = useId();
  const assetId = `${uid}-asset`;
  const deptId = `${uid}-dept`;
  const deptListId = `${uid}-dept-options`;
  const amountId = `${uid}-amount`;

  // Every read this surface needs — option lists, the people directory, and
  // the two seed sources — lives in one hook so this component stays state +
  // layout only.
  const ctx = useApprovalAnswerContext(workspaceId, rulesProp);
  const { rules, members, roleHolders, departments } = ctx;
  const assetOptions = assetOptionsProp ?? buildAssetTypeOptions(ctx.assetTypeConfig);

  // ── seed once every source has settled ───────────────────────────────
  const [inputs, setInputs] = useState<HeroInputs | null>(null);
  const [seedSource, setSeedSource] = useState<HeroSeedSource>('defaults');
  const [touched, setTouched] = useState(false);
  const reseededRef = useRef(false);

  useEffect(() => {
    if (!ctx.seedReady || inputs) return;
    const seed = buildHeroSeed({
      leases: ctx.leases,
      rules,
      assetTypeOptions: assetOptions,
      departmentOptions: departments,
    });
    setInputs(seed.inputs);
    setSeedSource(seed.source);
  }, [ctx.seedReady, ctx.leases, inputs, rules, assetOptions, departments]);

  // ── resolve, debounced, keeping the previous answer visible ──────────
  const serialized = useMemo(
    () => (inputs ? JSON.stringify([inputs.assetType, inputs.department, inputs.annualCost]) : ''),
    [inputs],
  );
  const debounced = useDebounced(serialized, DEBOUNCE_MS);

  const previewQuery = useQuery({
    queryKey: ['approval-hero-preview', workspaceId, debounced],
    enabled: enabled && debounced !== '',
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<PreviewResolution> => {
      const [assetType, department, annualCost] = JSON.parse(debounced) as [string, string, number];
      const { data, error } = await supabase.rpc('preview_policy_resolution', {
        p_workspace_id: workspaceId!,
        p_asset_type: assetType,
        p_department: department,
        p_annual_cost: annualCost,
        // Retired dimensions — intake sends '' for both, and so do we.
        p_region: '',
        p_lease_type: '',
      });
      if (error) throw error;
      return data as unknown as PreviewResolution;
    },
  });

  const result = (previewQuery.data as PreviewResolution | undefined) ?? null;
  // Surfaced even when a previous answer is still cached: showing a stale
  // answer for inputs we could NOT resolve is the one thing this surface must
  // never do. React Query has already retried before isError flips.
  const resolveFailed = previewQuery.isError;

  // Ladder rung (i): a lease-derived seed that matches nothing, while rules
  // exist, opens the page on what looks like breakage. Re-seed ONCE from the
  // first rule the engine checks so the first render demonstrates a real route.
  useEffect(() => {
    if (!result || !inputs) return;
    const should = shouldReseedFromRule({
      source: seedSource,
      matched: result.matched,
      untouched: !touched,
      alreadyReseeded: reseededRef.current,
      rules,
    });
    if (!should) return;
    const top = topActiveRule(rules);
    if (!top) return;
    reseededRef.current = true;
    setInputs(seedFromRule(top, assetOptions, departments));
    setSeedSource('rule');
  }, [result, inputs, seedSource, touched, rules, assetOptions, departments]);

  const update = (patch: Partial<HeroInputs>) => {
    setTouched(true);
    setInputs((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const seedCaption = touched
    ? null
    : seedSource === 'leases'
      ? t('policy_editor.hero.seed_caption_leases', {
          defaultValue: 'Showing a typical request from your leases. Change any part of it.',
        })
      : seedSource === 'rule'
        ? t('policy_editor.hero.seed_caption_rule', {
            defaultValue:
              'Showing a request your first rule covers. Change any part of it.',
          })
        : t('policy_editor.hero.seed_caption_default', {
            defaultValue: 'Showing an example request. Change any part of it.',
          });

  const body = (
    <div
      className={cn(
        'grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]',
        // Inputs first, answer second: below the split the answer stacks BELOW
        // its own controls, so it is never an empty box above the thing that
        // fills it. `minmax(0,1fr)` lets long prose wrap instead of overflowing.
        //
        // #210 — the split is `xl` (1280px), NOT `lg`. This page sits beside a
        // ~305px sidebar, so a 1024px viewport leaves only ~720px of content:
        // a FIXED 400px answer column left ~300px for three side-by-side
        // inputs — about 100px each — and crushed the page's hero at its first
        // paint on an ordinary laptop. At `xl` the content is ~975px, and the
        // answer column is now a RANGE (320-420px) so it yields instead of
        // starving the controls. If the sidebar width ever changes, re-check
        // this breakpoint: the constraint is content width, not viewport width.
        variant === 'bare' && className,
      )}
    >
      <ApprovalAnswerInputs
        value={inputs}
        onChange={update}
        assetOptions={assetOptions}
        departments={departments}
        caption={seedCaption}
        ids={{
          asset: assetId,
          department: deptId,
          departmentList: deptListId,
          amount: amountId,
        }}
      />

      <ApprovalAnswerPanel
        result={result}
        busy={previewQuery.isFetching || serialized !== debounced}
        failed={resolveFailed}
        onRetry={() => void previewQuery.refetch()}
        directory={{ members, roleHolders }}
        hasActiveRules={topActiveRule(rules) !== null}
        approvalThreshold={ctx.approvalThreshold}
        language={language}
        onOpenRule={onOpenRule}
        onPickDefaultApprovers={onPickDefaultApprovers}
      />
    </div>
  );

  if (variant === 'bare') return body;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0 space-y-1.5">
          <CardTitle>
            {t('policy_editor.hero.card_title', { defaultValue: 'Check a request' })}
          </CardTitle>
          <CardDescription>
            {t('policy_editor.hero.card_desc', {
              defaultValue: 'Describe a lease and see exactly who has to sign off on it.',
            })}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
