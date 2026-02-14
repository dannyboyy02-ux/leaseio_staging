-- Add status_changed_at column for accurate pipeline metrics
ALTER TABLE public.leases
ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ DEFAULT now();
