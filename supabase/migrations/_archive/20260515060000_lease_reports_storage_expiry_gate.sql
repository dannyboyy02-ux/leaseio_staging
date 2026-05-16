-- ============================================================
-- lease_reports_storage_expiry_gate (P2-06)
--
-- Per audit P2-06 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- the lease-reports SELECT policy from phase8 (20260506200000) only
-- checked path ownership — `lr.pdf_storage_path = name OR
-- lr.json_storage_path = name` + workspace membership. It did NOT
-- check `status` or `expires_at`. If the cleanup cron failed to
-- delete a PDF (transient storage error) the row would be marked
-- expired but the blob would remain readable to anyone who knew or
-- guessed the path.
--
-- The companion fix in cleanup-expired-reports nulls the path
-- columns when marking a row expired, so the primary defense is
-- already in place: an orphaned blob has no row referencing it →
-- the EXISTS clause returns false → no read.
--
-- This migration adds the status + expires_at gate as defense in
-- depth. Even if a future code path puts a non-null path back on
-- an expired row, the SELECT policy still rejects.
-- ============================================================

DROP POLICY IF EXISTS "workspace members read lease-reports" ON storage.objects;

CREATE POLICY "workspace members read lease-reports"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE (lr.pdf_storage_path = name OR lr.json_storage_path = name)
        AND lr.status <> 'expired'
        AND (lr.expires_at IS NULL OR lr.expires_at > now())
        AND (
          lr.workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
          OR lr.workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
        )
    )
  );

COMMENT ON POLICY "workspace members read lease-reports" ON storage.objects IS
  'P2-06: gate report PDF/JSON reads on status <> ''expired'' AND expires_at > now() in addition to workspace membership. Defense in depth against orphaned blobs after a partial cleanup.';
