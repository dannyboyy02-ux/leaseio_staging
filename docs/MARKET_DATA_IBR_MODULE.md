# Module: Market Data & IBR

**Workstream type:** Parallel module, not a phase
**Owner:** Daniel
**Status:** Spec, not yet started
**Relationship to phases:** Independent of Phases 3–8. Can ship anytime after the core LeaseIO product is functional in Pro and Business tiers.
**Estimated effort:** ~3 weeks for IBR + ~1 week for CPI = ~4 weeks total
**Tier exposure:** Pro and Business only. Plus tier sees a teaser/upgrade prompt but no live data.

---

## Why this is a module, not a phase

The numbered phases (1–8) describe the approval routing architecture: policy editor, chain resolution, lifecycle states, document tracking, signator handling, rerouting, delegation, and report integration. Each phase depends on the prior one and they ship in sequence.

Market Data & IBR is structurally different. It does not depend on the approval chain, the lifecycle states, or the report integration. It adds an independent capability — agent-driven market rate ingestion and audit-ready IBR calculation — that any lease in any state can use. Treating it as a parallel module keeps the phase numbering clean and lets it be scheduled independently of the approval routing roadmap.

The module can ship before Phase 8 (ASC 842 report integration) because it does not depend on report generation. It can also ship after Phase 8, in which case the report integration would automatically benefit from having structured IBR documentation packets to reference.

---

## Why this module exists

Two reasons, in order of importance:

1. **Tier differentiation.** Plus, Pro, and Business need a real reason for buyers to step up tiers. Live agent-driven rate updates with audit-ready documentation is a feature SMB-tier competitors (iLeaseXpress, LeaseGuru, Black Owl at the small portfolios) do not have. It is the cleanest justification for the Pro tier price point and a strong upsell to Business.

2. **Audit-defensibility positioning, without taking on liability.** The product position is: *the customer's treasury team or valuation advisor sets the credit spread once per year; LeaseIO automates the data gathering, calculation, documentation, and audit trail.* This keeps LeaseIO out of the "valuation professional" lane (which would require licensing, professional liability, and SOC implications we have explicitly avoided) while still delivering meaningful automation value.

## What this module is NOT

- **Not** an IBR-as-a-service product. We are not generating IBRs from nothing. We are not signing methodology certifications. We are not replacing Deloitte's IBR Calculator or Sofer Advisors' valuation engagements.
- **Not** a CPI forecasting service. We pull official BLS releases. We do not predict future CPI.
- **Not** a feature for the Plus tier. Plus stays simple — flat schedules, manual rate entry. The complexity here is for buyers who actually need it.
- **Not** a public tool. Rate data lives behind authentication, scoped per workspace via RLS where applicable.
- **Not** part of the approval routing phase plan. Phase 6 in that plan is rerouting; this module is independent.

## What it does, in one paragraph

For each Pro/Business workspace, an autonomous agent pulls market rate data daily from public sources (Treasury yields, SOFR curves, CPI), writes timestamped rows to a `market_rates` table, sanity-checks the values, and surfaces them in the workspace's IBR Configuration page. The customer (or their advisor) sets a credit spread per asset class and tenor bucket once per year. When a new lease is added or remeasured, LeaseIO calculates the IBR by matching the lease term to the appropriate tenor's risk-free rate and adding the customer's stored spread. Each calculation generates a documentation packet — source URLs, fetch timestamps, raw rate values, applied spread, calculated IBR, methodology narrative, user attribution — exportable as a PDF for the customer's audit binder. The same pattern handles CPI for CPI-indexed escalation clauses: monthly fetch, automatic alert when an escalation should re-apply to a lease's payment schedule, customer reviews and approves the re-application.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Public data sources (free)                   │
│  Treasury.gov XML  │  FRED API  │  BLS API  │  ALFRED API       │
└──────────────┬──────────────────────────────────────────────────┘
               │
               │  Daily cron (08:00 ET) for rates
               │  Monthly cron (BLS release day +1h) for CPI
               ▼
┌─────────────────────────────────────────────────────────────────┐
│         Supabase Edge Function: market_data_ingestion           │
│  Fetches sources, validates, writes to market_rates table       │
│  Anomaly check; flags outliers; emits monitoring events         │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase tables (global, no RLS)                   │
│  market_rates  │  cpi_releases  │  market_data_audit_log        │
└──────────────┬──────────────────────────────────────────────────┘
               │
               │  Read by per-workspace functions, scoped via RLS
               ▼
┌─────────────────────────────────────────────────────────────────┐
│          Per-workspace tables (RLS scoped)                      │
│  workspace_ibr_config   │  ibr_calculations                     │
│  cpi_escalation_alerts  │  ibr_documentation_packets            │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  UI: IBR Configuration page (annual setup)                      │
│  UI: Per-lease IBR display and override                         │
│  UI: CPI escalation review queue                                │
│  Export: Audit packet PDF                                       │
└─────────────────────────────────────────────────────────────────┘
```

The market data tables are global — every Pro/Business workspace reads from the same `market_rates` rows. The IBR config and calculations are workspace-scoped under existing RLS patterns.

---

## Data sources (all free, all stable)

| Source | URL | Auth | Rate limit | Frequency | What we pull |
|--------|-----|------|------------|-----------|--------------|
| US Treasury Daily Yield Curve | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/<year>/all?type=daily_treasury_yield_curve&field_tdr_date_value=<year>&page&_format=csv` | None | Generous, undocumented | Daily, ~3pm ET release | 1M, 2M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y constant maturity yields |
| FRED API (Term SOFR) | `https://api.stlouisfed.org/fred/series/observations` | API key, free | 120 req/min | Daily | Term SOFR 1M, 3M, 6M, 12M (series IDs `SOFR1M`, `SOFR3M`, `SOFR6M`, `SOFR12M`) |
| BLS API v2 | `https://api.bls.gov/publicAPI/v2/timeseries/data/` | API key, free, 500 req/day registered | 500/day | Monthly, second Tuesday of release month | CPI-U All Items (`CUUR0000SA0`); regional and category series as needed |
| ALFRED (FRED revisions) | `https://api.stlouisfed.org/fred/series/observations` | Same FRED key | Same | As-needed | Used to detect retroactive revisions to historical data |

**Why free public sources matter:** No vendor lock-in, no per-call costs that scale with customer count, no data-licensing concerns. The cost ceiling is essentially infrastructure (negligible) regardless of how many customers we add.

**One real risk:** Treasury.gov's CSV endpoint is technically a "resource center" download, not a documented API. It has been stable for years but has no SLA. **Mitigation:** the ingestion function logs every successful fetch with a hash; if the format ever changes, the function fails loudly into the monitoring system rather than writing bad data.

---

## Database schema

### Global tables (no RLS — read-only for authenticated users on Pro/Business workspaces)

```sql
-- Treasury and SOFR rate data
CREATE TABLE public.market_rates (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('treasury', 'sofr', 'fred_other')),
  series_code TEXT NOT NULL,         -- e.g., 'CMT_5Y', 'SOFR_3M'
  tenor_months INTEGER NOT NULL,     -- 1, 3, 6, 12, 24, 36, 60, 84, 120, 240, 360
  rate_value NUMERIC(8,5) NOT NULL,  -- 5 decimal places, e.g., 4.37500
  observation_date DATE NOT NULL,    -- the date the rate applies to
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url TEXT NOT NULL,          -- exact URL of the fetch, for audit trail
  source_payload_hash TEXT NOT NULL, -- sha256 of raw fetched payload, for forensics
  ingestion_run_id UUID NOT NULL,    -- groups rates fetched in the same run
  is_anomaly_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  anomaly_reason TEXT,               -- if flagged, why
  CONSTRAINT market_rates_unique_observation UNIQUE (series_code, observation_date)
);

CREATE INDEX market_rates_series_date_idx ON public.market_rates (series_code, observation_date DESC);
CREATE INDEX market_rates_observation_date_idx ON public.market_rates (observation_date DESC);

-- CPI release data
CREATE TABLE public.cpi_releases (
  id BIGSERIAL PRIMARY KEY,
  series_code TEXT NOT NULL,         -- e.g., 'CUUR0000SA0' (CPI-U All Items)
  series_name TEXT NOT NULL,         -- human readable
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,     -- 1-12
  index_value NUMERIC(10,3) NOT NULL,
  yoy_change_pct NUMERIC(7,4),       -- year-over-year, computed at ingest
  mom_change_pct NUMERIC(7,4),       -- month-over-month, computed at ingest
  release_date DATE NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  ingestion_run_id UUID NOT NULL,
  is_revision BOOLEAN NOT NULL DEFAULT FALSE,
  revised_from_value NUMERIC(10,3),  -- if BLS later revised this period
  CONSTRAINT cpi_releases_unique_period UNIQUE (series_code, period_year, period_month)
);

CREATE INDEX cpi_releases_series_period_idx ON public.cpi_releases (series_code, period_year DESC, period_month DESC);

-- Audit log of every ingestion run
CREATE TABLE public.market_data_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ingestion_run_id UUID NOT NULL,
  run_type TEXT NOT NULL CHECK (run_type IN ('treasury_daily', 'sofr_daily', 'cpi_monthly', 'manual_backfill')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  anomalies_flagged INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  raw_response_truncated TEXT       -- first 4KB of response for forensic
);

CREATE INDEX audit_log_run_type_started_idx ON public.market_data_audit_log (run_type, started_at DESC);
```

### Per-workspace tables (RLS-scoped)

```sql
-- One row per asset_class × tenor_bucket per workspace
-- Set annually by the customer's treasury team or valuation advisor
CREATE TABLE public.workspace_ibr_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('real_estate', 'equipment', 'vehicle', 'other')),
  tenor_bucket TEXT NOT NULL CHECK (tenor_bucket IN ('0_2y', '2_5y', '5_7y', '7_10y', '10_15y', '15_plus')),
  base_rate_source TEXT NOT NULL CHECK (base_rate_source IN ('treasury_cmt', 'sofr')),
  credit_spread_bps INTEGER NOT NULL,     -- e.g., 250 = 2.50%
  effective_date DATE NOT NULL,
  expires_date DATE,                       -- typically effective + 12 months
  set_by_user_id UUID REFERENCES auth.users(id),
  set_by_user_role TEXT,                   -- e.g., 'controller', 'cfo', 'external_advisor'
  methodology_notes TEXT,                  -- free text from the customer/advisor
  external_advisor_name TEXT,              -- if set by external valuation firm
  external_advisor_engagement_ref TEXT,    -- optional reference to engagement letter
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_ibr_config_unique_active UNIQUE (workspace_id, asset_class, tenor_bucket, effective_date)
);

ALTER TABLE public.workspace_ibr_config ENABLE ROW LEVEL SECURITY;

-- One row per IBR calculation event (lease creation, remeasurement)
CREATE TABLE public.ibr_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN ('lease_creation', 'remeasurement', 'manual_override', 'manual_recalc')),
  calculation_date DATE NOT NULL,
  asset_class TEXT NOT NULL,
  lease_term_months INTEGER NOT NULL,
  matched_tenor_bucket TEXT NOT NULL,
  base_rate_source TEXT NOT NULL,
  base_rate_observation_date DATE NOT NULL,
  base_rate_value NUMERIC(8,5) NOT NULL,
  market_rates_id BIGINT REFERENCES public.market_rates(id),  -- exact rate row used
  credit_spread_bps INTEGER NOT NULL,
  workspace_ibr_config_id UUID REFERENCES public.workspace_ibr_config(id),
  calculated_ibr NUMERIC(8,5) NOT NULL,
  was_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  override_value NUMERIC(8,5),
  override_reason TEXT,
  override_by_user_id UUID REFERENCES auth.users(id),
  final_ibr NUMERIC(8,5) NOT NULL,         -- = override_value if overridden, else calculated_ibr
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id)
);

ALTER TABLE public.ibr_calculations ENABLE ROW LEVEL SECURITY;

-- CPI escalation alerts
CREATE TABLE public.cpi_escalation_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  cpi_series_code TEXT NOT NULL,
  triggering_release_id BIGINT NOT NULL REFERENCES public.cpi_releases(id),
  prior_index_value NUMERIC(10,3) NOT NULL,
  new_index_value NUMERIC(10,3) NOT NULL,
  pct_change NUMERIC(7,4) NOT NULL,
  proposed_escalation_pct NUMERIC(7,4) NOT NULL,  -- after applying floor/cap from lease terms
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved_applied', 'rejected', 'superseded')),
  reviewed_by_user_id UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  applied_to_schedule_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.cpi_escalation_alerts ENABLE ROW LEVEL SECURITY;

-- Audit packet metadata (the actual PDFs go to Storage)
CREATE TABLE public.ibr_documentation_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ibr_calculation_id UUID NOT NULL REFERENCES public.ibr_calculations(id) ON DELETE CASCADE,
  packet_format TEXT NOT NULL DEFAULT 'pdf' CHECK (packet_format IN ('pdf')),
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by_user_id UUID REFERENCES auth.users(id),
  packet_hash TEXT NOT NULL                 -- sha256 of the rendered PDF, anti-tamper
);

ALTER TABLE public.ibr_documentation_packets ENABLE ROW LEVEL SECURITY;
```

### RLS policies (per existing LeaseIO pattern)

For each per-workspace table:
- `SELECT` allowed where `workspace_id` is in the user's accessible workspaces
- `INSERT`/`UPDATE` allowed where the user has the appropriate role in that workspace
- Specifically for `workspace_ibr_config`: only users with `controller`, `cfo`, or `external_advisor` role can insert/update (not regular members)

The exact policy SQL follows the existing LeaseIO pattern from prior phases — committed as part of the module migration set, idempotent.

---

## Edge function: `market_data_ingestion`

Single edge function with three modes selected by event payload:

```ts
// supabase/functions/market_data_ingestion/index.ts
//
// Modes:
//   - mode=treasury_daily   (cron: 0 13 * * 1-5  // weekdays 8am ET)
//   - mode=sofr_daily       (cron: 30 13 * * 1-5)
//   - mode=cpi_monthly      (cron: 0 14 * * *  with day-of-release check inside)
//
// Each mode:
//   1. Generate a fresh ingestion_run_id (UUID)
//   2. Insert a 'running' row in market_data_audit_log
//   3. Fetch from the source URL with timeout (30s)
//   4. Hash the raw payload (sha256)
//   5. Parse and validate (schema check, range check)
//   6. Run anomaly detection (described below)
//   7. Upsert into market_rates or cpi_releases (ON CONFLICT DO NOTHING)
//   8. For CPI: derive cpi_escalation_alerts for affected leases
//   9. Mark audit log row 'success', 'partial', or 'failed'
//  10. Emit monitoring event on failure or anomaly
```

**Anomaly detection (deliberately simple, deliberately strict):**

- For Treasury and SOFR: the new rate cannot differ from the prior business day's rate by more than 100 basis points. If it does, flag and do not write — write to a quarantine table for human review.
- For CPI: the new month-over-month change cannot exceed 3% in absolute value. Same quarantine pattern if exceeded.
- For all sources: if the response is empty, missing required fields, or has a payload hash identical to a fetch from more than 7 days ago (suggesting a cached/stale response), flag and quarantine.

The anomaly thresholds are deliberately conservative. Real economic events (a 100bp Treasury move in one day, a 3% MoM CPI swing) would be globally newsworthy and warrant manual review anyway. False positives are cheap; false negatives in audit-relevant data are expensive.

**Failure handling:**

- Source returns 5xx or times out: retry with exponential backoff up to 3 times, then fail and emit alert.
- Source returns unexpected schema: do not write, emit alert with payload hash.
- Database write fails: roll back the audit log row to 'failed', emit alert.
- All alerts go to the daily ops digest agent (separate work, but the wiring is `INSERT INTO ops_digest_events (...)`).

---

## IBR calculation flow

When a lease is created or remeasured in a Pro/Business workspace:

1. The lease form computes the lease term in months.
2. The system looks up the matching `workspace_ibr_config` row by `asset_class` + `tenor_bucket`.
3. If no config exists for that combination → block lease save and prompt the user to set up IBR config first. Display a clear message: *"Your workspace needs an IBR configuration for [asset class] / [tenor bucket] leases before this lease can be saved. Set this up in Settings → IBR Configuration. This is typically done annually by your treasury team or valuation advisor."*
4. If config exists, fetch the most recent `market_rates` row for the configured `base_rate_source` and matching tenor.
5. If the most recent rate is more than 7 days stale → still allow the calculation but flag it in the documentation packet. (Friday + long weekend can produce 4-day stales; we want to allow this without pestering the user.)
6. Calculate: `final_ibr = base_rate_value + (credit_spread_bps / 10000)`.
7. Insert an `ibr_calculations` row capturing every input.
8. Auto-generate the documentation packet (next section) and store it.
9. Apply the IBR to the lease's amortization schedule.

**Override path:** the user (with appropriate role) can override the calculated IBR, but must enter a reason. Override is captured in `ibr_calculations` with `was_overridden = true`. Override reasons surface prominently in the audit packet — this is exactly what auditors want to see.

---

## Documentation packet (PDF)

Generated automatically on every `ibr_calculations` row insert. Stored in a dedicated Storage bucket scoped per workspace.

**Sections of the PDF:**

1. **Header** — workspace name, lease identifier, calculation date, calculation ID
2. **Lease summary** — asset class, term, payment summary (no sensitive amounts unless explicitly enabled)
3. **IBR result** — final IBR with two-decimal display, formula breakdown
4. **Base rate detail** — source name, source URL, observation date, fetch timestamp, exact rate value, payload hash
5. **Credit spread detail** — spread in basis points, effective date of the workspace config, who set it (user + role + optional external advisor name and engagement reference), methodology notes from the config
6. **Calculation methodology** — the static narrative paragraph: "This IBR was calculated by adding the customer's pre-determined credit spread for this asset class and tenor to the most recent published [Treasury constant maturity / SOFR] rate matching the lease term. The credit spread was determined and recorded by [name/role] effective [date], with methodology described in the credit spread documentation set by the customer's [treasury team / external advisor]. LeaseIO automated the data retrieval and calculation; LeaseIO does not certify the methodology or the rate."
7. **Override details if applicable** — original calculated value, override value, override reason, overriding user
8. **Tamper hash** — sha256 of the packet itself, displayed at the bottom for the customer's records

**Important:** the PDF must NOT contain any language suggesting LeaseIO has certified or vouched for the methodology. The product's value here is automation and documentation, not certification.

---

## CPI escalation flow

When a new CPI release is ingested:

1. The ingestion function identifies all `leases` rows in Pro/Business workspaces with CPI-indexed escalation clauses tied to that CPI series.
2. For each affected lease, calculate the proposed escalation:
   - Read the lease's stored CPI escalation rule (base period, floor, cap, frequency)
   - Compare the new CPI release to the prior reference period
   - Apply floor/cap from the lease terms
   - Compute the proposed escalation percentage
3. Insert a `cpi_escalation_alerts` row with status `pending_review`.
4. The alert appears in a "CPI Escalations Awaiting Review" queue in the workspace UI.
5. Authorized users review, approve or reject. Approved alerts trigger a schedule re-application via the existing remeasurement pipeline. Rejected alerts must include a reason.

This is HITL by design — the same pattern as lease verification. CPI escalation is mechanical but the trigger conditions and floor/cap interpretation can vary by lease, so we never auto-apply.

---

## Module build order

1. Migrations: global tables (`market_rates`, `cpi_releases`, `market_data_audit_log`)
2. Migrations: per-workspace tables with RLS (`workspace_ibr_config`, `ibr_calculations`, `cpi_escalation_alerts`, `ibr_documentation_packets`)
3. Edge function: `market_data_ingestion` with treasury_daily mode + tests
4. Edge function: sofr_daily mode + tests
5. Edge function: cpi_monthly mode + tests
6. PDF generation for IBR documentation packets
7. UI: IBR Configuration settings page (Pro/Business only)
8. UI: IBR display on lease creation/remeasurement
9. UI: IBR override flow
10. UI: CPI escalation review queue
11. End-to-end tests covering each happy and unhappy path
12. Backfill historical Treasury/SOFR/CPI for the trailing 24 months (one-time `manual_backfill` run)

Each step ships behind a feature flag (`feature_module_market_data_ibr` and `feature_module_market_data_cpi`) until the full module is verified end-to-end. Steps 1–2 must be in a single migration set, committed to git, before any edge function code is written.

---

## Test scenarios that must pass before module is considered done

**Ingestion tests (run in staging against real public sources):**

- Treasury fetch on a normal weekday, all 12 tenors written, no anomalies
- Treasury fetch on a federal holiday (no new data), no rows written, audit log marked `success` with `records_skipped > 0`
- SOFR fetch on a normal weekday, 4 series written
- CPI fetch on release day, all configured series written with derived YoY/MoM, escalation alerts generated for affected leases
- Synthetic anomaly: feed a payload with a 200bp jump, confirm quarantine and alert
- Synthetic schema break: feed a malformed Treasury CSV, confirm fail-loud and no rows written
- Repeat fetch within the same day: confirm idempotency via the `UNIQUE` constraint, no duplicates

**IBR calculation tests:**

- Pro workspace creates a 5-year real estate lease with config in place: IBR calculated correctly, packet generated, packet hash stored
- Pro workspace creates a 5-year real estate lease with NO config in place: lease save blocked with the prompt message
- Business workspace creates a 60-month equipment lease, matched to `2_5y` bucket: correct rate and packet
- Override flow: user with controller role overrides a calculated IBR, reason captured, packet shows both original and override
- Override flow: user without authorized role attempts override, blocked at RLS level
- Stale base rate (8 days old due to weekend + holiday): packet warns but allows calculation
- Cross-workspace isolation: User A in Workspace 1 cannot see IBR calculations or packets from Workspace 2

**CPI escalation tests:**

- New CPI release triggers alerts for all affected CPI-indexed leases in Pro/Business workspaces
- Alert respects lease floor and cap correctly
- Approval applies the escalation to the lease schedule via the existing remeasurement pipeline
- Rejection requires a reason and is captured
- Plus tier workspace with a CPI-indexed lease: NO alert generated (this feature is not exposed to Plus)

**Documentation packet tests:**

- Packet content matches the calculation inputs exactly
- Packet hash matches the stored value
- Tamper test: packet PDF is modified, hash mismatch detected on re-verification
- Packet contains zero language suggesting LeaseIO certified the methodology

**SOC / liability boundary tests:**

- Search the codebase for any string suggesting LeaseIO certifies, validates, or vouches for IBR rates or methodologies. Should return zero results outside of negation phrasing.

---

## Out of scope for this module

Explicitly not in this module, even though they are tempting:

- **IBR benchmarking across customers** ("here's what other companies in your industry use"). This crosses into providing methodology guidance, which is exactly the lane we are staying out of. Possible separate workstream later if framed correctly.
- **Yield curve interpolation between published tenors.** We use exact tenor matches. Interpolation introduces methodology choices; the customer's advisor handles that if relevant.
- **International rate sources (SONIA, EURIBOR, etc.).** US-only for now.
- **GASB 87 risk-free-rate election support.** Future module candidate.
- **Auto-suggesting credit spreads.** Hard no — this is the methodology lane.

---

## Relationship to the phase plan

This module does not block and is not blocked by the numbered phases. Specifically:

- **Independent of Phase 3 (Lifecycle expansion).** IBR calculations attach to leases regardless of their lifecycle state.
- **Independent of Phases 4–5 (Negotiation, Signator).** Document tracking and signatory workflow do not interact with IBR calculation timing.
- **Independent of Phase 6 (Rerouting).** A rerouted lease that is materially changed will trigger a remeasurement, which generates a new `ibr_calculations` row and packet — but the trigger comes from the existing remeasurement pipeline, not from the rerouting logic itself.
- **Independent of Phase 7 (Delegation/Override).** Approval delegation does not affect IBR calculation paths.
- **Synergistic with Phase 8 (ASC 842 report integration).** When the report module ships, it can reference IBR documentation packets directly. If this module ships before Phase 8, the report integration becomes more powerful when it arrives. If this module ships after Phase 8, the report integration adds IBR packet references retroactively.

The recommended sequencing is: ship Phase 3 first (lifecycle expansion is the riskiest in-flight work), then this module can run in parallel with Phases 4 and 5 if there is capacity, or sequentially after them.

---

## Open questions for Daniel

1. **Storage bucket scoping.** Should `ibr_documentation_packets` go into the existing per-workspace storage bucket or a new dedicated `ibr_packets_<workspace_id>` bucket? Dedicated is cleaner for retention and access control, but adds bucket-management overhead. Recommend dedicated.

2. **Backfill depth.** Recommend 24 months of historical Treasury/SOFR and 36 months of CPI on the initial backfill. Enough for any reasonable retroactive lease commencement scenario without bloating storage. Confirm or override.

3. **External advisor user role.** This module introduces the concept of an "external advisor" who can set IBR config. This may require a new role added to the workspace permissions schema. If we want to defer creating this role to a later iteration, we can fall back to "controller or cfo only" for the MVP and add `external_advisor` as a follow-up.

4. **Anomaly review UI.** When the ingestion function quarantines an anomaly, who sees it? Recommendation: only the LeaseIO ops view (yours), not customer-facing. If a real anomaly occurs, you investigate and either approve the data manually or wait for the next normal release.

5. **Pricing change timing.** The Pro tier price change (e.g., $79 → $179 to reflect this feature) — apply on module ship, or grandfather existing Pro customers at the old price for a transition period? Recommend grandfathering existing for 6 months as a goodwill gesture; new customers pay the new price from day one.

---

## Migration files (saved here for reference; NOT in `supabase/migrations/` until module opens)

Per the Schema Change Rule, files in `supabase/migrations/` are authoritative and applied. These two files stay inline in this spec until the module is ratified for build; at that point Checkpoint 1 lifts them into `supabase/migrations/<timestamp>_module_market_data_global.sql` and `<timestamp>_module_workspace_ibr_tables.sql`.

### `<timestamp>_module_market_data_global.sql`

```sql
-- Module: Market Data & IBR — global market data tables
-- (Treasury yields, SOFR, CPI releases, ingestion audit log)
--
-- This is part of the parallel "Market Data & IBR" workstream and is NOT
-- one of the numbered approval-routing phases (Phase 1–8). It can be
-- applied independently of those phases.
--
-- These tables are global (no RLS) — every Pro/Business workspace reads
-- from the same rows. Read access is granted to authenticated users; write
-- access is restricted to the service role used by the market_data_ingestion
-- edge function.
--
-- Idempotent: safe to run against fresh and existing environments.

BEGIN;

CREATE TABLE IF NOT EXISTS public.market_rates (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('treasury', 'sofr', 'fred_other')),
  series_code TEXT NOT NULL,
  tenor_months INTEGER NOT NULL,
  rate_value NUMERIC(8,5) NOT NULL,
  observation_date DATE NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  ingestion_run_id UUID NOT NULL,
  is_anomaly_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  anomaly_reason TEXT,
  CONSTRAINT market_rates_unique_observation UNIQUE (series_code, observation_date)
);

CREATE INDEX IF NOT EXISTS market_rates_series_date_idx
  ON public.market_rates (series_code, observation_date DESC);

CREATE INDEX IF NOT EXISTS market_rates_observation_date_idx
  ON public.market_rates (observation_date DESC);

CREATE TABLE IF NOT EXISTS public.cpi_releases (
  id BIGSERIAL PRIMARY KEY,
  series_code TEXT NOT NULL,
  series_name TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  index_value NUMERIC(10,3) NOT NULL,
  yoy_change_pct NUMERIC(7,4),
  mom_change_pct NUMERIC(7,4),
  release_date DATE NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  ingestion_run_id UUID NOT NULL,
  is_revision BOOLEAN NOT NULL DEFAULT FALSE,
  revised_from_value NUMERIC(10,3),
  CONSTRAINT cpi_releases_unique_period UNIQUE (series_code, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS cpi_releases_series_period_idx
  ON public.cpi_releases (series_code, period_year DESC, period_month DESC);

CREATE TABLE IF NOT EXISTS public.market_data_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ingestion_run_id UUID NOT NULL,
  run_type TEXT NOT NULL CHECK (run_type IN ('treasury_daily', 'sofr_daily', 'cpi_monthly', 'manual_backfill')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  anomalies_flagged INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  raw_response_truncated TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_run_type_started_idx
  ON public.market_data_audit_log (run_type, started_at DESC);

GRANT SELECT ON public.market_rates TO authenticated;
GRANT SELECT ON public.cpi_releases TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.market_rates FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.cpi_releases FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.market_data_audit_log FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.market_rates FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.cpi_releases FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.market_data_audit_log FROM authenticated;

REVOKE SELECT ON public.market_data_audit_log FROM PUBLIC;
REVOKE SELECT ON public.market_data_audit_log FROM authenticated;

COMMIT;
```

### `<timestamp>_module_workspace_ibr_tables.sql`

```sql
-- Module: Market Data & IBR — per-workspace tables
-- (workspace IBR config, IBR calculations, CPI escalation alerts,
--  IBR documentation packets)
--
-- This is part of the parallel "Market Data & IBR" workstream and is NOT
-- one of the numbered approval-routing phases (Phase 1–8). It can be
-- applied independently of those phases.
--
-- All tables are RLS-scoped per workspace, following the existing LeaseIO
-- RLS pattern. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_ibr_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('real_estate', 'equipment', 'vehicle', 'other')),
  tenor_bucket TEXT NOT NULL CHECK (tenor_bucket IN ('0_2y', '2_5y', '5_7y', '7_10y', '10_15y', '15_plus')),
  base_rate_source TEXT NOT NULL CHECK (base_rate_source IN ('treasury_cmt', 'sofr')),
  credit_spread_bps INTEGER NOT NULL CHECK (credit_spread_bps BETWEEN -1000 AND 5000),
  effective_date DATE NOT NULL,
  expires_date DATE,
  set_by_user_id UUID REFERENCES auth.users(id),
  set_by_user_role TEXT,
  methodology_notes TEXT,
  external_advisor_name TEXT,
  external_advisor_engagement_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_ibr_config_unique_active UNIQUE (workspace_id, asset_class, tenor_bucket, effective_date)
);

CREATE INDEX IF NOT EXISTS workspace_ibr_config_workspace_idx
  ON public.workspace_ibr_config (workspace_id);

ALTER TABLE public.workspace_ibr_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_ibr_config_select ON public.workspace_ibr_config;
CREATE POLICY workspace_ibr_config_select
  ON public.workspace_ibr_config FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS workspace_ibr_config_insert ON public.workspace_ibr_config;
CREATE POLICY workspace_ibr_config_insert
  ON public.workspace_ibr_config FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid()
      AND role IN ('controller', 'cfo', 'external_advisor')
  ));

DROP POLICY IF EXISTS workspace_ibr_config_update ON public.workspace_ibr_config;
CREATE POLICY workspace_ibr_config_update
  ON public.workspace_ibr_config FOR UPDATE
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid()
      AND role IN ('controller', 'cfo', 'external_advisor')
  ));

CREATE TABLE IF NOT EXISTS public.ibr_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN ('lease_creation', 'remeasurement', 'manual_override', 'manual_recalc')),
  calculation_date DATE NOT NULL,
  asset_class TEXT NOT NULL,
  lease_term_months INTEGER NOT NULL,
  matched_tenor_bucket TEXT NOT NULL,
  base_rate_source TEXT NOT NULL,
  base_rate_observation_date DATE NOT NULL,
  base_rate_value NUMERIC(8,5) NOT NULL,
  market_rates_id BIGINT REFERENCES public.market_rates(id),
  credit_spread_bps INTEGER NOT NULL,
  workspace_ibr_config_id UUID REFERENCES public.workspace_ibr_config(id),
  calculated_ibr NUMERIC(8,5) NOT NULL,
  was_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  override_value NUMERIC(8,5),
  override_reason TEXT,
  override_by_user_id UUID REFERENCES auth.users(id),
  final_ibr NUMERIC(8,5) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS ibr_calculations_workspace_idx
  ON public.ibr_calculations (workspace_id, calculation_date DESC);

CREATE INDEX IF NOT EXISTS ibr_calculations_lease_idx
  ON public.ibr_calculations (lease_id, calculation_date DESC);

ALTER TABLE public.ibr_calculations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ibr_calculations_select ON public.ibr_calculations;
CREATE POLICY ibr_calculations_select
  ON public.ibr_calculations FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS ibr_calculations_insert ON public.ibr_calculations;
CREATE POLICY ibr_calculations_insert
  ON public.ibr_calculations FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS public.cpi_escalation_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  cpi_series_code TEXT NOT NULL,
  triggering_release_id BIGINT NOT NULL REFERENCES public.cpi_releases(id),
  prior_index_value NUMERIC(10,3) NOT NULL,
  new_index_value NUMERIC(10,3) NOT NULL,
  pct_change NUMERIC(7,4) NOT NULL,
  proposed_escalation_pct NUMERIC(7,4) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved_applied', 'rejected', 'superseded')),
  reviewed_by_user_id UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  applied_to_schedule_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpi_escalation_alerts_workspace_status_idx
  ON public.cpi_escalation_alerts (workspace_id, status, created_at DESC);

ALTER TABLE public.cpi_escalation_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cpi_escalation_alerts_select ON public.cpi_escalation_alerts;
CREATE POLICY cpi_escalation_alerts_select
  ON public.cpi_escalation_alerts FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS cpi_escalation_alerts_update ON public.cpi_escalation_alerts;
CREATE POLICY cpi_escalation_alerts_update
  ON public.cpi_escalation_alerts FOR UPDATE
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid()
      AND role IN ('controller', 'cfo', 'external_advisor')
  ));

REVOKE INSERT ON public.cpi_escalation_alerts FROM authenticated;

CREATE TABLE IF NOT EXISTS public.ibr_documentation_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ibr_calculation_id UUID NOT NULL REFERENCES public.ibr_calculations(id) ON DELETE CASCADE,
  packet_format TEXT NOT NULL DEFAULT 'pdf' CHECK (packet_format IN ('pdf')),
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by_user_id UUID REFERENCES auth.users(id),
  packet_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ibr_documentation_packets_workspace_idx
  ON public.ibr_documentation_packets (workspace_id, generated_at DESC);

ALTER TABLE public.ibr_documentation_packets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ibr_documentation_packets_select ON public.ibr_documentation_packets;
CREATE POLICY ibr_documentation_packets_select
  ON public.ibr_documentation_packets FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
  ));

COMMIT;
```
