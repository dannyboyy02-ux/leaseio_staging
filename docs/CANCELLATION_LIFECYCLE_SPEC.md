# Cancellation Lifecycle — Soft-Delete + Buffered Purge

Ratified 2026-06-12 (researched against Visual Lease DPA + GDPR Art. 28 norms).

## Policy

1. **Grace (30 days, from period end):** when the plan subscription FULLY ends
   (Stripe status `canceled`), the workspace becomes read-only — view + export
   stay available; uploads, AI processing, requests, and approvals are blocked.
2. **Soft-delete (day 30):** access revoked (full-page wall outside Settings),
   processing stopped. Renewal still restores everything.
3. **Purge (+~10 days):** hard delete — storage, leases, workspace row — after
   writing the durable `deleted_workspaces` forensic row. Irreversible.
4. **Renewal at ANY point before purge** clears all lifecycle columns.
   Dunning states (`past_due`/`unpaid`/`incomplete`) never start this clock.
5. **Emails** to owner + admins at days 0/7/14/21/27, a final notice on the
   last day (arms day 29), and a post-soft-delete notice. Renew + export CTAs.

## Components

| Piece | Where |
|---|---|
| Lifecycle columns (`canceled_at`, `grace_expires_at`, `soft_deleted_at`, `purge_after`) + `cancellation_notices` ledger + guard re-derivation (4th) | `supabase/migrations/20260612160000_cancellation_lifecycle.sql` |
| Grace start/clear on webhook | `supabase/functions/stripe-webhook/index.ts` (`applySubscription`) |
| Daily cron: reminders → soft-delete → purge | `supabase/functions/process-cancellation-lifecycle/index.ts` |
| Pure logic + Deno mirror | `src/lib/cancellationLifecycle.ts` / `supabase/functions/_shared/cancellation_lifecycle.ts` |
| Banner + soft-delete wall | `src/components/CancellationBanner.tsx`, mounted in `AppLayout.tsx` (Settings stays reachable so admins can renew) |
| Server backstop | `process_lease` `checkProcessingQuota` → 403 `subscription_canceled` |
| Honest cancel-dialog copy | `account.cancel_confirm_desc*` (en/es) |

## Operator setup (required before the lifecycle is live)

1. Apply the migration; deploy `stripe-webhook`, `process-cancellation-lifecycle`,
   and `process_lease` (CLI — too large for MCP).
2. `supabase secrets set CANCELLATION_LIFECYCLE_CRON_SECRET=$(openssl rand -hex 32)`
   (keep the generated value — the cron job header needs it).
3. Schedule the cron DAILY at **Dashboard → Integrations → Cron → Jobs →
   Create job** (NOT under Database — the Cron module lives under
   Integrations): type "Supabase Edge Function", POST, headers
   `x-cron-secret: <secret>` + `Content-Type: application/json`, body `{}`,
   schedule `0 14 * * *`. Job names are case-sensitive and immutable.
   There is no "Run now" — verify with a manual `curl -X POST` carrying
   the same headers (expect `{"ok":true,...}` all-zero stats on a clean
   project), then check the job's History after the first scheduled run.
4. Resend already monitored via vendor-health-check; email volume bounded at
   200/run (`MAX_EMAILS_PER_RUN`).

## Invariants

- Lifecycle columns are service-role-only (#29 entitlement guard family).
- `cancellation_notices` UNIQUE(workspace, cycle, type) = idempotent sends;
  `cycle_started_at = canceled_at` resets the set on cancel→renew→cancel.
- Purge writes the forensic row FIRST and aborts if that insert fails.
- Every cron step re-checks entitlement and self-heals renewed workspaces.

## Review-hardening notes (2026-06-12, post security/integrity review)

- **Stale-event guard:** the webhook ignores non-entitled events whose
  subscription id differs from the workspace's stored one (C1 — late
  redelivery of an old sub's `canceled` event can never restart the clock
  on a renewed workspace).
- **Forward-notice floor:** `grace_expires_at = max(ended_at + 30d, now + 7d)`
  — a webhook delivered very late can never soft-delete without notice.
- **Purge order:** fresh re-verify → Stripe subscription cleanup (packs etc.;
  purge DEFERRED if cleanup fails) → forensic row with lifecycle + notice
  snapshot in `deleted_workspaces.details` → conditional row deletes →
  storage purge last (buckets: `leases`/`executed-leases` by uploader prefix,
  `lease-documents`/`lease-reports` by workspace prefix, recursive).
- **Ledger trade-off:** notices claim the ledger row before sending
  (double-send-proof); a crash between claim and send swallows that notice.
  Per-recipient delivery outcomes are recorded back onto the row.
- **Retroactivity:** workspaces already `canceled` before this deployed are
  NOT enrolled (no webhook event will re-fire) — deliberate; enroll manually
  via a service-role backfill if ever needed.
- **Enforcement depth:** grace read-only currently covers processing + pack
  purchases only; broader write-gating is KNOWN_ISSUES #75.
