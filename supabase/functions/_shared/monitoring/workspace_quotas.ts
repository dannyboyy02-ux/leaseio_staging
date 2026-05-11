// Workspace quota poller — Phase 3 of OPERATIONAL_MONITORING_SPEC.md
//
// Iterates workspaces, computes per-workspace usage against
// per-tier limits, writes to workspace_quota_snapshots. Used by the
// QuotaWarningBanner customer-facing surface.
//
// Tier limits mirror src/config/pricing.ts:
//   - starter: maxActiveLeases 15, maxArchivedLeases 50,
//              abstractionsIncluded 15, maxUsers 3
//   - business: maxActiveLeases 50, maxArchivedLeases 250,
//              abstractionsIncluded 50, maxUsers -1 (unlimited)
//
// Metrics tracked (v1):
//   - active_leases               soft_quota
//   - archived_leases             soft_quota
//   - monthly_extractions         soft_quota
//   - member_count                soft_quota (skipped for unlimited tiers)
//
// Out of scope for v1: document_storage_bytes (no per-workspace cap
// in pricing config; would need infra-level allocation) and
// monthly_email_intake_events (Email Intake not yet shipped).

// Loosely-typed Supabase client — see supabase.ts adapter for the
// Deno generic-resolution rationale.
type SupabaseLikeClient = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface WorkspaceQuotaSnapshot {
  workspace_id: string;
  metric: string;
  current_value: number;
  limit_value: number | null;
  pct_of_limit: number | null;
  tier: string;
  category: 'soft_quota' | 'hard_cliff' | 'cost_runaway';
  metadata?: Record<string, unknown>;
}

interface TierLimits {
  active_leases: number;
  archived_leases: number;
  monthly_extractions: number;
  members: number; // -1 = unlimited
}

const TIER_LIMITS: Record<string, TierLimits> = {
  starter: { active_leases: 15, archived_leases: 50, monthly_extractions: 15, members: 3 },
  business: { active_leases: 50, archived_leases: 250, monthly_extractions: 50, members: -1 },
};

function pctOf(current: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.round((current / limit) * 10000) / 100;
}

export async function pollWorkspaceQuotas(
  supabaseAdmin: SupabaseLikeClient,
): Promise<WorkspaceQuotaSnapshot[]> {
  const { data: workspaces, error: wsErr } = await supabaseAdmin
    .from('workspaces')
    .select('id, plan')
    .limit(1000);

  if (wsErr || !workspaces) {
    console.error('[workspace-quotas] workspace fetch failed:', wsErr?.message);
    return [];
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const out: WorkspaceQuotaSnapshot[] = [];

  for (const w of workspaces as Array<{ id: string; plan: string | null }>) {
    const tier = (w.plan === 'business' ? 'business' : 'starter');
    const limits = TIER_LIMITS[tier];

    // Active leases (lifecycle_status = 'active', not archived)
    const { count: activeCount } = await supabaseAdmin
      .from('leases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id)
      .eq('lifecycle_status', 'active')
      .eq('archived', false);
    const active = activeCount ?? 0;

    // Archived leases
    const { count: archivedCount } = await supabaseAdmin
      .from('leases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id)
      .eq('archived', true);
    const archived = archivedCount ?? 0;

    // Monthly extractions: count leases created in last 30 days
    // with a non-null extracted_json (proxy for "an extraction ran").
    // Note: this is conservative — it counts unique leases not
    // unique extraction calls, so a re-extracted lease counts once.
    // Acceptable approximation; the exact billable-extraction count
    // is what Stripe + the tier-overage logic uses, which can
    // diverge from this snapshot by intent.
    const { count: extractionCount } = await supabaseAdmin
      .from('leases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id)
      .gte('created_at', since30d)
      .not('extracted_json', 'is', null);
    const extractions = extractionCount ?? 0;

    // Member count
    const { count: memberCount } = await supabaseAdmin
      .from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', w.id);
    const members = memberCount ?? 0;

    out.push({
      workspace_id: w.id,
      metric: 'active_leases',
      current_value: active,
      limit_value: limits.active_leases,
      pct_of_limit: pctOf(active, limits.active_leases),
      tier,
      category: 'soft_quota',
    });

    out.push({
      workspace_id: w.id,
      metric: 'archived_leases',
      current_value: archived,
      limit_value: limits.archived_leases,
      pct_of_limit: pctOf(archived, limits.archived_leases),
      tier,
      category: 'soft_quota',
    });

    out.push({
      workspace_id: w.id,
      metric: 'monthly_extractions',
      current_value: extractions,
      limit_value: limits.monthly_extractions,
      pct_of_limit: pctOf(extractions, limits.monthly_extractions),
      tier,
      category: 'soft_quota',
      metadata: { window: '30d', proxy: 'leases_with_extracted_json' },
    });

    // Members metric only when the tier has a finite cap
    if (limits.members > 0) {
      out.push({
        workspace_id: w.id,
        metric: 'member_count',
        current_value: members,
        limit_value: limits.members,
        pct_of_limit: pctOf(members, limits.members),
        tier,
        category: 'soft_quota',
      });
    } else {
      out.push({
        workspace_id: w.id,
        metric: 'member_count',
        current_value: members,
        limit_value: null,
        pct_of_limit: null,
        tier,
        category: 'soft_quota',
        metadata: { note: 'tier has unlimited members' },
      });
    }
  }

  return out;
}
