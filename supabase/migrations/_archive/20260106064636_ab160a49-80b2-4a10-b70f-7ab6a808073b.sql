-- Create storage policies for the 'leases' bucket
-- Storage path structure: {user_id}/{lease_id}/{filename}

-- Allow users to view (download) their own lease files
CREATE POLICY "Users can view own lease files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'leases' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to upload files to their own folder
CREATE POLICY "Users can upload own lease files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'leases' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to update their own files
CREATE POLICY "Users can update own lease files"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'leases' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to delete their own lease files
CREATE POLICY "Users can delete own lease files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'leases' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);