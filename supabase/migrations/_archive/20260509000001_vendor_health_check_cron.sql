-- Schedule the vendor-health-check cron — Operational Monitoring Phase 2.
--
-- Daily at 06:00 UTC. Reads its secret from private.cron_secrets
-- (matching the pattern established in 20260507260000_cron_secrets_table.sql)
-- and forwards as the x-cron-secret header.
--
-- Operator deploy steps for this cron to actually run:
--   1. supabase secrets set VENDOR_HEALTH_CHECK_CRON_SECRET='<value>'
--   2. INSERT INTO private.cron_secrets (id, value, description) VALUES
--        ('vendor_health_check', '<same value>', 'Operational Monitoring Phase 2 cron')
--      ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--   3. Set adapter API tokens as edge function secrets:
--        - MANAGEMENT_API_TOKEN (read-only personal access token; not
--          named SUPABASE_MANAGEMENT_TOKEN because Supabase reserves
--          the SUPABASE_ prefix and silently refuses user-defined
--          secrets with that prefix — see .env.example and the runtime
--          code in supabase/functions/vendor-health-check/index.ts.)
--        - VERCEL_ACCESS_TOKEN (read-only personal access token)
--        - VERCEL_TEAM_ID (optional, only if using a team account)
--      RESEND_API_KEY is already set for outbound transactional email.
--   4. Reset/redeploy the vendor-health-check edge function so the
--      env-var changes take effect.
--
-- Without those secrets configured, the cron fires at 06:00 UTC but
-- the function rejects with 500 "Server configuration error" or
-- skips that vendor's adapter (RESEND/Supabase/Vercel each fail
-- independently — partial coverage is better than nothing). All
-- failures are visible via cron.job_run_details and the function's
-- own logs.

DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('vendor-health-check-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'vendor-health-check-daily',
  '0 6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/vendor-health-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'vendor_health_check' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);
