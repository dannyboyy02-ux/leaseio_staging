-- ============================================================
-- audit_remediation
-- Security hardening for executed-file storage, model locks,
-- governance approvals, billing entitlements, and smoke checks.
-- ============================================================

-- ----------------------------------------------------------------------------
-- 1. Workspace billing fields and entitlement guardrails
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;

ALTER TABLE public.workspaces
  ALTER COLUMN plan SET DEFAULT 'starter',
  ALTER COLUMN document_limit SET DEFAULT 15;

CREATE OR REPLACE FUNCTION public.prevent_workspace_entitlement_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.plan IS DISTINCT FROM 'starter'
      OR NEW.document_limit IS DISTINCT FROM 15
      OR NEW.documents_used IS DISTINCT FROM 0
      OR NEW.billing_interval IS DISTINCT FROM 'monthly'
      OR NEW.stripe_customer_id IS NOT NULL
      OR NEW.stripe_subscription_id IS NOT NULL
      OR NEW.subscription_status IS NOT NULL
      OR NEW.subscription_period_end IS NOT NULL
    THEN
      RAISE EXCEPTION 'Workspace billing entitlements are managed by the billing system';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.document_limit IS DISTINCT FROM OLD.document_limit
    OR NEW.documents_used IS DISTINCT FROM OLD.documents_used
    OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
    OR NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end
  THEN
    RAISE EXCEPTION 'Workspace billing entitlements are managed by the billing system';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_workspace_entitlement_guard ON public.workspaces;
CREATE TRIGGER enforce_workspace_entitlement_guard
  BEFORE INSERT OR UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_workspace_entitlement_edits();

-- ----------------------------------------------------------------------------
-- 2. Executed lease storage policies
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_upload_executed_leases" ON storage.objects;
DROP POLICY IF EXISTS "authenticated_read_executed_leases" ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_executed_leases" ON storage.objects;

DROP POLICY IF EXISTS "executed_leases_select" ON storage.objects;
CREATE POLICY "executed_leases_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'executed-leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1
        FROM public.leases l
        WHERE l.executed_storage_path = storage.objects.name
          AND l.workspace_id IS NOT NULL
          AND public.is_workspace_member(l.workspace_id, auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "executed_leases_insert" ON storage.objects;
CREATE POLICY "executed_leases_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'executed-leases'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "executed_leases_delete" ON storage.objects;
CREATE POLICY "executed_leases_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'executed-leases'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1
        FROM public.leases l
        WHERE l.executed_storage_path = storage.objects.name
          AND public.has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::public.workspace_role)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 3. Strict lease lock and summary-token client guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_locked_lease_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  old_client_state jsonb;
  new_client_state jsonb;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.summary_share_token IS DISTINCT FROM OLD.summary_share_token
    OR NEW.summary_shared_at IS DISTINCT FROM OLD.summary_shared_at
    OR NEW.summary_last_viewed_at IS DISTINCT FROM OLD.summary_last_viewed_at
  THEN
    RAISE EXCEPTION 'Financial summary sharing fields are managed by the summary publishing workflow';
  END IF;

  IF OLD.model_locked IS TRUE THEN
    old_client_state := to_jsonb(OLD) - ARRAY['updated_at'];
    new_client_state := to_jsonb(NEW) - ARRAY['updated_at'];

    IF new_client_state IS DISTINCT FROM old_client_state THEN
      RAISE EXCEPTION 'Cannot modify a locked lease except through the governance workflow';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_model_lock ON public.leases;
CREATE TRIGGER enforce_model_lock
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_lease_edits();

-- Existing links are only allowed to remain on approved/executed/active leases.
UPDATE public.leases
SET
  summary_share_token = NULL,
  summary_shared_at = NULL,
  summary_last_viewed_at = NULL
WHERE summary_share_token IS NOT NULL
  AND COALESCE(lifecycle_status, '') NOT IN ('approved', 'executed', 'active');

-- ----------------------------------------------------------------------------
-- 4. Governance RLS policies
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "workspace members can view unlock requests" ON public.lease_unlock_requests;
DROP POLICY IF EXISTS "workspace members can create unlock requests" ON public.lease_unlock_requests;
DROP POLICY IF EXISTS "admins and requesters can update unlock requests" ON public.lease_unlock_requests;

CREATE POLICY "workspace access can view unlock requests"
  ON public.lease_unlock_requests FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace members can create unlock requests"
  ON public.lease_unlock_requests FOR INSERT
  WITH CHECK (
    requested_by = auth.uid()
    AND public.is_workspace_member(workspace_id, auth.uid())
  );

CREATE POLICY "requesters and admins can update unlock requests"
  ON public.lease_unlock_requests FOR UPDATE
  USING (
    requested_by = auth.uid()
    OR public.has_workspace_permission(workspace_id, auth.uid(), 'admin'::public.workspace_role)
  )
  WITH CHECK (
    (
      requested_by = auth.uid()
      AND status = 'canceled'
      AND reviewed_by IS NULL
      AND reviewed_at IS NULL
    )
    OR public.has_workspace_permission(workspace_id, auth.uid(), 'admin'::public.workspace_role)
  );

DROP POLICY IF EXISTS "workspace members can view change sets" ON public.lease_change_sets;
DROP POLICY IF EXISTS "workspace members can create change sets" ON public.lease_change_sets;
DROP POLICY IF EXISTS "submitters and approvers can update change sets" ON public.lease_change_sets;

CREATE POLICY "workspace access can view change sets"
  ON public.lease_change_sets FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.workspace_roles wr
      WHERE wr.workspace_id = lease_change_sets.workspace_id
        AND wr.user_id = auth.uid()
        AND wr.role IN ('financial_approver', 'admin')
    )
  );

CREATE POLICY "workspace members can create change sets"
  ON public.lease_change_sets FOR INSERT
  WITH CHECK (
    submitted_by = auth.uid()
    AND public.is_workspace_member(workspace_id, auth.uid())
  );

CREATE POLICY "submitters and governance approvers can update change sets"
  ON public.lease_change_sets FOR UPDATE
  USING (
    submitted_by = auth.uid()
    OR public.has_workspace_permission(workspace_id, auth.uid(), 'admin'::public.workspace_role)
    OR EXISTS (
      SELECT 1
      FROM public.workspace_roles wr
      WHERE wr.workspace_id = lease_change_sets.workspace_id
        AND wr.user_id = auth.uid()
        AND wr.role IN ('financial_approver', 'admin')
    )
  )
  WITH CHECK (
    submitted_by = auth.uid()
    OR public.has_workspace_permission(workspace_id, auth.uid(), 'admin'::public.workspace_role)
    OR EXISTS (
      SELECT 1
      FROM public.workspace_roles wr
      WHERE wr.workspace_id = lease_change_sets.workspace_id
        AND wr.user_id = auth.uid()
        AND wr.role IN ('financial_approver', 'admin')
    )
  );

DROP POLICY IF EXISTS "workspace members can view change set items" ON public.lease_change_set_items;
DROP POLICY IF EXISTS "workspace members can insert change set items" ON public.lease_change_set_items;
DROP POLICY IF EXISTS "workspace members can delete change set items" ON public.lease_change_set_items;

CREATE POLICY "workspace access can view change set items"
  ON public.lease_change_set_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND (
          public.is_workspace_member(cs.workspace_id, auth.uid())
          OR EXISTS (
            SELECT 1
            FROM public.workspace_roles wr
            WHERE wr.workspace_id = cs.workspace_id
              AND wr.user_id = auth.uid()
              AND wr.role IN ('financial_approver', 'admin')
          )
        )
    )
  );

CREATE POLICY "draft submitters can insert change set items"
  ON public.lease_change_set_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND cs.submitted_by = auth.uid()
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

CREATE POLICY "draft submitters can delete change set items"
  ON public.lease_change_set_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND cs.submitted_by = auth.uid()
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "workspace members can view governance audit" ON public.lease_governance_audit;
DROP POLICY IF EXISTS "workspace members can insert governance audit" ON public.lease_governance_audit;
DROP POLICY IF EXISTS "governance audit is service role append only" ON public.lease_governance_audit;

CREATE POLICY "workspace access can view governance audit"
  ON public.lease_governance_audit FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.workspace_roles wr
      WHERE wr.workspace_id = lease_governance_audit.workspace_id
        AND wr.user_id = auth.uid()
        AND wr.role IN ('financial_approver', 'admin')
    )
  );

CREATE POLICY "governance audit is service role append only"
  ON public.lease_governance_audit FOR INSERT TO authenticated
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 5. Scheduled notification cron now passes a deployment-managed secret header.
-- The secret value must be configured outside this repo, for example with:
-- ALTER DATABASE postgres SET app.lease_notifications_cron_secret = '<secret>';
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('send-lease-notifications-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'send-lease-notifications-daily',
  '0 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/send-lease-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.lease_notifications_cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ----------------------------------------------------------------------------
-- 6. Expanded deployment smoke check
-- ----------------------------------------------------------------------------
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
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO service_role;
