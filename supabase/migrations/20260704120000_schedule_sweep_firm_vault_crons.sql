-- Operator backlog 2026-07-04 — schedule the three crons whose functions are
-- deployed but were never wired to pg_cron: sweep-pending-workspaces (abandoned
-- pending-workspace collector, 2h cutoff, Stripe-truth re-derivation before any
-- delete), firm-billing-reconcile (firm subscription quantity drift repair),
-- and vault-renewal-reminder (V4 no-surprise-billing email ~14d before the
-- $249/yr Vault renewal; the vault_renewal_reminders ledger makes daily runs
-- idempotent).
--
-- Uses pg_cron + pg_net + the private.cron_secrets ledger, exactly like the
-- lease-retention (20260625130100), reclaim-stuck-extractions (20260623000000)
-- and cancellation-lifecycle crons.
--
-- OPERATOR-GATED (fail-closed): each edge function rejects any call whose
-- x-cron-secret header does not match its *_CRON_SECRET env var, and each
-- schedule forwards the secret from private.cron_secrets. Until the operator
-- (a) `supabase secrets set <NAME>_CRON_SECRET=<v>` and (b) INSERTs the same
-- value into private.cron_secrets under the matching id, the POST carries a
-- NULL secret and the function returns 401 — nothing runs. cron.schedule
-- upserts by job name, so re-running this migration replaces rather than errors.
--
-- Times chosen to avoid the existing slots (05:00, 06:00, 08:00, 08:15, 08:30,
-- 09:00, 14:00 daily; :05 hourly; */10; */15).

SELECT cron.schedule(
  'sweep-pending-workspaces-hourly',
  '35 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/sweep-pending-workspaces',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'sweep_pending_workspaces' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'firm-billing-reconcile-daily',
  '30 7 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/firm-billing-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'firm_billing' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'vault-renewal-reminder-daily',
  '20 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/vault-renewal-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'vault_renewal' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
