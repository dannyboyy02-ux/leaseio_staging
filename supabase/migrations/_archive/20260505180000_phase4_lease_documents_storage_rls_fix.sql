-- Phase 4 — storage RLS rework for lease-documents bucket
--
-- The original Phase 4 migration (20260505160000) wrote storage.objects
-- policies that require a matching lease_documents row to ALREADY exist
-- when the storage upload runs. That assumed an insert-metadata-then-
-- upload-bytes flow. The Phase 4 spec mandates the opposite flow:
-- upload bytes first via supabase-js, then call the
-- upload-lease-document edge function to insert metadata. The upload
-- never lands because storage RLS rejects it.
--
-- Fix: switch storage RLS to path-prefix workspace check. The path
-- convention is `{workspace_id}/{lease_id}/{uuid}_{filename}` —
-- (storage.foldername(name))[1] is the workspace_id; we verify
-- membership against that. Same pattern as the executed-leases
-- bucket but tightened to workspace scoping (executed-leases is
-- authenticated-anyone, which is too loose for a launch surface).
--
-- The lease_documents TABLE RLS is unchanged — those policies
-- continue to enforce that only owners / admins / editors can insert
-- the metadata row. So a viewer cannot bypass the metadata gate by
-- uploading bytes alone; they would just leave an orphan storage
-- object that the upload-lease-document edge function refuses to
-- record.
--
-- Per the schema-change rule: this is a follow-on migration; the
-- original 20260505160000 migration file is not edited.

DROP POLICY IF EXISTS "workspace members upload to lease-documents" ON storage.objects;
DROP POLICY IF EXISTS "workspace members read lease-documents" ON storage.objects;
DROP POLICY IF EXISTS "admins delete from lease-documents" ON storage.objects;

-- Workspace members (owner OR member) can upload to any path under
-- {workspace_id}/... in the lease-documents bucket.
CREATE POLICY "workspace members upload to lease-documents"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'lease-documents'
    AND owner = auth.uid()
    AND (
      ((storage.foldername(name))[1])::uuid IN (
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
        UNION
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      )
    )
  );

-- Workspace members can read documents whose path starts with a
-- workspace they belong to.
CREATE POLICY "workspace members read lease-documents"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lease-documents'
    AND (
      ((storage.foldername(name))[1])::uuid IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
        UNION
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      )
    )
  );

-- Workspace owners + admins can delete (used for orphan cleanup
-- after a failed metadata insert in the upload dialog, and for the
-- delete-workspace edge function).
CREATE POLICY "admins delete from lease-documents"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'lease-documents'
    AND (
      ((storage.foldername(name))[1])::uuid IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
      )
    )
  );
