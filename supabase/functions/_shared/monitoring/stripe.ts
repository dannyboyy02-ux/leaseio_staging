// Stripe monitoring adapter — Phase 3 of OPERATIONAL_MONITORING_SPEC.md
//
// Distinct from the other adapters because it monitors *delivery
// health* of webhook endpoints, not usage volume. Webhook failure
// is the highest-impact Stripe signal — if webhooks 500, subscription
// state in the DB drifts from Stripe's truth. One-hour SLA on this
// alert per spec.
//
// Auth: existing STRIPE_SECRET_KEY (already configured for outbound
// flows; needs read scope on /v1/events and /v1/webhook_endpoints).

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeAdapter implements MonitoringAdapter {
  readonly vendor = 'stripe';
  private readonly secretKey: string;

  constructor(opts: { secretKey: string }) {
    this.secretKey = opts.secretKey;
  }

  private async fetchJson(path: string): Promise<any | null> {
    try {
      const res = await fetch(`${STRIPE_API}${path}`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });
      if (!res.ok) {
        console.error(`[monitoring:stripe] ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`[monitoring:stripe] ${path} threw:`, err);
      return null;
    }
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    // Approach: list events from the last 24h, count those that
    // have any failed delivery_attempt. Stripe's events API exposes
    // pending_webhooks per event; events with delivery failures
    // show up there. Detailed failure inspection requires the
    // /v1/events/{id}/delivery endpoint (not all accounts have
    // this), so we use pending_webhooks > 0 after a reasonable
    // delivery window as a proxy.
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const events = await this.fetchJson(`/events?created[gte]=${since}&limit=100`);
    if (!events) return [];

    const total = Array.isArray(events.data) ? events.data.length : 0;
    let pending = 0;
    if (Array.isArray(events.data)) {
      for (const event of events.data) {
        // pending_webhooks > 0 on an event >5 min old indicates a
        // delivery problem (Stripe retries within seconds normally).
        const ageSec = Math.floor((Date.now() / 1000) - (event.created ?? 0));
        if (ageSec > 300 && (event.pending_webhooks ?? 0) > 0) {
          pending++;
        }
      }
    }

    const failureRate = total > 0 ? (pending / total) * 100 : 0;

    return [
      {
        vendor: 'stripe',
        metric: 'webhook_failure_rate_24h',
        current_value: Math.round(failureRate * 100) / 100,
        // 1% threshold per spec. Encoded as a hard_cliff metric where
        // limit_value = 1; any value > limit crosses 'critical'
        // immediately (the ladder is 50/75/90 of limit, so 0.5/0.75/0.9
        // of 1% = 0.5%/0.75%/0.9% — matches "alert at first
        // occurrence" intent).
        limit_value: 1,
        tier: 'pay-as-you-go',
        category: 'hard_cliff',
        metadata: {
          events_24h: total,
          pending_or_failed: pending,
        },
      },
      {
        vendor: 'stripe',
        metric: 'events_24h',
        current_value: total,
        limit_value: null,
        tier: 'pay-as-you-go',
        category: 'cost_runaway',
        metadata: { window_seconds: 86_400 },
      },
    ];
  }
}
