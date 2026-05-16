-- ============================================================
-- lease_reports_storage_finalization_guard (P1-06)
--
-- Per audit P1-06 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- the lease-reports storage INSERT/UPDATE policies from migration
-- 20260507000000 allowed ANY workspace member to upload or overwrite
-- the PDF object at {workspace_id}/{report_id}/report.pdf. The
-- finalize-report-pdf edge function correctly restricts the
-- lease_reports.pdf_storage_path PATCH to the original generator,
-- workspace owner, or workspace admin — but the storage layer wasn't
-- aligned, so a non-admin member could:
--   1. SELECT the report row (allowed by phase8's read policy)
--   2. Take the report_id + workspace_id
--   3. Call supabase-js .upload({ upsert: true }) against the
--      canonical path with malicious content
--   4. The existing UPDATE storage policy passes because they're a
--      workspace member and the path matches an existing report row.
-- Anyone subsequently reading lease_reports.pdf_storage_path
-- downloads the tampered PDF — corrupting the disclosure report
-- audit trail with no signal at the application layer.
--
-- This migration tightens both policies along two axes:
--   1. Actor — caller must be the original generated_by user, the
--      workspace owner, OR a workspace_members.role = 'admin'.
--   2. Lifecycle — only allow writes while lease_reports.pdf_storage_path
--      is NULL. Once finalize-report-pdf has stamped the column the
--      PDF object is immutable for authenticated callers; further
--      writes can only happen under service_role (e.g. background-queue
--      regeneration in a future workstream).
--
-- Cleanup (cleanup-expired-reports cron) uses service_role and is
-- unaffected. JSON artifacts are written by edge functions under
-- service_role and similarly unaffected — these policies only
-- govern authenticated callers.
-- ============================================================

DROP POLICY IF EXISTS "workspace members upload lease-reports" ON storage.objects;
DROP POLICY IF EXISTS "workspace members update lease-reports" ON storage.objects;

-- ─── INSERT — generator/owner/admin, pre-finalize only ────────────────────
CREATE POLICY "report owners insert lease-reports"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1
      FROM public.lease_reports lr
      LEFT JOIN public.workspaces w ON w.id = lr.workspace_id
      LEFT JOIN public.workspace_members wm
        ON wm.workspace_id = lr.workspace_id AND wm.user_id = auth.uid()
      WHERE lr.id::text          = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
        AND lr.pdf_storage_path IS NULL   -- immutability gate
        AND (
          lr.generated_by = auth.uid()
          OR w.owner_id = auth.uid()
          OR wm.role = 'admin'
        )
    )
  );

-- ─── UPDATE — same restrictions; supabase-js upsert needs UPDATE ──────────
-- supabase-js's .upload({ upsert: true }) issues an UPSERT. The UPDATE
-- branch fires when the client retries against an existing path BEFORE
-- finalize-report-pdf has stamped pdf_storage_path. After finalization,
-- the immutability gate rejects.
CREATE POLICY "report owners update lease-reports"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1
      FROM public.lease_reports lr
      LEFT JOIN public.workspaces w ON w.id = lr.workspace_id
      LEFT JOIN public.workspace_members wm
        ON wm.workspace_id = lr.workspace_id AND wm.user_id = auth.uid()
      WHERE lr.id::text          = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
        AND lr.pdf_storage_path IS NULL
        AND (
          lr.generated_by = auth.uid()
          OR w.owner_id = auth.uid()
          OR wm.role = 'admin'
        )
    )
  )
  WITH CHECK (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1
      FROM public.lease_reports lr
      LEFT JOIN public.workspaces w ON w.id = lr.workspace_id
      LEFT JOIN public.workspace_members wm
        ON wm.workspace_id = lr.workspace_id AND wm.user_id = auth.uid()
      WHERE lr.id::text          = (storage.foldername(name))[2]
        AND lr.workspace_id::text = (storage.foldername(name))[1]
        AND lr.pdf_storage_path IS NULL
        AND (
          lr.generated_by = auth.uid()
          OR w.owner_id = auth.uid()
          OR wm.role = 'admin'
        )
    )
  );

COMMENT ON POLICY "report owners insert lease-reports" ON storage.objects IS
  'P1-06: limits PDF uploads to the original generator, workspace owner, or workspace admin, and only while the row has not yet been finalized (pdf_storage_path IS NULL).';

COMMENT ON POLICY "report owners update lease-reports" ON storage.objects IS
  'P1-06: same actor + immutability restrictions as the matching INSERT policy. Necessary because supabase-js upsert can fire UPDATE on a retry path.';
