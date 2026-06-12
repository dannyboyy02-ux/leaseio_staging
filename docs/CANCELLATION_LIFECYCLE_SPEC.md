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
3. Schedule the cron DAILY (same scheduler as the other crons), POSTing with
   header `x-cron-secret: <secret>`.
4. Resend already monitored via vendor-health-check; email volume bounded at
   200/run (`MAX_EMAILS_PER_RUN`).

## Invariants

- Lifecycle columns are service-role-only (#29 entitlement guard family).
- `cancellation_notices` UNIQUE(workspace, cycle, type) = idempotent sends;
  `cycle_started_at = canceled_at` resets the set on cancel→renew→cancel.
- Purge writes the forensic row FIRST and aborts if that insert fails.
- Every cron step re-checks entitlement and self-heals renewed workspaces.
