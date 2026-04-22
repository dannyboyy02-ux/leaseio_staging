-- Fix 1: Extend lease_notifications event_type CHECK constraint
-- phase6_notification_triggers migration was never applied to production.
-- Original constraint only has 5 values; frontend inserts new_request,
-- status_changed, document_uploaded which violate it.
ALTER TABLE public.lease_notifications
  DROP CONSTRAINT IF EXISTS lease_notifications_event_type_check;

ALTER TABLE public.lease_notifications
  ADD CONSTRAINT lease_notifications_event_type_check
  CHECK (event_type IN (
    'expiration',
    'escalation',
    'renewal_window',
    'commencement',
    'custom',
    'new_request',
    'status_changed',
    'document_uploaded'
  ));

-- Fix 2: Swap lease_activity_log.user_id FK from auth.users → public.profiles
-- PostgREST cannot traverse FKs into the auth schema, so the ActivityTimeline
-- join `profiles!lease_activity_log_user_id_fkey` returns PGRST200.
-- Dropping the auth.users FK and adding one to public.profiles fixes the join.
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_user_id_fkey;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
