-- Phase 9 — Firm Layer Foundation (docs/PHASE_9_BUILD_SPEC.md)
--
-- Builds the firm entity, firm membership, firm-aware RLS, firm-level billing
-- plumbing, and per-child usage views. NO firm UX (that's Phase 10).
--
-- ⚠️ SECURITY MIGRATION — the `is_workspace_member` change below silently
-- rewires EVERY workspace-scoped RLS policy to be firm-aware. Reviewer routing
-- happens BEFORE this is applied (CLAUDE.md security-migration rule). Do not
-- `db push` until lease-security-scanner + integrity-reviewer have cleared it.
--
-- Idempotent: IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS throughout.
--
-- As-built deviations from the spec:
--   * v_firm_child_usage / v_firm_billing_period_summary use
--     `security_invoker = true` so the underlying (firm-aware) RLS applies to
--     the querying user — the spec's raw view definitions would have been
--     security-definer and leaked every firm's usage to any caller. Service-role
--     (the Stripe webhook) bypasses RLS regardless, so billing still works.

-- ============================================================================
-- 1. firms
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.firms (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  firm_type               text NOT NULL CHECK (firm_type IN ('cpa_firm', 'parent_company', 'other')),
  owner_id                uuid NOT NULL REFERENCES auth.users(id),
  plan                    text NOT NULL DEFAULT 'business' CHECK (plan = 'business'),
  stripe_customer_id      text,
  stripe_subscription_id  text,
  child_workspace_limit   integer NOT NULL DEFAULT 50 CHECK (child_workspace_limit >= 1),
  child_workspaces_used   integer NOT NULL DEFAULT 0,
  billing_email           text NOT NULL,
  billing_summary_mode    text NOT NULL DEFAULT 'detailed'
                          CHECK (billing_summary_mode IN ('detailed', 'summarized')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firms_name_length CHECK (length(trim(name)) >= 2)
);

CREATE INDEX IF NOT EXISTS idx_firms_owner ON public.firms(owner_id);
CREATE INDEX IF NOT EXISTS idx_firms_stripe_customer
  ON public.firms(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS firms_updated_at ON public.firms;
CREATE TRIGGER firms_updated_at
  BEFORE UPDATE ON public.firms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. firm_members  (owner is implicitly firm_admin via is_firm_member; no row)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.firm_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('firm_admin', 'firm_member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id),
  UNIQUE (firm_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_firm_members_user ON public.firm_members(user_id);
CREATE INDEX IF NOT EXISTS idx_firm_members_firm ON public.firm_members(firm_id);

-- ============================================================================
-- 3. firm_activity_log  (parallel to lease_activity_log for firm-only events)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.firm_activity_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES auth.users(id),
  activity_type  text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_firm_activity_log_firm_chronological
  ON public.firm_activity_log(firm_id, created_at DESC);

-- ============================================================================
-- 4. workspaces additions  (firm binding; firm_id absent before this migration)
-- ============================================================================
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS firm_id               uuid REFERENCES public.firms(id),
  ADD COLUMN IF NOT EXISTS firm_child_label      text,
  ADD COLUMN IF NOT EXISTS restrict_firm_access  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS firm_joined_at        timestamptz;

CREATE INDEX IF NOT EXISTS idx_workspaces_firm_id
  ON public.workspaces(firm_id) WHERE firm_id IS NOT NULL;

-- ============================================================================
-- 5. Counter + quota trigger on workspaces.firm_id
-- ============================================================================
CREATE OR REPLACE FUNCTION public.maintain_firm_child_workspace_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_used  integer;
BEGIN
  -- Workspace joining a firm
  IF (TG_OP = 'INSERT' AND NEW.firm_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.firm_id IS NOT NULL AND OLD.firm_id IS DISTINCT FROM NEW.firm_id) THEN
    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Firm has reached its child workspace limit of %. Increase the limit or remove an existing child first.', v_limit;
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1, updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  -- Workspace leaving a firm
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NULL) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1), updated_at = now()
     WHERE id = OLD.firm_id;
  END IF;

  -- Workspace moving between firms
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NOT NULL AND OLD.firm_id <> NEW.firm_id) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1), updated_at = now()
     WHERE id = OLD.firm_id;

    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Destination firm has reached its child workspace limit.';
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1, updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_firm_counter ON public.workspaces;
CREATE TRIGGER workspaces_firm_counter
  BEFORE INSERT OR UPDATE OF firm_id ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.maintain_firm_child_workspace_counter();

-- ============================================================================
-- 6. Plan-lock trigger: firm-bound workspaces inherit/keep 'business'
-- ============================================================================
CREATE OR REPLACE FUNCTION public.prevent_independent_plan_change_for_firm_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.firm_id IS NOT NULL AND OLD.plan IS DISTINCT FROM NEW.plan AND NEW.plan <> 'business' THEN
    RAISE EXCEPTION 'Workspace plan cannot be changed independently while bound to a firm. The firm''s plan governs all child workspaces.';
  END IF;

  -- On join, force the plan to 'business'
  IF NEW.firm_id IS NOT NULL AND OLD.firm_id IS DISTINCT FROM NEW.firm_id THEN
    NEW.plan = 'business';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_plan_firm_lock ON public.workspaces;
CREATE TRIGGER workspaces_plan_firm_lock
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_independent_plan_change_for_firm_workspace();

-- ============================================================================
-- 7. Firm membership helpers (owner counts as firm member / firm admin)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_firm_member(_firm_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.firm_members WHERE firm_id = _firm_id AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.firms WHERE id = _firm_id AND owner_id = _user_id
  )
$$;

CREATE OR REPLACE FUNCTION public.is_firm_admin(_firm_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.firm_members
    WHERE firm_id = _firm_id AND user_id = _user_id AND role = 'firm_admin'
  ) OR EXISTS (
    SELECT 1 FROM public.firms WHERE id = _firm_id AND owner_id = _user_id
  )
$$;

-- ============================================================================
-- 8. THE LOAD-BEARING CHANGE — is_workspace_member becomes firm-aware.
--    Adds a 3rd EXISTS: firm members gain implicit access to child workspaces
--    UNLESS restrict_firm_access = true. Rewires every workspace-scoped policy.
--    is_workspace_owner is intentionally NOT changed (owner ≠ firm member).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  -- Direct workspace membership (Plus/Pro semantics — unchanged)
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = _workspace_id AND user_id = _user_id
  )
  -- Workspace owner (Plus/Pro semantics — unchanged)
  OR EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = _workspace_id AND owner_id = _user_id
  )
  -- Firm membership grants implicit access UNLESS the child opted out
  OR EXISTS (
    SELECT 1 FROM public.workspaces w
    WHERE w.id = _workspace_id
      AND w.firm_id IS NOT NULL
      AND w.restrict_firm_access = false
      AND public.is_firm_member(w.firm_id, _user_id)
  )
$$;

-- ============================================================================
-- 9. Per-child usage view + billing-period summary (security_invoker → RLS-safe)
-- ============================================================================
CREATE OR REPLACE VIEW public.v_firm_child_usage
WITH (security_invoker = true) AS
SELECT
  w.firm_id,
  w.id   AS workspace_id,
  w.name AS workspace_name,
  w.firm_child_label,
  w.firm_joined_at,
  w.restrict_firm_access,
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id) AS total_leases,
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id AND l.lifecycle_status = 'active') AS active_leases,
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id AND l.model_locked = true) AS finalized_leases,
  (SELECT count(*) FROM public.lease_documents ld WHERE ld.workspace_id = w.id) AS total_documents,
  (SELECT COALESCE(SUM(ld.file_size_bytes), 0) FROM public.lease_documents ld WHERE ld.workspace_id = w.id) AS total_document_bytes,
  (SELECT count(*) FROM public.lease_reports lr WHERE lr.workspace_id = w.id) AS reports_generated_total,
  (SELECT count(*) FROM public.lease_reports lr WHERE lr.workspace_id = w.id AND lr.generated_at >= now() - INTERVAL '30 days') AS reports_generated_last_30_days,
  (SELECT count(*) FROM public.workspace_members wm WHERE wm.workspace_id = w.id) AS direct_members,
  w.updated_at AS workspace_updated_at
FROM public.workspaces w
WHERE w.firm_id IS NOT NULL;

CREATE OR REPLACE VIEW public.v_firm_billing_period_summary
WITH (security_invoker = true) AS
SELECT
  f.id   AS firm_id,
  f.name AS firm_name,
  f.billing_summary_mode,
  date_trunc('month', now()) AS period_start,
  (date_trunc('month', now()) + INTERVAL '1 month - 1 day')::date AS period_end,
  count(DISTINCT w.id) AS active_child_workspaces,
  COALESCE(SUM(child.active_leases), 0)         AS aggregate_active_leases,
  COALESCE(SUM(child.total_document_bytes), 0)  AS aggregate_document_bytes,
  COALESCE(SUM(child.reports_generated_last_30_days), 0) AS aggregate_reports_30d
FROM public.firms f
LEFT JOIN public.workspaces w ON w.firm_id = f.id
LEFT JOIN public.v_firm_child_usage child ON child.workspace_id = w.id
GROUP BY f.id, f.name, f.billing_summary_mode;

-- ============================================================================
-- 10. RLS — firms, firm_members, firm_activity_log
-- ============================================================================
ALTER TABLE public.firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "firm members read firm" ON public.firms;
CREATE POLICY "firm members read firm"
  ON public.firms FOR SELECT
  USING (public.is_firm_member(id, auth.uid()));

DROP POLICY IF EXISTS "firm owner updates firm" ON public.firms;
CREATE POLICY "firm owner updates firm"
  ON public.firms FOR UPDATE
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "firm owner deletes firm" ON public.firms;
CREATE POLICY "firm owner deletes firm"
  ON public.firms FOR DELETE
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "firm members read membership" ON public.firm_members;
CREATE POLICY "firm members read membership"
  ON public.firm_members FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));

DROP POLICY IF EXISTS "firm admins manage membership" ON public.firm_members;
CREATE POLICY "firm admins manage membership"
  ON public.firm_members FOR ALL
  USING (public.is_firm_admin(firm_id, auth.uid()))
  WITH CHECK (public.is_firm_admin(firm_id, auth.uid()));

DROP POLICY IF EXISTS "firm members read firm activity" ON public.firm_activity_log;
CREATE POLICY "firm members read firm activity"
  ON public.firm_activity_log FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));

-- ============================================================================
-- 11. Expand lease_activity_log.activity_type CHECK with Phase 9 values.
--     Full current list reproduced verbatim (102 values) + 11 firm additions.
--     Dropping any existing value would break live writers — append only.
-- ============================================================================
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    'status_change','approval','rejection','send_back','pause','nudge_sent',
    'document_upload','created','comment','executed_uploaded','executed_terms_extracted',
    'unlock_approved','unlock_requested','change_canceled','change_set_submitted',
    'change_set_approved','change_set_rejected','change_set_self_approved','risk_dismissed',
    'risk_restored','risk_added','change_submitted','change_approved','change_rejected',
    'chain_resolved','chain_step_approved','chain_step_rejected','chain_step_sent_back',
    'chain_stage_completed','chain_resolution_failed','concept_stage_entered',
    'concept_stage_completed','negotiation_stage_entered','final_review_stage_entered',
    'pending_counter_signature_started','fully_executed_recorded',
    'concept_approver_escalation_requested','final_review_advanced',
    'document_uploaded_with_metadata','document_iteration_started','document_version_bumped',
    'signator_attestation_recorded','execution_owner_assigned','counter_signature_recorded',
    'counter_signature_reminder_sent','counter_signature_overdue_recorded',
    'signator_review_decline','execution_owner_reassigned','attribute_change_detected',
    'chain_rerouted','chain_reroute_skipped_no_match','chain_violation_entered',
    'chain_violation_resolved','reroute_audit_run','manual_reroute_requested',
    'manual_reroute_approved','manual_reroute_rejected','voluntary_delegation_set',
    'voluntary_delegation_revoked','admin_override_executed','out_of_office_declared',
    'out_of_office_revoked','delegate_timer_activated','delegate_timer_started',
    'step_pending_started','stuck_chain_detected','stuck_chain_resolved',
    'deactivated_approver_handled','chain_step_overridden','chain_step_admin_reassigned',
    'report_generation_requested','report_generation_completed','report_generation_failed',
    'report_downloaded','report_expired','report_deleted','discount_rate_set',
    'discount_rate_cleared','asc842_inputs_updated','tier2_classification_passed',
    'tier2_classification_rejected','tier2_classification_overridden','tier2_correction_recorded',
    'lease_insights_generated','document_deleted','amendment_archived','amendment_restored',
    'lease_archived','lease_restored','counter_signature_overdue','counter_signature_received',
    'deactivated_approver_reassigned','delegate_activated','document_iteration_uploaded',
    'negotiation_escalated_to_concept','ooo_revoked','ooo_routed_step',
    'policy_assignee_validation_failed','voluntary_delegation_created',
    'final_review_returned_to_negotiation','unlock_rejected',
    -- Phase 9 firm additions
    'firm_created','firm_member_added','firm_member_removed','firm_member_role_changed',
    'workspace_joined_firm','workspace_left_firm','workspace_firm_access_restricted',
    'workspace_firm_access_unrestricted','firm_billing_subscription_started',
    'firm_billing_subscription_updated','firm_billing_subscription_canceled'
  ]));
