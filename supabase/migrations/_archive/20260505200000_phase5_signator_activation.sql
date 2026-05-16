-- Phase 5 — Signator Stage Activation and Counter-Signature
-- See docs/PHASE_5_BUILD_SPEC.md for the full contract.
--
-- Purely additive:
--   1. Three new lease columns:
--      - signator_attestation        (text, captured at signator approval)
--      - counter_signature_due_date  (date, populated when entering
--                                     pending_counter_signature)
--      - counter_signature_reminder_count (int, increments per reminder)
--   2. One new workspace column:
--      - counter_signature_default_due_days (int 1..365, default 21)
--      Drives the default due date when a lease enters
--      pending_counter_signature.
--   3. Row-level CHECK on leases enforcing that signator_approved_at
--      cannot be set without signator_attestation. Highest-stakes
--      contract-liability protection layer per the spec.
--   4. lease_activity_log.activity_type CHECK extended with the 7
--      Phase 5 transition activity types. Live constraint snapshot
--      (queried 2026-05-05 via pg_get_constraintdef) captured all 41
--      pre-existing values verbatim.
--
-- Per the schema-change rule in CLAUDE.md, this .sql is the source of
-- truth. Idempotent via IF NOT EXISTS / DROP-then-ADD.

-- ───────────────────────────────────────────────────────────────────────
-- 1. New lease columns
-- ───────────────────────────────────────────────────────────────────────
--
-- All nullable except counter_signature_reminder_count which has a
-- NOT NULL DEFAULT 0 — every lease starts with zero reminders sent and
-- the column is incremented in place by the reminder edge function.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS signator_attestation       text,
  ADD COLUMN IF NOT EXISTS counter_signature_due_date date,
  ADD COLUMN IF NOT EXISTS counter_signature_reminder_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.leases.signator_attestation IS
  'Free-text attestation captured at signator approval. Required (per CHECK constraint) when signator_approved_at is set. Becomes part of the audit trail.';
COMMENT ON COLUMN public.leases.counter_signature_due_date IS
  'Date by which the counter-signed document is expected. Populated when the lease enters pending_counter_signature. Drives the reminder cadence.';
COMMENT ON COLUMN public.leases.counter_signature_reminder_count IS
  'Number of reminders sent for counter-signature. Incremented by send-counter-signature-reminder edge function; used for idempotency + escalation.';

-- ───────────────────────────────────────────────────────────────────────
-- 2. Workspace setting
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS counter_signature_default_due_days integer NOT NULL DEFAULT 21;

-- Range CHECK — added separately so this migration can re-run cleanly
-- against environments where the column already exists without the CHECK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workspaces_counter_signature_due_days_range'
       AND conrelid = 'public.workspaces'::regclass
  ) THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_counter_signature_due_days_range
      CHECK (counter_signature_default_due_days BETWEEN 1 AND 365);
  END IF;
END $$;

COMMENT ON COLUMN public.workspaces.counter_signature_default_due_days IS
  'Default number of days from signator approval until counter-signed document is expected. Used by act-on-chain-step to compute counter_signature_due_date when transitioning a lease to pending_counter_signature.';

-- ───────────────────────────────────────────────────────────────────────
-- 3. Row-level CHECK: signator_approved_at requires signator_attestation
-- ───────────────────────────────────────────────────────────────────────
--
-- Defense in depth alongside the act-on-chain-step edge function's
-- payload validation. If the edge function ever has a bug that lets
-- an empty attestation through, this CHECK is the last line of
-- defense. It also blocks any direct DB write that would attempt to
-- set signator_approved_at without an attestation.
--
-- Both null is allowed (lease hasn't reached signator approval yet).
-- Both populated is allowed (post-signator-approval state).
-- signator_approved_at populated WITHOUT attestation is the
-- forbidden state.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'leases_signator_attestation_required'
       AND conrelid = 'public.leases'::regclass
  ) THEN
    ALTER TABLE public.leases
      ADD CONSTRAINT leases_signator_attestation_required
      CHECK (
        signator_approved_at IS NULL
        OR (
          signator_approved_at IS NOT NULL
          AND signator_attestation IS NOT NULL
          AND length(trim(signator_attestation)) > 0
        )
      );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- 4. lease_activity_log.activity_type CHECK extension
-- ───────────────────────────────────────────────────────────────────────
--
-- Live snapshot (queried 2026-05-05) accepts 41 values:
--   24 pre-Phase-2 + 6 Phase 2 + 6 Phase 3 + 5 Phase 4
-- Phase 5 adds 7 transition-related activity types. All 41 prior
-- values preserved verbatim from the snapshot.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Pre-Phase-2 (24, live snapshot)
    'status_change',
    'approval',
    'rejection',
    'send_back',
    'pause',
    'nudge_sent',
    'document_upload',
    'created',
    'comment',
    'executed_uploaded',
    'executed_terms_extracted',
    'unlock_approved',
    'unlock_requested',
    'change_canceled',
    'change_set_submitted',
    'change_set_approved',
    'change_set_rejected',
    'change_set_self_approved',
    'risk_dismissed',
    'risk_restored',
    'risk_added',
    'change_submitted',
    'change_approved',
    'change_rejected',
    -- Phase 2 (6)
    'chain_resolved',
    'chain_step_approved',
    'chain_step_rejected',
    'chain_step_sent_back',
    'chain_stage_completed',
    'chain_resolution_failed',
    -- Phase 3 (6)
    'concept_stage_entered',
    'concept_stage_completed',
    'negotiation_stage_entered',
    'final_review_stage_entered',
    'pending_counter_signature_started',
    'fully_executed_recorded',
    -- Phase 4 (5)
    'document_iteration_uploaded',
    'document_iteration_superseded',
    'negotiation_escalated_to_concept',
    'document_marked_final_negotiated',
    'document_lineage_corrected',
    -- Phase 5 additions (7)
    'signator_attestation_recorded',
    'counter_signature_reminder_sent',
    'counter_signature_overdue',
    'counter_signature_received',
    'execution_owner_assigned',
    'execution_owner_reassigned',
    'final_review_returned_to_negotiation'
  ));
