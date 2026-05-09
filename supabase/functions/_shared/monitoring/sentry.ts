// Sentry monitoring adapter — Phase 3 of OPERATIONAL_MONITORING_SPEC.md
//
// Hard-cliff because once exceeded, Sentry drops events on the floor —
// error monitoring fails open exactly when you most need it. Threshold
// ladder is the tighter 50/75/90 from the hard_cliff category.
//
// Auth: SENTRY_AUTH_TOKEN with org:read + project:read scopes.
// Org slug needed (SENTRY_ORG_SLUG). Generated at:
//   https://sentry.io/settings/account/api/auth-tokens/

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const SENTRY_API = 'https://sentry.io/api/0';
const FREE_EVENTS_PER_MONTH = 5_000;
const TEAM_EVENTS_PER_MONTH = 50_000;

export class SentryAdapter implements MonitoringAdapter {
  readonly vendor = 'sentry';
  private readonly token: string;
  private readonly orgSlug: string;
  private readonly tier: 'free' | 'team' | 'business';

  constructor(opts: { authToken: string; orgSlug: string; tier?: 'free' | 'team' | 'business' }) {
    this.token = opts.authToken;
    this.orgSlug = opts.orgSlug;
    this.tier = opts.tier ?? 'free';
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    // Sentry stats_v2 endpoint returns event counts per category per
    // bucket. We sum errors over the last 30 days.
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const url = new URL(`${SENTRY_API}/organizations/${this.orgSlug}/stats_v2/`);
    url.searchParams.set('field', 'sum(quantity)');
    url.searchParams.set('category', 'error');
    url.searchParams.set('start', String(since));
    url.searchParams.set('interval', '1d');

    let total = 0;
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) {
        console.error(`[monitoring:sentry] ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return [];
      }
      const data = await res.json() as any;
      // stats_v2 returns groups; sum the 'sum(quantity)' across groups
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      for (const group of groups) {
        const series = group?.series?.['sum(quantity)'];
        if (Array.isArray(series)) {
          for (const v of series) {
            const n = Number(v);
            if (Number.isFinite(n)) total += n;
          }
        } else {
          const n = Number(group?.totals?.['sum(quantity)']);
          if (Number.isFinite(n)) total += n;
        }
      }
    } catch (err) {
      console.error('[monitoring:sentry] fetch threw:', err);
      return [];
    }

    const cap = this.tier === 'team' ? TEAM_EVENTS_PER_MONTH
              : this.tier === 'business' ? TEAM_EVENTS_PER_MONTH * 4
              : FREE_EVENTS_PER_MONTH;

    return [{
      vendor: 'sentry',
      metric: 'events_30d',
      current_value: total,
      limit_value: cap,
      tier: this.tier,
      category: 'hard_cliff',
      metadata: { org: this.orgSlug },
    }];
  }
}
