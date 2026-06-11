-- ============================================================================
-- Document capacity packs — addon_document_capacity column + guard extension
-- ============================================================================
--
-- FEATURE
--   Workspaces can buy recurring "document packs" that raise their monthly
--   abstraction allowance AND active-lease cap while active. The granted
--   capacity is mirrored from Stripe onto workspaces.addon_document_capacity
--   by the stripe-webhook (the sole entitlement writer), computed as the sum
--   of the workspace's active/trialing pack subscriptions' sizes.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds workspaces.addon_document_capacity (integer NOT NULL DEFAULT 0).
--      0 means no pack. process_lease adds this to both the active_leases and
--      monthly_extractions limits; AppContext surfaces it for the usage meter.
--   2. Extends prevent_workspace_entitlement_edits() (KNOWN_ISSUES #29 guard)
--      to treat addon_document_capacity as a billing-managed entitlement:
--        - INSERT: must be 0 (new workspaces have no pack; packs are bought
--          later through the paying path + webhook).
--        - UPDATE: only service_role may change it (Stripe webhook / cron),
--          exactly like plan/document_limit/subscription_*.
--      Without this, an authenticated owner could PATCH addon_document_capacity
--      to an arbitrary value and self-grant unlimited abstraction capacity —
--      the same billing-bypass class #29 closed for the other entitlement
--      columns. This column MUST be added to the guard in the same migration
--      that introduces it, or it ships unguarded.
--
-- CARVE-OUT (unchanged)
--   COALESCE(auth.role(),'') = 'service_role' short-circuits the guard. Only
--   the signed Stripe webhook (service_role) writes addon_document_capacity.
--
-- SMOKE CHECK
--   The 'workspace_entitlement_guard' key (20260517000000) asserts the trigger
--   exists; it stays TRUE across this CREATE OR REPLACE. No new key needed —
--   the column-coverage assertion lives in the static test
--   workspaceEntitlementGuard.test.ts (updated alongside this migration).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
-- DROP TRIGGER IF EXISTS + CREATE. Safe to replay.
-- ============================================================================

-- 1. New entitlement column --------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS addon_document_capacity integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.workspaces.addon_document_capacity IS
  'Extra monthly abstraction allowance AND active-lease capacity granted by '
  'active document packs. Sum of the workspace''s active/trialing pack '
  'subscription sizes, mirrored from Stripe by stripe-webhook. '
  'Billing-managed: guarded by prevent_workspace_entitlement_edits (#29).';

-- 2. Extend the entitlement guard to cover the new column ---------------------
CREATE OR REPLACE FUNCTION public.prevent_workspace_entitlement_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Service role is the only writer allowed to set/change billing state.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.plan IS DISTINCT FROM 'starter' THEN
      RAISE EXCEPTION 'workspaces.plan must be the Starter default at creation (got %); billing entitlements are managed by the billing system', NEW.plan
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.document_limit IS DISTINCT FROM 15 THEN
      RAISE EXCEPTION 'workspaces.document_limit must be the Starter default (15) at creation (got %); billing entitlements are managed by the billing system', NEW.document_limit
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.documents_used IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'workspaces.documents_used must be 0 at creation (got %); the quota counter is managed by the billing system', NEW.documents_used
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.addon_document_capacity IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'workspaces.addon_document_capacity must be 0 at creation (got %); document-pack capacity is managed by the billing system', NEW.addon_document_capacity
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.billing_interval IS DISTINCT FROM 'monthly' THEN
      RAISE EXCEPTION 'workspaces.billing_interval must be the default (monthly) at creation (got %); billing entitlements are managed by the billing system', NEW.billing_interval
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.stripe_customer_id IS NOT NULL
       OR NEW.stripe_subscription_id IS NOT NULL
       OR NEW.subscription_status IS NOT NULL
       OR NEW.subscription_period_end IS NOT NULL THEN
      RAISE EXCEPTION 'workspaces stripe/subscription columns cannot be set at creation; they are managed by the billing system'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.max_archived_leases IS NOT NULL THEN
      RAISE EXCEPTION 'workspaces.max_archived_leases is a tier entitlement and cannot be set at creation; it is managed by the billing system'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE': none of the billing/entitlement columns may change.
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'workspaces.plan is managed by the billing system (attempted % -> %)', OLD.plan, NEW.plan
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.document_limit IS DISTINCT FROM OLD.document_limit THEN
    RAISE EXCEPTION 'workspaces.document_limit is managed by the billing system (attempted % -> %)', OLD.document_limit, NEW.document_limit
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.documents_used IS DISTINCT FROM OLD.documents_used THEN
    RAISE EXCEPTION 'workspaces.documents_used is managed by the billing/quota system (attempted % -> %)', OLD.documents_used, NEW.documents_used
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.addon_document_capacity IS DISTINCT FROM OLD.addon_document_capacity THEN
    RAISE EXCEPTION 'workspaces.addon_document_capacity is managed by the billing system (attempted % -> %)', OLD.addon_document_capacity, NEW.addon_document_capacity
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.billing_interval IS DISTINCT FROM OLD.billing_interval THEN
    RAISE EXCEPTION 'workspaces.billing_interval is managed by the billing system (attempted % -> %)', OLD.billing_interval, NEW.billing_interval
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
    RAISE EXCEPTION 'workspaces.stripe_customer_id is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    RAISE EXCEPTION 'workspaces.stripe_subscription_id is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    RAISE EXCEPTION 'workspaces.subscription_status is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end THEN
    RAISE EXCEPTION 'workspaces.subscription_period_end is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_archived_leases IS DISTINCT FROM OLD.max_archived_leases THEN
    RAISE EXCEPTION 'workspaces.max_archived_leases is a tier entitlement managed by the billing system (attempted % -> %)', OLD.max_archived_leases, NEW.max_archived_leases
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_workspace_entitlement_edits() OWNER TO postgres;

COMMENT ON FUNCTION public.prevent_workspace_entitlement_edits() IS
  'KNOWN_ISSUES #29 guard. Rejects any non-service_role attempt to set (INSERT) '
  'or change (UPDATE) the billing/entitlement columns plan, document_limit, '
  'documents_used, addon_document_capacity, billing_interval, stripe_customer_id, '
  'stripe_subscription_id, subscription_status, subscription_period_end, '
  'max_archived_leases. intended_plan is intentionally NOT guarded (Onboarding '
  'writes it; abandoned-checkout recovery). Only service_role (Stripe '
  'webhook/cron) may write these columns; migrations that must touch them run '
  'under service_role or DISABLE this trigger.';

-- Recreate the trigger so a fresh replay binds to the replaced function.
DROP TRIGGER IF EXISTS enforce_workspace_entitlement_guard ON public.workspaces;
CREATE TRIGGER enforce_workspace_entitlement_guard
  BEFORE INSERT OR UPDATE ON public.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_workspace_entitlement_edits();
