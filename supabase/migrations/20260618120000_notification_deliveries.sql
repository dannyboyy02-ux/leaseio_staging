-- ============================================================================
-- KNOWN_ISSUES #109 — wire the write-only approval-notification system to real
-- delivery.
-- ----------------------------------------------------------------------------
-- The approval workflow (submit / approve / reject / send-back / escalate /
-- reroute / nudge) writes `lease_activity_log` rows with activity_type='comment'
-- and details.{notification_type, recipient_ids, message}. NOTHING ever
-- delivered them — no email, no in-app — so approvers/requesters received zero
-- notifications (the dead "Nudge sent!" button was the visible symptom).
--
-- This table is the dispatch / idempotency log: a cron dispatcher
-- (`dispatch-notifications`) and the `send-nudge` fn deliver each
-- (notification row × recipient × channel) exactly once. The UNIQUE constraint
-- makes overlapping cron runs / retries safe; a row is upserted to 'sent' on
-- success or 'failed' (with the error, hard rule #9) so a later run can retry.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_log_id   uuid NOT NULL REFERENCES public.lease_activity_log(id) ON DELETE CASCADE,
  lease_id          uuid,
  recipient_user_id uuid NOT NULL,
  channel           text NOT NULL DEFAULT 'email',
  status            text NOT NULL DEFAULT 'sent',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_channel_check CHECK (channel = ANY (ARRAY['email'::text, 'in_app'::text])),
  CONSTRAINT notification_deliveries_status_check  CHECK (status  = ANY (ARRAY['sent'::text, 'failed'::text, 'skipped'::text])),
  -- One delivery record per (notification, recipient, channel) → the dispatcher
  -- is idempotent: a SENT row is never re-sent; a FAILED row is retried + upserted.
  CONSTRAINT notification_deliveries_unique UNIQUE (activity_log_id, recipient_user_id, channel)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_activity_idx
  ON public.notification_deliveries (activity_log_id);

-- RLS: service-role-only. The dispatcher + send-nudge write via the service-role
-- client (bypasses RLS). RLS enabled with NO client policy = deny-all for
-- authenticated/anon — the same append-only-audit pattern as lease_activity_log.
-- A future in-app notification center can add a recipient SELECT policy
-- (USING recipient_user_id = auth.uid()) when that UI is built.
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
