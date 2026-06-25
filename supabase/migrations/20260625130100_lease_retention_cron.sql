-- Leases redesign Phase 3 — schedule the nightly lease-retention purge cron.
--
-- Posts to the process-lease-retention edge function once a day; that function
-- hard-purges every lease whose 14-day retention window has elapsed
-- (deleted_at IS NOT NULL AND purge_after <= now), writing a deleted_leases
-- forensic row first. Uses pg_cron + pg_net + the private.cron_secrets ledger,
-- exactly like the cancellation-lifecycle (20260612170000) and
-- reclaim-stuck-extractions (20260623000000) crons.
--
-- OPERATOR-GATED (fail-closed): the edge function rejects any call whose
-- x-cron-secret header does not match LEASE_RETENTION_CRON_SECRET, and this
-- schedule forwards the secret from private.cron_secrets WHERE id =
-- 'lease_retention'. Until the operator (a) `supabase secrets set
-- LEASE_RETENTION_CRON_SECRET=<v>`, (b) deploys process-lease-retention, and
-- (c) `INSERT INTO private.cron_secrets (id, value) VALUES ('lease_retention',
-- '<v>')`, the nightly POST carries a NULL secret and the function returns 401 —
-- i.e. nothing is purged. cron.schedule upserts by job name, so re-running this
-- migration replaces the schedule rather than erroring.
--
-- 05:00 UTC daily — off-peak and distinct from the 14:00 cancellation cron and
-- the */15 reclaim cron.

SELECT cron.schedule(
  'process-lease-retention-daily',
  '0 5 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/process-lease-retention',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'lease_retention' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
