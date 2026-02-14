-- Phase 1: Lease Intake pivot foundation
-- Adds lease request intake columns and updates lifecycle status model.

ALTER TABLE public.leases
ADD COLUMN IF NOT EXISTS request_title TEXT,
ADD COLUMN IF NOT EXISTS requesting_department TEXT,
ADD COLUMN IF NOT EXISTS requestor_id UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS request_urgency TEXT DEFAULT 'standard' CHECK (request_urgency IN ('low', 'standard', 'urgent')),
ADD COLUMN IF NOT EXISTS expected_start_date DATE,
ADD COLUMN IF NOT EXISTS request_description TEXT,
ADD COLUMN IF NOT EXISTS vendor_name TEXT;

UPDATE public.leases
SET lifecycle_status = CASE lifecycle_status
  WHEN 'draft' THEN 'requested'
  WHEN 'pending_internal_approval' THEN 'negotiating'
  WHEN 'lease_candidate' THEN 'negotiating'
  WHEN 'pending_execution_approval' THEN 'pending_review'
  WHEN 'rejected' THEN 'cancelled'
  ELSE lifecycle_status
END
WHERE lifecycle_status IN (
  'draft',
  'pending_internal_approval',
  'lease_candidate',
  'pending_execution_approval',
  'rejected'
);

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_lifecycle_status_check;
ALTER TABLE public.leases
ADD CONSTRAINT leases_lifecycle_status_check
CHECK (lifecycle_status IN (
  'requested',
  'negotiating',
  'pending_review',
  'executed',
  'active',
  'expired',
  'cancelled'
));
