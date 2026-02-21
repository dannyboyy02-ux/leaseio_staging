-- Phase 1: Financial columns and lifecycle status update

-- Add financial input columns to leases table
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS monthly_payment NUMERIC,
  ADD COLUMN IF NOT EXISTS term_months INTEGER,
  ADD COLUMN IF NOT EXISTS asset_type TEXT CHECK (asset_type IN ('equipment', 'vehicle', 'property', 'other')),
  ADD COLUMN IF NOT EXISTS escalation_rate NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calc_total_commitment NUMERIC,
  ADD COLUMN IF NOT EXISTS calc_pv_liability NUMERIC,
  ADD COLUMN IF NOT EXISTS calc_straight_line_exp NUMERIC,
  ADD COLUMN IF NOT EXISTS calc_cash_pl_delta NUMERIC,
  ADD COLUMN IF NOT EXISTS lease_classification TEXT DEFAULT 'pending'
    CHECK (lease_classification IN ('operating', 'finance', 'pending')),
  ADD COLUMN IF NOT EXISTS covenant_flagged BOOLEAN DEFAULT FALSE;

-- Add financial configuration columns to workspaces table
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS discount_rate NUMERIC DEFAULT 5.5,
  ADD COLUMN IF NOT EXISTS covenant_threshold NUMERIC,
  ADD COLUMN IF NOT EXISTS approval_threshold NUMERIC DEFAULT 0;

-- Migrate existing lifecycle statuses to new naming convention
UPDATE public.leases
SET lifecycle_status = CASE lifecycle_status
  WHEN 'requested'     THEN 'submitted'
  WHEN 'negotiating'   THEN 'under_review'
  WHEN 'pending_review' THEN 'under_review'
  ELSE lifecycle_status
END
WHERE lifecycle_status IN ('requested', 'negotiating', 'pending_review');

-- Update lifecycle_status constraint to match new status model
ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_lifecycle_status_check;
ALTER TABLE public.leases
  ADD CONSTRAINT leases_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'submitted',
    'under_review',
    'approved',
    'executed',
    'active',
    'expired',
    'rejected',
    'cancelled'
  ));
