-- P0-d follow-up — relax actor/attribution auth.users FKs to ON DELETE SET NULL
-- (2026-07-16), so account deletion (GDPR right-to-erasure) actually completes.
--
-- WHY: the P0-d rebuild preserves a departing user's leases in workspaces they
-- don't own (fixing cross-tenant destruction). But ~44 actor/attribution columns
-- across the schema reference auth.users with ON DELETE NO ACTION, so any row a
-- departing user authored on surviving (cross-tenant) data would FK-BLOCK
-- auth.admin.deleteUser — the deletion 500s for essentially any user who was ever
-- an approver / uploader / editor in a workspace they don't own (integrity review
-- CRITICAL/HIGH). This is the "relax audit FKs to SET NULL" follow-up the old
-- delete-account code flagged.
--
-- FIX: every such FK becomes ON DELETE SET NULL — the row (and its audit value)
-- SURVIVES with the actor cleared (the #90 null-attribution convention already
-- used by lease_activity_log.user_id / risks / workspace_activity_log). NOT NULL
-- actor columns are made nullable (they only ever go null on a hard user-delete).
-- Owner's-own CASCADE data is untouched; firms.owner_id is intentionally excluded
-- (a firm cannot have a null owner — deferred to #104 delete-firm).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD; DROP NOT NULL is re-runnable.

ALTER TABLE public.approval_chain_steps DROP CONSTRAINT IF EXISTS approval_chain_steps_delegate_user_id_fkey;
ALTER TABLE public.approval_chain_steps ADD CONSTRAINT approval_chain_steps_delegate_user_id_fkey FOREIGN KEY (delegate_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.approval_chain_steps DROP CONSTRAINT IF EXISTS approval_chain_steps_approver_user_id_fkey;
ALTER TABLE public.approval_chain_steps ADD CONSTRAINT approval_chain_steps_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.approval_policies ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.approval_policies DROP CONSTRAINT IF EXISTS approval_policies_created_by_fkey;
ALTER TABLE public.approval_policies ADD CONSTRAINT approval_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.approval_policies ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE public.approval_policies DROP CONSTRAINT IF EXISTS approval_policies_updated_by_fkey;
ALTER TABLE public.approval_policies ADD CONSTRAINT approval_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_overrides DROP CONSTRAINT IF EXISTS chain_step_overrides_reassigned_to_user_id_fkey;
ALTER TABLE public.chain_step_overrides ADD CONSTRAINT chain_step_overrides_reassigned_to_user_id_fkey FOREIGN KEY (reassigned_to_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_overrides DROP CONSTRAINT IF EXISTS chain_step_overrides_prior_assignee_user_id_fkey;
ALTER TABLE public.chain_step_overrides ADD CONSTRAINT chain_step_overrides_prior_assignee_user_id_fkey FOREIGN KEY (prior_assignee_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_overrides ALTER COLUMN override_by DROP NOT NULL;
ALTER TABLE public.chain_step_overrides DROP CONSTRAINT IF EXISTS chain_step_overrides_override_by_fkey;
ALTER TABLE public.chain_step_overrides ADD CONSTRAINT chain_step_overrides_override_by_fkey FOREIGN KEY (override_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_voluntary_delegations DROP CONSTRAINT IF EXISTS chain_step_voluntary_delegations_revoked_by_fkey;
ALTER TABLE public.chain_step_voluntary_delegations ADD CONSTRAINT chain_step_voluntary_delegations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_voluntary_delegations ALTER COLUMN delegated_by DROP NOT NULL;
ALTER TABLE public.chain_step_voluntary_delegations DROP CONSTRAINT IF EXISTS chain_step_voluntary_delegations_delegated_by_fkey;
ALTER TABLE public.chain_step_voluntary_delegations ADD CONSTRAINT chain_step_voluntary_delegations_delegated_by_fkey FOREIGN KEY (delegated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.chain_step_voluntary_delegations ALTER COLUMN delegated_to DROP NOT NULL;
ALTER TABLE public.chain_step_voluntary_delegations DROP CONSTRAINT IF EXISTS chain_step_voluntary_delegations_delegated_to_fkey;
ALTER TABLE public.chain_step_voluntary_delegations ADD CONSTRAINT chain_step_voluntary_delegations_delegated_to_fkey FOREIGN KEY (delegated_to) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.classification_corrections DROP CONSTRAINT IF EXISTS classification_corrections_corrected_by_fkey;
ALTER TABLE public.classification_corrections ADD CONSTRAINT classification_corrections_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.deleted_workspaces DROP CONSTRAINT IF EXISTS deleted_workspaces_deleted_by_fkey;
ALTER TABLE public.deleted_workspaces ADD CONSTRAINT deleted_workspaces_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.executed_term_edits ALTER COLUMN edited_by DROP NOT NULL;
ALTER TABLE public.executed_term_edits DROP CONSTRAINT IF EXISTS executed_term_edits_edited_by_fkey;
ALTER TABLE public.executed_term_edits ADD CONSTRAINT executed_term_edits_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_activity_log DROP CONSTRAINT IF EXISTS firm_activity_log_user_id_fkey;
ALTER TABLE public.firm_activity_log ADD CONSTRAINT firm_activity_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_invitations DROP CONSTRAINT IF EXISTS firm_invitations_revoked_by_fkey;
ALTER TABLE public.firm_invitations ADD CONSTRAINT firm_invitations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_invitations ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE public.firm_invitations DROP CONSTRAINT IF EXISTS firm_invitations_invited_by_fkey;
ALTER TABLE public.firm_invitations ADD CONSTRAINT firm_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_invitations DROP CONSTRAINT IF EXISTS firm_invitations_accepted_by_fkey;
ALTER TABLE public.firm_invitations ADD CONSTRAINT firm_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_members DROP CONSTRAINT IF EXISTS firm_members_created_by_fkey;
ALTER TABLE public.firm_members ADD CONSTRAINT firm_members_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_workspace_join_requests DROP CONSTRAINT IF EXISTS firm_workspace_join_requests_acted_by_fkey;
ALTER TABLE public.firm_workspace_join_requests ADD CONSTRAINT firm_workspace_join_requests_acted_by_fkey FOREIGN KEY (acted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.firm_workspace_join_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE public.firm_workspace_join_requests DROP CONSTRAINT IF EXISTS firm_workspace_join_requests_requested_by_fkey;
ALTER TABLE public.firm_workspace_join_requests ADD CONSTRAINT firm_workspace_join_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approval_actions ALTER COLUMN approver_id DROP NOT NULL;
ALTER TABLE public.lease_approval_actions DROP CONSTRAINT IF EXISTS lease_approval_actions_approver_id_fkey;
ALTER TABLE public.lease_approval_actions ADD CONSTRAINT lease_approval_actions_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approval_chain DROP CONSTRAINT IF EXISTS lease_approval_chain_approver_user_id_fkey;
ALTER TABLE public.lease_approval_chain ADD CONSTRAINT lease_approval_chain_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approval_chain DROP CONSTRAINT IF EXISTS lease_approval_chain_effective_assignee_user_id_fkey;
ALTER TABLE public.lease_approval_chain ADD CONSTRAINT lease_approval_chain_effective_assignee_user_id_fkey FOREIGN KEY (effective_assignee_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approval_chain DROP CONSTRAINT IF EXISTS lease_approval_chain_action_by_fkey;
ALTER TABLE public.lease_approval_chain ADD CONSTRAINT lease_approval_chain_action_by_fkey FOREIGN KEY (action_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approval_chain DROP CONSTRAINT IF EXISTS lease_approval_chain_delegate_user_id_fkey;
ALTER TABLE public.lease_approval_chain ADD CONSTRAINT lease_approval_chain_delegate_user_id_fkey FOREIGN KEY (delegate_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_approvers ALTER COLUMN approver_id DROP NOT NULL;
ALTER TABLE public.lease_approvers DROP CONSTRAINT IF EXISTS lease_approvers_approver_id_fkey;
ALTER TABLE public.lease_approvers ADD CONSTRAINT lease_approvers_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_asc842_inputs DROP CONSTRAINT IF EXISTS lease_asc842_inputs_last_updated_by_fkey;
ALTER TABLE public.lease_asc842_inputs ADD CONSTRAINT lease_asc842_inputs_last_updated_by_fkey FOREIGN KEY (last_updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_change_sets ALTER COLUMN submitted_by DROP NOT NULL;
ALTER TABLE public.lease_change_sets DROP CONSTRAINT IF EXISTS lease_change_sets_submitted_by_fkey;
ALTER TABLE public.lease_change_sets ADD CONSTRAINT lease_change_sets_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_change_sets DROP CONSTRAINT IF EXISTS lease_change_sets_reviewed_by_fkey;
ALTER TABLE public.lease_change_sets ADD CONSTRAINT lease_change_sets_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_documents ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE public.lease_documents DROP CONSTRAINT IF EXISTS lease_documents_uploaded_by_fkey;
ALTER TABLE public.lease_documents ADD CONSTRAINT lease_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_governance_audit DROP CONSTRAINT IF EXISTS lease_governance_audit_actor_user_id_fkey;
ALTER TABLE public.lease_governance_audit ADD CONSTRAINT lease_governance_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_nudges DROP CONSTRAINT IF EXISTS lease_nudges_sent_by_fkey;
ALTER TABLE public.lease_nudges ADD CONSTRAINT lease_nudges_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_reports ALTER COLUMN generated_by DROP NOT NULL;
ALTER TABLE public.lease_reports DROP CONSTRAINT IF EXISTS lease_reports_generated_by_fkey;
ALTER TABLE public.lease_reports ADD CONSTRAINT lease_reports_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_reroute_events DROP CONSTRAINT IF EXISTS lease_reroute_events_triggered_by_fkey;
ALTER TABLE public.lease_reroute_events ADD CONSTRAINT lease_reroute_events_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_unlock_requests DROP CONSTRAINT IF EXISTS lease_unlock_requests_reviewed_by_fkey;
ALTER TABLE public.lease_unlock_requests ADD CONSTRAINT lease_unlock_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lease_unlock_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE public.lease_unlock_requests DROP CONSTRAINT IF EXISTS lease_unlock_requests_requested_by_fkey;
ALTER TABLE public.lease_unlock_requests ADD CONSTRAINT lease_unlock_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_financial_approved_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_financial_approved_by_fkey FOREIGN KEY (financial_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_variance_reviewed_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_variance_reviewed_by_fkey FOREIGN KEY (variance_reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_executed_uploaded_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_executed_uploaded_by_fkey FOREIGN KEY (executed_uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_lease_classification_set_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_lease_classification_set_by_fkey FOREIGN KEY (lease_classification_set_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_execution_owner_id_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_execution_owner_id_fkey FOREIGN KEY (execution_owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_lease_owner_id_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_lease_owner_id_fkey FOREIGN KEY (lease_owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_discount_rate_set_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_discount_rate_set_by_fkey FOREIGN KEY (discount_rate_set_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_archived_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_unlock_requested_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_unlock_requested_by_fkey FOREIGN KEY (unlock_requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_manager_approved_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_manager_approved_by_fkey FOREIGN KEY (manager_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_model_locked_by_fkey;
ALTER TABLE public.leases ADD CONSTRAINT leases_model_locked_by_fkey FOREIGN KEY (model_locked_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.ops_admins DROP CONSTRAINT IF EXISTS ops_admins_added_by_fkey;
ALTER TABLE public.ops_admins ADD CONSTRAINT ops_admins_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.user_out_of_office ALTER COLUMN delegate_user_id DROP NOT NULL;
ALTER TABLE public.user_out_of_office DROP CONSTRAINT IF EXISTS user_out_of_office_delegate_user_id_fkey;
ALTER TABLE public.user_out_of_office ADD CONSTRAINT user_out_of_office_delegate_user_id_fkey FOREIGN KEY (delegate_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.vendor_alert_log DROP CONSTRAINT IF EXISTS vendor_alert_log_acknowledged_by_fkey;
ALTER TABLE public.vendor_alert_log ADD CONSTRAINT vendor_alert_log_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_approvers DROP CONSTRAINT IF EXISTS workspace_approvers_created_by_fkey;
ALTER TABLE public.workspace_approvers ADD CONSTRAINT workspace_approvers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── Self-verify: no NO-ACTION auth.users FK may remain on the relaxed tables ──
-- Guards against constraint-name drift (a non-default name would make the
-- DROP IF EXISTS above silently no-op, leaving the blocking FK in place). Fails
-- the migration loudly if any survived. firms.owner_id is intentionally NOT in
-- this set (kept NO ACTION — a firm cannot have a null owner; #104).
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
  INTO v_bad
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid = 'auth.users'::regclass
    AND confdeltype = 'a'  -- NO ACTION
    AND conrelid::regclass::text = ANY (ARRAY[
      'approval_chain_steps','approval_policies','chain_step_overrides',
      'chain_step_voluntary_delegations','classification_corrections','deleted_workspaces',
      'executed_term_edits','firm_activity_log','firm_invitations','firm_members',
      'firm_workspace_join_requests','lease_approval_actions','lease_approval_chain',
      'lease_approvers','lease_asc842_inputs','lease_change_sets','lease_documents',
      'lease_governance_audit','lease_nudges','lease_reports','lease_reroute_events',
      'lease_unlock_requests','leases','ops_admins','user_out_of_office',
      'vendor_alert_log','workspace_approvers'
    ]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'P0-d: NO-ACTION auth.users FK(s) still present after relax (constraint-name drift?): %', v_bad;
  END IF;
END $$;

-- ── Prevent SET NULL from orphaning a departing user's PENDING chain steps ──
-- A step assigned to a SPECIFIC user (approver_user_id = them, approver_role
-- null) would, once nulled, match no queue branch for anyone — the lease stalls
-- invisibly (integrity review MEDIUM). delete-account calls this BEFORE the auth
-- delete: pending steps the departing user holds in workspaces they DON'T own
-- (owned workspaces are being purged anyway) are reassigned to each step's
-- workspace OWNER, who can then act or reassign. Acted/historical steps keep
-- their actor (SET NULL there is harmless).
CREATE OR REPLACE FUNCTION public.reassign_departing_user_chain_steps(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;
  WITH updated AS (
    UPDATE public.lease_approval_chain lac
    SET approver_user_id = w.owner_id,
        effective_assignee_user_id = w.owner_id
    FROM public.workspaces w
    WHERE lac.workspace_id = w.id
      AND lac.status = 'pending'
      AND w.owner_id IS NOT NULL
      AND w.owner_id <> p_user_id
      AND (lac.approver_user_id = p_user_id OR lac.effective_assignee_user_id = p_user_id)
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM updated;
  RETURN v_n;
END $$;

ALTER FUNCTION public.reassign_departing_user_chain_steps(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reassign_departing_user_chain_steps(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_departing_user_chain_steps(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reassign_departing_user_chain_steps(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_departing_user_chain_steps(uuid) TO service_role;
