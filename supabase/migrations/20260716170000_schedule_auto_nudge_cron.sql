-- P1-6: schedule the day-2/5/10 automatic approver nudge, once daily.
-- Fail-closed: the edge function returns 401 unless the x-cron-secret matches
-- AUTO_NUDGE_CRON_SECRET, and this schedule reads the secret from
-- private.cron_secrets at fire-time (so rotating it needs no re-schedule). Until
-- the operator sets BOTH the edge-fn secret (`supabase secrets set
-- AUTO_NUDGE_CRON_SECRET=<v>`) AND inserts the matching
-- private.cron_secrets row (id='auto_nudge'), the POST carries a NULL header and
-- the function 401s — nothing runs. This mirrors the dispatch-notifications and
-- counter-signature-reminder crons.
--
-- Daily (not more) because the milestones are day-granular and each fires once
-- per step-cycle; a daily sweep catches the 2/5/10-day crossings promptly
-- without re-nudging (the function dedupes on lease_nudges.automatic_dayN since
-- the step's pending_since).

SELECT cron.schedule(
  'auto-nudge-approvers-cron',
  '0 15 * * *',  -- 15:00 UTC daily (~mid-morning US business hours)
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/auto-nudge-approvers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'auto_nudge' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
