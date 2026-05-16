-- Update storage policies to support workspace-based file sharing
-- This allows workspace members to view lease files when they have access to the lease via RLS

-- Drop existing SELECT policy on leases bucket
DROP POLICY IF EXISTS "Users can view own lease files" ON storage.objects;

-- Create workspace-aware SELECT policy for lease files
-- This policy allows access if:
-- 1. The file is in the 'leases' bucket, AND
-- 2. Either the user owns the file (first folder matches user ID) OR
--    the user is a member of the workspace that owns the lease
CREATE POLICY "Users and workspace members can view lease files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'leases' 
  AND (
    -- User owns the file (backwards compatible)
    (storage.foldername(name))[1] = auth.uid()::text
    OR
    -- User is a workspace member with access to this lease
    EXISTS (
      SELECT 1 FROM public.leases
      WHERE leases.storage_path = storage.objects.name
        AND leases.workspace_id IS NOT NULL
        AND public.is_workspace_member(leases.workspace_id, auth.uid())
    )
  )
);

-- Keep existing policies for upload/update/delete (owner-only)
-- These don't need to change since only lease owners should modify files