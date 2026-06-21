-- Add 'source_document_replaced' to lease_activity_log.activity_type CHECK.
--
-- C1 (in-place re-upload): retry_lease can now replace the stored source
-- document of a FAILED lease with a fresh upload and reprocess it in place.
-- Replacing a lease's source-of-truth document is an auditable event, so
-- retry_lease writes a lease_activity_log row with this activity_type
-- (details: { filename, storage_path, previous_storage_path, reason }).
--
-- Pattern: snapshot the live list (reproduced verbatim from
-- 20260615172439_phase9_firm_layer_foundation.sql — the latest writer of this
-- constraint) + append. Dropping any existing value would break live writers,
-- so this is append-only. Re-runnable (DROP IF EXISTS + ADD).

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
    'firm_billing_subscription_updated','firm_billing_subscription_canceled',
    -- C1 in-place re-upload (2026-06-21)
    'source_document_replaced'
  ]));
