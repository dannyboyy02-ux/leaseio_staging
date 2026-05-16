-- ============================================================
-- lease_workflow_field_guard (P1-11)
-- Block authenticated UPDATE of audit-critical workflow columns on
-- public.leases. Every legitimate path must go through the
-- legacy-lease-action edge function (or its chain-vocabulary
-- equivalent), which runs under the service role and bypasses
-- this trigger.
--
-- Per audit P1-11 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- the leases UPDATE RLS policy is row-oriented, not column-oriented.
-- That gives any workspace member with a valid JWT the ability to
-- mutate lifecycle_status, approval columns, and the model-lock fields
-- directly via the PostgREST API, bypassing the intended workflow
-- and corrupting audit-trail provenance.
--
-- service_role bypasses RLS but ALSO bypasses this trigger by the
-- explicit early-return on auth.role(). pg_cron and edge functions
-- using SUPABASE_SERVICE_ROLE_KEY are unaffected.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_unauthorized_lease_workflow_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Service role: trusted server-side path. Bypass.
  IF COALESCE(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status
    OR NEW.manager_approved_by IS DISTINCT FROM OLD.manager_approved_by
    OR NEW.manager_approved_at IS DISTINCT FROM OLD.manager_approved_at
    OR NEW.manager_rejection_reason IS DISTINCT FROM OLD.manager_rejection_reason
    OR NEW.financial_approved_by IS DISTINCT FROM OLD.financial_approved_by
    OR NEW.financial_approved_at IS DISTINCT FROM OLD.financial_approved_at
    OR NEW.financial_returned_to_submitter IS DISTINCT FROM OLD.financial_returned_to_submitter
    OR NEW.financial_rejection_reason IS DISTINCT FROM OLD.financial_rejection_reason
    OR NEW.model_locked IS DISTINCT FROM OLD.model_locked
    OR NEW.model_locked_at IS DISTINCT FROM OLD.model_locked_at
    OR NEW.model_locked_by IS DISTINCT FROM OLD.model_locked_by
    OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
  THEN
    RAISE EXCEPTION 'Lease workflow fields can only be changed through the governance edge functions (legacy-lease-action or act-on-chain-step). Direct authenticated updates are not permitted.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_unauthorized_lease_workflow_edits ON public.leases;
CREATE TRIGGER prevent_unauthorized_lease_workflow_edits
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.prevent_unauthorized_lease_workflow_edits();
