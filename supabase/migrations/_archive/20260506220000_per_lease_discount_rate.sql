-- ─────────────────────────────────────────────────────────────────────────
-- Per-lease discount rate (IBR) — ASC 842 compliance follow-up to Phase 8
-- ─────────────────────────────────────────────────────────────────────────
--
-- ASC 842 measurement of the lease liability requires the lessee to
-- assess an incremental borrowing rate (IBR) at lease inception that
-- reflects:
--   - the lease term,
--   - the collateral (or lack thereof),
--   - the lessee's credit standing at the time of the lease,
--   - the economic environment at that time.
--
-- A single workspace-wide rate is at best a starting point. It is NOT
-- ASC 842 compliant for the underlying measurement. Phase 8 shipped
-- with the workspace-wide rate as the only source (As-built A4
-- documented this as forward-compat to a per-lease override).
--
-- This migration adds the per-lease override + audit trail and
-- updates the verification view to surface it via COALESCE. Edge
-- functions and the report builder must read l.discount_rate first
-- and fall back to w.discount_rate when null.
--
-- Schema deltas:
--   1. leases.discount_rate                  numeric, nullable
--      Per-lease IBR override. Null = use workspace default.
--      Bound CHECK: 0 < rate <= 50 (matches preparer-notes flag rule).
--   2. leases.discount_rate_basis            text, nullable
--      Free-form description of the methodology used to derive the
--      rate (e.g., "Treasury 7Y + 250bp credit spread", "Bank quoted
--      IBR for 5Y term, secured", "Risk-free rate election under
--      ASC 842-20-30-3 alternative"). Critical for audit defensibility.
--   3. leases.discount_rate_set_at           timestamptz, nullable
--   4. leases.discount_rate_set_by           uuid, FK auth.users
--      Capture WHO last set the rate and WHEN. Required for audit
--      trail in the verification audit section of the disclosure
--      report.
--
-- Activity types added: discount_rate_set, discount_rate_cleared
-- (for audit trail when admin/editor edits the per-lease rate).
--
-- View update:
--   v_lease_verification_audit's discount_rate column becomes
--   COALESCE(l.discount_rate, w.discount_rate) so consumers see the
--   effective rate without having to know about the override.
--
-- Idempotent — every CREATE / ADD / DROP uses IF [NOT] EXISTS.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── 1. Per-lease columns ────────────────────────────────────────────────

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS discount_rate         numeric(6,4),
  ADD COLUMN IF NOT EXISTS discount_rate_basis   text,
  ADD COLUMN IF NOT EXISTS discount_rate_set_at  timestamptz,
  ADD COLUMN IF NOT EXISTS discount_rate_set_by  uuid REFERENCES auth.users(id);

-- Bound CHECK on per-lease rate: must be > 0 and <= 50%.
ALTER TABLE public.leases
  DROP CONSTRAINT IF EXISTS leases_discount_rate_range;

ALTER TABLE public.leases
  ADD CONSTRAINT leases_discount_rate_range
  CHECK (discount_rate IS NULL OR (discount_rate > 0 AND discount_rate <= 50));

-- Index on set_at for audit-trail queries (most recent overrides per workspace).
CREATE INDEX IF NOT EXISTS idx_leases_discount_rate_set_at
  ON public.leases (workspace_id, discount_rate_set_at DESC)
  WHERE discount_rate IS NOT NULL;

-- ─── 2. Activity types ───────────────────────────────────────────────────
--
-- Snapshot live constraint, append the two new values, swap.

DO $$
DECLARE
  v_existing_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_existing_def
  FROM pg_constraint
  WHERE conrelid = 'public.lease_activity_log'::regclass
    AND conname = 'lease_activity_log_activity_type_check';

  IF v_existing_def IS NULL THEN
    RAISE EXCEPTION 'lease_activity_log_activity_type_check not found — cannot extend';
  END IF;
END $$;

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Legacy
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'unlock_approved',
    'unlock_requested', 'change_canceled', 'change_set_submitted',
    'change_set_approved', 'change_set_rejected', 'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added', 'change_submitted',
    'change_approved', 'change_rejected',
    -- Phase 2
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    -- Phase 3
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    -- Phase 4
    'concept_approver_escalation_requested', 'final_review_advanced',
    'document_uploaded_with_metadata', 'document_iteration_started',
    'document_version_bumped',
    -- Phase 5
    'signator_attestation_recorded', 'execution_owner_assigned',
    'counter_signature_recorded', 'counter_signature_reminder_sent',
    'counter_signature_overdue_recorded',
    'signator_review_decline', 'execution_owner_reassigned',
    -- Phase 6
    'attribute_change_detected', 'chain_rerouted',
    'chain_reroute_skipped_no_match', 'chain_violation_entered',
    'chain_violation_resolved', 'reroute_audit_run',
    'manual_reroute_requested', 'manual_reroute_approved',
    'manual_reroute_rejected',
    -- Phase 7
    'voluntary_delegation_set', 'voluntary_delegation_revoked',
    'admin_override_executed', 'out_of_office_declared',
    'out_of_office_revoked', 'delegate_timer_activated',
    'delegate_timer_started', 'step_pending_started',
    'stuck_chain_detected', 'stuck_chain_resolved',
    'deactivated_approver_handled', 'chain_step_overridden',
    'chain_step_admin_reassigned',
    -- Phase 8
    'report_generation_requested', 'report_generation_completed',
    'report_generation_failed', 'report_downloaded',
    'report_expired', 'report_deleted',
    -- Per-lease IBR (this migration)
    'discount_rate_set', 'discount_rate_cleared'
  ));

-- ─── 3. View update — surface effective rate via COALESCE ────────────────
--
-- CREATE OR REPLACE VIEW cannot reorder or add columns in Postgres
-- (existing columns must keep position + name). DROP + CREATE is the
-- only path. The Phase 8 migration's view ships first; this one
-- supersedes it. No external code consumes the dropped column shape
-- yet (Phase 8 frontend just hit prod 30 min ago and the table is
-- empty), so the drop is safe.

DROP VIEW IF EXISTS public.v_lease_verification_audit;

CREATE VIEW public.v_lease_verification_audit AS
SELECT
  l.id AS lease_id,
  l.workspace_id,
  l.confirmed_sections,
  l.model_locked,
  l.model_locked_at,
  l.model_locked_by,
  l.lease_classification_set_at,
  l.lease_classification_set_by,
  -- Effective discount rate: per-lease override if set, else workspace default.
  -- This is the single source of truth consumers should read for the
  -- ASC 842 disclosure report's measurement input.
  COALESCE(l.discount_rate, w.discount_rate) AS discount_rate,
  l.discount_rate AS discount_rate_per_lease_override,
  w.discount_rate AS discount_rate_workspace_default,
  l.discount_rate_basis,
  l.discount_rate_set_at,
  l.discount_rate_set_by,
  l.signator_attestation,
  l.signator_approved_at,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'field_id', fc.field_name,
      'original_value', fc.original_value,
      'corrected_value', fc.corrected_value,
      'correction_type', fc.correction_type,
      'corrected_at', fc.corrected_at,
      'corrected_by', fc.corrected_by,
      'ai_confidence_at_correction', fc.ai_confidence
    ) ORDER BY fc.corrected_at)
    FROM public.field_corrections fc
    WHERE fc.lease_id = l.id),
    '[]'::jsonb
  ) AS field_corrections
FROM public.leases l
LEFT JOIN public.workspaces w ON w.id = l.workspace_id;

COMMENT ON VIEW public.v_lease_verification_audit IS
  'Verification audit aggregate for ASC 842 disclosure reports. The discount_rate column is the EFFECTIVE rate (per-lease override if set, else workspace default). Use discount_rate_per_lease_override to detect explicit override; use discount_rate_workspace_default for the fallback value.';
