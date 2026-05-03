-- Phase 2 — Resolution engine + chain table
-- See docs/PHASE_2_BUILD_SPEC.md for full context.
--
-- This migration is purely additive:
--   - Creates lease_approval_chain (concrete per-lease approval chain rows
--     resolved from approval_policies at submission time)
--   - Extends lease_activity_log.activity_type CHECK to add 6 chain-related
--     activity types
--
-- The legacy parallel manager_approver / financial_approver flow stays
-- intact — workspaces with no policies fall back to it via the resolution
-- function's `legacyFallback: true` response (built in Checkpoint 2).
--
-- Idempotent: safe on environments that already have these objects, and on
-- fresh ones. Per the schema-change rule in CLAUDE.md, this .sql lives in
-- supabase/migrations/ as the source of truth.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. lease_approval_chain table
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_approval_chain (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id             uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  policy_id                uuid REFERENCES public.approval_policies(id),
  policy_version           integer,
  stage                    text NOT NULL CHECK (stage IN ('concept', 'signator')),
  step_order               integer NOT NULL,
  parallel_group           integer NOT NULL DEFAULT 1,
  approver_user_id         uuid REFERENCES auth.users(id),
  approver_role            text,
  delegate_user_id         uuid REFERENCES auth.users(id),
  delegate_after_days      integer,
  is_required              boolean NOT NULL DEFAULT true,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'sent_back', 'superseded', 'delegated', 'skipped')),
  action_at                timestamptz,
  action_by                uuid REFERENCES auth.users(id),
  comment                  text,
  rerouted_from_chain_id   uuid REFERENCES public.lease_approval_chain(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_assignee_present CHECK (
    approver_user_id IS NOT NULL OR approver_role IS NOT NULL
  )
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Indexes
-- ───────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_lease
  ON public.lease_approval_chain(lease_id, stage, step_order);

CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_assignee_pending
  ON public.lease_approval_chain(approver_user_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lease_approval_chain_workspace_pending
  ON public.lease_approval_chain(workspace_id, status)
  WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
--
-- INSERT: no policy for `authenticated` — only the resolve-approval-chain
--   edge function (service role) inserts rows. Service role bypasses RLS.
-- UPDATE to status='superseded': only the service role (admin client used
--   inside the edge functions on reject/send_back) writes this. The
--   assignee policy's WITH CHECK clause explicitly excludes it.
-- DELETE: no policy. Chain rows are part of the audit history; never
--   user-deletable. Lease deletion CASCADEs them.

ALTER TABLE public.lease_approval_chain ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read chain" ON public.lease_approval_chain;
CREATE POLICY "workspace members read chain"
  ON public.lease_approval_chain FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "assignee acts on own pending step" ON public.lease_approval_chain;
CREATE POLICY "assignee acts on own pending step"
  ON public.lease_approval_chain FOR UPDATE
  USING (
    status = 'pending'
    AND (
      approver_user_id = auth.uid()
      OR (
        approver_role IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.workspace_roles wr
          WHERE wr.workspace_id = lease_approval_chain.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role = lease_approval_chain.approver_role
        )
      )
    )
  )
  WITH CHECK (
    -- action_by must equal the acting user (no impersonation)
    action_by = auth.uid()
    -- and the new status must be one of the assignee-action terminals
    AND status IN ('approved', 'rejected', 'sent_back')
  );

DROP POLICY IF EXISTS "admins update chain in workspace" ON public.lease_approval_chain;
CREATE POLICY "admins update chain in workspace"
  ON public.lease_approval_chain FOR UPDATE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Extend lease_activity_log.activity_type CHECK
-- ───────────────────────────────────────────────────────────────────────────
--
-- The live constraint (queried 2026-05-02) contains the 24 existing values
-- listed below. Per CLAUDE.md schema-change rule and the spec's instruction
-- to "preserve every existing value when extending," all 24 are reproduced
-- verbatim, with the 6 Phase 2 additions appended.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Pre-Phase-2 values (live as of 2026-05-02)
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
    'chain_resolution_failed'
  ));
