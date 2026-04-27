-- ============================================================================
-- Governance RLS Tightening
-- ============================================================================
-- Prevents submitters from editing a change set after it has been submitted
-- for approval. Only draft sets can be edited by the submitter. Admin and
-- financial_approver roles retain the ability to update pending_approval sets.
-- ============================================================================

-- Drop the permissive UPDATE policy that allowed submitters to edit at any status
DROP POLICY IF EXISTS "submitter or approver can update change sets" ON public.lease_change_sets;

CREATE POLICY "submitter can edit draft change sets"
  ON public.lease_change_sets FOR UPDATE
  TO authenticated
  USING (
    -- Submitter can only modify their own draft sets
    (
      submitted_by = auth.uid()
      AND status = 'draft'
      AND is_workspace_member(workspace_id, auth.uid())
    )
    OR
    -- Admin / financial_approver can approve or reject pending sets
    (
      status = 'pending_approval'
      AND is_workspace_member(workspace_id, auth.uid())
      AND (
        EXISTS (
          SELECT 1 FROM public.workspace_roles wr
          WHERE wr.workspace_id = lease_change_sets.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role IN ('admin', 'financial_approver')
        )
        OR EXISTS (
          SELECT 1 FROM public.workspaces w
          WHERE w.id = lease_change_sets.workspace_id
            AND w.owner_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (true);

-- ============================================================================
-- Extend smoke check to assert the tightened policy exists
-- ============================================================================
CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
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
    ),
    'executed_legacy_storage_policies_removed', NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'storage'
        AND tablename = 'objects'
        AND policyname IN (
          'authenticated_upload_executed_leases',
          'authenticated_read_executed_leases',
          'authenticated_delete_executed_leases'
        )
    ),
    'executed_scoped_storage_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'storage'
        AND tablename = 'objects'
        AND policyname = 'executed_leases_select'
    ),
    'strict_model_lock_trigger', EXISTS (
      SELECT 1
      FROM pg_trigger t
      WHERE t.tgname = 'enforce_model_lock'
        AND t.tgrelid = 'public.leases'::regclass
        AND NOT t.tgisinternal
    ),
    'strict_model_lock_function', EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'prevent_locked_lease_edits'
        AND pg_get_functiondef(p.oid) ILIKE '%service_role%'
        AND pg_get_functiondef(p.oid) ILIKE '%governance workflow%'
    ),
    'workspace_entitlement_guard', EXISTS (
      SELECT 1
      FROM pg_trigger t
      WHERE t.tgname = 'enforce_workspace_entitlement_guard'
        AND t.tgrelid = 'public.workspaces'::regclass
        AND NOT t.tgisinternal
    ),
    'workspace_subscription_columns', EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workspaces'
        AND column_name = 'stripe_subscription_id'
    ),
    'governance_unlock_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_unlock_requests'
        AND policyname = 'workspace access can view unlock requests'
    ),
    'governance_change_set_policy', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_change_sets'
        AND policyname = 'workspace access can view change sets'
    ),
    'governance_audit_append_guard', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_governance_audit'
        AND policyname = 'governance audit is service role append only'
    ),
    'governance_change_set_draft_only_edit', EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_change_sets'
        AND policyname = 'submitter can edit draft change sets'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO service_role;
