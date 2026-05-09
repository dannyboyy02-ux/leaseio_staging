# Module: Operational Monitoring — Build Spec

**Workstream type:** Parallel module (not a phase). Sits alongside P1–P8 lifecycle phases and Module: Market Data & IBR. Does not consume phase numbers.
**Owner:** Daniel
**Audience:** Claude Code, future contributors, anyone making decisions about vendor health, quotas, costs, or renewals.
**Status:** Draft, awaiting ratification.
**Prerequisite reading:** `CLAUDE.md`, `docs/PRODUCT_STRATEGY.md`, `docs/EMAIL_INTAKE_PLAN.md` (the email vendor monitoring overlap is non-trivial), the LeaseIO Cost Model spreadsheet.

---

## Purpose

LeaseIO depends on a half-dozen external vendors whose free tiers, paid caps, and renewal dates each have a different failure shape. Without an operational monitoring layer, the failure modes are silent until they become customer-impacting:

- A free-tier cap quietly fills up over weeks; the next email send / database write / function invocation fails on a Tuesday morning.
- A runaway extraction loop or compromised API key produces a $5,000 Anthropic bill overnight.
- A domain registration auto-renew silently fails because the card on file expired six weeks ago; the entire site goes dark when the domain expires.
- Stripe webhook failures cause subscription state in the DB to drift from Stripe's truth without anyone noticing for weeks.
- A customer's workspace approaches its tier cap; the customer hits "upload" on lease #26 and is told no, with no advance warning.

This module builds a layered monitoring system that catches each of these classes of failure before they become incidents. It is intentionally scoped for the pre-customer / early-customer stage — a Supabase scheduled function writing to a snapshots table, with email alerts via the existing Resend transactional rail, and an admin operations page reading the latest snapshot. No external monitoring SaaS, no agent infrastructure, no on-call rotation. Those layers come later when the operator count and customer base justify them.

The build is staged across four phases with explicit check-in gates. Phase 1 is non-code operational hardening that should ship within a week of ratification. Phases 2–4 are progressively-scoped code work, with Phase 4 gated on Phase 9 (firm layer) being live.

---

## The five categories of thing being monitored

These categories are referenced throughout the spec. Each has a different failure shape and a different right answer.

**1. Soft quota creep.** Vendors where exceeding a quota means paying overage but nothing actually breaks. Supabase database size past 500MB on free tier, Vercel bandwidth past 100GB, Resend monthly emails past 3K. Threshold ladder: 70% / 85% / 95%. Enough headroom to plan an upgrade calmly.

**2. Hard cliffs.** Vendors where exceeding a cap means the next operation fails silently. Resend daily cap of 100/day on free, Sentry's 5K events/month after which events are dropped (so error monitoring stops monitoring exactly when something is going wrong). Threshold ladder: 50% / 75% / 90%. Tighter because the cliff matters more than the headroom.

**3. Cost runaways.** No hard cap, but cost can spike pathologically. Anthropic API, Azure Document Intelligence, OpenAI fallback. A bug, a misconfigured retry loop, or an abusive customer can drive four-figure bills in a day. Defense is *spend ceilings set at the vendor* (most have this feature) plus daily-burn-rate alerts.

**4. Renewal cliffs.** Date-based, not usage-based. Domain expiry (the SaaS-killer; site goes dark if missed), insurance, trademark filings, SSL certs not on auto-renew, credit card expiration on file at every vendor. Defense is the renewal calendar with multi-stage reminders, plus card-expiry tracking.

**5. Customer-facing quotas.** Not vendor cost — workspace tier limits. Plus customer at 22 of 25 active leases, Pro workspace approaching its 250-lease cap, broker rate-limit at the email-intake endpoint approaching daily cap. Same monitoring infrastructure, different audience: the alert goes to the workspace admin, not to Daniel.

---

## Architecture

### Data model

Three new tables. All admin-only (RLS restricts reads to service role + future ops-admin role).

```sql
-- Time series of vendor usage snapshots
CREATE TABLE vendor_usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,                    -- 'resend' | 'supabase' | 'vercel' | 'anthropic' | 'azure_di' | 'stripe' | 'sentry'
  metric TEXT NOT NULL,                    -- 'emails_30d' | 'db_size_bytes' | 'bandwidth_gb' | 'spend_30d_usd' | etc.
  current_value NUMERIC NOT NULL,
  limit_value NUMERIC,                     -- NULL when no hard limit (cost-runaway category)
  pct_of_limit NUMERIC,                    -- NULL when limit_value is NULL
  tier TEXT,                               -- 'free' | 'pro' | 'pay-as-you-go'
  category TEXT NOT NULL,                  -- 'soft_quota' | 'hard_cliff' | 'cost_runaway'
  recorded_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb       -- vendor-specific raw payload for debugging
);

CREATE INDEX idx_vendor_usage_recent ON vendor_usage_snapshots (vendor, metric, recorded_at DESC);

-- Static calendar of date-based renewals
CREATE TABLE vendor_renewal_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,
  item TEXT NOT NULL,                      -- 'theleaseio.com domain' | 'E&O insurance' | 'card-on-file: stripe'
  renewal_date DATE NOT NULL,
  amount_estimate NUMERIC,
  reminder_days_before INT[] DEFAULT ARRAY[60, 30, 14, 7, 1],
  auto_renew BOOLEAN DEFAULT false,
  account_url TEXT,                        -- where to go to manage this
  notes TEXT,
  last_alerted_at TIMESTAMPTZ
);

-- Alert log (every threshold crossing fires one row; deduplicated per day per metric)
CREATE TABLE vendor_alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold_crossed TEXT NOT NULL,         -- 'warn' | 'alert' | 'critical'
  current_value NUMERIC,
  limit_value NUMERIC,
  pct_of_limit NUMERIC,
  upgrade_suggestion TEXT,                 -- human-readable, included in alert email
  upgrade_url TEXT,
  fired_at TIMESTAMPTZ DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX idx_alert_dedupe ON vendor_alert_log (vendor, metric, threshold_crossed, DATE(fired_at));
```

### Edge function: `vendor-health-check`

Single Supabase scheduled edge function, runs daily at 06:00 UTC via `pg_cron`. Sequence:

1. For each registered vendor, call the corresponding adapter (`src/adapters/monitoring/<vendor>.ts`) to fetch current usage.
2. Each adapter returns a normalized `VendorUsageSnapshot[]` array.
3. Insert all snapshots into `vendor_usage_snapshots`.
4. For each snapshot, evaluate against threshold ladder for its category.
5. If a threshold is newly crossed (not already alerted today), insert into `vendor_alert_log` and dispatch alert email.
6. Separate daily pass over `vendor_renewal_calendar`: for each row, check if today is within `reminder_days_before` of `renewal_date`; if so and not already alerted today, dispatch reminder.

Adapter contract:

```typescript
// src/adapters/monitoring/types.ts
export interface VendorUsageSnapshot {
  vendor: string;
  metric: string;
  current_value: number;
  limit_value: number | null;
  tier: string;
  category: 'soft_quota' | 'hard_cliff' | 'cost_runaway';
  metadata?: Record<string, unknown>;
}

export interface MonitoringAdapter {
  vendor: string;
  fetchSnapshots(): Promise<VendorUsageSnapshot[]>;
}
```

This adapter pattern matches the inbound-email adapter pattern from `EMAIL_INTAKE_PLAN.md` — same shape, same swap-cost protection. Adding a new vendor means writing one file under `src/adapters/monitoring/`.

### Alert dispatch

Outbound email via the existing Resend transactional rail. Single template per alert type:

- **Threshold alert email** — subject: `[LeaseIO Ops] {vendor} {metric} at {pct}% of {tier} limit`. Body: current value, limit, threshold crossed, upgrade suggestion text, upgrade URL, link to admin operations page.
- **Renewal reminder email** — subject: `[LeaseIO Ops] {item} renews in {days} days ({date})`. Body: amount estimate, auto-renew status, account URL, notes.

Recipients are stored in `vendor_alert_recipients` (a tiny admin table, probably one row at v1: Daniel's email). Future: add Slack webhook delivery as a second rail when LeaseIO has a workspace.

### Admin operations dashboard

New route: `/app/admin/operations`. Admin-only, gated by `is_workspace_owner` of the LeaseIO internal workspace (or service-role override during dev).

Three sections, all reading from the latest snapshot per (vendor, metric):

- **Vendor health** — colored bars per vendor/metric showing current % of limit. Green <70, yellow 70–85, orange 85–95, red >95. Click to see the 30-day history sparkline.
- **Upcoming renewals** — table of `vendor_renewal_calendar` ordered by date, highlighting anything within 60 days.
- **Recent alerts** — last 30 days of `vendor_alert_log`, with acknowledge button.

No fancy charting. Recharts for the sparklines (already in stack), shadcn for the layout, no new dependencies.

---

## Vendor-by-vendor specifications

Each entry: what's tracked, how it's fetched, threshold ladder, the upgrade suggestion that ships in the alert.

### Resend (transactional + inbound email)

| Metric | Limit (free) | Limit (Pro $20) | Category | Ladder |
|--------|-------------:|----------------:|----------|--------|
| `emails_30d` | 3,000/mo | 50,000/mo | soft_quota | 70 / 85 / 95 |
| `emails_24h` | 100/day | unlimited | hard_cliff | 50 / 75 / 90 |
| `inbound_events_30d` | shared bucket (verify) | shared bucket | soft_quota | 70 / 85 / 95 |

Fetch: Resend usage API. Adapter must handle both transactional sends and inbound events (once email intake ships). If Resend treats inbound as a separate bucket — needs verification at v1 build time — split into two snapshots.

Upgrade suggestion: *"Resend at {pct}% of free tier ({current}/3,000 emails this period). Upgrade to Pro: $20/mo for 50K emails, removes 100/day cap. https://resend.com/settings/billing"*

### Supabase

| Metric | Limit (free) | Limit (Pro $25) | Category | Ladder |
|--------|-------------:|----------------:|----------|--------|
| `db_size_bytes` | 500 MB | 8 GB | soft_quota | 70 / 85 / 95 |
| `storage_bytes` | 1 GB | 100 GB | soft_quota | 70 / 85 / 95 |
| `egress_30d_bytes` | 5 GB | 250 GB | soft_quota | 70 / 85 / 95 |
| `edge_invocations_30d` | 500K | 2M | soft_quota | 70 / 85 / 95 |
| `monthly_active_users` | 50K | 100K | soft_quota | 70 / 85 / 95 |
| `paused_status` | n/a | n/a | hard_cliff | alert immediately if paused |

Fetch: Supabase Management API (`api.supabase.com/v1/projects/{ref}/usage`). Service-role key required.

The `paused_status` check is crucial: free Supabase projects pause after 7 days of inactivity. Once you have customers, this should never happen, but during development it can. Alert immediately if status changes from active.

Upgrade suggestion: *"Supabase {metric} at {pct}% of free tier ({current} of {limit}). Pro tier: $25/mo, lifts to {pro_limit}. Already accounted for in the cost model. https://supabase.com/dashboard/project/{ref}/settings/billing"*

### Vercel

| Metric | Limit (Hobby) | Limit (Pro $20) | Category | Ladder |
|--------|--------------:|----------------:|----------|--------|
| `bandwidth_30d_gb` | 100 GB | 1 TB | soft_quota | 70 / 85 / 95 |
| `function_invocations_30d` | 100K | 1M | soft_quota | 70 / 85 / 95 |
| `build_minutes_30d` | 6,000 | 24,000 | soft_quota | 70 / 85 / 95 |

Fetch: Vercel Usage API (`api.vercel.com/v1/usage`). Personal access token required (read-only scope).

Note: LeaseIO is already on Vercel Pro per cost model. Treat the Hobby column as historical context. Pro overage is metered and billed automatically — these alerts are about *spend creep*, not *service shutoff*.

Upgrade suggestion: *"Vercel {metric} at {pct}% of Pro tier ({current} of {limit}). Past this, overage billed at $X per unit. Review usage: https://vercel.com/dashboard/usage"*

### Anthropic API

| Metric | Limit | Category | Ladder |
|--------|------:|----------|--------|
| `spend_30d_usd` | configured cap | cost_runaway | 50 / 75 / 90 |
| `spend_24h_usd` | (none) | cost_runaway | alert if > 3× 7-day rolling avg |
| `spending_limit_set` | bool | cost_runaway | alert if false or > intended cap |

Fetch: Anthropic Console API for usage. The spending limit itself is configured in the console UI.

The `spending_limit_set` check is the single most important monitoring signal in the entire system. The hard ceiling is set at the vendor; this poll verifies it stays set at the value Daniel intended. If a teammate (or future-Daniel) lowers it or removes it, fire an alert — the absence of a cap is itself a critical risk.

The `spend_24h_usd` rate-of-change alert is the early-warning for a runaway loop or compromised key. Normal daily burn is small; a 3× spike means something is wrong.

Upgrade suggestion: *"Anthropic spend at {pct}% of monthly cap (${current} of ${limit}). Review usage: https://console.anthropic.com/settings/usage. If this is normal growth, raise the cap. If unexpected, audit recent process_lease invocations."*

### Azure Document Intelligence

| Metric | Limit | Category | Ladder |
|--------|------:|----------|--------|
| `spend_30d_usd` | budget alert | cost_runaway | 75 / 90 |

Fetch: Azure Cost Management API is heavyweight. For v1, set a budget alert directly in the Azure Portal at the subscription level, and skip API polling. The Portal alert emails Daniel directly. Revisit when monthly Azure spend exceeds ~$50/mo and the polling investment makes sense.

This is explicitly an exception to the "everything in one dashboard" rule — pragmatism wins over consistency until Azure usage justifies the integration work.

### Stripe

| Metric | Threshold | Category | Ladder |
|--------|-----------|----------|--------|
| `webhook_failure_rate_24h` | > 1% | hard_cliff | alert at first occurrence |
| `failed_payment_count_24h` | > 0 | hard_cliff | informational, not alert |
| `api_key_age_days` | > 180 | renewal | reminder at 180, 365 |

Fetch: Stripe API for webhook delivery success rates (`/v1/webhook_endpoints/{id}` + delivery logs). Failed payments via `/v1/charges?status=failed`.

Webhook failure is the highest-impact Stripe signal — if webhooks 500, subscription state in the DB drifts from Stripe's truth, and customers can be charged but not have entitlements provisioned (or vice versa). One-hour SLA on this alert.

Failed payment count is informational because Stripe's smart retries handle most. Track it for trend analysis only; don't email-alert per failure.

API key age is a renewal-class signal: rotate every 6 months. Add to `vendor_renewal_calendar`.

### Sentry

| Metric | Limit (free) | Limit (Team $26) | Category | Ladder |
|--------|-------------:|-----------------:|----------|--------|
| `events_30d` | 5K | 50K | hard_cliff | 50 / 75 / 90 |

Fetch: Sentry stats API (`/api/0/organizations/{org}/stats_v2/`).

Hard cliff because once exceeded, Sentry drops events on the floor — error monitoring fails open exactly when you most need it. Defer until Phase 3 (by which point error volume actually matters).

### Domain registrar (Namecheap / Cloudflare / wherever theleaseio.com lives)

No usage API. Tracked entirely via `vendor_renewal_calendar`:

- `theleaseio.com` domain — annual renewal, ~$15, auto-renew should be ON, card on file should be valid for at least 12 months past renewal date
- Card-on-file expiry tracked separately as its own renewal entry, reminder ladder 60/30/14 days

The `vendor_renewal_calendar` should also include a row for each vendor where a card is on file, dated to that card's expiration. Card expires → autopay fails → service shutoff in days.

---

## Phase 1 — Critical operational hardening (no code)

**Scope:** Three vendor-side configurations and one calendar setup. Total time: ~2 hours of clicking through dashboards. Ship within a week of spec ratification.

**Out of scope for Phase 1:** Anything requiring code, schema, or deployment.

### Phase 1 deliverables

**1. Anthropic spending cap configured.** In the Anthropic Console, under Settings → Limits, set a hard monthly spending limit at a value Daniel chooses (recommendation: $200/mo for the pre-customer phase, raised explicitly as customer count grows). Verify the limit is *enforcing* (not just a notification threshold). Capture a screenshot of the configured cap; store in `docs/ops/screenshots/anthropic-spend-cap-{date}.png` for audit.

**2. Domain registrar hardened.** Log into the registrar where `theleaseio.com` is registered. Verify:
   - Auto-renew is ON
   - Card on file is valid for at least 12 months past the next renewal date
   - The contact email for renewal notifications is a mailbox Daniel actively monitors (not a forwarded alias that might break)
   - 2FA is enabled on the registrar account itself
   - Domain locking / transfer protection is enabled

   Capture state in `docs/ops/registrar-state-{date}.md`.

**3. Stripe webhook health verified.** In Stripe dashboard, Developers → Webhooks → click the LeaseIO endpoint. Verify:
   - Endpoint shows recent successful deliveries (no current failure backlog)
   - Webhook signing secret is valid (trace it back to the `STRIPE_WEBHOOK_SECRET` env var in Supabase)
   - Subscribed event types match what the codebase consumes (audit `supabase/functions/stripe-webhook/index.ts` against the dashboard subscription list)

**4. Manual renewal calendar.** Create a calendar (Google Calendar works) with one event per vendor renewal:
   - Domain renewal at T-60, T-30, T-7
   - Insurance renewal at T-60, T-30
   - Each card-on-file expiration at T-60, T-30, T-14
   - Anthropic spending cap review at T-90 (quarterly check that the cap is still right-sized)

   This calendar is the manual fallback that catches anything the Phase 2 system misses.

### Phase 1 check-in

Before declaring Phase 1 done, verify:

- [ ] Anthropic spending cap is set and screenshot captured. The cap is *enforcing*, not just *notifying*.
- [ ] Registrar state documented. Auto-renew on, card valid, 2FA on, contact email working.
- [ ] Stripe webhook endpoint shows healthy deliveries for the last 7 days.
- [ ] Manual renewal calendar populated with all vendors that bill LeaseIO.
- [ ] `docs/ops/` directory exists in repo with the screenshots and state docs from above.
- [ ] `CLAUDE.md` updated with the Phase 1 completion note (see "Updates to CLAUDE.md" section below).

If any item fails, do not proceed to Phase 2. The Phase 2 monitoring assumes Phase 1 cliffs are protected.

---

## Phase 2 — Core monitoring infrastructure

**Scope:** Schema, daily cron, three pollers (Resend, Supabase, Vercel), email alerting, admin operations dashboard. The monitoring system from "nothing" to "useful for the three highest-traffic vendors."

**Out of scope for Phase 2:** Customer-facing quota warnings (Phase 3), Sentry / Azure DI / Stripe webhook polling (Phase 3), firm-layer aggregation (Phase 4), Slack delivery (deferred indefinitely).

### Phase 2 deliverables

**1. Database migration.** New file: `<timestamp>_module_monitoring_foundation.sql`. Creates the three tables defined in the Architecture section, with RLS policies restricting reads to service role + an `is_ops_admin` helper (added in this migration; defaults to checking workspace ownership of a designated internal "LeaseIO HQ" workspace).

**2. Adapter scaffolding.** Create `src/adapters/monitoring/` directory with:
   - `types.ts` — the `VendorUsageSnapshot` and `MonitoringAdapter` interfaces
   - `resend.ts` — Resend usage poller
   - `supabase.ts` — Supabase Management API poller
   - `vercel.ts` — Vercel Usage API poller
   - `index.ts` — registry exporting all configured adapters

   Each adapter has a Deno mirror under `supabase/functions/_shared/monitoring/` because the edge function consumes them.

**3. Edge function: `vendor-health-check`.** Path: `supabase/functions/vendor-health-check/index.ts`. Logic per the Architecture section. Deployed and registered with `pg_cron` to run daily at 06:00 UTC.

**4. Alert dispatch.** Path: `supabase/functions/_shared/alerts/dispatch.ts`. Single function that takes an alert type + payload and sends via Resend. Alert deduplication enforced by the unique index on `vendor_alert_log`.

**5. Admin operations page.** Path: `src/pages/app/admin/OperationsPage.tsx`. Route: `/app/admin/operations`. Renders the three sections (vendor health, renewals, recent alerts). RLS-enforced admin-only. Uses Recharts sparklines for the 30-day history. No new dependencies.

**6. Recipient configuration.** Tiny table `vendor_alert_recipients` with one row at v1 (Daniel's email). UI not required at Phase 2 — `INSERT` via migration is fine.

**7. Tests.**
   - Unit tests for each adapter's parsing logic (mocked vendor responses).
   - Unit tests for threshold evaluation logic.
   - Unit tests for alert dedup logic (same threshold crossed twice in a day → one alert).
   - Integration test: full edge function run against a mock vendor stub, asserting that snapshots and alerts are written correctly.

### Phase 2 check-in

Before declaring Phase 2 done, verify:

- [ ] Migration applied cleanly. All three tables exist with correct RLS policies. `is_ops_admin` helper works.
- [ ] All three adapters fetch live data successfully against the real vendor APIs (not just mocks).
- [ ] Edge function runs end-to-end via manual trigger, writes snapshots for all three vendors, and writes correct alert rows when thresholds are forced (test with a temporarily-low limit).
- [ ] `pg_cron` schedule registered, job runs at 06:00 UTC, output visible in `cron.job_run_details`.
- [ ] Email alerts deliver successfully to the recipient. Email rendering is readable; upgrade suggestion text and URL are present.
- [ ] Admin operations page renders all three sections. Sparklines display 7+ days of data after a week of cron runs.
- [ ] Alert dedup verified: same threshold crossed on consecutive days produces only one row per day.
- [ ] All tests pass (unit + integration). No regressions in existing test suite.
- [ ] `KNOWN_ISSUES.md` updated with any deltas discovered during build.
- [ ] `CLAUDE.md` updated per the "Updates to CLAUDE.md" section below.
- [ ] As-built notes appended to this spec capturing any departures from the design.

If any check fails, do not proceed to Phase 3. Phase 3 builds customer-facing alerts on this same infrastructure; bugs at Phase 2 will surface to customers at Phase 3.

---

## Phase 3 — Customer-facing quota warnings & coverage expansion

**Scope:** Per-workspace quota warnings shown in-app to customers, plus three additional vendor pollers (Sentry, Stripe webhooks, Anthropic). Backup-restore validation. Coverage expansion from "internal vendors" to "everything that matters."

**Out of scope for Phase 3:** Firm-layer aggregation (Phase 4), Azure DI API integration (defer indefinitely; Portal budget alert remains the answer), monitoring SaaS evaluation.

### Phase 3 deliverables

**1. Customer-facing quota warning component.** New component: `src/components/QuotaWarningBanner.tsx`. Displays an in-app banner when a workspace approaches its tier cap on any of: active lease count, member count, document storage, monthly extraction count, monthly email-intake events. Banner appears at 80% (informational, dismissible), 95% (persistent, action-suggesting). Includes upgrade CTA linking to billing.

**2. Workspace quota poller.** Extends `vendor-health-check` to also iterate workspaces and write per-workspace usage snapshots to a parallel `workspace_quota_snapshots` table. Same shape as `vendor_usage_snapshots` but partitioned by `workspace_id`, with `tier` referring to the workspace's plan.

**3. Sentry adapter.** `src/adapters/monitoring/sentry.ts` + Deno mirror. Polls Sentry stats API. Hard cliff alerting per the spec.

**4. Stripe webhook health adapter.** `src/adapters/monitoring/stripe.ts`. Distinct from the other adapters because it monitors *delivery health*, not usage volume. Reads webhook delivery logs, computes 24h failure rate, alerts above 1%.

**5. Anthropic spend adapter.** `src/adapters/monitoring/anthropic.ts`. Polls usage endpoint. Three snapshots per run: 30-day spend vs cap, 24-hour spend vs 7-day rolling avg, spending-limit-configured boolean.

**6. Backup-restore drill.** Manual but documented. Once during Phase 3:
   - Pick a non-production day
   - Trigger a Supabase backup restore to a staging project
   - Verify data integrity matches production at the snapshot time
   - Document the procedure in `docs/ops/backup-restore-runbook.md`
   - Add an annual reminder to `vendor_renewal_calendar` to repeat this drill

**7. Tests.** Same shape as Phase 2 — unit tests for each new adapter, integration test for the workspace-quota poller (assert that a workspace at 96% of cap triggers the right banner state).

### Phase 3 check-in

- [ ] Customer-facing banner renders correctly at 80% and 95% thresholds. Dismissible at 80%, persistent at 95%. Upgrade CTA works.
- [ ] Workspace quota poller writes per-workspace snapshots for every active workspace. Sample 3 workspaces and verify snapshot values match what the existing UI reports.
- [ ] All three new vendor adapters fetch live data successfully and write snapshots.
- [ ] Stripe webhook failure alert tested: temporarily break the webhook endpoint, verify the alert fires within 24 hours, restore endpoint, verify alert clears.
- [ ] Anthropic spending-limit-configured check tested: temporarily change the cap, verify the snapshot reflects the change.
- [ ] Backup-restore drill executed successfully. Runbook committed.
- [ ] All tests pass. No regressions.
- [ ] `KNOWN_ISSUES.md` updated.
- [ ] `CLAUDE.md` updated.
- [ ] As-built notes appended.

If any check fails, do not proceed to Phase 4. Phase 4 builds firm-layer aggregation on top of the workspace-quota poller; defects there will compound.

---

## Phase 4 — Firm-layer aggregation (gated on Phase 9)

**Scope:** Per-firm aggregate quota visibility. CPA firm with 8 child workspaces gets one rollup view. Cross-workspace alert routing (firm admin gets the alert, not just the child workspace owner).

**Gating:** Phase 4 cannot start until Phase 9 (Firm Layer Foundation) is shipped and the `is_workspace_member` helper is firm-aware. If Phase 4 starts before Phase 9 lands, the schema assumptions don't hold and the work has to be redone.

### Phase 4 deliverables

**1. Firm aggregate snapshot view.** New SQL view: `v_firm_quota_aggregate`. For each firm, sums the relevant quotas (active leases, storage, members) across all child workspaces, joining against the firm's tier limits.

**2. Firm operations page.** Extension of the admin operations page: when a firm context is selected (firm admins only), shows the aggregated view alongside per-child breakdown. Reuses the same colored-bar component from Phase 2.

**3. Firm-routed alerts.** When a child workspace's quota threshold is crossed AND the workspace is firm-bound, the alert routes to *both* the workspace owner and the firm admins. This change is in the alert dispatch logic; the snapshot writer doesn't need to change.

**4. Cross-firm leak audit.** Hard requirement: verify that no firm's aggregate view ever includes child workspaces from another firm, even under degraded RLS. Test by creating two firms with similar workspace counts and asserting their aggregates are independent.

### Phase 4 check-in

- [ ] Phase 9 (Firm Layer Foundation) is fully shipped per its own definition-of-done before Phase 4 starts.
- [ ] `v_firm_quota_aggregate` returns correct sums for a firm with multiple child workspaces. Edge case: firm with zero child workspaces returns zero rows, not NULL/error.
- [ ] Firm operations page renders for firm admins, denied for non-firm-members of any kind.
- [ ] Firm-routed alert tested: trigger a child workspace threshold crossing, verify both workspace owner and firm admin receive the alert.
- [ ] Cross-firm leak audit passes. Two firms tested in isolation never see each other's data.
- [ ] All tests pass.
- [ ] `CLAUDE.md` updated.

---

## Out of scope (deferred indefinitely or to far future)

- **External monitoring SaaS** (Better Stack, Datadog, Cronitor, PagerDuty). Revisit when LeaseIO has multiple operators and an on-call rotation. Estimate: Year 2+.
- **Customer-facing operational status page** (status.leaseio.com). Revisit at ~50 paying customers.
- **Vendor health-status page parsing** (e.g., scraping status.supabase.com to surface vendor outages in the operations dashboard). Cute but low-value. The vendor's own incident emails to Daniel are sufficient.
- **Anomaly detection / ML-based alerting.** Threshold ladders are the right answer at this stage. Statistical anomaly detection adds complexity for marginal value.
- **SLA dashboards for customers.** Implies an SLA, which LeaseIO does not yet offer. Revisit when enterprise contracts demand it.
- **On-call paging / PagerDuty integration.** Email is fine for the operator-of-one stage.

---

## Operational prerequisites that block ship per phase

These cannot be done by Claude Code; they require human action.

**Phase 1:** Anthropic Console access, registrar account access, Stripe dashboard access. All Daniel-side. ~2 hours.

**Phase 2:**
- `pg_cron` extension enabled in Supabase (one-line SQL but requires service-role + verification it's available on the current Supabase tier; Supabase Pro includes it)
- Resend API key with usage-read scope
- Supabase Management API personal access token (read-only)
- Vercel personal access token (read-only)
- All env vars added to Supabase edge function secrets

**Phase 3:**
- Sentry organization admin access for API key generation
- Stripe API key with `read` scope on webhook endpoints (the existing key likely has this; verify)
- Anthropic Console API key for usage endpoint (separate from the runtime API key — Anthropic distinguishes admin vs runtime keys)

**Phase 4:** Phase 9 firm-layer ship complete.

---

## Updates to CLAUDE.md

When Claude Code processes this spec, append the following blocks to `CLAUDE.md`. Existing CLAUDE.md sections referenced (Active Workstreams, Always Check For, etc.) may need to be created if they don't yet exist; if so, create them at the top level of the document and place the additions there.

### 1. Add to the "Active Workstreams" section

> **Module: Operational Monitoring** — vendor health, quota tracking, renewal calendar, customer-facing quota warnings. Parallel module (not a phase). Spec: `docs/OPERATIONAL_MONITORING_SPEC.md`. Phases:
>
> - Phase 1 (no-code operational hardening) — *status: TBD, update when complete*
> - Phase 2 (core monitoring infrastructure) — *status: TBD*
> - Phase 3 (customer-facing & coverage expansion) — *status: TBD*
> - Phase 4 (firm-layer aggregation, gated on Phase 9) — *status: blocked until Phase 9 ships*

### 2. Add to the "Always Check For" section

> **Operational monitoring touchpoints.** When modifying any of the following areas, check whether the Operational Monitoring spec needs updating:
>
> - Adding a new external vendor dependency → add an adapter under `src/adapters/monitoring/` and a row to the vendor table in `OPERATIONAL_MONITORING_SPEC.md`
> - Changing a tier's quota limits → update the customer-facing banner thresholds in `QuotaWarningBanner.tsx` and the tier-limit constants
> - Adding a new edge function that calls a paid API → verify the call cost is bounded (per-invocation rate limit or upstream spending cap)
> - Modifying Stripe webhook subscriptions → verify the subscription list still matches what the codebase consumes; update Phase 1 audit notes
> - Adding a new card-on-file at any vendor → add a row to `vendor_renewal_calendar` for the card expiration date

### 3. Add to the "Strategic Rules" section (or create one if absent)

> **Rule: No silent vendor failures.** Every external vendor LeaseIO depends on must fall into exactly one of three states: (a) monitored via the `vendor-health-check` cron with snapshots written daily; (b) tracked in `vendor_renewal_calendar` with multi-stage reminders; (c) explicitly listed in `OPERATIONAL_MONITORING_SPEC.md` "out of scope" with a documented reason. There is no fourth state of "we'll notice if it breaks."

### 4. Add to the "Known Operational Dependencies" section (create if absent)

> **Vendor admin access required.** The following vendor consoles must remain accessible to the operator at all times:
>
> - Anthropic Console (spending caps, API key rotation)
> - Supabase Dashboard (Management API tokens, billing, backups)
> - Vercel Dashboard (usage, deployment health, billing)
> - Resend Dashboard (transactional + inbound, API keys)
> - Stripe Dashboard (webhook endpoints, payment health)
> - Sentry (after Phase 3)
> - Domain registrar for `theleaseio.com`
>
> Loss of access to any of these is a P0 incident. 2FA recovery codes for each should be stored in a password manager Daniel can access independently of the primary device.

---

## Notes for Claude Code

- The adapter pattern in `src/adapters/monitoring/` should mirror the inbound-email adapter pattern from `EMAIL_INTAKE_PLAN.md`. Same shape, same goal: vendor swap is a single new file.
- Pure helpers go in `src/lib/monitoring/` with full unit test coverage. The Deno mirror under `supabase/functions/_shared/monitoring/` is required because edge functions cannot import from `src/`.
- The alert-dedup unique index on `vendor_alert_log` uses `DATE(fired_at)` — this is timezone-sensitive. Confirm Postgres session timezone is UTC (it should be on Supabase).
- The `is_ops_admin` helper added in Phase 2 should be conservatively scoped: a single hardcoded workspace_id in v1 (the LeaseIO HQ workspace), promoted to a more general role system only when there's a second operator. Do not over-engineer this in Phase 2.
- When the Phase 2 cron starts running, expect 24–48 hours of "interesting" data as initial snapshots populate. Don't trust threshold alerts until at least 7 days of history exist (the 7-day rolling avg for Anthropic burn-rate alerting needs that history).
- The `vendor_renewal_calendar` table is mostly static. Updates happen rarely (new vendor added, card expiration date changed). No UI required at Phase 2; manual `INSERT` via migration or admin SQL is fine. Revisit in Phase 3+ if frequency justifies.
- Email rendering for alerts: keep it text-heavy and ugly-but-readable. This is operator email, not customer email. No fancy templates, no images, no marketing styling. Subject + plain body + URL is enough.
- When this spec is updated (new vendors, new phases, scope changes), update the "Ratified" date at the top and append an entry to the as-built notes appendix below.

---

## As-built notes appendix

*To be filled in by Claude Code as each phase completes. Append entries; do not modify earlier entries.*

### Phase 1 as-built
*(pending)*

### Phase 2 as-built
*(pending)*

### Phase 3 as-built
*(pending)*

### Phase 4 as-built
*(pending; blocked on Phase 9)*
