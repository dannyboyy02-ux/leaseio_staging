-- ============================================================
-- security_rls_hardening
-- Fix 11 RLS / multi-tenant isolation issues identified in audit
-- ============================================================

-- S1: Enable RLS on summary_views (was disabled)
ALTER TABLE public.summary_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "summary_views_insert" ON public.summary_views;
CREATE POLICY "summary_views_insert" ON public.summary_views
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = summary_views.lease_id
        AND l.summary_share_token IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "summary_views_select_workspace" ON public.summary_views;
CREATE POLICY "summary_views_select_workspace" ON public.summary_views
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = summary_views.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

-- S2: Fix notifications INSERT — require workspace membership
DROP POLICY IF EXISTS "notifications_service_insert" ON public.notifications;
CREATE POLICY "notifications_service_insert" ON public.notifications
  FOR INSERT WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM workspaces WHERE owner_id = auth.uid()
    )
  );

-- S3: Fix lease_activity_log INSERT — verify lease ownership/membership
DROP POLICY IF EXISTS "Users can create activity entries" ON public.lease_activity_log;
CREATE POLICY "Users can create activity entries" ON public.lease_activity_log
  FOR INSERT WITH CHECK (
    (user_id = auth.uid() OR user_id IS NULL)
    AND EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = lease_activity_log.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

-- S4: Fix lease_state_transitions INSERT — verify lease ownership/membership
DROP POLICY IF EXISTS "Users can insert transitions for their leases" ON public.lease_state_transitions;
CREATE POLICY "Users can insert transitions for their leases" ON public.lease_state_transitions
  FOR INSERT WITH CHECK (
    (transitioned_by = auth.uid() OR transitioned_by IS NULL)
    AND EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = lease_state_transitions.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

-- S5: Rewrite SECURITY DEFINER functions to use auth.uid() internally
-- Drop old signatures that accepted p_user_id
DROP FUNCTION IF EXISTS public.approve_field(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.finalize_lease_approval(uuid, uuid);
DROP FUNCTION IF EXISTS public.record_field_correction(uuid, text, text, text, uuid, text, text);

CREATE OR REPLACE FUNCTION public.approve_field(p_lease_id uuid, p_field_name text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE leases
  SET
    confirmed_sections = array_append(
      array_remove(confirmed_sections, p_field_name),
      p_field_name
    ),
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',     'field_approved',
      'timestamp',  NOW(),
      'user_id',    auth.uid(),
      'field_name', p_field_name
    )
  WHERE id = p_lease_id;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_lease_approval(p_lease_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_confirmed_sections TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (
        l.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM workspace_roles wr
          WHERE wr.workspace_id = l.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role IN ('financial_approver', 'admin')
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unauthorized: financial_approver or admin role required';
  END IF;

  SELECT confirmed_sections INTO v_confirmed_sections
  FROM leases WHERE id = p_lease_id;

  UPDATE leases
  SET
    status           = 'Ready',
    lifecycle_status = 'approved',
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',            'lease_approved',
      'timestamp',         NOW(),
      'user_id',           auth.uid(),
      'fields_confirmed',  v_confirmed_sections
    )
  WHERE id = p_lease_id;

  INSERT INTO lease_approval_actions (lease_id, action, performed_by, performed_at)
  VALUES (p_lease_id, 'final_approval', auth.uid(), NOW())
  ON CONFLICT DO NOTHING;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_field_correction(
  p_lease_id        uuid,
  p_field_name      text,
  p_original_value  text,
  p_corrected_value text,
  p_correction_type text DEFAULT 'manual',
  p_user_notes      text DEFAULT NULL
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_correction_id uuid;
  v_ai_confidence numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT confidence_score INTO v_ai_confidence
  FROM lease_field_confidence
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  INSERT INTO field_corrections (
    lease_id, field_name, original_value, corrected_value,
    ai_confidence, corrected_by, corrected_at, correction_type, user_notes
  ) VALUES (
    p_lease_id, p_field_name, p_original_value, p_corrected_value,
    v_ai_confidence, auth.uid(), NOW(), p_correction_type, p_user_notes
  )
  RETURNING id INTO v_correction_id;

  UPDATE lease_field_confidence
  SET was_corrected = TRUE, corrected_at = NOW()
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  UPDATE leases
  SET audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
    'action',        'field_corrected',
    'timestamp',     NOW(),
    'user_id',       auth.uid(),
    'field_name',    p_field_name,
    'correction_id', v_correction_id
  )
  WHERE id = p_lease_id;

  RETURN v_correction_id;
END;
$$;

-- S6: Remove wildcard leases bucket storage policies and replace with scoped ones
DROP POLICY IF EXISTS "leases_0" ON storage.objects;
DROP POLICY IF EXISTS "leases_1" ON storage.objects;
DROP POLICY IF EXISTS "leases_2" ON storage.objects;
DROP POLICY IF EXISTS "leases_3" ON storage.objects;

DROP POLICY IF EXISTS "Users can upload own lease files" ON storage.objects;
CREATE POLICY "Users can upload own lease files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'leases'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users and workspace members can view lease files" ON storage.objects;
CREATE POLICY "Users and workspace members can view lease files" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM leases
        WHERE leases.storage_path = objects.name
          AND leases.workspace_id IS NOT NULL
          AND is_workspace_member(leases.workspace_id, auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "Users can update own lease files" ON storage.objects;
CREATE POLICY "Users can update own lease files" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'leases'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own lease files" ON storage.objects;
CREATE POLICY "Users can delete own lease files" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'leases'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- S7: Scope executed-leases bucket policies to owner/workspace
DROP POLICY IF EXISTS "executed_leases_select" ON storage.objects;
CREATE POLICY "executed_leases_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'executed-leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM leases l
        WHERE l.executed_storage_path = objects.name
          AND is_workspace_member(l.workspace_id, auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "executed_leases_insert" ON storage.objects;
CREATE POLICY "executed_leases_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'executed-leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM leases l
        WHERE l.executed_storage_path = objects.name
          AND is_workspace_member(l.workspace_id, auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "executed_leases_delete" ON storage.objects;
CREATE POLICY "executed_leases_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'executed-leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM leases l
        WHERE l.executed_storage_path = objects.name
          AND has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)
      )
    )
  );

-- S8: profiles SELECT — add co-worker visibility
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own_or_coworker" ON public.profiles;
CREATE POLICY "profiles_select_own_or_coworker" ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.user_id = profiles.id
        AND is_workspace_member(wm.workspace_id, auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.owner_id = profiles.id
        AND is_workspace_member(w.id, auth.uid())
    )
  );

-- S9: leases UPDATE — add functional approver roles
DROP POLICY IF EXISTS "leases_update_own_or_workspace_editor" ON public.leases;
CREATE POLICY "leases_update_own_or_workspace_editor" ON public.leases
  FOR UPDATE USING (
    user_id = auth.uid()
    OR has_workspace_permission(workspace_id, auth.uid(), 'editor'::workspace_role)
    OR EXISTS (
      SELECT 1 FROM workspace_roles wr
      WHERE wr.workspace_id = leases.workspace_id
        AND wr.user_id = auth.uid()
        AND wr.role = ANY(ARRAY['manager_approver','financial_approver','admin'])
    )
  );

-- S10: rent_schedules — extend DML to workspace members
DROP POLICY IF EXISTS "rent_schedules_insert" ON public.rent_schedules;
CREATE POLICY "rent_schedules_insert" ON public.rent_schedules
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = rent_schedules.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "rent_schedules_update" ON public.rent_schedules;
CREATE POLICY "rent_schedules_update" ON public.rent_schedules
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = rent_schedules.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "rent_schedules_delete" ON public.rent_schedules;
CREATE POLICY "rent_schedules_delete" ON public.rent_schedules
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = rent_schedules.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

-- S10: risks — extend DML to workspace members
DROP POLICY IF EXISTS "risks_insert" ON public.risks;
CREATE POLICY "risks_insert" ON public.risks
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = risks.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "risks_update" ON public.risks;
CREATE POLICY "risks_update" ON public.risks
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = risks.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "risks_delete" ON public.risks;
CREATE POLICY "risks_delete" ON public.risks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = risks.lease_id
        AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
    )
  );

-- S11: workspace_members SELECT — members can see full workspace roster
DROP POLICY IF EXISTS "Members can view workspace membership" ON public.workspace_members;
CREATE POLICY "Members can view workspace membership" ON public.workspace_members
  FOR SELECT USING (
    user_id = auth.uid()
    OR is_workspace_member(workspace_id, auth.uid())
  );
