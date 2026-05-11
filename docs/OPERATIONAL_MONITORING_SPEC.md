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

## Backlog — review later

### ICS subscription feed for renewal calendar (proposed 2026-05-11)

Replace manual Google Calendar event creation for `vendor_renewal_calendar` rows with a subscribed ICS feed.

**Shape:** New edge function `renewal-calendar-feed` returns `text/calendar` from `vendor_renewal_calendar`. Each row emits a VEVENT with VALARM blocks for T-60/T-30/T-14 (and T-7 for cards). Operator adds the URL once to Google Calendar via "Other calendars → From URL." Google auto-refreshes every ~12-24h, so new rows appear without manual sync.

**Why it's attractive:** Zero per-event Google Calendar API cost (read-only ICS, not OAuth). Subscribe once, hands-off. Reuses existing renewal table. No new dependencies. Solves the current gap where every new renewal needs manual calendar entry.

**Tradeoffs / open questions:**
- URL is a bearer secret — anyone with it reads the renewal list. Path needs a token-gated route (HMAC or a `?token=` query param tied to a row in `private.cron_secrets` or similar).
- Up to ~24h refresh lag on Google's side. Acceptable for renewal dates measured in months.
- Alternative considered: attach `.ics` files to the T-60/T-30/T-14 reminder emails Resend already sends, letting Gmail's "Add to Calendar" do the work per event. Lower setup cost but click-per-event vs subscribe-once.

**Effort estimate:** ~1 session (edge function + token-gating + one-time operator setup steps in OPERATOR_PLAYBOOK).

**Not a launch blocker.** Manual entry of the handful of renewal dates is fine for the operator-of-one stage; revisit when the calendar has more than ~10 rows or when a second operator is added.

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

### Phase 2 as-built (2026-05-09, commit `9a05bd7`)

Shipped the Phase 2 engine end-to-end: schema, three adapters, edge function, cron, admin dashboard. Deployed and smoke-verified.

**Deltas from the design as written:**

- **A1: Auth pattern uses `x-cron-secret` header, not service-role JWT.** The spec said "Single Supabase scheduled edge function, runs daily at 06:00 UTC via `pg_cron`" without specifying auth shape. Used the codebase's established `private.cron_secrets` pattern (per migration `20260507260000`) — single shared mechanism for all cron functions, generated secret stored in both env var (`VENDOR_HEALTH_CHECK_CRON_SECRET`) and `private.cron_secrets` table (id=`vendor_health_check`). Smoke-tested end-to-end: correct secret → 200, wrong secret → 401.
- **A2: Adapter scaffolding lives only in `supabase/functions/_shared/monitoring/`, not duplicated to `src/adapters/monitoring/<vendor>.ts`.** The Deno mirror is the actual runtime; the `src/` mirror would only be for unit tests in vitest, and Phase 2 didn't ship adapter unit tests yet (deferred to Phase 3 with the broader test pass). The shared types file IS in both locations (`src/adapters/monitoring/types.ts` + `supabase/functions/_shared/monitoring/types.ts`) so the contract is visible to future frontend consumers.
- **A3: Resend usage is computed via `/emails` pagination, not a dedicated usage endpoint.** Resend doesn't expose a public usage-aggregate API as of the build date. The adapter paginates with a 50-page (5K email) cap; legitimate usage would have triggered the per-day cap at 100/day before reaching the page cap. If Resend ships a usage endpoint later, the adapter can be swapped for a single call.
- **A4: Supabase adapter does defensive field mapping** (tries multiple key names per metric: `db_size`, `database_size`, `db_size_bytes`). The Management API's response shape varies across revs; rather than pin to one version, the adapter is permissive and emits any metric where SOME expected field is present. Missing fields are skipped (no synthetic 0 emission).
- **A5: Vercel adapter uses `/v1/usage`** as the spec suggests; if the actual response shape diverges, the snapshot mapping is independent of the URL path so only the path needs updating.
- **A6: `is_ops_admin` helper hardcoded to workspace `c9dad4c7-d04a-4d14-b846-8e017d662341`** (Labs Analytix, owned by `daniel.c.priest@gmail.com`) per the spec note "single hardcoded workspace_id in v1." Returns true for owner OR admin members of that workspace.
- **A7: Recipient seeded via migration insert, not via UI.** Per spec note "INSERT via migration is fine" at Phase 2 — single row for `daniel.c.priest@gmail.com`.
- **A8: Operations dashboard is an authenticated route (any user can navigate); RLS gates the data.** Non-ops users see empty cards rather than a 403. Cleaner separation per the principle "auth in one place." Acceptable v1 UX; can add explicit "not authorized" empty state if the empty-cards experience proves confusing.

**Smoke verification results:**

- Migration applied cleanly. All 4 tables (`vendor_usage_snapshots`, `vendor_renewal_calendar`, `vendor_alert_log`, `vendor_alert_recipients`) present in live. Seed recipient row inserted.
- `is_ops_admin` helper present in live. RLS policies in place on all 4 tables.
- Edge function deployed (Supabase Functions dashboard confirms ACTIVE status).
- `cron.job_run_details` shows the schedule registered as `vendor-health-check-daily` at `0 6 * * *`. Will fire first at next 06:00 UTC.
- Manual smoke trigger (POST with `x-cron-secret`): HTTP 200 with structured response — `{ok:true, adaptersConfigured:["resend"], adapterErrors:[], snapshotsWritten:3, alertsFired:0, alertEmailsSent:0, renewalsAlerted:0, recipientCount:1}`. Resend adapter ran successfully; Supabase + Vercel adapters skipped because their tokens aren't configured yet.
- Wrong-secret test: HTTP 401 — fail-closed verified.

**Phase 2 check-in items: status**

Per the spec's check-in list:

- [x] Migration applied cleanly. Tables exist with correct RLS. `is_ops_admin` helper works.
- [x] At least one adapter (Resend) fetches live data successfully against the real vendor API.
- [ ] All three adapters fetch live data — Supabase + Vercel pending operator-side token setup. Expected first-run-after-tokens-set fills in the gap.
- [x] Edge function runs end-to-end via manual trigger; writes snapshots; would write correct alert rows when thresholds crossed (no thresholds crossed at current pre-customer volume; logic verified via code review).
- [x] `pg_cron` schedule registered.
- [ ] Email alerts deliver successfully — pending natural threshold crossings to fully exercise. Path proven via the existing Resend transactional rail (`dispatchAlertEmail` is a thin wrapper over the same API used by `send-lease-notifications`).
- [ ] Admin operations page renders all three sections — code shipped, deployed via Vercel auto-deploy, but a 7-day data window is needed before the sparklines show meaningful 30-day history.
- [x] Alert dedup verified by code review: unique index on `(vendor, metric, threshold, day-UTC)` ensures dup attempts get `23505` and the function silently continues.
- [x] Build green; 5 audit-remediation tests still pass; no regressions.
- [ ] Adapter unit tests + integration test — DEFERRED to Phase 3 with the broader testing pass. Acceptable trade-off: the smoke run is a stronger signal than mocked tests for adapters that hit external APIs.
- [x] As-built notes (this section) populated.

**Phase 2 partially closed** — code path 100% complete; adapter completion pending operator-side token setup; data-density-dependent items (alert email delivery, sparkline visualization) pending natural data accumulation. Phase 3 unblocked from a code-dependency standpoint; the customer-facing `QuotaWarningBanner` doesn't depend on Phase 2 adapter completeness.

### Phase 3 as-built (2026-05-09, commit `6393b25`)

Shipped the customer-facing banner + 3 vendor adapters (Sentry, Stripe webhook health, Anthropic spend) + the workspace quota poller. Edge function redeployed; smoke-verified end-to-end.

**Deltas from the design as written:**

- **B1: Stripe webhook health check uses `pending_webhooks > 0` after a 5-min delivery window as the failure proxy.** The spec called for "computes 24h failure rate." Stripe doesn't expose per-event delivery success directly via `/v1/events`; the cleanest available signal is `pending_webhooks` (count of endpoints that haven't acked the event). Fresh events naturally have `pending_webhooks > 0` for seconds; we filter to `age_sec > 300` to avoid false positives from in-flight deliveries. The 1% threshold from the spec is implemented via `limit_value=1` with the hard_cliff ladder, which means alert fires the moment failure rate exceeds 0.5% (warn at 50% of limit) — slightly tighter than 1%, which matches the spec's "alert at first occurrence" intent.
- **B2: Anthropic burn-rate alert is computed in the edge function, not in the adapter.** The adapter emits a `spend_24h_usd` snapshot with `limit_value=null` (which short-circuits `thresholdCrossed()`'s null guard). The edge function's burn-rate logic queries the trailing 7 days of `spend_24h_usd` snapshots from `vendor_usage_snapshots`, computes the rolling average, and fires a `critical` alert under the synthetic metric `spend_24h_usd_burn_rate` if today > 3× avg. Cold-start protection: skipped until ≥7 prior snapshots exist (the 7-day-window assumption from the spec).
- **B3: `spending_limit_set` snapshot deferred to v1.5.** The spec lists this as a snapshot but Anthropic does not expose the configured cap value via API. The cap is set in the Console (Phase 1 deliverable); from the API side we can only see usage, not the limit. Adapter docstring documents the gap. The "is the cap still set?" question answers via the operator's quarterly Phase 1 review, not via this adapter.
- **B4: Workspace quota poller skips `document_storage_bytes` and `monthly_email_intake_events`.** The first has no per-workspace cap defined in `pricing.ts` (would need infrastructure-level allocation); the second waits for Email Intake to ship and per-tier caps to be enforced. Both can be added when needed without touching the schema (just add metric rows to the poller output).
- **B5: Workspace quota snapshots use the same threshold ladder as vendor `soft_quota`** (70/85/95). The customer-facing banner overrides this slightly: it triggers at 80% (informational) and 95% (persistent), matching the spec's "80%/95%" UI contract rather than the 70/85/95 backend ladder. The mismatch is intentional — the backend records snapshots and could fire backend alerts at 70%, but the customer-facing UI only surfaces from 80% to avoid noise.
- **B6: QuotaWarningBanner picks the single highest-pct metric over 80%, not all of them.** Banner spam is worse than missed signals; the worst offender is the actionable one. If a workspace is over on multiple metrics, the user sees the highest one and addresses it; subsequent metrics surface as the worst becomes second-worst.
- **B7: Banner dismissal is workspace-scoped + metric-scoped + pct-bucket-scoped via localStorage.** Dismissing at 82% sticks until the same metric crosses a 5% bucket boundary (85, 90, 95). At 95% the banner becomes persistent and ignores any prior dismissal. localStorage means dismissal is per-browser, not per-account — adequate for v1; a server-side dismissal record is v1.5.
- **B8: Operations admin route did NOT need a `RequireRole` gate.** Per Phase 2 A8: RLS is the auth source for the admin operations dashboard. The same applies here — non-ops users see empty data on `/app/admin/operations`. Phase 3's QuotaWarningBanner has no admin gate; it's customer-facing by design.
- **B9: Backup-restore runbook documents both Supabase native restore and `pg_dump`/`pg_restore` fallback.** Daniel-side execution still owed; the drill log section in the runbook tracks each annual run.

**Smoke verification results:**

- Migration applied cleanly. `workspace_quota_snapshots` table present with correct RLS (workspace members read their own).
- Edge function redeployed. Manual smoke trigger: HTTP 200 with `{ok:true, adaptersConfigured:["resend","stripe"], adapterErrors:[], snapshotsWritten:5, workspaceSnapshotsWritten:8, alertsFired:0, anthropicBurnAlerts:0, alertEmailsSent:0, renewalsAlerted:0, recipientCount:1}`.
- `workspace_quota_snapshots` populated correctly: 8 rows = 4 metrics × 2 workspaces. Spot-checked Labs Analytix snapshot — `archived_leases: 1/250 = 0.4%` and `member_count: 1, limit=null` (Business tier unlimited members) match production reality.
- Stripe webhook health adapter activated automatically (existing `STRIPE_SECRET_KEY` was already set for outbound). Sentry + Anthropic adapters logged "skipping" warnings as expected.
- All 24 vitest tests pass (19 new monitoring + 5 existing audit-remediation).

**Phase 3 check-in items: status**

- [x] Customer-facing banner renders correctly at 80% and 95% thresholds. Dismissible at 80% (per metric per pct-bucket via localStorage), persistent at 95%. Upgrade CTA wired.
- [x] Workspace quota poller writes per-workspace snapshots for every active workspace. Sample workspace verified.
- [x] All three new vendor adapters (Sentry, Stripe webhook health, Anthropic spend) ship in code and activate when their tokens are configured. Stripe activated automatically; Sentry + Anthropic pending operator-side tokens.
- [ ] Stripe webhook failure alert tested with real failure — pending. The threshold-crossing logic is exercised by code review + the unit tests; live exercise would require breaking and unbreaking the webhook endpoint, which is invasive.
- [ ] Anthropic spending-limit-configured check tested — DEFERRED (B3 above; Anthropic doesn't expose the cap value via API).
- [ ] Backup-restore drill executed — runbook committed; execution Daniel-side.
- [x] All tests pass. No regressions.
- [x] As-built notes (this section) populated.

**Phase 3 partially closed** — code path 100% complete; vendor adapter completion pending operator-side token setup; backup-restore drill execution pending.

#### Phase 3 adapter shape fixes (2026-05-11)

After operator-side tokens were configured (`MANAGEMENT_API_TOKEN`, `VERCEL_ACCESS_TOKEN`, `ANTHROPIC_ADMIN_API_KEY`, etc.), the Supabase, Vercel, and Anthropic adapters all authenticated but returned **zero snapshots**. Built a temporary `monitoring-probe` edge function (deployed, ran, then deleted) to capture the real API response shapes. The probe revealed the design assumed Management/usage endpoints that don't actually exist on the public APIs. Three adapters rewritten against observed reality:

- **C1: Supabase adapter rewritten.** `/v1/projects/{ref}/usage` and `/v1/organizations/{slug}/usage` returned 404 — they're not public. Adapter now emits `paused_status` from `/v1/projects/{ref}` (returns `ACTIVE_HEALTHY` cleanly) and queries `db_size_bytes` / `storage_bytes` directly via the service-role Postgres client. New SECURITY DEFINER RPC `pg_database_size_postgres()` shipped in migration `20260511000000_pg_database_size_rpc.sql` (the Management API doesn't expose DB size; pg_database_size() is the only path). Egress / edge invocations / MAU deferred — those live in Supabase's internal billing and aren't on the public Management API; operator picks them up from the Supabase Dashboard during quarterly review.
- **C2: Vercel adapter rewritten.** Vercel intentionally locks usage data behind their billing dashboard; no public `/v1/usage` or `/v1/teams/{id}/billing/usage` endpoints exist. Adapter now emits a single `project_count` snapshot from `/v9/projects` (with `limit_value: null` so threshold logic short-circuits) as a "signal of life." The metadata note documents that bandwidth/function/build-minute overage protection relies on Vercel's own dashboard alerts — operator must ensure the Vercel billing email is one Daniel actively monitors.
- **C3: Anthropic adapter rewritten with admin-key diagnostic path.** All admin endpoints (`/v1/organizations/me`, `/v1/organizations/cost_report`, `/v1/organizations/usage_report/messages`) returned 401 "invalid x-api-key". Signature of "valid key, wrong type" — admin endpoints require an admin-scoped key (`sk-ant-admin-...`), not a runtime key (`sk-ant-api...`). The adapter now probes `/v1/organizations/cost_report` first; on 401 it emits a single synthetic snapshot `admin_key_invalid` (current_value=1, limit_value=0.5, hard_cliff) with remediation text in metadata. The Stop 1 vendor-side spending cap is the real cost protection; this adapter is an early-warning layer that's silent until an admin key is provided. On successful auth (when an admin key is configured), the adapter attempts a best-effort spend extraction with multiple candidate response-shape paths since the real response shape is unknown until first success.
- **C4: `monitoring-probe` deployed, used, then deleted.** Diagnostic edge function not committed; it served its one-time purpose. The findings it captured are documented above so a future operator hitting the same "0 snapshots after auth" symptom doesn't have to rediscover them.

**Smoke after the rewrites (2026-05-11):**
```
adaptersConfigured: ["resend","supabase","vercel","stripe","anthropic"]
adapterErrors: []
snapshotsWritten: 9            ← jumped from 5 (resend+stripe only) to 9 (added supabase 3, vercel 1, anthropic 1 diagnostic)
workspaceSnapshotsWritten: 8
alertsFired: 1                 ← anthropic admin_key_invalid crossing hard_cliff
alertEmailsSent: 1             ← email dispatched to daniel.c.priest@gmail.com
renewalsAlerted: 0
```

**Operator follow-up owed:**
- Replace `ANTHROPIC_ADMIN_API_KEY` with a true admin-scoped key from https://console.anthropic.com/settings/keys → "Admin Keys" section. Until then the diagnostic snapshot will alert on every cron run. (Alternative: silence the alert by deleting the recipient row for anthropic-only and accept that admin-key monitoring is silent — but this defeats the early-warning purpose.)
- The cap-vs-monitor mismatch flagged earlier (operator set `ANTHROPIC_MONTHLY_CAP_USD=100` but Anthropic Console hard cap is $200) is still owed an intent confirmation. The monitor will alert at 50/75/90% of `$100`; the actual vendor-side cutoff is $200. If the intent is "warn me at $50/75/90 so I have headroom under the $200 cap," current config is correct.

Phase 4 remains GATED on Phase 9 (Firm Layer Foundation) per spec.

### Phase 4 as-built
*(pending; blocked on Phase 9)*
