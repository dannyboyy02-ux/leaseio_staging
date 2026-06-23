-- Cluster B2 — stuck-extraction sweep (2026-06-23).
--
-- Two parts:
--   1. Add 'extraction_timed_out' to the lease_activity_log activity_type CHECK
--      so the reclaim-stuck-extractions sweep can write an audit row when it
--      fails a zombie 'Processing' lease. Append-only (snapshot the live list,
--      verbatim from 20260621000000_source_document_replaced_activity_type.sql,
--      + append) — dropping any value would break live writers. Re-runnable.
--   2. Schedule the reclaim-stuck-extractions edge function every 15 minutes.
--      Secret pulled from private.cron_secrets at runtime (same pattern as the
--      other LeaseIO cron jobs — never stored plaintext in cron.job).
--
-- Prerequisites (operator, before this is effective):
--   supabase secrets set RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET=$(openssl rand -hex 32)
--   INSERT INTO private.cron_secrets (id, value)
--     VALUES ('reclaim_stuck_extractions', '<same value>');
--   (and deploy the reclaim-stuck-extractions function.)

-- ── 1. activity_type CHECK: append 'extraction_timed_out' ──────────────────
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
    'source_document_replaced',
    -- Cluster B2 stuck-extraction sweep (2026-06-23)
    'extraction_timed_out'
  ]));

-- ── 2. schedule the sweep every 15 minutes ─────────────────────────────────
-- cron.schedule upserts by job name, so re-running this migration replaces the
-- schedule rather than erroring (same pattern as the cancellation cron).
SELECT cron.schedule(
  'reclaim-stuck-extractions',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/reclaim-stuck-extractions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM private.cron_secrets WHERE id = 'reclaim_stuck_extractions' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
