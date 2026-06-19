-- Schedule dispatch-notifications to run every 10 minutes.
-- Secret is read from private.cron_secrets at fire-time so it stays current
-- without re-scheduling when the secret is rotated.
SELECT cron.schedule(
  'dispatch-notifications-cron',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'notification_dispatch' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
