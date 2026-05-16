-- Add parent_lease_id column for lease amendments
ALTER TABLE public.leases 
ADD COLUMN IF NOT EXISTS parent_lease_id uuid REFERENCES public.leases(id);

-- Add category column for New Lease vs Amendment
ALTER TABLE public.leases
ADD COLUMN IF NOT EXISTS category text;

-- Create index for faster parent lease lookups
CREATE INDEX IF NOT EXISTS idx_leases_parent_lease_id 
ON public.leases(parent_lease_id) 
WHERE parent_lease_id IS NOT NULL;