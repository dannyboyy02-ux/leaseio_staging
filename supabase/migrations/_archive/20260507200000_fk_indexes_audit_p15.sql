-- ─────────────────────────────────────────────────────────────────────────
-- P1.5 audit fix — backing indexes for foreign keys
-- ─────────────────────────────────────────────────────────────────────────
--
-- Audit 2026-05-07 found 56 foreign keys in public schema with no
-- supporting index. Postgres does not auto-index FK columns; without
-- an index, every join, cascade delete, and "find children of parent"
-- query is a sequential scan on the child table. Free 10-100× speedup
-- as workspaces grow into thousands of leases / chain steps / etc.
--
-- All CREATE INDEX statements are IF NOT EXISTS so the migration is
-- idempotent and safe to re-run. Index names follow the
-- `idx_<table>_<column>` convention.

-- approval_chain_steps
CREATE INDEX IF NOT EXISTS idx_approval_chain_steps_approver_user_id
  ON public.approval_chain_steps (approver_user_id);
CREATE INDEX IF NOT EXISTS idx_approval_chain_steps_delegate_user_id
  ON public.approval_chain_steps (delegate_user_id);

-- approval_policies
CREATE INDEX IF NOT EXISTS idx_approval_policies_created_by
  ON public.approval_policies (created_by);
CREATE INDEX IF NOT EXISTS idx_approval_policies_updated_by
  ON public.approval_policies (updated_by);

-- chain_step_overrides
CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_chain_step_id
  ON public.chain_step_overrides (chain_step_id);
CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_override_by
  ON public.chain_step_overrides (override_by);
CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_prior_assignee_user_id
  ON public.chain_step_overrides (prior_assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_reassigned_to_user_id
  ON public.chain_step_overrides (reassigned_to_user_id);

-- chain_step_voluntary_delegations
CREATE INDEX IF NOT EXISTS idx_chain_step_voluntary_delegations_delegated_by
  ON public.chain_step_voluntary_delegations (delegated_by);
CREATE INDEX IF NOT EXISTS idx_chain_step_voluntary_delegations_delegated_to
  ON public.chain_step_voluntary_delegations (delegated_to);
CREATE INDEX IF NOT EXISTS idx_chain_step_voluntary_delegations_lease_id
  ON public.chain_step_voluntary_delegations (lease_id);
CREATE INDEX IF NOT EXISTS idx_chain_step_voluntary_delegations_revoked_by
  ON public.chain_step_voluntary_delegations (revoked_by);
CREATE INDEX IF NOT EXISTS idx_chain_step_voluntary_delegations_workspace_id
  ON public.chain_step_voluntary_delegations (workspace_id);

-- deleted_workspaces
CREATE INDEX IF NOT EXISTS idx_deleted_workspaces_deleted_by
  ON public.deleted_workspaces (deleted_by);

-- dismissed_events
CREATE INDEX IF NOT EXISTS idx_dismissed_events_workspace_id
  ON public.dismissed_events (workspace_id);

-- executed_term_edits
CREATE INDEX IF NOT EXISTS idx_executed_term_edits_edited_by
  ON public.executed_term_edits (edited_by);

-- lease_approval_actions
CREATE INDEX IF NOT EXISTS idx_lease_approval_actions_approver_id
  ON public.lease_approval_actions (approver_id);

-- lease_approval_chain
CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_action_by
  ON public.lease_approval_chain (action_by);
CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_delegate_user_id
  ON public.lease_approval_chain (delegate_user_id);
CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_effective_assignee_user_id
  ON public.lease_approval_chain (effective_assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_policy_id
  ON public.lease_approval_chain (policy_id);
CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_rerouted_from_chain_id
  ON public.lease_approval_chain (rerouted_from_chain_id);

-- lease_asc842_inputs
CREATE INDEX IF NOT EXISTS idx_lease_asc842_inputs_last_updated_by
  ON public.lease_asc842_inputs (last_updated_by);

-- lease_attribute_snapshots
CREATE INDEX IF NOT EXISTS idx_lease_attribute_snapshots_policy_id
  ON public.lease_attribute_snapshots (policy_id);
CREATE INDEX IF NOT EXISTS idx_lease_attribute_snapshots_workspace_id
  ON public.lease_attribute_snapshots (workspace_id);

-- lease_change_sets
CREATE INDEX IF NOT EXISTS idx_lease_change_sets_reviewed_by
  ON public.lease_change_sets (reviewed_by);
CREATE INDEX IF NOT EXISTS idx_lease_change_sets_submitted_by
  ON public.lease_change_sets (submitted_by);

-- lease_documents
CREATE INDEX IF NOT EXISTS idx_lease_documents_superseded_by
  ON public.lease_documents (superseded_by);
CREATE INDEX IF NOT EXISTS idx_lease_documents_uploaded_by
  ON public.lease_documents (uploaded_by);

-- lease_nudges
CREATE INDEX IF NOT EXISTS idx_lease_nudges_sent_by
  ON public.lease_nudges (sent_by);

-- lease_reports
CREATE INDEX IF NOT EXISTS idx_lease_reports_generated_by
  ON public.lease_reports (generated_by);

-- lease_reroute_events
CREATE INDEX IF NOT EXISTS idx_lease_reroute_events_new_policy_id
  ON public.lease_reroute_events (new_policy_id);
CREATE INDEX IF NOT EXISTS idx_lease_reroute_events_prior_policy_id
  ON public.lease_reroute_events (prior_policy_id);
CREATE INDEX IF NOT EXISTS idx_lease_reroute_events_triggered_by
  ON public.lease_reroute_events (triggered_by);

-- lease_unlock_requests
CREATE INDEX IF NOT EXISTS idx_lease_unlock_requests_requested_by
  ON public.lease_unlock_requests (requested_by);
CREATE INDEX IF NOT EXISTS idx_lease_unlock_requests_reviewed_by
  ON public.lease_unlock_requests (reviewed_by);

-- leases (10 unindexed FKs — most-impactful table)
CREATE INDEX IF NOT EXISTS idx_leases_archived_by
  ON public.leases (archived_by);
CREATE INDEX IF NOT EXISTS idx_leases_discount_rate_set_by
  ON public.leases (discount_rate_set_by);
CREATE INDEX IF NOT EXISTS idx_leases_executed_uploaded_by
  ON public.leases (executed_uploaded_by);
CREATE INDEX IF NOT EXISTS idx_leases_execution_owner_id
  ON public.leases (execution_owner_id);
CREATE INDEX IF NOT EXISTS idx_leases_financial_approved_by
  ON public.leases (financial_approved_by);
CREATE INDEX IF NOT EXISTS idx_leases_lease_classification_set_by
  ON public.leases (lease_classification_set_by);
CREATE INDEX IF NOT EXISTS idx_leases_manager_approved_by
  ON public.leases (manager_approved_by);
CREATE INDEX IF NOT EXISTS idx_leases_model_locked_by
  ON public.leases (model_locked_by);
CREATE INDEX IF NOT EXISTS idx_leases_unlock_requested_by
  ON public.leases (unlock_requested_by);
CREATE INDEX IF NOT EXISTS idx_leases_variance_reviewed_by
  ON public.leases (variance_reviewed_by);

-- risk_templates
CREATE INDEX IF NOT EXISTS idx_risk_templates_created_by
  ON public.risk_templates (created_by);

-- risks
CREATE INDEX IF NOT EXISTS idx_risks_created_by
  ON public.risks (created_by);
CREATE INDEX IF NOT EXISTS idx_risks_dismissed_by
  ON public.risks (dismissed_by);

-- user_out_of_office
CREATE INDEX IF NOT EXISTS idx_user_out_of_office_delegate_user_id
  ON public.user_out_of_office (delegate_user_id);
CREATE INDEX IF NOT EXISTS idx_user_out_of_office_workspace_id
  ON public.user_out_of_office (workspace_id);

-- user_preferences
CREATE INDEX IF NOT EXISTS idx_user_preferences_workspace_id
  ON public.user_preferences (workspace_id);

-- workspace_approvers
CREATE INDEX IF NOT EXISTS idx_workspace_approvers_created_by
  ON public.workspace_approvers (created_by);
CREATE INDEX IF NOT EXISTS idx_workspace_approvers_user_id
  ON public.workspace_approvers (user_id);

-- workspace_roles
CREATE INDEX IF NOT EXISTS idx_workspace_roles_user_id
  ON public.workspace_roles (user_id);

-- workspaces
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id
  ON public.workspaces (owner_id);
