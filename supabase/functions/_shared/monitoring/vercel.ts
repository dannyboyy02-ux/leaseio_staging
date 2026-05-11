// Vercel monitoring adapter — REWRITTEN 2026-05-11 after Phase 3
// probe revealed that Vercel does NOT expose a clean public usage
// API.
//
// What we observed via the live probe:
//   - /v2/user                    → 200, user metadata only
//   - /v2/teams                   → 200, team list with pagination
//   - /v9/projects                → 200, project list with pagination
//   - /v1/usage                   → never existed (the spec guessed)
//   - /v1/teams/{id}/billing/usage→ also doesn't return numbers we
//                                   can use, even with team auth
//
// Vercel intentionally locks usage data behind their billing
// dashboard at vercel.com/{team}/usage. The pragmatic v1 answer:
// surface auth-check + project count as a "signal of life" and
// rely on Vercel's own dashboard alerts for actual bandwidth /
// function / build-minute overages.
//
// What this means operationally: the monitoring's role for Vercel
// is "is the integration alive and our project list reachable" —
// it does NOT prevent surprise bandwidth bills. Vercel sends those
// alerts themselves; ensure the billing email on the Vercel account
// is one Daniel actively monitors (Phase 1 Stop 2 / registrar
// hardening covers this for the domain, applies equivalently here).
//
// Auth: VERCEL_ACCESS_TOKEN env var.

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const VERCEL_API = 'https://api.vercel.com';

export class VercelAdapter implements MonitoringAdapter {
  readonly vendor = 'vercel';
  private readonly token: string;
  private readonly teamId?: string;

  constructor(opts: { accessToken: string; teamId?: string; tier?: 'pro' | 'hobby' }) {
    this.token = opts.accessToken;
    this.teamId = opts.teamId;
    // tier kept in the constructor signature for future use; not
    // currently differentiated since we can't query the real usage.
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    const snapshots: VendorUsageSnapshot[] = [];

    // ── Auth probe — list projects ──
    try {
      const url = new URL(`${VERCEL_API}/v9/projects`);
      if (this.teamId) url.searchParams.set('teamId', this.teamId);
      url.searchParams.set('limit', '100');
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) {
        console.warn(`[monitoring:vercel] /v9/projects returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return [];
      }
      const data = await res.json() as { projects?: any[]; pagination?: any };
      const projectCount = Array.isArray(data.projects) ? data.projects.length : 0;
      // "auth_alive" — a synthetic snapshot that proves the Vercel
      // integration is configured + reachable. limit_value=0
      // (boolean-shaped) so threshold logic emits no false alarms.
      // The dashboard surfaces this as "Vercel: <N> projects".
      snapshots.push({
        vendor: 'vercel',
        metric: 'project_count',
        current_value: projectCount,
        limit_value: null,
        tier: 'pro',
        category: 'soft_quota',
        metadata: {
          note: 'Vercel does not expose public usage API; bandwidth/function/build-minute monitoring relies on Vercel dashboard alerts. This snapshot proves the integration is alive.',
          team_id: this.teamId,
        },
      });
    } catch (err) {
      console.warn('[monitoring:vercel] project list threw:', err);
    }

    return snapshots;
  }
}
