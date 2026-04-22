-- Fix: leases_lifecycle_status_check was missing 'draft'
-- The lifecycle_status column has DEFAULT 'draft' but the CHECK constraint
-- did not include 'draft', causing process_lease to fail on initial insert.
ALTER TABLE public.leases
  DROP CONSTRAINT IF EXISTS leases_lifecycle_status_check;

ALTER TABLE public.leases
  ADD CONSTRAINT leases_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'draft',
    'submitted',
    'under_review',
    'approved',
    'executed',
    'active',
    'expired',
    'rejected',
    'cancelled'
  ));
