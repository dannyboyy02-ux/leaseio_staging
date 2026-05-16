-- ============================================================
-- PHASE 4: Executed Record & Variance Report
-- ============================================================

-- ------------------------------------------------------------
-- 1. Create executed-leases storage bucket
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'executed-leases',
  'executed-leases',
  false,
  52428800,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Add executed_*, variance_*, model_locked_* columns to leases
-- ------------------------------------------------------------
ALTER TABLE leases
  -- Executed document
  ADD COLUMN IF NOT EXISTS executed_document_url     text,
  ADD COLUMN IF NOT EXISTS executed_storage_path     text,
  ADD COLUMN IF NOT EXISTS executed_filename         text,
  ADD COLUMN IF NOT EXISTS executed_extracted_json   jsonb,
  ADD COLUMN IF NOT EXISTS executed_extraction_confidence jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS executed_uploaded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS executed_uploaded_by      uuid REFERENCES auth.users(id),
  -- Executed core terms
  ADD COLUMN IF NOT EXISTS executed_monthly_payment  numeric,
  ADD COLUMN IF NOT EXISTS executed_commencement_date date,
  ADD COLUMN IF NOT EXISTS executed_expiry_date      date,
  ADD COLUMN IF NOT EXISTS executed_tenant_name      text,
  ADD COLUMN IF NOT EXISTS executed_landlord_name    text,
  ADD COLUMN IF NOT EXISTS executed_rent_review_clause text,
  ADD COLUMN IF NOT EXISTS executed_break_clause     text,
  -- Variance fields
  ADD COLUMN IF NOT EXISTS variance_monthly_payment       numeric,
  ADD COLUMN IF NOT EXISTS variance_commencement_days     integer,
  ADD COLUMN IF NOT EXISTS variance_expiry_days           integer,
  ADD COLUMN IF NOT EXISTS variance_tenant_name_match     boolean,
  ADD COLUMN IF NOT EXISTS variance_landlord_name_match   boolean,
  ADD COLUMN IF NOT EXISTS variance_reviewed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS variance_reviewed_by           uuid REFERENCES auth.users(id),
  -- Model lock
  ADD COLUMN IF NOT EXISTS model_locked    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS model_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS model_locked_by uuid REFERENCES auth.users(id);

-- ------------------------------------------------------------
-- 3. Create executed_term_edits table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS executed_term_edits (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id      uuid        NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  field_name    text        NOT NULL,
  original_value text,
  edited_value  text,
  edited_by     uuid        NOT NULL REFERENCES auth.users(id),
  edited_at     timestamptz NOT NULL DEFAULT now(),
  reason        text
);

ALTER TABLE executed_term_edits ENABLE ROW LEVEL SECURITY;

-- Workspace members can view edits for leases they can access
CREATE POLICY "workspace_members_select_term_edits"
  ON executed_term_edits FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      WHERE l.id = executed_term_edits.lease_id
        AND (
          l.user_id = auth.uid()
          OR is_workspace_member(l.workspace_id, auth.uid())
        )
    )
  );

-- Only financial_approver or admin can insert term edits
CREATE POLICY "financial_approver_insert_term_edits"
  ON executed_term_edits FOR INSERT
  WITH CHECK (
    edited_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM leases l
      JOIN workspace_roles wr
        ON wr.workspace_id = l.workspace_id
       AND wr.user_id = auth.uid()
      WHERE l.id = executed_term_edits.lease_id
        AND wr.role IN ('financial_approver', 'admin')
    )
  );

-- ------------------------------------------------------------
-- 4. Storage RLS policies for executed-leases bucket
-- ------------------------------------------------------------

-- Authenticated users can upload to executed-leases
CREATE POLICY "authenticated_upload_executed_leases"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'executed-leases');

-- Authenticated users can read from executed-leases
CREATE POLICY "authenticated_read_executed_leases"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'executed-leases');

-- Authenticated users can delete their own executed-leases objects
CREATE POLICY "authenticated_delete_executed_leases"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'executed-leases' AND owner = auth.uid());

-- ------------------------------------------------------------
-- 5. Model-lock immutability trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_locked_lease_edits()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.model_locked = true THEN
    IF (
      NEW.executed_monthly_payment      IS DISTINCT FROM OLD.executed_monthly_payment      OR
      NEW.executed_commencement_date    IS DISTINCT FROM OLD.executed_commencement_date    OR
      NEW.executed_expiry_date          IS DISTINCT FROM OLD.executed_expiry_date          OR
      NEW.executed_tenant_name          IS DISTINCT FROM OLD.executed_tenant_name          OR
      NEW.executed_landlord_name        IS DISTINCT FROM OLD.executed_landlord_name        OR
      NEW.executed_rent_review_clause   IS DISTINCT FROM OLD.executed_rent_review_clause   OR
      NEW.executed_break_clause         IS DISTINCT FROM OLD.executed_break_clause         OR
      NEW.executed_extracted_json       IS DISTINCT FROM OLD.executed_extracted_json       OR
      NEW.variance_monthly_payment      IS DISTINCT FROM OLD.variance_monthly_payment      OR
      NEW.variance_commencement_days    IS DISTINCT FROM OLD.variance_commencement_days    OR
      NEW.variance_expiry_days          IS DISTINCT FROM OLD.variance_expiry_days          OR
      NEW.variance_tenant_name_match    IS DISTINCT FROM OLD.variance_tenant_name_match    OR
      NEW.variance_landlord_name_match  IS DISTINCT FROM OLD.variance_landlord_name_match
    ) THEN
      RAISE EXCEPTION 'Cannot modify executed or variance fields on a locked lease record (model_locked = true)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_model_lock ON leases;
CREATE TRIGGER enforce_model_lock
  BEFORE UPDATE ON leases
  FOR EACH ROW EXECUTE FUNCTION prevent_locked_lease_edits();

-- ------------------------------------------------------------
-- 6. Indexes
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leases_model_locked
  ON leases(model_locked) WHERE model_locked = true;

CREATE INDEX IF NOT EXISTS idx_leases_lifecycle_status
  ON leases(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_executed_term_edits_lease_id
  ON executed_term_edits(lease_id);
