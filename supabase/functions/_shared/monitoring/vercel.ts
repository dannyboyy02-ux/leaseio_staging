// Vercel monitoring adapter — Phase 2 of OPERATIONAL_MONITORING_SPEC.md
//
// LeaseIO is on Vercel Pro per cost model; alerts here are about
// spend creep on Pro overage, not service shutoff. Tracks:
//   - bandwidth_30d_gb         soft_quota
//   - function_invocations_30d soft_quota
//   - build_minutes_30d        soft_quota
//
// Auth: VERCEL_ACCESS_TOKEN (operator generates at
// https://vercel.com/account/tokens; read-only scope is sufficient).
//
// The Vercel Usage API returns cumulative usage for the current
// billing period; we treat that as the 30-day window even though
// billing periods aren't strictly 30 days. Acceptable for
// operator-facing alerts.

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const VERCEL_API = 'https://api.vercel.com';
const PRO_LIMITS = {
  bandwidth_30d_gb: 1000,
  function_invocations_30d: 1_000_000,
  build_minutes_30d: 24_000,
} as const;
const HOBBY_LIMITS = {
  bandwidth_30d_gb: 100,
  function_invocations_30d: 100_000,
  build_minutes_30d: 6_000,
} as const;

export class VercelAdapter implements MonitoringAdapter {
  readonly vendor = 'vercel';
  private readonly token: string;
  private readonly teamId?: string;
  private readonly tier: 'pro' | 'hobby';

  constructor(opts: { accessToken: string; teamId?: string; tier?: 'pro' | 'hobby' }) {
    this.token = opts.accessToken;
    this.teamId = opts.teamId;
    this.tier = opts.tier ?? 'pro';
  }

  private async fetchJson(path: string): Promise<any | null> {
    const url = new URL(`${VERCEL_API}${path}`);
    if (this.teamId) url.searchParams.set('teamId', this.teamId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      console.error(`[monitoring:vercel] ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return await res.json();
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    // Vercel exposes usage at /v1/teams/{teamId}/billing or
    // /v3/usage depending on account type. The most stable shape
    // is the billing summary endpoint when scoped to a team. v1 of
    // this adapter uses /v1/usage as a reasonable starting point;
    // adjust the path here if the real endpoint diverges from what's
    // in the cost model — the snapshot mapping logic is independent.
    const usage = await this.fetchJson('/v1/usage');
    if (!usage) return [];

    const limits = this.tier === 'pro' ? PRO_LIMITS : HOBBY_LIMITS;
    const tierLabel = this.tier;
    const snapshots: VendorUsageSnapshot[] = [];

    function num(value: unknown): number | null {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value !== '') {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
      }
      return null;
    }

    // Bandwidth usually reported in bytes; normalize to GB.
    const bandwidthBytes = num((usage as any)?.bandwidth?.value)
      ?? num((usage as any)?.bandwidth)
      ?? num((usage as any)?.bandwidth_bytes);
    if (bandwidthBytes !== null) {
      const bandwidthGb = bandwidthBytes / (1024 * 1024 * 1024);
      snapshots.push({
        vendor: 'vercel',
        metric: 'bandwidth_30d_gb',
        current_value: Math.round(bandwidthGb * 1000) / 1000,
        limit_value: limits.bandwidth_30d_gb,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const invocations = num((usage as any)?.serverlessFunctionExecution)
      ?? num((usage as any)?.function_invocations)
      ?? num((usage as any)?.invocations);
    if (invocations !== null) {
      snapshots.push({
        vendor: 'vercel',
        metric: 'function_invocations_30d',
        current_value: invocations,
        limit_value: limits.function_invocations_30d,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    const buildMinutes = num((usage as any)?.buildMinutes)
      ?? num((usage as any)?.build_minutes)
      ?? num((usage as any)?.deploymentBuildTime);
    if (buildMinutes !== null) {
      snapshots.push({
        vendor: 'vercel',
        metric: 'build_minutes_30d',
        current_value: buildMinutes,
        limit_value: limits.build_minutes_30d,
        tier: tierLabel,
        category: 'soft_quota',
      });
    }

    return snapshots;
  }
}
