// Supabase monitoring adapter — REWRITTEN 2026-05-11 after Phase 3
// probe revealed the spec-suggested Management API usage endpoints
// don't actually exist publicly.
//
// What we observed via the live probe (commit history has the probe
// function that captured this):
//   - /v1/projects/{ref}                      → 200, project metadata
//                                               including `status` (perfect
//                                               for the paused-status check)
//   - /v1/projects/{ref}/usage                → never existed (the spec
//                                               was wrong)
//   - /v1/organizations/{slug}/usage          → 404
//   - /v1/organizations/{slug}/billing/...    → 404
//
// So the Management API gives us project status only. For actual
// usage metrics we query Postgres directly:
//   - db_size_bytes via pg_database_size()
//   - storage_bytes via SUM over storage.objects metadata
//
// What we can't get cleanly at v1: egress_30d_bytes,
// edge_invocations_30d, monthly_active_users. These live in
// Supabase's internal billing system and aren't on the public
// Management API. Operator picks these up from the Supabase Dashboard
// quarterly (annual reminder in vendor_renewal_calendar).
//
// Auth: MANAGEMENT_API_TOKEN env var for the project-status check.
// supabaseAdmin client (passed in) for direct SQL.

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

// Loosely-typed Supabase client. The strict `ReturnType<typeof createClient>`
// trips on Deno's generic resolution when the function imports its own
// createClient with the same version pin (the generics resolve differently
// across module boundaries). Runtime is well-tested via smoke; this `any`
// is a Deno typing pragma, not a correctness loss.
type SupabaseLikeClient = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const MGMT_API = 'https://api.supabase.com';

// Pro-tier limits per the cost model. Free-tier kept as reference.
const LIMITS = {
  free: {
    db_size_bytes: 500 * 1024 * 1024,            // 500 MB
    storage_bytes: 1 * 1024 * 1024 * 1024,       // 1 GB
  },
  pro: {
    db_size_bytes: 8 * 1024 * 1024 * 1024,       // 8 GB
    storage_bytes: 100 * 1024 * 1024 * 1024,     // 100 GB
  },
} as const;

export class SupabaseAdapter implements MonitoringAdapter {
  readonly vendor = 'supabase';
  private readonly managementToken: string;
  private readonly projectRef: string;
  private readonly tier: keyof typeof LIMITS;
  private readonly supabaseAdmin: SupabaseLikeClient;

  constructor(opts: {
    managementToken: string;
    projectRef: string;
    tier?: keyof typeof LIMITS;
    supabaseAdmin: SupabaseLikeClient;
  }) {
    this.managementToken = opts.managementToken;
    this.projectRef = opts.projectRef;
    this.tier = opts.tier ?? 'pro';
    this.supabaseAdmin = opts.supabaseAdmin;
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    const limits = LIMITS[this.tier];
    const snapshots: VendorUsageSnapshot[] = [];

    // ── Project status (paused_status check via Management API) ──
    try {
      const res = await fetch(`${MGMT_API}/v1/projects/${this.projectRef}`, {
        headers: { Authorization: `Bearer ${this.managementToken}` },
      });
      if (res.ok) {
        const data = await res.json() as { status?: string; name?: string };
        const status = data.status ?? 'UNKNOWN';
        const isActive = status === 'ACTIVE_HEALTHY' || status === 'ACTIVE';
        snapshots.push({
          vendor: 'supabase',
          metric: 'paused_status',
          current_value: isActive ? 0 : 1,
          limit_value: 0.5,  // any non-active value crosses threshold
          tier: this.tier,
          category: 'hard_cliff',
          metadata: { project_status: status, project_name: data.name },
        });
      } else {
        console.warn(`[monitoring:supabase] /v1/projects/${this.projectRef} returned ${res.status}`);
      }
    } catch (err) {
      console.warn('[monitoring:supabase] project status fetch threw:', err);
    }

    // ── DB size via direct SQL (no public Management API endpoint) ──
    try {
      const { data, error } = await this.supabaseAdmin
        .rpc('pg_database_size_postgres' as any);
      // The RPC might not exist; fall back to a raw query via the
      // PostgREST table-with-views pattern. The cleanest is just to
      // create a tiny SECURITY DEFINER view if we want this often;
      // for v1, swallow errors and skip the metric.
      if (!error && data !== null && data !== undefined) {
        const size = Number(data);
        if (Number.isFinite(size)) {
          snapshots.push({
            vendor: 'supabase',
            metric: 'db_size_bytes',
            current_value: size,
            limit_value: limits.db_size_bytes,
            tier: this.tier,
            category: 'soft_quota',
            metadata: { source: 'pg_database_size(postgres)' },
          });
        }
      }
    } catch (err) {
      // RPC doesn't exist — that's the expected path until the
      // migration adding pg_database_size_postgres lands. Logged
      // benignly.
      console.warn('[monitoring:supabase] pg_database_size RPC unavailable:', err instanceof Error ? err.message : err);
    }

    // ── Storage size via SUM over storage.objects metadata ──
    try {
      const { data, error } = await this.supabaseAdmin
        .from('storage.objects' as any)
        .select('metadata');
      if (!error && Array.isArray(data)) {
        let totalBytes = 0;
        for (const row of data) {
          const m = (row as any)?.metadata;
          const size = Number(m?.size);
          if (Number.isFinite(size)) totalBytes += size;
        }
        snapshots.push({
          vendor: 'supabase',
          metric: 'storage_bytes',
          current_value: totalBytes,
          limit_value: limits.storage_bytes,
          tier: this.tier,
          category: 'soft_quota',
          metadata: { source: 'sum(storage.objects.metadata.size)', object_count: data.length },
        });
      }
    } catch (err) {
      console.warn('[monitoring:supabase] storage.objects sum threw:', err instanceof Error ? err.message : err);
    }

    return snapshots;
  }
}
