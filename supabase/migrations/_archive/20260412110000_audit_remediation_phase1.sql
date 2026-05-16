-- ============================================================
-- audit_remediation_phase1
-- Persistence, guardrails, and backfills for audit fixes
-- ============================================================

-- Persist user-specific event dismissals per workspace
CREATE TABLE IF NOT EXISTS public.dismissed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id, event_key)
);

ALTER TABLE public.dismissed_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dismissed_events_select_own" ON public.dismissed_events;
CREATE POLICY "dismissed_events_select_own" ON public.dismissed_events
  FOR SELECT USING (
    user_id = auth.uid()
    AND (
      is_workspace_member(workspace_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.workspaces w
        WHERE w.id = dismissed_events.workspace_id
          AND w.owner_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "dismissed_events_insert_own" ON public.dismissed_events;
CREATE POLICY "dismissed_events_insert_own" ON public.dismissed_events
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (
      is_workspace_member(workspace_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.workspaces w
        WHERE w.id = dismissed_events.workspace_id
          AND w.owner_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "dismissed_events_delete_own" ON public.dismissed_events;
CREATE POLICY "dismissed_events_delete_own" ON public.dismissed_events
  FOR DELETE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "dismissed_events_update_own" ON public.dismissed_events;
CREATE POLICY "dismissed_events_update_own" ON public.dismissed_events
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Persist onboarding preferences across devices
CREATE TABLE IF NOT EXISTS public.user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  onboarding_dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id)
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_preferences_select_own" ON public.user_preferences;
CREATE POLICY "user_preferences_select_own" ON public.user_preferences
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_insert_own" ON public.user_preferences;
CREATE POLICY "user_preferences_insert_own" ON public.user_preferences
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_update_own" ON public.user_preferences;
CREATE POLICY "user_preferences_update_own" ON public.user_preferences
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_delete_own" ON public.user_preferences;
CREATE POLICY "user_preferences_delete_own" ON public.user_preferences
  FOR DELETE USING (user_id = auth.uid());

-- Hourly processing limits for expensive edge functions
CREATE TABLE IF NOT EXISTS public.processing_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, function_name, window_start)
);

ALTER TABLE public.processing_rate_limits ENABLE ROW LEVEL SECURITY;

-- Guardrail for workspace discount rate inputs
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_discount_rate_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_discount_rate_check
  CHECK (discount_rate IS NULL OR (discount_rate > 0 AND discount_rate <= 50));

-- Backfill confidence scores to the 0-100 UI scale
UPDATE public.lease_field_confidence
SET confidence_score = ROUND(confidence_score * 100, 2)
WHERE confidence_score >= 0
  AND confidence_score <= 1;

-- Backfill normalized escalation fields for older leases
WITH normalized AS (
  SELECT
    id,
    CASE
      WHEN substring(coalesce(rent_escalation_type, '') from '([0-9]+(\.[0-9]+)?)\s*%') IS NOT NULL THEN 'percent'
      WHEN coalesce(rent_escalation_type, '') ~* '\m(cpi|index|consumer[[:space:]]+price|inflation[- ]based)\M' THEN 'index'
      ELSE 'none'
    END AS escalation_type,
    CASE
      WHEN substring(coalesce(rent_escalation_type, '') from '([0-9]+(\.[0-9]+)?)\s*%') IS NOT NULL
        THEN substring(coalesce(rent_escalation_type, '') from '([0-9]+(\.[0-9]+)?)\s*%')::numeric
      WHEN coalesce(rent_escalation_type, '') ~* '\m(cpi|index|consumer[[:space:]]+price|inflation[- ]based)\M'
        THEN NULL
      ELSE coalesce(escalation_rate, 0)
    END AS escalation_rate,
    CASE
      WHEN coalesce(rent_escalation_type, '') ~* '\m(cpi|index|consumer[[:space:]]+price|inflation[- ]based)\M'
        THEN true
      ELSE false
    END AS needs_escalation_review
  FROM public.leases
  WHERE escalation_type IS NULL
)
UPDATE public.leases l
SET
  escalation_type = n.escalation_type,
  escalation_rate = n.escalation_rate,
  needs_escalation_review = n.needs_escalation_review
FROM normalized n
WHERE l.id = n.id;

-- Deployment smoke test hook for security hardening verification
CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'is_workspace_member_function', EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'is_workspace_member'
    ),
    'workspace_members_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'workspace_members'
        AND policyname = 'Members can view workspace membership'
    ),
    'workspace_roles_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'workspace_roles'
        AND policyname = 'workspace_roles_select'
    ),
    'leases_select_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'leases'
        AND policyname = 'leases_select_own_or_workspace'
    ),
    'summary_views_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'summary_views'
        AND policyname = 'summary_views_select_workspace'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO service_role;
