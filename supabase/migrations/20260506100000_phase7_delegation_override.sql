-- ─────────────────────────────────────────────────────────────────────────
-- Phase 7 — Delegation, Override, and Exception Handling
-- ─────────────────────────────────────────────────────────────────────────
--
-- Spec: docs/PHASE_7_BUILD_SPEC.md (ratified 2026-05-06)
--
-- Activates the latent delegate_user_id / delegate_after_days
-- infrastructure from Phase 1 and adds operational maturity:
--
--   1. user_out_of_office — workspace-scoped OOO declarations with
--      designated delegate, validated window
--   2. chain_step_overrides — admin override audit table with
--      20-char minimum reason as deliberate friction
--   3. chain_step_voluntary_delegations — user-initiated per-step
--      delegations, soft-deletable via revoked_at/revoked_by
--   4. lease_approval_chain new columns:
--        - pending_since (when this step became the active blocker)
--        - delegate_activated_at (policy delegate timer fired)
--        - effective_assignee_user_id (denormalized priority resolution:
--          admin reassign > voluntary > OOO > policy delegate > original)
--        - assignee_resolution_source (audit trail for the denormalized
--          column: which source determined the effective assignee)
--   5. 13 new activity types appended to the live CHECK
--      (snapshotted from pg_get_constraintdef before extending; standing
--      pattern across all phases — see CLAUDE.md → "Schema Change Rule")
--
-- Idempotent: every CREATE uses IF NOT EXISTS, every CREATE POLICY is
-- preceded by DROP POLICY IF EXISTS, the activity_type constraint swap
-- uses DROP CONSTRAINT IF EXISTS. Re-runnable on staging and prod.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. user_out_of_office
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_out_of_office (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  delegate_user_id    uuid NOT NULL REFERENCES auth.users(id),
  reason              text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ooo_valid_window CHECK (starts_at < ends_at),
  CONSTRAINT ooo_no_self_delegation CHECK (user_id <> delegate_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_ooo_active_window
  ON public.user_out_of_office(user_id, workspace_id, starts_at, ends_at)
  WHERE is_active = true;

DROP TRIGGER IF EXISTS user_out_of_office_updated_at ON public.user_out_of_office;
CREATE TRIGGER user_out_of_office_updated_at
  BEFORE UPDATE ON public.user_out_of_office
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_out_of_office ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members + workspace owner can see all OOO records
-- in their workspaces (admins need full visibility for the exceptions
-- dashboard; regular members need to see whose OOO would route a step
-- to whom).
DROP POLICY IF EXISTS user_out_of_office_select ON public.user_out_of_office;
CREATE POLICY user_out_of_office_select
  ON public.user_out_of_office FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- INSERT: a user can declare their own OOO. Admin-on-behalf flow is
-- the same INSERT but routed through declare-out-of-office edge
-- function with service-role privileges (which bypasses RLS).
DROP POLICY IF EXISTS user_out_of_office_insert_self ON public.user_out_of_office;
CREATE POLICY user_out_of_office_insert_self
  ON public.user_out_of_office FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- UPDATE: a user can revoke (set is_active=false) their own OOO.
-- Admin-on-behalf is service-role-only.
DROP POLICY IF EXISTS user_out_of_office_update_self ON public.user_out_of_office;
CREATE POLICY user_out_of_office_update_self
  ON public.user_out_of_office FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- 2. chain_step_overrides
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.chain_step_overrides (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_step_id               uuid NOT NULL REFERENCES public.lease_approval_chain(id) ON DELETE CASCADE,
  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  override_action             text NOT NULL CHECK (override_action IN ('approve', 'reject', 'send_back', 'reassign', 'cancel_step')),
  override_by                 uuid NOT NULL REFERENCES auth.users(id),
  override_reason             text NOT NULL CHECK (length(trim(override_reason)) >= 20),
  override_at                 timestamptz NOT NULL DEFAULT now(),
  reassigned_to_user_id       uuid REFERENCES auth.users(id),
  prior_assignee_user_id      uuid REFERENCES auth.users(id),
  prior_assignee_role         text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_lease
  ON public.chain_step_overrides(lease_id, override_at DESC);

CREATE INDEX IF NOT EXISTS idx_chain_step_overrides_workspace_recent
  ON public.chain_step_overrides(workspace_id, override_at DESC);

ALTER TABLE public.chain_step_overrides ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members can see overrides on leases in their
-- workspace (audit trail visibility).
DROP POLICY IF EXISTS chain_step_overrides_select ON public.chain_step_overrides;
CREATE POLICY chain_step_overrides_select
  ON public.chain_step_overrides FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- INSERT is service-role only (admin-override-step edge function
-- writes these). The function enforces the workspace-admin gate
-- before the INSERT.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. chain_step_voluntary_delegations
-- ─────────────────────────────────────────────────────────────────────────
--
-- Soft-delete columns (revoked_at, revoked_by) added beyond the spec's
-- minimal table definition because §"revoke-voluntary-delegation"
-- explicitly says "soft delete via additional columns: revoked_at,
-- revoked_by." Capturing them here keeps the schema cohesive.

CREATE TABLE IF NOT EXISTS public.chain_step_voluntary_delegations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_step_id            uuid NOT NULL REFERENCES public.lease_approval_chain(id) ON DELETE CASCADE,
  lease_id                 uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id             uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  delegated_by             uuid NOT NULL REFERENCES auth.users(id),
  delegated_to             uuid NOT NULL REFERENCES auth.users(id),
  delegated_at             timestamptz NOT NULL DEFAULT now(),
  reason                   text,
  revoked_at               timestamptz,
  revoked_by               uuid REFERENCES auth.users(id),
  CONSTRAINT vd_no_self_delegation CHECK (delegated_by <> delegated_to)
);

CREATE INDEX IF NOT EXISTS idx_voluntary_delegations_step
  ON public.chain_step_voluntary_delegations(chain_step_id);

-- Active voluntary delegation lookup (per-step, only un-revoked)
CREATE INDEX IF NOT EXISTS idx_voluntary_delegations_active
  ON public.chain_step_voluntary_delegations(chain_step_id, delegated_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.chain_step_voluntary_delegations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voluntary_delegations_select ON public.chain_step_voluntary_delegations;
CREATE POLICY voluntary_delegations_select
  ON public.chain_step_voluntary_delegations FOR SELECT
  TO authenticated
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
  ));

-- INSERT is service-role only (voluntary-delegate-step edge function);
-- UPDATE is service-role only (revoke-voluntary-delegation soft-deletes).

-- ─────────────────────────────────────────────────────────────────────────
-- 4. lease_approval_chain new columns
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lease_approval_chain
  ADD COLUMN IF NOT EXISTS pending_since        timestamptz,
  ADD COLUMN IF NOT EXISTS delegate_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS effective_assignee_user_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS assignee_resolution_source text;

-- CHECK on assignee_resolution_source via DROP/ADD pattern. The CHECK
-- is permissive: NULL is allowed for chain rows that pre-date Phase 7
-- (existing rows have NULL values that the spec contract allows).
ALTER TABLE public.lease_approval_chain
  DROP CONSTRAINT IF EXISTS lease_approval_chain_assignee_source_check;
ALTER TABLE public.lease_approval_chain
  ADD CONSTRAINT lease_approval_chain_assignee_source_check
  CHECK (
    assignee_resolution_source IS NULL OR
    assignee_resolution_source IN (
      'policy_user', 'policy_role', 'policy_delegate',
      'ooo_delegate', 'voluntary_delegate', 'admin_reassign'
    )
  );

-- Helpful index for the process-delegate-timers cron query:
-- pending steps with a delegate configured but not yet activated.
CREATE INDEX IF NOT EXISTS idx_chain_pending_delegate_timer
  ON public.lease_approval_chain(pending_since)
  WHERE status = 'pending'
    AND delegate_user_id IS NOT NULL
    AND delegate_after_days IS NOT NULL
    AND delegate_activated_at IS NULL;

-- Helpful index for the detect-stuck-chains cron query:
-- pending steps with a non-null pending_since.
CREATE INDEX IF NOT EXISTS idx_chain_pending_since
  ON public.lease_approval_chain(pending_since)
  WHERE status = 'pending' AND pending_since IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. activity_type CHECK extension — append 13 Phase 7 values
-- ─────────────────────────────────────────────────────────────────────────
--
-- Snapshot of the live constraint at Phase 7 C1 time (2026-05-06) is
-- the authoritative starting point. Phase 7 appends 13 values at the
-- end. Live snapshot includes all Phase 6 additions; do not lose them.

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
    -- Phase 7 additions
    'step_pending_started',
    'delegate_timer_started',
    'delegate_activated',
    'voluntary_delegation_created',
    'voluntary_delegation_revoked',
    'admin_override_executed',
    'ooo_declared',
    'ooo_revoked',
    'ooo_routed_step',
    'stuck_chain_detected',
    'stuck_chain_resolved',
    'deactivated_approver_reassigned',
    'policy_assignee_validation_failed'
  ));

COMMIT;
