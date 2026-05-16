-- Add status_changed_at column to leases for lifecycle transition tracking
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
