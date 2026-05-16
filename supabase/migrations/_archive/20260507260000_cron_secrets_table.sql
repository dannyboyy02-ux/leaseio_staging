-- Cron secrets table — replaces ALTER DATABASE postgres SET app.* pattern
--
-- The pre-existing pattern (audit-remediation migration 20260426000003,
-- and the cron migrations 20260507210000 / 20260507220000 I added) used
--   current_setting('app.<name>_cron_secret', true)
-- inside the pg_cron schedule body, with the value supposed to be set via
--   ALTER DATABASE postgres SET app.<name>_cron_secret = '<value>';
--
-- That ALTER requires superuser privileges. The Supabase Management API
-- connection that the CLI uses (`supabase db query --linked`) does NOT
-- have those privileges, so the cron secrets cannot be configured this
-- way from the CLI. The original migrations documented "operator must
-- run this manually" but in practice nobody had — the existing
-- send-lease-notifications-daily cron has been firing into a 401
-- response since it shipped, silently.
--
-- Fix: move secrets to a private.cron_secrets table that pg_cron's
-- schedule body reads via SELECT. Schema is `private` so PostgREST
-- doesn't expose it; only postgres role (which pg_cron runs as) can
-- read it. Idempotent migration; safe to re-apply.
--
-- After this migration applies, secrets are inserted via:
--   INSERT INTO private.cron_secrets (id, value)
--   VALUES ('cleanup_expired_reports', '<secret>'),
--   ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
-- which the Management API CAN do.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.cron_secrets (
  id          text PRIMARY KEY,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Reschedule every cron job that previously used current_setting() to
-- instead read from private.cron_secrets. Each unschedule guarded by
-- DO/EXCEPTION so the migration is idempotent against fresh and
-- existing environments.

-- ─── send-lease-notifications-daily (audit-remediation 20260426000003) ──
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('send-lease-notifications-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'send-lease-notifications-daily',
  '0 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/send-lease-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'lease_notifications' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── cleanup-expired-reports-daily (Phase 8 follow-up 20260507210000) ───
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('cleanup-expired-reports-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'cleanup-expired-reports-daily',
  '30 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/cleanup-expired-reports',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'cleanup_expired_reports' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── send-counter-signature-reminder-daily (Phase 5/6/7 20260507220000) ─
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('send-counter-signature-reminder-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'send-counter-signature-reminder-daily',
  '15 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/send-counter-signature-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'send_counter_signature_reminder' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── process-delegate-timers-hourly ─────────────────────────────────────
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('process-delegate-timers-hourly'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'process-delegate-timers-hourly',
  '5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/process-delegate-timers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'process_delegate_timers' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── detect-stuck-chains-daily ──────────────────────────────────────────
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('detect-stuck-chains-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'detect-stuck-chains-daily',
  '0 9 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/detect-stuck-chains',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'detect_stuck_chains' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);
