-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6 — Rerouting on Material Attribute Changes
-- ─────────────────────────────────────────────────────────────────────────
--
-- Spec: docs/PHASE_6_BUILD_SPEC.md (ratified 2026-05-05)
--
-- Removes the hidden assumption that policy-triggering attributes never
-- change after submission. Adds:
--
--   1. lease_attribute_snapshots — snapshot per chain resolution
--   2. lease_reroute_events — audit row per reroute
--   3. leases.reroute_evaluation_pending — flag-and-poll signal
--   4. detect_lease_attribute_change — BEFORE UPDATE trigger that
--      compares 5 policy-triggering attributes (asset_type,
--      lease_type, requesting_department, region, monthly_payment),
--      writes an `attribute_change_detected` activity row, and sets
--      the flag. Does NOT call the resolver inline (transactional
--      risk + edge-function-from-trigger anti-pattern).
--   5. 9 new activity types appended to the live CHECK (snapshotted
--      from pg_get_constraintdef before extending; standing pattern
--      across all phases — see CLAUDE.md → "Schema Change Rule").
--
-- Idempotent: every CREATE uses IF NOT EXISTS, every CREATE POLICY
-- is preceded by DROP POLICY IF EXISTS, the activity_type constraint
-- swap uses DROP CONSTRAINT IF EXISTS. Re-runnable on staging and
-- prod.
--
-- chain_violation is already in leases_lifecycle_status_check (Phase 3
-- added it). Phase 6 actually starts WRITING that state; no constraint
-- change needed.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. lease_attribute_snapshots
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_attribute_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  chain_resolution_at         timestamptz NOT NULL DEFAULT now(),
  policy_id                   uuid REFERENCES public.approval_policies(id),
  policy_version              integer,
  asset_type                  text,
  lease_type                  text,
  requesting_department       text,
  region                      text,
  monthly_payment             numeric,
  annual_cost_at_snapshot     numeric,
  raw_attributes              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_attribute_snapshots_lease_chronological
  ON public.lease_attribute_snapshots(lease_id, chain_resolution_at DESC);

ALTER TABLE public.lease_attribute_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lease_attribute_snapshots_select ON public.lease_attribute_snapshots;
CREATE POLICY lease_attribute_snapshots_select
  ON public.lease_attribute_snapshots FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- INSERT is service-role only (resolver writes these). The Phase 2 / 5
-- pattern is to leave INSERT off the authenticated grant set; service
-- role bypasses RLS.

-- ─────────────────────────────────────────────────────────────────────────
-- 2. lease_reroute_events
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_reroute_events (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                      uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  triggered_by                  uuid REFERENCES auth.users(id),
  triggered_at                  timestamptz NOT NULL DEFAULT now(),
  trigger_reason                text NOT NULL,
  prior_policy_id               uuid REFERENCES public.approval_policies(id),
  prior_policy_version          integer,
  new_policy_id                 uuid REFERENCES public.approval_policies(id),
  new_policy_version            integer,
  changed_attributes            jsonb NOT NULL,
  prior_lifecycle_status        text NOT NULL,
  new_lifecycle_status          text NOT NULL,
  steps_added_count             integer NOT NULL DEFAULT 0,
  steps_superseded_count        integer NOT NULL DEFAULT 0,
  steps_preserved_count         integer NOT NULL DEFAULT 0,
  detection_mode                text NOT NULL CHECK (detection_mode IN ('auto', 'manual_admin', 'manual_audit')),
  resulted_in_chain_violation   boolean NOT NULL DEFAULT false,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_reroute_events_lease_chronological
  ON public.lease_reroute_events(lease_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_lease_reroute_events_workspace_chain_violations
  ON public.lease_reroute_events(workspace_id, triggered_at)
  WHERE resulted_in_chain_violation = true;

ALTER TABLE public.lease_reroute_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lease_reroute_events_select ON public.lease_reroute_events;
CREATE POLICY lease_reroute_events_select
  ON public.lease_reroute_events FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- INSERT is service-role only.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. leases.reroute_evaluation_pending flag
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS reroute_evaluation_pending boolean NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. detect_lease_attribute_change trigger
-- ─────────────────────────────────────────────────────────────────────────
--
-- BEFORE UPDATE on leases. Compares 5 policy-triggering attributes
-- against OLD; if any differ AND the lease is chain-driven (has rows
-- in lease_approval_chain) AND not in a terminal state, writes an
-- `attribute_change_detected` activity log row and sets
-- NEW.reroute_evaluation_pending = true.
--
-- Does NOT call the resolver inline. The application layer (or the
-- Phase 6 process-pending-reroute-evaluations cron) consumes the flag
-- and clears it.
--
-- SECURITY DEFINER + bounded search_path so the function can write to
-- lease_activity_log even when called by an unprivileged authenticated
-- user. user_id on the activity row is NULL — consistent with the
-- existing convention for system-initiated entries.

CREATE OR REPLACE FUNCTION public.detect_lease_attribute_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  -- Only fire for chain-driven leases. Legacy leases keep their
  -- original chain forever; rerouting them would be incoherent
  -- because they have no chain rows to reconcile.
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_approval_chain WHERE lease_id = NEW.id LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  -- Only fire if the lease has not yet reached a terminal state.
  -- Phase 6 spec: rejected / cancelled / expired never reroute.
  IF NEW.lifecycle_status IN ('rejected', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  -- Compare each policy-triggering attribute. IS DISTINCT FROM
  -- handles NULL on either side (NULL ≠ NULL with =, but
  -- NULL IS NOT DISTINCT FROM NULL with this operator).
  IF OLD.asset_type IS DISTINCT FROM NEW.asset_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object(
      'asset_type',
      jsonb_build_object('from', OLD.asset_type, 'to', NEW.asset_type)
    );
  END IF;
  IF OLD.lease_type IS DISTINCT FROM NEW.lease_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object(
      'lease_type',
      jsonb_build_object('from', OLD.lease_type, 'to', NEW.lease_type)
    );
  END IF;
  IF OLD.requesting_department IS DISTINCT FROM NEW.requesting_department THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object(
      'requesting_department',
      jsonb_build_object('from', OLD.requesting_department, 'to', NEW.requesting_department)
    );
  END IF;
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object(
      'region',
      jsonb_build_object('from', OLD.region, 'to', NEW.region)
    );
  END IF;
  IF OLD.monthly_payment IS DISTINCT FROM NEW.monthly_payment THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object(
      'monthly_payment',
      jsonb_build_object('from', OLD.monthly_payment, 'to', NEW.monthly_payment)
    );
  END IF;

  IF v_changed THEN
    INSERT INTO public.lease_activity_log (
      lease_id, user_id, activity_type, from_status, to_status, details
    ) VALUES (
      NEW.id,
      NULL,
      'attribute_change_detected',
      NEW.lifecycle_status,
      NEW.lifecycle_status,
      jsonb_build_object(
        'changed_attributes', v_changes,
        'reroute_pending', true
      )
    );

    NEW.reroute_evaluation_pending = true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leases_detect_attribute_change ON public.leases;
CREATE TRIGGER leases_detect_attribute_change
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.detect_lease_attribute_change();

-- ─────────────────────────────────────────────────────────────────────────
-- 5. activity_type CHECK extension — append 9 Phase 6 values
-- ─────────────────────────────────────────────────────────────────────────
--
-- Snapshot of the live constraint at Phase 6 C1 time (2026-05-05) is
-- the authoritative starting point. Phase 6 appends 9 values at the
-- end. Live snapshot includes Phase 5 additions; do not lose them.

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
    -- Phase 6 additions
    'attribute_change_detected',
    'chain_rerouted',
    'chain_reroute_skipped_no_match',
    'chain_violation_entered',
    'chain_violation_resolved',
    'reroute_audit_run',
    'manual_reroute_requested',
    'manual_reroute_approved',
    'manual_reroute_rejected'
  ));

COMMIT;
