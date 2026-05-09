// Anthropic monitoring adapter — Phase 3 of OPERATIONAL_MONITORING_SPEC.md
//
// Tracks the highest-impact cost-runaway signal in the entire stack.
// A bug in process_lease, a misconfigured retry loop, or a
// compromised API key can produce four-figure bills overnight; the
// vendor-side spending cap (Phase 1) is the hard ceiling, this
// adapter is the early-warning siren.
//
// Three snapshots per run per spec:
//   - spend_30d_usd        (cost_runaway, 50/75/90 ladder vs configured cap)
//   - spend_24h_usd        (cost_runaway, no limit; 7d-rolling-avg
//                           comparison happens in alerting logic)
//   - spending_limit_set   (deferred to v1.5 — Anthropic does not
//                           expose the cap value via API; we cannot
//                           verify "limit_still_set_at_intended_value"
//                           from outside the Console)
//
// Auth: ANTHROPIC_ADMIN_API_KEY (distinct from the runtime
// ANTHROPIC_API_KEY; admin key has Organization Reports scope).
// Operator generates at https://console.anthropic.com/settings/keys
//
// Cap configuration: ANTHROPIC_MONTHLY_CAP_USD env var. Operator sets
// this matching the cap configured in the Console (Phase 1
// deliverable). When unset, the spend snapshot has limit_value=null
// and skips threshold evaluation; spend is still recorded for trend
// visibility.

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1';

export class AnthropicAdapter implements MonitoringAdapter {
  readonly vendor = 'anthropic';
  private readonly adminKey: string;
  private readonly monthlyCap: number | null;

  constructor(opts: { adminApiKey: string; monthlyCapUsd?: number | null }) {
    this.adminKey = opts.adminApiKey;
    this.monthlyCap = opts.monthlyCapUsd ?? null;
  }

  private async fetchUsd(sinceIso: string): Promise<number | null> {
    // Anthropic Organization Usage Report endpoint. Returns
    // aggregated cost across the organization. The exact shape of
    // the response has evolved; we read defensively.
    try {
      const url = new URL(`${ANTHROPIC_API}/organizations/usage_report`);
      url.searchParams.set('starting_at', sinceIso);
      const res = await fetch(url.toString(), {
        headers: {
          'x-api-key': this.adminKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        console.error(`[monitoring:anthropic] ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const data = await res.json() as any;
      // The usage report returns either a `data` array (newer) or a
      // top-level `cost` (older). Sum the cost field across rows.
      let total = 0;
      const candidates = [
        Array.isArray(data?.data) ? data.data : null,
        Array.isArray(data?.results) ? data.results : null,
        Array.isArray(data) ? data : null,
      ];
      const rows = candidates.find((c) => c !== null) ?? [];
      for (const row of rows) {
        // Try multiple field names for cost
        const cost = row?.cost_usd ?? row?.cost ?? row?.amount_usd ?? row?.total_cost;
        const n = Number(cost);
        if (Number.isFinite(n)) total += n;
      }
      // If the response is a single aggregate, also check top-level
      if (total === 0) {
        const topLevel = data?.total_cost ?? data?.cost_usd ?? data?.cost;
        const n = Number(topLevel);
        if (Number.isFinite(n) && n > 0) total = n;
      }
      return total;
    } catch (err) {
      console.error('[monitoring:anthropic] fetch threw:', err);
      return null;
    }
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    const now = Date.now();
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const [spend30d, spend24h] = await Promise.all([
      this.fetchUsd(since30d),
      this.fetchUsd(since24h),
    ]);

    const snapshots: VendorUsageSnapshot[] = [];

    if (spend30d !== null) {
      snapshots.push({
        vendor: 'anthropic',
        metric: 'spend_30d_usd',
        current_value: Math.round(spend30d * 100) / 100,
        limit_value: this.monthlyCap,
        tier: 'pay-as-you-go',
        category: 'cost_runaway',
        metadata: { since: since30d },
      });
    }

    if (spend24h !== null) {
      // No fixed limit — burn-rate alert is computed in the
      // edge function from history (3× 7-day rolling avg). Snapshot
      // recorded for trend; threshold evaluation skipped because
      // limit_value=null (per thresholdCrossed() pure logic).
      snapshots.push({
        vendor: 'anthropic',
        metric: 'spend_24h_usd',
        current_value: Math.round(spend24h * 100) / 100,
        limit_value: null,
        tier: 'pay-as-you-go',
        category: 'cost_runaway',
        metadata: { since: since24h, note: 'rolling-avg burn-rate alerting in edge function' },
      });
    }

    return snapshots;
  }
}
