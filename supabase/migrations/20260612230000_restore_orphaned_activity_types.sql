-- Restore orphaned activity-type writer values (KNOWN_ISSUES #76).
--
-- The 2026-05-08 constraint re-snapshot (archive 20260508000000) RENAMED
-- several activity-type values without renaming the deployed writers. Every
-- audit insert using the old names has been silently rejected since (the
-- writers don't error-check their inserts). This migration appends the
-- twelve verified writer values so those audit rows land again, effective
-- immediately, with NO function redeploys required.
--
-- Verified against the live constraint + a full grep of supabase/functions/
-- on 2026-06-12 (literal AND variable-assigned activity types):
--   counter_signature_overdue            send-counter-signature-reminder
--   counter_signature_received           record-counter-signature
--   deactivated_approver_reassigned      handle-deactivated-approver
--   delegate_activated                   process-delegate-timers
--   document_iteration_uploaded          upload-lease-document
--   negotiation_escalated_to_concept     escalate-to-concept-approver
--   ooo_revoked                          revoke-out-of-office
--   ooo_routed_step                      declare-out-of-office
--   policy_assignee_validation_failed    handle-deactivated-approver
--   voluntary_delegation_created         voluntary-delegate-step
--   final_review_returned_to_negotiation act-on-chain-step  (NOT in the
--                                        original #76 report — found in the
--                                        variable-assignment sweep)
--   unlock_rejected                      lease-governance-action  (ditto —
--                                        unlock DENIALS were never logged)
--
-- Deliberate choice: APPEND the writer values rather than rename the
-- writers. Renaming requires nine+ coordinated redeploys to stop the
-- bleeding; appending stops it the moment this applies. The renamed
-- 2026-05-08 values stay in the constraint (historical rows may exist and
-- future writers may adopt them). The companion code change adds error
-- checks to the writer inserts so a future rejection can never be silent,
-- and a static test diffs writer literals against this list.

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
    -- 2026-06-12 polish-pass additions:
    'document_deleted', 'amendment_archived', 'amendment_restored',
    'lease_archived', 'lease_restored',
    -- 2026-06-12 #76 remediation — orphaned writer values restored:
    'counter_signature_overdue', 'counter_signature_received',
    'deactivated_approver_reassigned', 'delegate_activated',
    'document_iteration_uploaded', 'negotiation_escalated_to_concept',
    'ooo_revoked', 'ooo_routed_step', 'policy_assignee_validation_failed',
    'voluntary_delegation_created', 'final_review_returned_to_negotiation',
    'unlock_rejected'
  ));
