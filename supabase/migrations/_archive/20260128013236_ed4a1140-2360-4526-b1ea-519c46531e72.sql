-- Add new columns to leases table for workflow lifecycle
ALTER TABLE public.leases 
ADD COLUMN IF NOT EXISTS lease_type text,
ADD COLUMN IF NOT EXISTS approver_email text,
ADD COLUMN IF NOT EXISTS initializer_id uuid,
ADD COLUMN IF NOT EXISTS confidence_scores jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS audit_log jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS last_nudged_at timestamptz;

-- Add constraint for lease_type (only if it doesn't exist)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leases_type_check'
  ) THEN
    ALTER TABLE public.leases 
    ADD CONSTRAINT leases_type_check 
    CHECK (lease_type IS NULL OR lease_type IN ('Real Estate', 'Equipment'));
  END IF;
END $$;