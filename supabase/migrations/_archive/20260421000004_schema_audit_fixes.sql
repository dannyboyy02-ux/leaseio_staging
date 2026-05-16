-- =============================================================================
-- Schema audit remediation — three confirmed issues
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fix 1: Create risks table
--
-- The risks table exists in production (created via Supabase dashboard) and is
-- referenced by RLS policies in 20260305225810_security_rls_hardening.sql, but
-- no CREATE TABLE exists in migrations. Adding it here so the migration chain
-- is complete and the table can be reproduced from scratch.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.risks (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id         UUID        NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  severity         TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  explanation      TEXT        NOT NULL,
  citation_snippet TEXT,
  citation_page    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS risks_lease_id_idx ON public.risks (lease_id);

ALTER TABLE public.risks ENABLE ROW LEVEL SECURITY;

-- Re-create RLS policies idempotently (originals in security_rls_hardening may
-- already exist; DROP IF EXISTS + re-create is safe to run twice).
DROP POLICY IF EXISTS "risks_select" ON public.risks;
CREATE POLICY "risks_select" ON public.risks
  FOR SELECT USING (
    lease_id IN (
      SELECT id FROM public.leases
      WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "risks_insert" ON public.risks;
CREATE POLICY "risks_insert" ON public.risks
  FOR INSERT WITH CHECK (
    lease_id IN (
      SELECT id FROM public.leases
      WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "risks_update" ON public.risks;
CREATE POLICY "risks_update" ON public.risks
  FOR UPDATE USING (
    lease_id IN (
      SELECT id FROM public.leases
      WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "risks_delete" ON public.risks;
CREATE POLICY "risks_delete" ON public.risks
  FOR DELETE USING (
    lease_id IN (
      SELECT id FROM public.leases
      WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- Fix 2: Extend activity_type CHECK constraint
--
-- process_lease writes 'executed_uploaded' and 'executed_terms_extracted' to
-- lease_activity_log, but those values are not in the original CHECK constraint.
-- The constraint must be dropped and re-created.
-- -----------------------------------------------------------------------------
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
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
    'executed_terms_extracted'
  ));

-- -----------------------------------------------------------------------------
-- Fix 3: Correct intake_source backfill
--
-- Migration 20260330000001 referenced non-existent table 'lease_approvals'
-- (correct name: 'lease_approval_actions'), so the backfill that marks
-- request_workflow leases never ran. Applying the correct backfill here.
-- -----------------------------------------------------------------------------
UPDATE public.leases
SET intake_source = 'request_workflow'
WHERE intake_source = 'manual_upload'
  AND lifecycle_status IS NOT NULL
  AND lifecycle_status NOT IN ('draft')
  AND id IN (
    SELECT DISTINCT lease_id FROM public.lease_approval_actions
  );
