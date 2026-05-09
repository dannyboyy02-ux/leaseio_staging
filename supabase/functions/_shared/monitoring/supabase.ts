// Supabase monitoring adapter — Phase 2 of OPERATIONAL_MONITORING_SPEC.md
//
// Polls the Supabase Management API for project usage. Tracks five
// metrics against tier caps:
//   - db_size_bytes              soft_quota
//   - storage_bytes              soft_quota
//   - egress_30d_bytes           soft_quota
//   - edge_invocations_30d       soft_quota
//   - monthly_active_users       soft_quota
//
// Plus the paused_status check (hard_cliff) — a free Supabase project
// pauses after 7 days of inactivity. Once you have customers, this
// should never happen, but during development it can.
//
// Auth: SUPABASE_MANAGEMENT_TOKEN (operator generates at
// https://supabase.com/dashboard/account/tokens; read-only scope is
// sufficient).

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const MGMT_API = 'https://api.supabase.com';

// Tier limits per the spec (free vs pro). v1 assumes the project is
// on Pro per the cost model. The free-tier values are kept for the
// rare case where someone re-checks against a free project.
const LIMITS = {
  free: {
    db_size_bytes: 500 * 1024 * 1024,                  // 500 MB
    storage_bytes: 1 * 1024 * 1024 * 1024,             // 1 GB
    egress_30d_bytes: 5 * 1024 * 1024 * 1024,          // 5 GB
    edge_invocations_30d: 500_000,
    monthly_active_users: 50_000,
  },
  pro: {
    db_size_bytes: 8 * 1024 * 1024 * 1024,             // 8 GB
    storage_bytes: 100 * 1024 * 1024 * 1024,           // 100 GB
    egress_30d_bytes: 250 * 1024 * 1024 * 1024,        // 250 GB
    edge_invocations_30d: 2_000_000,
    monthly_active_users: 100_000,
  },
} as const;

interface UsagePayload {
  // Supabase Management API returns a flexible structure; key off
  // the metric name. Specific fields vary across project tiers.
  [key: string]: unknown;
}

export class SupabaseAdapter implements MonitoringAdapter {
  readonly vendor = 'supabase';
  private readonly token: string;
  private readonly projectRef: string;
  private readonly tier: keyof typeof LIMITS;

  constructor(opts: { managementToken: string; projectRef: string; tier?: keyof typeof LIMITS }) {
    this.token = opts.managementToken;
    this.projectRef = opts.projectRef;
    this.tier = opts.tier ?? 'pro';
  }

  private async fetchJson(path: string): Promise<UsagePayload | null> {
    const res = await fetch(`${MGMT_API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      console.error(`[monitoring:supabase] ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return await res.json() as UsagePayload;
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    // Project status — for the paused_status hard_cliff check.
    const project = await this.fetchJson(`/v1/projects/${this.projectRef}`);
    const status = (project as any)?.status as string | undefined;

    // Usage bundle. The Management API endpoint shape can vary; we
    // pull and map defensively.
    const usage = await this.fetchJson(`/v1/projects/${this.projectRef}/usage`);
    if (!usage) return [];

    const limits = LIMITS[this.tier];
    const snapshots: VendorUsageSnapshot[] = [];
    const tierLabel = this.tier;

    function pickNumeric(obj: any, ...keys: string[]): number | null {
      for (const key of keys) {
        const v = obj?.[key];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v !== '') {
          const n = Number(v);
          if (!Number.isNaN(n)) return n;
        }
      }
      return null;
    }

    // The exact field names from the Supabase Management API can
    // differ between API revs; pull from a few likely keys. Each
    // snapshot is best-effort — if the field is missing, we skip it
    // rather than emit a 0 that would look like quota usage.
    const dbSize = pickNumeric(usage, 'db_size', 'database_size', 'db_size_bytes');
    if (dbSize !== null) {
      snapshots.push({
        vendor: 'supabase',
        metric: 'db_size_bytes',
        current_value: dbSize,
        limit_value: limits.db_size_bytes,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const storageBytes = pickNumeric(usage, 'storage', 'storage_size', 'storage_bytes');
    if (storageBytes !== null) {
      snapshots.push({
        vendor: 'supabase',
        metric: 'storage_bytes',
        current_value: storageBytes,
        limit_value: limits.storage_bytes,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const egress = pickNumeric(usage, 'egress', 'egress_bytes', 'monthly_egress', 'egress_30d_bytes');
    if (egress !== null) {
      snapshots.push({
        vendor: 'supabase',
        metric: 'egress_30d_bytes',
        current_value: egress,
        limit_value: limits.egress_30d_bytes,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const invocations = pickNumeric(usage, 'edge_function_invocations', 'edge_invocations', 'function_invocations');
    if (invocations !== null) {
      snapshots.push({
        vendor: 'supabase',
        metric: 'edge_invocations_30d',
        current_value: invocations,
        limit_value: limits.edge_invocations_30d,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const mau = pickNumeric(usage, 'monthly_active_users', 'mau');
    if (mau !== null) {
      snapshots.push({
        vendor: 'supabase',
        metric: 'monthly_active_users',
        current_value: mau,
        limit_value: limits.monthly_active_users,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    // Paused-status hard cliff. Encoded as a synthetic 0/1 metric
    // with limit 0.5 so any non-active value crosses critical.
    if (status) {
      const isActive = status === 'ACTIVE_HEALTHY' || status === 'ACTIVE';
      snapshots.push({
        vendor: 'supabase',
        metric: 'paused_status',
        current_value: isActive ? 0 : 1,
        limit_value: 0.5,
        tier: tierLabel,
        category: 'hard_cliff',
        metadata: { project_status: status },
      });
    }

    return snapshots;
  }
}
