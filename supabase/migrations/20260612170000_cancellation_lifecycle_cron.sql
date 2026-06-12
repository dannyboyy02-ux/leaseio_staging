-- Cancellation lifecycle cron job (2026-06-12).
--
-- Schedules the process-cancellation-lifecycle edge function to run daily
-- at 14:00 UTC. Secret pulled from private.cron_secrets at runtime
-- (same pattern as all other LeaseIO cron jobs — secret never stored in
-- plain text in cron.job).
--
-- Prerequisite: set the Supabase secret before running:
--   supabase secrets set CANCELLATION_LIFECYCLE_CRON_SECRET=$(openssl rand -hex 32)
-- Then insert that same value into private.cron_secrets with id =
-- 'cancellation_lifecycle'.

SELECT cron.schedule(
  'process-cancellation-lifecycle-daily',
  '0 14 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/process-cancellation-lifecycle',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'cancellation_lifecycle' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
