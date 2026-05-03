-- Phase 3 — Lifecycle Expansion
-- See docs/PHASE_3_BUILD_SPEC.md for full context.
--
-- Purely additive:
--   1. Extend leases.lifecycle_status CHECK to add 7 new chain-vocabulary
--      states. All 9 legacy values preserved.
--   2. Add 5 new nullable columns to leases for stage-specific timestamps
--      and the execution-owner FK.
--   3. Extend lease_activity_log.activity_type CHECK to add 6 Phase 3
--      transition activity types. All Phase 1+2 values preserved.
--
-- The chain workflow (Phase 2) is updated separately to start writing the
-- new states for chain-driven leases. Legacy fallback leases keep using
-- legacy states. Both vocabularies coexist permanently.
--
-- Per the schema-change rule in CLAUDE.md, this .sql lives in
-- supabase/migrations/ as the source of truth. Idempotent via IF EXISTS /
-- IF NOT EXISTS / DROP-then-ADD.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. leases.lifecycle_status CHECK extension
-- ───────────────────────────────────────────────────────────────────────────
--
-- Live constraint (queried 2026-05-03) accepts these 9 legacy values:
--   draft, submitted, under_review, approved, executed, active, expired,
--   rejected, cancelled
-- Phase 3 adds 7 chain-vocabulary states. All 9 legacy values preserved
-- verbatim below.

ALTER TABLE public.leases
  DROP CONSTRAINT IF EXISTS leases_lifecycle_status_check;

ALTER TABLE public.leases
  ADD CONSTRAINT leases_lifecycle_status_check
  CHECK (lifecycle_status IN (
    -- Legacy states (preserved verbatim from live constraint)
    'draft',
    'submitted',
    'under_review',
    'approved',
    'executed',
    'active',
    'expired',
    'rejected',
    'cancelled',
    -- Phase 3 chain-vocabulary additions
    'concept_submitted',
    'concept_under_review',
    'in_negotiation',
    'final_review',
    'pending_counter_signature',
    'fully_executed',
    'chain_violation'
  ));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. leases — new stage-timestamp columns + execution_owner_id FK
-- ───────────────────────────────────────────────────────────────────────────
--
-- All nullable. Populated as a chain-driven lease progresses through the
-- new lifecycle. Phase 5+ are the primary writers; columns added now so
-- chain code can reference them without schema churn later.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS concept_approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS signator_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS counter_signed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS fully_executed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS execution_owner_id   uuid REFERENCES auth.users(id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. lease_activity_log.activity_type CHECK extension
-- ───────────────────────────────────────────────────────────────────────────
--
-- Live constraint (queried 2026-05-03) accepts 30 values: 24 pre-Phase-2 +
-- 6 Phase 2 chain_* values. The Phase 3 spec's listing under "Phase 3
-- additions to activity_type" includes a few values that aren't in the
-- live constraint (model_locked, unlock_rejected) — same drift Phase 2
-- already reconciled. Live constraint is the source of truth; preserve
-- all 30 values verbatim and append only the 6 Phase 3 transition
-- activities.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Pre-Phase-2 values (live as of 2026-05-03)
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
    -- Phase 2 additions
    'chain_resolved',
    'chain_step_approved',
    'chain_step_rejected',
    'chain_step_sent_back',
    'chain_stage_completed',
    'chain_resolution_failed',
    -- Phase 3 additions
    'concept_stage_entered',
    'concept_stage_completed',
    'negotiation_stage_entered',
    'final_review_stage_entered',
    'pending_counter_signature_started',
    'fully_executed_recorded'
  ));
