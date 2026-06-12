-- Document management activity types (2026-06-12 polish pass).
--
-- Adds five values to the lease_activity_log.activity_type CHECK:
--   document_deleted    — an uploaded document (original or executed copy)
--                         was deleted from an unlocked lease via the
--                         Documents tab. details: { filename, document_kind,
--                         storage_path, bucket }.
--   amendment_archived  — an amendment (child lease) was archived from the
--                         parent's Amendments list. Logged on the PARENT
--                         lease. details: { amendment_lease_id, filename }.
--   lease_archived      — a lease was archived ("deleted") via ArchiveButton
--                         or the amendments list (logged on the lease itself).
--   lease_restored      — a lease was unarchived. Restore nulls
--                         archived_at/archived_by, so this row is the durable
--                         attribution for the restore (integrity review).
--   amendment_restored  — reserved for a parent-side restore log if a
--                         restore-from-parent surface ships later.
--
-- Pattern: snapshot the live list + append (same as the Phase 8 extension).
-- The list below was captured from the live constraint on 2026-06-12.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'unlock_approved',
    'unlock_requested', 'change_canceled', 'change_set_submitted',
    'change_set_approved', 'change_set_rejected', 'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added', 'change_submitted',
    'change_approved', 'change_rejected', 'chain_resolved',
    'chain_step_approved', 'chain_step_rejected', 'chain_step_sent_back',
    'chain_stage_completed', 'chain_resolution_failed',
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    'concept_approver_escalation_requested', 'final_review_advanced',
    'document_uploaded_with_metadata', 'document_iteration_started',
    'document_version_bumped', 'signator_attestation_recorded',
    'execution_owner_assigned', 'counter_signature_recorded',
    'counter_signature_reminder_sent', 'counter_signature_overdue_recorded',
    'signator_review_decline', 'execution_owner_reassigned',
    'attribute_change_detected', 'chain_rerouted',
    'chain_reroute_skipped_no_match', 'chain_violation_entered',
    'chain_violation_resolved', 'reroute_audit_run',
    'manual_reroute_requested', 'manual_reroute_approved',
    'manual_reroute_rejected', 'voluntary_delegation_set',
    'voluntary_delegation_revoked', 'admin_override_executed',
    'out_of_office_declared', 'out_of_office_revoked',
    'delegate_timer_activated', 'delegate_timer_started',
    'step_pending_started', 'stuck_chain_detected', 'stuck_chain_resolved',
    'deactivated_approver_handled', 'chain_step_overridden',
    'chain_step_admin_reassigned', 'report_generation_requested',
    'report_generation_completed', 'report_generation_failed',
    'report_downloaded', 'report_expired', 'report_deleted',
    'discount_rate_set', 'discount_rate_cleared', 'asc842_inputs_updated',
    'tier2_classification_passed', 'tier2_classification_rejected',
    'tier2_classification_overridden', 'tier2_correction_recorded',
    'lease_insights_generated',
    -- 2026-06-12 additions:
    'document_deleted', 'amendment_archived', 'amendment_restored',
    'lease_archived', 'lease_restored'
  ));
