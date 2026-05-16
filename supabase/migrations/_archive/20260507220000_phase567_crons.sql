-- Wires production cron schedules for the three leaf scheduled functions
-- that have shipped without production cron wiring:
--
--   - send-counter-signature-reminder    (Phase 5, daily 08:15 UTC)
--   - process-delegate-timers            (Phase 7, hourly at :05)
--   - detect-stuck-chains                (Phase 7, daily 09:00 UTC)
--
-- Each function uses the audit-remediated x-cron-secret pattern (per
-- 20260426000003_audit_remediation.sql) — a deployment-managed shared
-- secret is read from a database setting and forwarded as the
-- x-cron-secret header. The edge function compares it against an env
-- var of the same name. No JWT, no hard-coded tokens in the migration.
--
-- DEFERRED: reroute-audit-sweep and process-pending-reroute-evaluations
-- are not wired here. Both forward the inbound Authorization header to
-- resolve-approval-chain (a 1054-line sibling function that uses
-- user.id for workspace-membership gates and triggered_by attribution).
-- Switching them to x-cron-secret leaves no JWT to forward; wiring them
-- safely requires a service-context invocation path in
-- resolve-approval-chain. Filed as a follow-up rather than taken on
-- speculatively.
--
-- BEFORE this migration takes effect in production, the operator must
-- set EACH secret in TWO places (same value per function):
--
--   1. Edge function env (so the function knows what to expect):
--      supabase secrets set SEND_COUNTER_SIGNATURE_REMINDER_CRON_SECRET='<v1>'
--      supabase secrets set PROCESS_DELEGATE_TIMERS_CRON_SECRET='<v2>'
--      supabase secrets set DETECT_STUCK_CHAINS_CRON_SECRET='<v3>'
--
--   2. Database settings (so pg_cron knows what to send):
--      ALTER DATABASE postgres SET app.send_counter_signature_reminder_cron_secret = '<v1>';
--      ALTER DATABASE postgres SET app.process_delegate_timers_cron_secret = '<v2>';
--      ALTER DATABASE postgres SET app.detect_stuck_chains_cron_secret = '<v3>';
--
-- Slot map (UTC), to keep crons from contending:
--   08:00      send-lease-notifications-daily            (existing)
--   08:15  →   send-counter-signature-reminder-daily     (NEW)
--   08:30      cleanup-expired-reports-daily             (existing)
--   09:00  →   detect-stuck-chains-daily                 (NEW)
--   xx:05  →   process-delegate-timers-hourly            (NEW)
--
-- If a secret is missing or values diverge between the env var and the
-- database setting, the edge function fails closed with 401. pg_cron
-- still fires; the rejection lands in net._http_response. No data loss.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─── send-counter-signature-reminder (Phase 5) ────────────────────────
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('send-counter-signature-reminder-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'send-counter-signature-reminder-daily',
  '15 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/send-counter-signature-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.send_counter_signature_reminder_cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── process-delegate-timers (Phase 7) ────────────────────────────────
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('process-delegate-timers-hourly');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'process-delegate-timers-hourly',
  '5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/process-delegate-timers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.process_delegate_timers_cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ─── detect-stuck-chains (Phase 7) ────────────────────────────────────
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('detect-stuck-chains-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'detect-stuck-chains-daily',
  '0 9 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/detect-stuck-chains',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.detect_stuck_chains_cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);
