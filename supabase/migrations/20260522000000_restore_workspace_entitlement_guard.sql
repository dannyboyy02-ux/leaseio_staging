-- ============================================================================
-- Restore workspace entitlement guard  (KNOWN_ISSUES #29 — billing-bypass P0)
-- ============================================================================
--
-- PROBLEM
--   public.workspaces had a live billing-bypass: the only UPDATE policy,
--   "Owners can update their workspaces", was USING (owner_id = auth.uid())
--   with NO WITH CHECK clause, and the intended BEFORE INSERT/UPDATE trigger
--   enforce_workspace_entitlement_guard never reached production. Any
--   authenticated workspace owner could
--     PATCH /rest/v1/workspaces?id=eq.<their_id>
--     {"plan":"business","document_limit":9999,"subscription_status":"active"}
--   self-granting Business-tier features and unbounded Opus-extraction spend
--   while Stripe never saw the change. Verified exploitable 2026-05-17.
--
-- WHY THE ORIGINAL NEVER APPLIED (meta-question, resolved before this SQL)
--   The trigger was defined in _archive/20260426000003_audit_remediation.sql,
--   which was COMMITTED BUT NEVER APPLIED to prod (not applied-then-reverted):
--   version 20260426000003 is absent from the captured pre-baseline
--   schema_migrations snapshot (docs/ops/schema_migrations_pre_baseline_2026-05-16.json),
--   the trigger is absent from the 20260516120000 baseline dump, and the file
--   was moved into _archive/ (CLI-skipped) during the squash. Same pattern as
--   #16/#17/#25, all remediated with NEW active-directory migrations. So a
--   standard new migration suffices; no constraint/CI-tripwire is required.
--
-- WHAT THIS MIGRATION DOES (hardened scope, decisions ratified 2026-05-22)
--   1. Fixes the stale column defaults plan='pro'/document_limit=3 to the
--      Starter baseline plan='starter'/document_limit=15 (aligns with the
--      2026-05-07 pricing reconciliation and the Onboarding.tsx contract,
--      which omits these columns and relies on the DB defaults). This is
--      REQUIRED: the INSERT guard pins new authenticated workspaces to the
--      Starter baseline, so the defaults and the guard must agree or every
--      onboarding INSERT would be rejected.
--   2. Restores prevent_workspace_entitlement_edits() + the trigger, guarding
--      9 billing/entitlement columns on INSERT and UPDATE: plan, document_limit,
--      documents_used (quota counter — verified no authenticated writer exists),
--      billing_interval, stripe_customer_id, stripe_subscription_id,
--      subscription_status, subscription_period_end, and max_archived_leases
--      (tier-derived archive cap, read DB-first by AppContext — verified no
--      authenticated writer; flagged by security review M1). intended_plan is
--      NOT guarded (Onboarding writes it; abandoned-checkout recovery).
--   3. Adds WITH CHECK (owner_id = auth.uid()) to the UPDATE policy — closes
--      the literal #29 gap and blocks ownership reassignment.
--
-- CARVE-OUT
--   Service role (Stripe webhook, cron, deliberate service-role migrations) is
--   the only writer permitted to set or change entitlements. Everything else —
--   authenticated PostgREST, anon, and direct/owner DB connections — is
--   enforced. This matches the canonical COALESCE(auth.role(),'') predicate in
--   prevent_change_set_field_tampering (20260517000000) and
--   prevent_locked_lease_edits. A future migration that legitimately needs to
--   relocate billing state must run under service_role or temporarily
--   ALTER TABLE ... DISABLE TRIGGER enforce_workspace_entitlement_guard.
--
-- SMOKE CHECK
--   No audit_rls_smoke_check() change needed: the key 'workspace_entitlement_guard'
--   already exists (20260517000000) and asserts this trigger's existence. It
--   returns FALSE today and flips to TRUE on apply — the success signal for
--   this migration (Category C: must be TRUE post-apply or the vuln survived).
--
-- Idempotent: SET DEFAULT is naturally idempotent; CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER/POLICY IF EXISTS guard the rest. Safe to replay.
-- ============================================================================

-- 1. Align the column defaults to the Starter baseline -----------------------
ALTER TABLE public.workspaces
  ALTER COLUMN plan SET DEFAULT 'starter',
  ALTER COLUMN document_limit SET DEFAULT 15;

-- 2. Entitlement guard function ----------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_workspace_entitlement_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Service role is the only writer allowed to set/change billing state.
  -- COALESCE-to-empty means everything that is NOT explicit service_role is
  -- enforced (authenticated, anon, direct DB / migrations). See header.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- New workspaces must be created at the Starter baseline. Onboarding.tsx
    -- omits these columns and relies on the DB defaults; Stripe checkout +
    -- the signed webhook (service_role) own any promotion to Business.
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
  'documents_used, billing_interval, stripe_customer_id, stripe_subscription_id, '
  'subscription_status, subscription_period_end, max_archived_leases. intended_plan is intentionally '
  'NOT guarded (Onboarding writes it; abandoned-checkout recovery). Only '
  'service_role (Stripe webhook/cron) may write these columns; migrations that '
  'must touch them run under service_role or DISABLE this trigger.';

DROP TRIGGER IF EXISTS enforce_workspace_entitlement_guard ON public.workspaces;
CREATE TRIGGER enforce_workspace_entitlement_guard
  BEFORE INSERT OR UPDATE ON public.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_workspace_entitlement_edits();

-- 3. Close the missing WITH CHECK on the UPDATE policy -----------------------
-- Recreated faithfully (no TO clause, matching the baseline) plus a WITH CHECK
-- that pins the post-update row to the same owner — blocking ownership
-- reassignment that the missing WITH CHECK previously allowed.
DROP POLICY IF EXISTS "Owners can update their workspaces" ON public.workspaces;
CREATE POLICY "Owners can update their workspaces"
  ON public.workspaces
  FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
