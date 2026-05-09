// Resend monitoring adapter — Phase 2 of OPERATIONAL_MONITORING_SPEC.md
//
// Tracks outbound transactional email volume against the Resend free
// tier (3000/mo, 100/day). Returns up to three snapshots per call:
//   - emails_30d        (soft_quota, 70/85/95 ladder)
//   - emails_24h        (hard_cliff, 50/75/90 ladder)
//   - inbound_events_30d (soft_quota; placeholder until email-intake
//                         ships and Resend Inbound bucket question
//                         resolves per EMAIL_INTAKE_DECISIONS.md)
//
// Resend does not currently expose a direct usage-aggregate endpoint;
// the adapter paginates GET /emails for the 30-day window. The
// pagination cap protects cost and rate-limit if email volume spikes
// pathologically (legitimate usage would have triggered the per-day
// cap before reaching the page cap).

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const RESEND_API = 'https://api.resend.com';
const FREE_MONTHLY_CAP = 3000;
const FREE_DAILY_CAP = 100;
const PRO_MONTHLY_CAP = 50000;
const PAGE_CAP = 50; // 50 pages × 100 emails = 5000 emails counted max
const PAGE_SIZE = 100;

interface ResendEmailListItem {
  id: string;
  created_at: string;
}

async function listRecentEmails(
  apiKey: string,
  sinceIso: string,
): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < PAGE_CAP; page++) {
    const url = new URL(`${RESEND_API}/emails`);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('after', cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json() as { data?: ResendEmailListItem[] };
    const items = Array.isArray(body.data) ? body.data : [];
    if (items.length === 0) return { count, truncated: false };
    let pageHasOutOfWindow = false;
    for (const item of items) {
      if (item.created_at >= sinceIso) {
        count++;
      } else {
        pageHasOutOfWindow = true;
      }
    }
    if (pageHasOutOfWindow) return { count, truncated: false };
    cursor = items[items.length - 1].id;
  }
  return { count, truncated: true };
}

export class ResendAdapter implements MonitoringAdapter {
  readonly vendor = 'resend';
  private readonly apiKey: string;
  private readonly tier: string;
  constructor(opts: { apiKey: string; tier?: string }) {
    this.apiKey = opts.apiKey;
    this.tier = opts.tier ?? 'free';
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const monthlyCap = this.tier === 'pro' ? PRO_MONTHLY_CAP : FREE_MONTHLY_CAP;
    const dailyCap = this.tier === 'pro' ? null : FREE_DAILY_CAP;

    let monthly: { count: number; truncated: boolean };
    let daily: { count: number; truncated: boolean };
    try {
      monthly = await listRecentEmails(this.apiKey, since30d);
      daily = await listRecentEmails(this.apiKey, since24h);
    } catch (err) {
      console.error('[monitoring:resend] fetch failed:', err);
      return [];
    }

    const snapshots: VendorUsageSnapshot[] = [
      {
        vendor: 'resend',
        metric: 'emails_30d',
        current_value: monthly.count,
        limit_value: monthlyCap,
        tier: this.tier,
        category: 'soft_quota',
        metadata: { truncated: monthly.truncated, since: since30d },
      },
    ];

    if (dailyCap !== null) {
      snapshots.push({
        vendor: 'resend',
        metric: 'emails_24h',
        current_value: daily.count,
        limit_value: dailyCap,
        tier: this.tier,
        category: 'hard_cliff',
        metadata: { truncated: daily.truncated, since: since24h },
      });
    }

    // Placeholder for inbound events. Once Email Intake ships and
    // EMAIL_INTAKE_DECISIONS.md prerequisite #5 confirms the bucket
    // question, count incoming emails the same way.
    // Tracking explicitly so the dashboard surface exists from day 1.
    snapshots.push({
      vendor: 'resend',
      metric: 'inbound_events_30d',
      current_value: 0,
      limit_value: this.tier === 'pro' ? null : FREE_MONTHLY_CAP,
      tier: this.tier,
      category: 'soft_quota',
      metadata: {
        note: 'placeholder; populates when Email Intake v1 ships',
        bucket_question_unresolved: true,
      },
    });

    return snapshots;
  }
}
