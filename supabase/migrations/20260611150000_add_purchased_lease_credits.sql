-- ============================================================================
-- Single-lease credits — purchased_lease_credits + purchase ledger + consume RPC
-- ============================================================================
--
-- FEATURE (Workstream C — limit wall)
--   A workspace at its cap can buy a SINGLE extra lease at the plan's overage
--   rate ($12 starter / $10 business) as a one-time charge. Each successful
--   payment grants one credit; process_lease consumes one credit to let one
--   upload through when the workspace is over its (base + pack) caps.
--
-- DESIGN
--   * `workspaces.purchased_lease_credits` — current spendable credits.
--     Billing-managed entitlement: written only by the ledger trigger (webhook
--     path, service_role) and the consume RPC (process_lease, service_role).
--   * `lease_credit_purchases` — append-only ledger keyed UNIQUE on the Stripe
--     payment_intent_id, making webhook retries idempotent: the duplicate
--     insert no-ops, so the credit can never be granted twice. The AFTER INSERT
--     trigger increments the workspace counter exactly once per ledger row.
--   * `consume_lease_credit(uuid)` — atomic claim (single UPDATE guarded by
--     `> 0`), so two concurrent uploads can't spend the same credit.
--
-- ENTITLEMENT GUARD
--   prevent_workspace_entitlement_edits() is re-derived (3rd derivation; prior
--   one in 20260611120000) to cover purchased_lease_credits on INSERT (must be
--   0) and UPDATE (service_role only) — without this, an authenticated owner
--   could PATCH themselves free credits (the #29 billing-bypass class).
--
-- TRIGGER ORDERING
--   lease_credit_purchases is a NEW table; increment_lease_credits is its only
--   trigger, so no alphabetical-ordering interaction (CLAUDE.md gotcha n/a).
--   On workspaces, the guard trigger already exists; the ledger trigger's
--   UPDATE runs under the inserting role (service_role via webhook) and passes
--   the guard's carve-out.
--
-- RLS
--   Ledger is readable by workspace members (their own billing history — feeds
--   the future itemized-billing surface, KNOWN_ISSUES #60). No INSERT/UPDATE/
--   DELETE policies exist, so only service_role can write.
--
-- Idempotent: IF NOT EXISTS / OR REPLACE / DROP IF EXISTS throughout.
-- ============================================================================

-- 1. Credits column -----------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS purchased_lease_credits integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.workspaces.purchased_lease_credits IS
  'Spendable single-lease credits bought at the overage rate. Granted by the '
  'lease_credit_purchases ledger trigger (Stripe webhook, service_role); '
  'consumed atomically by consume_lease_credit() from process_lease. '
  'Billing-managed: guarded by prevent_workspace_entitlement_edits (#29).';

-- 2. Append-only purchase ledger ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.lease_credit_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  payment_intent_id text NOT NULL UNIQUE,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  purchased_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lease_credit_purchases IS
  'Append-only ledger of one-time single-lease credit purchases. UNIQUE '
  'payment_intent_id makes Stripe webhook retries idempotent. The AFTER INSERT '
  'trigger grants the credits; rows are never updated or deleted.';

CREATE INDEX IF NOT EXISTS lease_credit_purchases_workspace_idx
  ON public.lease_credit_purchases (workspace_id, created_at DESC);

ALTER TABLE public.lease_credit_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their workspace credit purchases"
  ON public.lease_credit_purchases;
CREATE POLICY "Members can read their workspace credit purchases"
  ON public.lease_credit_purchases
  FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

-- 2b. Append-only consumption ledger (debit side) -----------------------------
-- Makes a spent credit attributable: every consume writes one row linking the
-- credit to the lease/upload that spent it. purchases − consumptions = balance,
-- decomposable after the fact (the bare counter alone was not — integrity H2).
CREATE TABLE IF NOT EXISTS public.lease_credit_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lease_id uuid,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lease_credit_consumptions IS
  'Append-only debit ledger: one row per single-lease credit spent, linking it '
  'to the lease that consumed it. Written only by consume_lease_credit() '
  '(process_lease, service_role). Member-readable; never updated or deleted. '
  'NOTE: ON DELETE CASCADE — deleting a workspace removes its billing-history '
  'rows; the forensic record of the workspace itself lives in deleted_workspaces.';

CREATE INDEX IF NOT EXISTS lease_credit_consumptions_workspace_idx
  ON public.lease_credit_consumptions (workspace_id, consumed_at DESC);

ALTER TABLE public.lease_credit_consumptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their workspace credit consumptions"
  ON public.lease_credit_consumptions;
CREATE POLICY "Members can read their workspace credit consumptions"
  ON public.lease_credit_consumptions
  FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

-- 3. Grant trigger — one increment per ledger row -----------------------------
CREATE OR REPLACE FUNCTION public.grant_lease_credits_on_purchase()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.workspaces
  SET purchased_lease_credits = purchased_lease_credits + NEW.quantity
  WHERE id = NEW.workspace_id;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.grant_lease_credits_on_purchase() OWNER TO postgres;

DROP TRIGGER IF EXISTS increment_lease_credits ON public.lease_credit_purchases;
CREATE TRIGGER increment_lease_credits
  AFTER INSERT ON public.lease_credit_purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_lease_credits_on_purchase();

-- 4. Atomic consume RPC (service_role only) -----------------------------------
-- Claims one credit AND records the debit in one transaction, so a spend is
-- always attributable. p_lease_id is the lease the credit covers (nullable
-- only defensively). Drop the prior single-arg signature first so the RPC has
-- exactly one definition.
DROP FUNCTION IF EXISTS public.consume_lease_credit(uuid);

CREATE OR REPLACE FUNCTION public.consume_lease_credit(
  p_workspace_id uuid,
  p_lease_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.workspaces
  SET purchased_lease_credits = purchased_lease_credits - 1
  WHERE id = p_workspace_id
    AND purchased_lease_credits > 0
  RETURNING true INTO v_claimed;

  IF COALESCE(v_claimed, false) THEN
    INSERT INTO public.lease_credit_consumptions (workspace_id, lease_id)
    VALUES (p_workspace_id, p_lease_id);
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

ALTER FUNCTION public.consume_lease_credit(uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.consume_lease_credit(uuid, uuid) IS
  'Atomically spends one single-lease credit (UPDATE guarded by > 0, so '
  'concurrent uploads cannot double-spend) AND writes a lease_credit_consumptions '
  'debit row linking it to p_lease_id. Called only by process_lease '
  '(service_role) when a workspace is over its caps. Returns true if a credit '
  'was claimed.';

-- Only service_role may execute — an authenticated user must never be able to
-- spend (or probe) credits directly.
REVOKE ALL ON FUNCTION public.consume_lease_credit(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_lease_credit(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.consume_lease_credit(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_lease_credit(uuid, uuid) TO service_role;

-- 5. Re-derive the entitlement guard to cover purchased_lease_credits ---------
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
  'documents_used, addon_document_capacity, purchased_lease_credits, '
  'billing_interval, stripe_customer_id, stripe_subscription_id, '
  'subscription_status, subscription_period_end, max_archived_leases. '
  'intended_plan is intentionally NOT guarded (Onboarding writes it; '
  'abandoned-checkout recovery). Only service_role (Stripe webhook/cron) may '
  'write these columns; migrations that must touch them run under service_role '
  'or DISABLE this trigger.';

DROP TRIGGER IF EXISTS enforce_workspace_entitlement_guard ON public.workspaces;
CREATE TRIGGER enforce_workspace_entitlement_guard
  BEFORE INSERT OR UPDATE ON public.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_workspace_entitlement_edits();
