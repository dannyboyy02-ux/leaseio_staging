-- ============================================================
-- workspace_intended_plan
-- Capture the user's *declared* plan at workspace creation so
-- that an abandoned Business-tier checkout is recoverable.
--
-- Background: migration 20260426000003 added an entitlement-guard
-- trigger that rejects any authenticated INSERT/UPDATE where
-- workspace.plan != 'starter' or document_limit != 15. The trigger
-- is correct (Stripe webhook owns plan promotion via service role)
-- but it means the user's selected plan was never persisted at
-- workspace creation, only carried in React navigation state.
-- That made abandoned Business signups indistinguishable from
-- deliberate Starter signups.
--
-- intended_plan is a customer declaration, NOT a billing entitlement.
-- It is intentionally outside the entitlement-guard trigger's column
-- set. The Stripe webhook may clear it on successful promotion;
-- AccountSettings reads it to surface a "complete checkout" callout
-- when the user returns without having paid.
-- ============================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS intended_plan text;

COMMENT ON COLUMN public.workspaces.intended_plan IS
  'User-declared plan at workspace creation. Not an entitlement — Stripe webhook owns workspaces.plan. Used to recover abandoned checkout flows.';
