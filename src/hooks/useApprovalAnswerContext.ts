// ─────────────────────────────────────────────────────────────────────────
// useApprovalAnswerContext — every read the approval "answer strip" needs,
// in one hook, so the strip component itself holds only state and layout.
//
// FIVE READS, ONE PURPOSE: turn a workspace id into (a) the option lists the
// what-if inputs offer, (b) the directory that resolves ids and role tokens to
// PEOPLE, and (c) the two seed sources (recent leases, then the rules in the
// engine's own evaluation order).
//
// The `workspace_roles` read is the one the old list page never made — it is
// why "Anyone with role" and raw ids reached users, and why the Everything-else
// row could not name a single human. Every surface that answers "who approves
// this?" needs it.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { buildRoleHolderMap, type MemberLike, type RoleHolderMap } from '@/lib/approvalDescribe';
import type { HeroLeaseSample, HeroSeedRule } from '@/lib/approvalHeroSeed';

export interface ApprovalAnswerContext {
  departments: string[];
  /** workspaces.asset_type_config — the workspace's own Asset Types. */
  assetTypeConfig: string[];
  /** Compared by the engine against total cash commitment over the FULL TERM. */
  approvalThreshold: number | null;
  members: MemberLike[];
  roleHolders: RoleHolderMap;
  leases: HeroLeaseSample[];
  /** In the engine's exact total order: priority DESC, created_at ASC, id ASC. */
  rules: HeroSeedRule[];
  /** Every seed source has settled — safe to compute the opening sample. */
  seedReady: boolean;
  /** `members` AND `roleHolders` have settled. Load-bearing and separate from
   *  `seedReady`: an empty role map resolves every role slot to "nobody holds
   *  this role", which is the DESTRUCTIVE state on both the rule rows and the
   *  Everything-else row. Rendering either before this is true tells an admin
   *  that lease requests are unreviewed when they are not. */
  directoryReady: boolean;
}

export function useApprovalAnswerContext(
  workspaceId: string | null,
  /** Rules the caller already fetched (engine order). Skips the rules read. */
  rulesOverride?: HeroSeedRule[],
): ApprovalAnswerContext {
  const enabled = !!workspaceId;

  const settingsQuery = useQuery({
    queryKey: ['approval-answer-settings', workspaceId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspaces')
        .select('department_options, asset_type_config, approval_threshold')
        .eq('id', workspaceId!)
        .maybeSingle();
      if (error) throw error;
      return {
        departments: ((data?.department_options ?? []) as string[]) ?? [],
        assetTypeConfig: ((data?.asset_type_config ?? []) as string[]) ?? [],
        approvalThreshold: (data?.approval_threshold ?? null) as number | null,
      };
    },
  });

  const membersQuery = useQuery({
    queryKey: ['approval-answer-members', workspaceId],
    enabled,
    queryFn: async (): Promise<MemberLike[]> => {
      const { data: rows, error } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId!);
      if (error) throw error;
      const ids = (rows ?? []).map((r) => r.user_id).filter(Boolean);
      if (ids.length === 0) return [];
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', ids);
      if (pErr) throw pErr;
      // Same label composition as the policy editor's member list.
      // approvalDescribe strips the "(email)" tail and refuses an id-shaped
      // label, so a profile with neither name nor email degrades to "Former
      // member" rather than leaking a UUID.
      return (profiles ?? []).map((p) => ({
        id: p.id,
        label:
          p.first_name && p.last_name
            ? `${p.first_name} ${p.last_name} (${p.email ?? ''})`
            : (p.email ?? ''),
      }));
    },
  });

  const rolesQuery = useQuery({
    queryKey: ['approval-answer-roles', workspaceId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_roles')
        .select('role, user_id')
        .eq('workspace_id', workspaceId!);
      if (error) throw error;
      return (data ?? []) as Array<{ role: string; user_id: string }>;
    },
  });

  const leasesQuery = useQuery({
    queryKey: ['approval-answer-lease-seed', workspaceId],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<HeroLeaseSample[]> => {
      const { data, error } = await supabase
        .from('leases')
        .select('asset_type, requesting_department, monthly_payment')
        .eq('workspace_id', workspaceId!)
        // Soft-deleted leases are already hidden by the restrictive RLS policy;
        // the explicit filter documents the intent and survives a policy change.
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as HeroLeaseSample[];
    },
  });

  const rulesQuery = useQuery({
    queryKey: ['approval-answer-rules', workspaceId],
    enabled: enabled && rulesOverride === undefined,
    queryFn: async (): Promise<HeroSeedRule[]> => {
      const { data, error } = await supabase
        .from('approval_policies')
        .select(
          'id, is_active, match_asset_types, match_departments, match_min_annual_cost, match_max_annual_cost',
        )
        .eq('workspace_id', workspaceId!)
        // The engine's exact total order — the `id` key included, so the rule
        // we seed from is genuinely the first one the engine would check.
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return (data ?? []) as HeroSeedRule[];
    },
  });

  const roleRows = rolesQuery.data;
  const roleHolders = useMemo(() => buildRoleHolderMap(roleRows ?? []), [roleRows]);

  return {
    departments: settingsQuery.data?.departments ?? [],
    assetTypeConfig: settingsQuery.data?.assetTypeConfig ?? [],
    approvalThreshold: settingsQuery.data?.approvalThreshold ?? null,
    members: membersQuery.data ?? [],
    roleHolders,
    leases: leasesQuery.data ?? [],
    rules: rulesOverride ?? rulesQuery.data ?? [],
    seedReady:
      enabled &&
      !settingsQuery.isPending &&
      !leasesQuery.isPending &&
      (rulesOverride !== undefined || !rulesQuery.isPending),
    directoryReady: enabled && !membersQuery.isPending && !rolesQuery.isPending,
  };
}
