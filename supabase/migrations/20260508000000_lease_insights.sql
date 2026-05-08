-- Tier 3 contextual intelligence — Phase 1 (foundation)
--
-- Stores Sonnet-generated insights that compare a single lease against
-- the workspace's broader portfolio. Triggered manually for v1
-- ("Generate portfolio insights" button on lease detail); event-driven
-- triggers (model_lock, amendment confirm, renewal-window approaching)
-- are v2.
--
-- Insights are workspace-scoped via the lease_id FK + RLS, append-only
-- from the application layer. The generate-lease-insights edge
-- function (service-role) writes; workspace members read.
--
-- Gated to Business tier at the application layer — generate-lease-insights
-- checks workspace.plan and refuses for starter. The schema itself does
-- not enforce that gate; it's a product-tier decision, not a data integrity one.

CREATE TABLE IF NOT EXISTS public.lease_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lease_id        uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  -- What kind of insight Sonnet generated. Bounded for filtering UI;
  -- 'general_observation' is the catch-all when nothing more specific
  -- fits.
  insight_type    text NOT NULL CHECK (insight_type IN (
    'portfolio_norm_deviation',  -- this lease is X% above/below the workspace norm
    'amendment_impact',          -- amendment materially changes prior lease
    'renewal_proximity',         -- renewal window is approaching
    'risk_pattern_match',        -- matches a workspace risk_template pattern
    'general_observation'        -- other contextual observations
  )),
  severity        text NOT NULL CHECK (severity IN ('info', 'notice', 'concern')),
  title           text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  body            text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  -- The specific data points Sonnet cited as supporting this insight
  -- (e.g., {"this_lease_monthly":2400, "workspace_median":1800,
  -- "deviation_pct":33}). Used in the UI for tooltip context and for
  -- forensics when the user wants to know "why does the AI think this?"
  source_data     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What event caused this analysis to run.
  triggered_by    text NOT NULL CHECK (triggered_by IN (
    'manual', 'model_locked', 'amendment_confirmed', 'scheduled'
  )),
  generated_model text,
  generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_insights_lease_recent
  ON public.lease_insights(lease_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_lease_insights_workspace_recent
  ON public.lease_insights(workspace_id, generated_at DESC);

ALTER TABLE public.lease_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read insights" ON public.lease_insights;
CREATE POLICY "workspace members read insights"
  ON public.lease_insights FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "no direct client inserts" ON public.lease_insights;
CREATE POLICY "no direct client inserts"
  ON public.lease_insights FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "no client updates" ON public.lease_insights;
CREATE POLICY "no client updates"
  ON public.lease_insights FOR UPDATE
  TO authenticated
  USING (false);

DROP POLICY IF EXISTS "no client deletes" ON public.lease_insights;
CREATE POLICY "no client deletes"
  ON public.lease_insights FOR DELETE
  TO authenticated
  USING (false);

-- Activity type for the audit trail when insights are generated
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Lifecycle + workflow (legacy + chain)
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted',
    'unlock_approved', 'unlock_requested',
    'change_canceled', 'change_set_submitted', 'change_set_approved',
    'change_set_rejected', 'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added',
    'change_submitted', 'change_approved', 'change_rejected',
    -- Phase 2: chain workflow
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    -- Phase 3: lifecycle vocabulary
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    'concept_approver_escalation_requested', 'final_review_advanced',
    -- Phase 4: negotiation documents
    'document_uploaded_with_metadata', 'document_iteration_started',
    'document_version_bumped',
    -- Phase 5: signator + counter-signature
    'signator_attestation_recorded', 'execution_owner_assigned',
    'counter_signature_recorded', 'counter_signature_reminder_sent',
    'counter_signature_overdue_recorded', 'signator_review_decline',
    'execution_owner_reassigned',
    -- Phase 6: rerouting
    'attribute_change_detected', 'chain_rerouted',
    'chain_reroute_skipped_no_match', 'chain_violation_entered',
    'chain_violation_resolved', 'reroute_audit_run',
    'manual_reroute_requested', 'manual_reroute_approved',
    'manual_reroute_rejected',
    -- Phase 7: delegation, OOO, overrides
    'voluntary_delegation_set', 'voluntary_delegation_revoked',
    'admin_override_executed', 'out_of_office_declared',
    'out_of_office_revoked', 'delegate_timer_activated',
    'delegate_timer_started', 'step_pending_started',
    'stuck_chain_detected', 'stuck_chain_resolved',
    'deactivated_approver_handled', 'chain_step_overridden',
    'chain_step_admin_reassigned',
    -- Phase 8: ASC 842 reports
    'report_generation_requested', 'report_generation_completed',
    'report_generation_failed', 'report_downloaded', 'report_expired',
    'report_deleted', 'discount_rate_set', 'discount_rate_cleared',
    'asc842_inputs_updated',
    -- Tier 2 classification
    'tier2_classification_passed',
    'tier2_classification_rejected',
    'tier2_classification_overridden',
    'tier2_correction_recorded',
    -- Tier 3 contextual intelligence
    'lease_insights_generated'
  ));
