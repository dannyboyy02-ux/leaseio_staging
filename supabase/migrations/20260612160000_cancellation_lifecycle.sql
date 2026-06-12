-- Cancellation lifecycle — soft-delete + buffered purge (ratified 2026-06-12).
--
-- Policy: when a workspace's plan subscription fully ends (Stripe status
-- 'canceled', i.e. the paid-through period is over), the workspace enters a
-- 30-day read-only GRACE window (view + export only). At grace expiry the
-- workspace is SOFT-DELETED (access revoked, hidden, all processing stopped);
-- ~10 days later the nightly cron HARD-PURGES it (storage + rows), writing the
-- durable deleted_workspaces forensic row first. Renewal at any point before
-- purge clears the lifecycle columns and restores everything.
--
-- Writers: stripe-webhook (grace start/clear) and the
-- process-cancellation-lifecycle cron (soft-delete, purge) — service_role
-- only, enforced by the 4th derivation of prevent_workspace_entitlement_edits
-- below (#29 family; prior derivations: 20260522000000, 20260611120000,
-- 20260611150000).
--
-- cancellation_notices is the reminder-email ledger: one row per
-- (workspace, cancellation cycle, notice type) makes cron sends idempotent —
-- a retried run can never double-send. cycle_started_at = canceled_at of the
-- cycle, so a cancel → renew → cancel sequence gets a fresh notice set.

-- ── 1. Lifecycle columns ─────────────────────────────────────────────────
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS soft_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz;

COMMENT ON COLUMN public.workspaces.canceled_at IS
  'Set by stripe-webhook when the plan subscription fully ends (period end). NULL = subscription not canceled. Cleared on renewal. Service-role only (#29 guard).';
COMMENT ON COLUMN public.workspaces.grace_expires_at IS
  'canceled_at + 30 days: end of the read-only view/export window. Service-role only (#29 guard).';
COMMENT ON COLUMN public.workspaces.soft_deleted_at IS
  'Set by the process-cancellation-lifecycle cron at grace expiry: access revoked, workspace hidden, processing stopped. Service-role only (#29 guard).';
COMMENT ON COLUMN public.workspaces.purge_after IS
  'soft_deleted_at + 10 days: after this the cron hard-purges the workspace (forensic row in deleted_workspaces survives). Service-role only (#29 guard).';

-- ── 2. Reminder-notice ledger ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cancellation_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cycle_started_at timestamptz NOT NULL,
  notice_type text NOT NULL CHECK (notice_type IN
    ('day0', 'day7', 'day14', 'day21', 'day27', 'day30_final', 'soft_deleted')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (workspace_id, cycle_started_at, notice_type)
);

COMMENT ON TABLE public.cancellation_notices IS
  'Idempotency ledger for cancellation-lifecycle reminder emails. Written only by the process-cancellation-lifecycle cron (service_role). One row per workspace × cancellation cycle × notice type.';

ALTER TABLE public.cancellation_notices ENABLE ROW LEVEL SECURITY;
-- No member policies: internal operational ledger, service_role only.
REVOKE ALL ON public.cancellation_notices FROM PUBLIC, anon, authenticated;

-- ── 3. Guard re-derivation (4th) — lifecycle columns are billing-managed ─
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
    IF NEW.purchased_lease_credits IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'workspaces.purchased_lease_credits must be 0 at creation (got %); lease credits are managed by the billing system', NEW.purchased_lease_credits
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
    IF NEW.canceled_at IS NOT NULL
       OR NEW.grace_expires_at IS NOT NULL
       OR NEW.soft_deleted_at IS NOT NULL
       OR NEW.purge_after IS NOT NULL THEN
      RAISE EXCEPTION 'workspaces cancellation-lifecycle columns cannot be set at creation; they are managed by the billing system'
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
  IF NEW.purchased_lease_credits IS DISTINCT FROM OLD.purchased_lease_credits THEN
    RAISE EXCEPTION 'workspaces.purchased_lease_credits is managed by the billing system (attempted % -> %)', OLD.purchased_lease_credits, NEW.purchased_lease_credits
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
  IF NEW.canceled_at IS DISTINCT FROM OLD.canceled_at THEN
    RAISE EXCEPTION 'workspaces.canceled_at is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.grace_expires_at IS DISTINCT FROM OLD.grace_expires_at THEN
    RAISE EXCEPTION 'workspaces.grace_expires_at is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.soft_deleted_at IS DISTINCT FROM OLD.soft_deleted_at THEN
    RAISE EXCEPTION 'workspaces.soft_deleted_at is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purge_after IS DISTINCT FROM OLD.purge_after THEN
    RAISE EXCEPTION 'workspaces.purge_after is managed by the billing system'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_archived_leases IS DISTINCT FROM OLD.max_archived_leases THEN
    RAISE EXCEPTION 'workspaces.max_archived_leases is a tier entitlement managed by the billing system (attempted % -> %)', OLD.max_archived_leases, NEW.max_archived_leases
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
