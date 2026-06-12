-- Login activity feed (2026-06-12 polish pass).
--
-- Backs the Settings → Account "Login activity" card (replaces the old
-- Recent Activity card, which duplicated lease activity the Dashboard
-- already shows). One row per successful sign-in, captured by the
-- record-login-event edge function (service-role writer — the client
-- cannot forge rows for other users, and the IP comes from the edge
-- runtime's forwarded headers rather than anything client-supplied).
--
-- RLS: users read ONLY their own rows. No INSERT/UPDATE/DELETE policies —
-- writes and retention pruning happen exclusively through the service-role
-- path inside the edge function.

CREATE TABLE IF NOT EXISTS public.login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS login_events_user_created_idx
  ON public.login_events (user_id, created_at DESC);

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.login_events FROM PUBLIC, anon;
GRANT SELECT ON public.login_events TO authenticated;

DO $$
BEGIN
  CREATE POLICY "users read own login events"
    ON public.login_events FOR SELECT
    USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE public.login_events IS
  'Per-user sign-in history for the Settings → Account login-activity card. Written only by the record-login-event edge function (service_role); pruned to the most recent 25 rows per user on each insert.';
