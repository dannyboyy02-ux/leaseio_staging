-- ============================================================
-- process_alerts_cron_secret (P2-01 follow-up, KNOWN_ISSUES #15)
--
-- The process-alerts cron was scheduled in early 2026 via a Studio
-- migration that never made it into the repo (`phase5_process_alerts_cron`,
-- on the remote-only list per docs/MIGRATION_DRIFT_REMEDIATION.md).
-- The schedule posts to the function with no auth header — meaning
-- anyone hitting the endpoint can trigger an alert-evaluation pass.
-- The function itself did no auth check of its own.
--
-- This migration:
--   1. Unschedules the orphan `process-alerts-daily` job
--   2. Reschedules it with `x-cron-secret` forwarded from
--      `private.cron_secrets` — the canonical pattern used by every
--      other scheduled function (cleanup-expired-reports,
--      send-counter-signature-reminder, process-delegate-timers, etc.)
--
-- Operator deploy steps:
--   1. Generate a 32+ char random secret
--   2. `supabase secrets set PROCESS_ALERTS_CRON_SECRET='<value>'`
--   3. INSERT INTO private.cron_secrets (id, value, description) VALUES
--        ('process_alerts', '<same value>', 'process-alerts daily cron')
--      ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--   4. Redeploy process-alerts so the env var change takes effect.
--
-- Without those secrets, the cron fires daily at 08:30 UTC but the
-- function rejects with 401 — same fail-closed posture as every
-- other cron-secret job.
-- ============================================================

DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('process-alerts-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'process-alerts-daily',
  '30 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/process-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'process_alerts' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);
