-- Phase 4 — Negotiation Document Tracking
-- See docs/PHASE_4_BUILD_SPEC.md (committed as <SHA>) for the full
-- contract.
--
-- Purely additive:
--   1. New public.lease_documents table (one row per uploaded document
--      iteration) with a unique partial index that lets at most ONE row
--      per lease have is_current_latest = true.
--   2. New 'lease-documents' storage bucket (private, 50MB limit, no
--      mime-type restriction — redlines arrive as .docx as often as
--      .pdf).
--   3. RLS on lease_documents: workspace members read; submitters +
--      admins insert; admins update/delete.
--   4. RLS on storage.objects scoped to the new bucket: workspace
--      members upload + read; admins delete. Tighter than the legacy
--      executed-leases bucket which is authenticated-anyone — Phase 4
--      ships the modern shape.
--   5. AFTER INSERT trigger maintains is_current_latest: new row gets
--      true, prior latest gets false + superseded_by + superseded_at.
--   6. lease_activity_log activity_type CHECK extended with the 5
--      Phase 4 additions (live constraint snapshot was the authoritative
--      starting point — spec's listing diverged on a few values).
--
-- Per the schema-change rule in CLAUDE.md, this .sql is the source of
-- truth. Idempotent via IF NOT EXISTS / DROP-then-CREATE.

-- ───────────────────────────────────────────────────────────────────────
-- 1. lease_documents table
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_type       text NOT NULL CHECK (document_type IN (
    'concept_attachment',
    'loi',
    'draft',
    'redline',
    'counter_redline',
    'final_negotiated',
    'our_signed',
    'fully_executed_counterparty_returned',
    'amendment',
    'side_letter',
    'other'
  )),
  iteration_number    integer NOT NULL,
  version_number      integer NOT NULL,
  storage_path        text NOT NULL,
  filename            text NOT NULL,
  mime_type           text,
  file_size_bytes     bigint,
  uploaded_by         uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  notes               text,
  is_current_latest   boolean NOT NULL DEFAULT false,
  superseded_by       uuid REFERENCES public.lease_documents(id),
  superseded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_documents_lease_chronological
  ON public.lease_documents(lease_id, iteration_number, version_number);

CREATE INDEX IF NOT EXISTS idx_lease_documents_workspace
  ON public.lease_documents(workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_documents_one_current_latest_per_lease
  ON public.lease_documents(lease_id)
  WHERE is_current_latest = true;

COMMENT ON TABLE public.lease_documents IS
  'One row per uploaded document iteration. is_current_latest flag is maintained by the AFTER INSERT trigger; application code never sets it directly.';

-- ───────────────────────────────────────────────────────────────────────
-- 2. lease-documents storage bucket
-- ───────────────────────────────────────────────────────────────────────
--
-- 50MB limit matches executed-leases. No mime-type restriction —
-- redlines arrive as .docx, signed copies as .pdf, occasionally
-- Word/RTF or images of marked-up paper.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('lease-documents', 'lease-documents', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────
-- 3. RLS on public.lease_documents
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.lease_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read documents" ON public.lease_documents;
CREATE POLICY "workspace members read documents"
  ON public.lease_documents FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "submitters and admins write documents" ON public.lease_documents;
CREATE POLICY "submitters and admins write documents"
  ON public.lease_documents FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND uploaded_by = auth.uid()
    AND lease_id IN (
      SELECT id FROM public.leases WHERE workspace_id = lease_documents.workspace_id
    )
  );

DROP POLICY IF EXISTS "admins manage documents" ON public.lease_documents;
CREATE POLICY "admins manage documents"
  ON public.lease_documents FOR UPDATE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "admins delete documents" ON public.lease_documents;
CREATE POLICY "admins delete documents"
  ON public.lease_documents FOR DELETE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ───────────────────────────────────────────────────────────────────────
-- 4. RLS on storage.objects, scoped to lease-documents bucket
-- ───────────────────────────────────────────────────────────────────────
--
-- The lease_documents row is created BEFORE the storage upload
-- completes (frontend convention: insert metadata, then upload bytes,
-- with rollback on upload failure). So the EXISTS subquery against
-- lease_documents always finds the row when storage RLS evaluates.

DROP POLICY IF EXISTS "workspace members upload to lease-documents" ON storage.objects;
CREATE POLICY "workspace members upload to lease-documents"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'lease-documents'
    AND owner = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

DROP POLICY IF EXISTS "workspace members read lease-documents" ON storage.objects;
CREATE POLICY "workspace members read lease-documents"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lease-documents'
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

DROP POLICY IF EXISTS "admins delete from lease-documents" ON storage.objects;
CREATE POLICY "admins delete from lease-documents"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'lease-documents'
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
              WHERE user_id = auth.uid() AND role = 'admin'
          )
        )
    )
  );

-- ───────────────────────────────────────────────────────────────────────
-- 5. is_current_latest maintenance trigger
-- ───────────────────────────────────────────────────────────────────────
--
-- The trigger fires AFTER INSERT and is the SOLE writer of
-- is_current_latest. Application code inserts with is_current_latest =
-- false (the column default); the trigger flips the new row to true
-- and demotes the prior latest with superseded_by + superseded_at.
--
-- Why AFTER INSERT (not BEFORE INSERT or a partial unique constraint
-- alone): a BEFORE trigger would race the unique partial index check
-- if two concurrent inserts both tried to set is_current_latest=true
-- atomically. With AFTER INSERT and the demotion-then-promotion
-- sequence, the unique index serializes correctly: the first INSERT
-- wins; concurrent inserters' triggers fire in a deterministic
-- order, with each demoting whatever was previously latest.

CREATE OR REPLACE FUNCTION public.maintain_lease_document_latest_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mark prior latest as superseded by this new row
  UPDATE public.lease_documents
     SET is_current_latest = false,
         superseded_by = NEW.id,
         superseded_at = now()
   WHERE lease_id = NEW.lease_id
     AND id <> NEW.id
     AND is_current_latest = true;

  -- Promote the new row to latest
  UPDATE public.lease_documents
     SET is_current_latest = true
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lease_documents_latest_flag ON public.lease_documents;
CREATE TRIGGER lease_documents_latest_flag
  AFTER INSERT ON public.lease_documents
  FOR EACH ROW EXECUTE FUNCTION public.maintain_lease_document_latest_flag();

-- ───────────────────────────────────────────────────────────────────────
-- 6. lease_activity_log.activity_type CHECK extension
-- ───────────────────────────────────────────────────────────────────────
--
-- Live constraint (queried 2026-05-05) accepts 36 values:
--   24 pre-Phase-2 + 6 Phase 2 + 6 Phase 3
-- Phase 4 adds 5 transition-related activity types. All 36 prior
-- values preserved verbatim from the live snapshot — the spec's
-- listing diverged on a few values that aren't actually in the live
-- constraint (model_locked, unlock_rejected) so we use the live
-- constraint as the authoritative starting point.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Pre-Phase-2 (24, live snapshot 2026-05-05)
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
    -- Phase 4 additions (5)
    'document_iteration_uploaded',
    'document_iteration_superseded',
    'negotiation_escalated_to_concept',
    'document_marked_final_negotiated',
    'document_lineage_corrected'
  ));
