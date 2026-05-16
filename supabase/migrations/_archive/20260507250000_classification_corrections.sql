-- Tier 2 Phase 4: in-context learning from classification corrections
--
-- Append-only table that captures every time a workspace member
-- corrects the AI classifier's output. Workspace-scoped (RLS); the
-- corrections never cross workspace boundaries.
--
-- The classifier (callHaikuForClassification in process_lease) reads
-- the most recent N corrections for the workspace and injects them
-- as few-shot examples in the system prompt. This produces
-- per-workspace classification tuning at zero retraining cost — same
-- in-context augmentation pattern as the existing risk_templates
-- watchlist that's already shipped in extractLeaseDataWithClaude.
--
-- NOT a model-fine-tuning store. Anthropic's Claude is never
-- retrained from this data. The data influences Claude's behavior
-- only via prompt-context for THIS workspace's future calls.

CREATE TABLE IF NOT EXISTS public.classification_corrections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Optional reference to the lease this correction was made on. ON
  -- DELETE SET NULL because the correction's signal value persists
  -- even if the original lease record is deleted.
  lease_id                 uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  -- The classifier's original output (full Tier2Classification
  -- jsonb: is_lease, confidence, asset_type, lease_type, reason).
  original_classification  jsonb NOT NULL,
  -- The corrected fields (subset; only the fields the user changed).
  corrected_classification jsonb NOT NULL,
  -- Filterable correction-type label.
  correction_type          text NOT NULL CHECK (correction_type IN (
    'is_lease_override',     -- "this IS a lease" override (Phase 5)
    'asset_type_changed',    -- user changed asset_type
    'lease_type_changed',    -- user changed master/amendment
    'parent_lease_changed',  -- user picked a different parent than suggested
    'general_correction'     -- catch-all for v1 manual corrections
  )),
  -- Optional human-readable rationale ("This is actually a sublease,
  -- not a master lease"). Plumbed into the few-shot prompt so the
  -- classifier learns the team's reasoning, not just the verdict.
  user_note                text,
  -- Lightweight document summary (filename + a few extracted fields
  -- for prompt context). Workspace-internal data only — same scope
  -- as everything else this workspace's classifier sees.
  document_summary         text,
  corrected_by             uuid REFERENCES auth.users(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_corrections_workspace_recent
  ON public.classification_corrections(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_classification_corrections_lease
  ON public.classification_corrections(lease_id, created_at DESC)
  WHERE lease_id IS NOT NULL;

ALTER TABLE public.classification_corrections ENABLE ROW LEVEL SECURITY;

-- Workspace members read corrections (so the UI can show "this
-- workspace has corrected X classifications, contributing to better
-- accuracy" or similar).
DROP POLICY IF EXISTS "workspace members read corrections" ON public.classification_corrections;
CREATE POLICY "workspace members read corrections"
  ON public.classification_corrections FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- No direct client inserts. The record-classification-correction
-- edge function is the only writer; it runs as service-role and
-- explicitly checks workspace-membership of the actor before insert.
DROP POLICY IF EXISTS "no direct inserts from clients" ON public.classification_corrections;
CREATE POLICY "no direct inserts from clients"
  ON public.classification_corrections FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- Append-only: deny UPDATE and DELETE entirely from authenticated
-- callers (service role bypasses RLS, but no application code
-- updates or deletes either).
DROP POLICY IF EXISTS "no client updates" ON public.classification_corrections;
CREATE POLICY "no client updates"
  ON public.classification_corrections FOR UPDATE
  TO authenticated
  USING (false);

DROP POLICY IF EXISTS "no client deletes" ON public.classification_corrections;
CREATE POLICY "no client deletes"
  ON public.classification_corrections FOR DELETE
  TO authenticated
  USING (false);
