-- Module: Operational Monitoring — Phase 2 foundation
-- See docs/OPERATIONAL_MONITORING_SPEC.md for the full architecture.
--
-- Creates four tables and an is_ops_admin helper:
--   1. vendor_usage_snapshots    — time series of vendor usage metrics
--   2. vendor_renewal_calendar   — date-based renewal tracker
--   3. vendor_alert_log          — every threshold crossing (deduped per day)
--   4. vendor_alert_recipients   — who receives alerts (1 row at v1)
--
-- RLS: all four tables read by ops admins (via is_ops_admin helper).
-- Service role bypasses RLS for the vendor-health-check edge function
-- writes. No direct client INSERT/UPDATE/DELETE.
--
-- The is_ops_admin helper is conservatively scoped per spec:
--   "single hardcoded workspace_id in v1 (the LeaseIO HQ workspace)"
-- Workspace c9dad4c7-d04a-4d14-b846-8e017d662341 (Labs Analytix,
-- owned by daniel.c.priest@gmail.com) is the v1 HQ workspace.
-- Promote to a more general role system only when there's a second
-- operator.

CREATE TABLE IF NOT EXISTS public.vendor_usage_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor          text NOT NULL,
  metric          text NOT NULL,
  current_value   numeric NOT NULL,
  limit_value     numeric,
  pct_of_limit    numeric,
  tier            text,
  category        text NOT NULL CHECK (category IN ('soft_quota', 'hard_cliff', 'cost_runaway')),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_vendor_usage_recent
  ON public.vendor_usage_snapshots (vendor, metric, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.vendor_renewal_calendar (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor                text NOT NULL,
  item                  text NOT NULL,
  renewal_date          date NOT NULL,
  amount_estimate       numeric,
  reminder_days_before  integer[] NOT NULL DEFAULT ARRAY[60, 30, 14, 7, 1],
  auto_renew            boolean NOT NULL DEFAULT false,
  account_url           text,
  notes                 text,
  last_alerted_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_vendor_renewal_upcoming
  ON public.vendor_renewal_calendar (renewal_date);

CREATE TABLE IF NOT EXISTS public.vendor_alert_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor              text NOT NULL,
  metric              text NOT NULL,
  threshold_crossed   text NOT NULL CHECK (threshold_crossed IN ('warn', 'alert', 'critical')),
  current_value       numeric,
  limit_value         numeric,
  pct_of_limit        numeric,
  upgrade_suggestion  text,
  upgrade_url         text,
  fired_at            timestamptz NOT NULL DEFAULT now(),
  acknowledged_at     timestamptz,
  acknowledged_by     uuid REFERENCES auth.users(id)
);

-- Per-day dedupe: same threshold crossed on the same metric on the
-- same day produces only one alert row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_dedupe
  ON public.vendor_alert_log (vendor, metric, threshold_crossed, ((fired_at AT TIME ZONE 'UTC')::date));

CREATE INDEX IF NOT EXISTS idx_vendor_alert_recent
  ON public.vendor_alert_log (fired_at DESC);

CREATE TABLE IF NOT EXISTS public.vendor_alert_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────
-- is_ops_admin helper
-- ─────────────────────────────────────────────────────────────────────
-- Returns true when the calling user is the owner of the LeaseIO HQ
-- workspace (or a member with admin role). Hardcoded workspace_id at
-- v1; promote to a more general role system when a second operator
-- joins.

CREATE OR REPLACE FUNCTION public.is_ops_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = 'c9dad4c7-d04a-4d14-b846-8e017d662341'::uuid
      AND owner_id = _user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = 'c9dad4c7-d04a-4d14-b846-8e017d662341'::uuid
      AND wm.user_id = _user_id
      AND wm.role = 'admin'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.vendor_usage_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_renewal_calendar   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_alert_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_alert_recipients   ENABLE ROW LEVEL SECURITY;

-- Reads: ops admins only.
DROP POLICY IF EXISTS "ops admins read snapshots" ON public.vendor_usage_snapshots;
CREATE POLICY "ops admins read snapshots"
  ON public.vendor_usage_snapshots FOR SELECT
  TO authenticated
  USING (public.is_ops_admin(auth.uid()));

DROP POLICY IF EXISTS "ops admins read renewals" ON public.vendor_renewal_calendar;
CREATE POLICY "ops admins read renewals"
  ON public.vendor_renewal_calendar FOR SELECT
  TO authenticated
  USING (public.is_ops_admin(auth.uid()));

DROP POLICY IF EXISTS "ops admins read alerts" ON public.vendor_alert_log;
CREATE POLICY "ops admins read alerts"
  ON public.vendor_alert_log FOR SELECT
  TO authenticated
  USING (public.is_ops_admin(auth.uid()));

DROP POLICY IF EXISTS "ops admins read recipients" ON public.vendor_alert_recipients;
CREATE POLICY "ops admins read recipients"
  ON public.vendor_alert_recipients FOR SELECT
  TO authenticated
  USING (public.is_ops_admin(auth.uid()));

-- Acknowledge alerts: ops admins can update the acknowledged_* columns
-- but cannot rewrite history. Enforced at the application layer; the
-- RLS policy permits UPDATE only for ops admins.
DROP POLICY IF EXISTS "ops admins acknowledge alerts" ON public.vendor_alert_log;
CREATE POLICY "ops admins acknowledge alerts"
  ON public.vendor_alert_log FOR UPDATE
  TO authenticated
  USING (public.is_ops_admin(auth.uid()))
  WITH CHECK (public.is_ops_admin(auth.uid()));

-- All inserts via service role only (the vendor-health-check edge
-- function bypasses RLS). No client INSERT policies.

-- ─────────────────────────────────────────────────────────────────────
-- Seed the v1 alert recipient
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.vendor_alert_recipients (email, name)
VALUES ('daniel.c.priest@gmail.com', 'Daniel (operator)')
ON CONFLICT (email) DO NOTHING;
