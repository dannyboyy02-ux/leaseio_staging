-- Wires daily production cron for cleanup-expired-reports edge function.
-- Closes the deployment-checklist item from KNOWN_ISSUES #12.
--
-- The cron pattern mirrors the audit-remediated send-lease-notifications
-- cron (migration 20260426000003): a deployment-managed shared secret
-- is read from a database setting and forwarded as the x-cron-secret
-- header. The edge function compares it against an env-var of the same
-- name. No JWT, no hard-coded tokens in the migration.
--
-- BEFORE this migration takes effect in production, the operator must
-- set the secret in TWO places (same value):
--
--   1. Edge function env (so the function knows what to expect):
--      supabase secrets set CLEANUP_EXPIRED_REPORTS_CRON_SECRET='<value>'
--
--   2. Database setting (so pg_cron knows what to send):
--      ALTER DATABASE postgres SET app.cleanup_expired_reports_cron_secret = '<value>';
--
-- If either is missing or the values diverge, the edge function returns
-- 401 — fail closed. The cron call still fires; the rejection shows up
-- in pg_net's `net._http_response` and the function's logs. No data
-- loss either way (the function only marks expired rows + removes
-- already-expired storage artifacts).
--
-- Schedule: 08:30 UTC daily. Offset 30 minutes from
-- send-lease-notifications-daily (08:00 UTC) so the two crons don't
-- contend for the edge runtime simultaneously.

-- Extensions are already enabled by 20260106052646; this is defensive.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: drop any prior version of this schedule before recreating.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('cleanup-expired-reports-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'cleanup-expired-reports-daily',
  '30 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/cleanup-expired-reports',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cleanup_expired_reports_cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);
