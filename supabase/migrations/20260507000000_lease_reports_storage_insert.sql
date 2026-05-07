-- ─────────────────────────────────────────────────────────────────────────
-- Lease-reports storage RLS — allow client-side PDF upload
-- ─────────────────────────────────────────────────────────────────────────
--
-- Phase 8 migration (20260506200000) authored a SELECT-only RLS policy
-- on storage.objects for the lease-reports bucket and explicitly
-- documented "Insert is service-role-only (the edge function does the
-- upload after generating the artifact)". That assumption was correct
-- at the time of writing the migration but wrong by Phase 8 C3 — when
-- the architecture flipped to client-side PDF rendering (As-built A1
-- in PHASE_8_BUILD_SPEC.md): @react-pdf/renderer cannot run reliably
-- in Deno, so the client renders the PDF in the browser and uploads
-- it via supabase-js. The storage RLS was never updated to match,
-- which produced the 400 every report-PDF upload was hitting:
--
--   POST /storage/v1/object/lease-reports/{ws}/{report}/report.pdf
--   → 400 (no INSERT policy permits the request)
--
-- This migration adds INSERT + UPDATE policies scoped to:
--   1. The lease-reports bucket
--   2. A path whose first folder matches a workspace the user is a
--      member of OR owns
--   3. A path whose second folder matches an existing lease_reports
--      row id in that workspace
--
-- Constraint #3 prevents an authenticated user from dumping arbitrary
-- objects into the bucket — they can only upload PDFs against rows
-- that already exist (created by the edge function with status='ready').

-- ─── INSERT — authenticated user uploads PDF for a report they can see ────
DROP POLICY IF EXISTS "workspace members upload lease-reports" ON storage.objects;
CREATE POLICY "workspace members upload lease-reports"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'lease-reports'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE lr.id::text = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
    )
  );

-- ─── UPDATE — required so supabase-js .upload({ upsert: true }) works ─────
-- supabase-js's upsert performs an UPSERT under the hood; without UPDATE
-- the second-attempt path on a path that already has a row will 400.
DROP POLICY IF EXISTS "workspace members update lease-reports" ON storage.objects;
CREATE POLICY "workspace members update lease-reports"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'lease-reports'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE lr.id::text = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
    )
  )
  WITH CHECK (
    bucket_id = 'lease-reports'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE lr.id::text = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
    )
  );
