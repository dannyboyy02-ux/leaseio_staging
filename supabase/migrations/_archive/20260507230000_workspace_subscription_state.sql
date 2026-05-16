-- Adds subscription state columns to public.workspaces.
--
-- BACKGROUND
-- ----------
-- Migration 20260426000003_audit_remediation.sql ALREADY contains
-- ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS for these four
-- columns:
--   stripe_customer_id, stripe_subscription_id,
--   subscription_status, subscription_period_end
--
-- However, that migration was never applied to the live database (per
-- the migration drift remediation doc and the schema baseline at
-- docs/SCHEMA_BASELINE_2026_05_07.md, which reflects 28 columns on
-- workspaces and is missing all four).
--
-- Two independent breakages followed:
--   1. supabase/functions/stripe-webhook/index.ts writes all four
--      columns on every subscription event. The UPDATE returns 400
--      ("column does not exist") in production. No real customer had
--      subscribed yet, so it stayed hidden.
--   2. The 2026-05-07 pricing reconciliation work (commit e223144)
--      added subscription_status and subscription_period_end to the
--      workspaces SELECT in src/contexts/AppContext.tsx. PostgREST
--      400'd every workspace load, breaking the app for every user.
--      AppContext was reverted to the smaller SELECT in the same
--      commit that introduces this migration; the SELECT can be
--      expanded back to include subscription_status +
--      subscription_period_end after this migration ships to live.
--
-- This migration intentionally duplicates the ADD COLUMN block from
-- 20260426000003. The IF NOT EXISTS guards make it a no-op against
-- environments where 20260426000003 already landed, and it
-- guarantees the columns exist in environments where it didn't.
--
-- Operator deploy step: `supabase db push`. After that, expand the
-- AppContext workspaceSelect to include subscription_status +
-- subscription_period_end and read them in setWorkspace.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;

-- Defensive index on stripe_subscription_id for webhook lookups
-- (find the workspace whose subscription Stripe is reporting on).
CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_subscription_id
  ON public.workspaces(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
