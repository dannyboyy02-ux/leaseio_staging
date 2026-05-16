-- ─────────────────────────────────────────────────────────────────────────
-- Phase 8 — ASC 842 Disclosure Report Generation
-- ─────────────────────────────────────────────────────────────────────────
--
-- Spec: docs/PHASE_8_BUILD_SPEC.md (ratified 2026-05-06)
--
-- The phase that closes the product loop. Adds the artifact customers
-- actually buy LeaseIO for: per-lease + per-period ASC 842 disclosure
-- reports (PDF + JSON) with full verification audit trail and the
-- "Not a Financial Statement" liability shield.
--
-- Changes:
--   1. lease_reports table — single-lease vs. portfolio-period reports
--      with status lifecycle + workspace_settings_snapshot for forensic
--      reproducibility. report_scope_lease_id_correlation CHECK
--      enforces shape per type.
--   2. v_lease_verification_audit view — single source of truth for
--      "what was verified on this lease and by whom." Aggregates
--      confirmed_sections + model_locked metadata + field_corrections
--      JSON.
--      As-built delta: spec named columns 'field_id' and
--      'ai_confidence_at_correction' on field_corrections; live
--      columns are 'field_name' and 'ai_confidence' (Phase 0 schema).
--      View aliases them to spec names so downstream consumers get the
--      stable contract.
--      As-built delta: spec referenced leases.discount_rate; live
--      schema has discount_rate on workspaces only. View joins
--      workspaces.discount_rate so the report reads the workspace
--      default. Per-lease override is a future enhancement.
--   3. 5 new workspace report-settings columns (organization name,
--      fiscal year start month 1..12, rounding precision 0..6,
--      retention days 1..730, discount rate methodology enum).
--   4. lease-reports storage bucket (private). Bucket-level RLS via
--      separate storage.objects policies.
--   5. RLS on lease_reports: workspace members read; editors+ insert;
--      admins/owner delete. INSERT enforces generated_by = auth.uid().
--   6. 6 new activity types appended to live CHECK (snapshotted
--      from pg_get_constraintdef before extending; standing pattern).
--      Live state pre-Phase-8 has 69 values; this brings it to 75.
--
-- Idempotent: every CREATE uses IF NOT EXISTS; CREATE OR REPLACE for
-- view/policies; constraint swap uses DROP CONSTRAINT IF EXISTS.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. lease_reports
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_reports (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_type                 text NOT NULL CHECK (report_type IN ('lease_disclosure', 'portfolio_period')),
  report_scope                text NOT NULL CHECK (report_scope IN ('single_lease', 'monthly', 'quarterly', 'annual', 'custom_range')),
  lease_id                    uuid REFERENCES public.leases(id) ON DELETE CASCADE,
  period_start                date,
  period_end                  date,
  generated_at                timestamptz NOT NULL DEFAULT now(),
  generated_by                uuid NOT NULL REFERENCES auth.users(id),
  pdf_storage_path            text,
  json_storage_path           text,
  lease_count                 integer NOT NULL DEFAULT 0,
  excluded_lease_count        integer NOT NULL DEFAULT 0,
  exclusion_reasons           jsonb NOT NULL DEFAULT '{}'::jsonb,
  organization_name_at_gen    text,
  discount_rate_method_at_gen text,
  workspace_settings_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'expired')),
  error_message               text,
  expires_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_scope_lease_id_correlation CHECK (
    (report_scope = 'single_lease' AND lease_id IS NOT NULL AND period_start IS NULL AND period_end IS NULL)
    OR
    (report_scope IN ('monthly', 'quarterly', 'annual', 'custom_range') AND lease_id IS NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)
  )
);

CREATE INDEX IF NOT EXISTS idx_lease_reports_workspace_chronological
  ON public.lease_reports(workspace_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_lease_reports_lease
  ON public.lease_reports(lease_id, generated_at DESC)
  WHERE lease_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lease_reports_period
  ON public.lease_reports(workspace_id, period_start, period_end)
  WHERE period_start IS NOT NULL;

ALTER TABLE public.lease_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read reports" ON public.lease_reports;
CREATE POLICY "workspace members read reports"
  ON public.lease_reports FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "members initiate reports" ON public.lease_reports;
CREATE POLICY "members initiate reports"
  ON public.lease_reports FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND generated_by = auth.uid()
  );

DROP POLICY IF EXISTS "admins delete reports" ON public.lease_reports;
CREATE POLICY "admins delete reports"
  ON public.lease_reports FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 2. v_lease_verification_audit view
-- ─────────────────────────────────────────────────────────────────────────
--
-- As-built deltas vs. spec (Phase 0 schema realities):
--   - field_corrections.field_name → exposed as 'field_id' in the JSON
--     so downstream consumers get the stable contract per spec.
--   - field_corrections.ai_confidence → exposed as
--     'ai_confidence_at_correction' for the same reason.
--   - leases.discount_rate doesn't exist; the column lives at
--     workspaces.discount_rate (one rate per workspace today).
--     View joins workspaces and surfaces the workspace's discount_rate
--     as the lease's effective rate. Per-lease override is a future
--     enhancement; the view is forward-compatible because it can be
--     swapped to COALESCE(l.discount_rate, w.discount_rate) once the
--     lease column ships.

CREATE OR REPLACE VIEW public.v_lease_verification_audit AS
SELECT
  l.id AS lease_id,
  l.workspace_id,
  l.confirmed_sections,
  l.model_locked,
  l.model_locked_at,
  l.model_locked_by,
  l.lease_classification_set_at,
  l.lease_classification_set_by,
  w.discount_rate,
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

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Workspace report settings
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS report_organization_name        text,
  ADD COLUMN IF NOT EXISTS report_fiscal_year_start_month  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS report_rounding_precision       integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS report_artifact_retention_days  integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS report_default_discount_method  text DEFAULT 'workspace_default';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_report_fiscal_year_start_month_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_report_fiscal_year_start_month_check
  CHECK (report_fiscal_year_start_month BETWEEN 1 AND 12);

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_report_rounding_precision_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_report_rounding_precision_check
  CHECK (report_rounding_precision BETWEEN 0 AND 6);

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_report_artifact_retention_days_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_report_artifact_retention_days_check
  CHECK (report_artifact_retention_days BETWEEN 1 AND 730);

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_report_default_discount_method_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_report_default_discount_method_check
  CHECK (report_default_discount_method IN ('workspace_default', 'risk_free_rate', 'incremental_borrowing_rate', 'custom'));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. lease-reports storage bucket
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('lease-reports', 'lease-reports', false)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Storage RLS for lease-reports
-- ─────────────────────────────────────────────────────────────────────────
--
-- Workspace members read artifacts associated with reports they can
-- see via the lease_reports table. Insert is service-role-only (the
-- edge function does the upload after generating the artifact); we
-- explicitly REVOKE INSERT from authenticated to enforce.

DROP POLICY IF EXISTS "workspace members read lease-reports" ON storage.objects;
CREATE POLICY "workspace members read lease-reports"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE (lr.pdf_storage_path = name OR lr.json_storage_path = name)
        AND (
          lr.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR lr.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 6. activity_type CHECK extension — append 6 Phase 8 values
-- ─────────────────────────────────────────────────────────────────────────
--
-- Snapshot of the live constraint at Phase 8 C1 time (2026-05-06).
-- Live has 69 values (Phase 7's 13 additions confirmed). Phase 8
-- appends 6 → final count 75.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Legacy + pre-Phase 2
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted',
    'unlock_approved', 'unlock_requested', 'change_canceled',
    'change_set_submitted', 'change_set_approved', 'change_set_rejected',
    'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added',
    'change_submitted', 'change_approved', 'change_rejected',
    -- Phase 2
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    -- Phase 3
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    -- Phase 4
    'document_iteration_uploaded', 'document_iteration_superseded',
    'negotiation_escalated_to_concept', 'document_marked_final_negotiated',
    'document_lineage_corrected',
    -- Phase 5
    'signator_attestation_recorded', 'counter_signature_reminder_sent',
    'counter_signature_overdue', 'counter_signature_received',
    'execution_owner_assigned', 'execution_owner_reassigned',
    'final_review_returned_to_negotiation',
    -- Phase 6
    'attribute_change_detected', 'chain_rerouted',
    'chain_reroute_skipped_no_match', 'chain_violation_entered',
    'chain_violation_resolved', 'reroute_audit_run',
    'manual_reroute_requested', 'manual_reroute_approved',
    'manual_reroute_rejected',
    -- Phase 7
    'step_pending_started', 'delegate_timer_started', 'delegate_activated',
    'voluntary_delegation_created', 'voluntary_delegation_revoked',
    'admin_override_executed', 'ooo_declared', 'ooo_revoked',
    'ooo_routed_step', 'stuck_chain_detected', 'stuck_chain_resolved',
    'deactivated_approver_reassigned', 'policy_assignee_validation_failed',
    -- Phase 8 additions
    'report_generation_requested',
    'report_generation_completed',
    'report_generation_failed',
    'report_downloaded',
    'report_expired',
    'report_deleted'
  ));

COMMIT;
