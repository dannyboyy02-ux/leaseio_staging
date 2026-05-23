-- ─────────────────────────────────────────────────────────────────────────
-- Workspace entitlement guard — behavioral DB test  (KNOWN_ISSUES #29)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Verifies that migration 20260522000000_restore_workspace_entitlement_guard
-- actually REJECTS the billing-bypass at the database level — not merely that
-- the trigger/policy exist (that is what audit_rls_smoke_check() asserts). This
-- closes the #24-class "behavioral verification" gap for public.workspaces.
--
-- HOW TO RUN
--   NON-PRODUCTION ONLY (Supabase branch / local docker / staging). Each test
--   runs inside BEGIN/ROLLBACK, so seed rows and SET LOCAL role/claims changes
--   leave no residue. Run via psql or the Studio SQL editor.
--
-- HOW TO READ
--   Each test prints 'PASS' or 'FAIL <reason>' via RAISE NOTICE. Grep output
--   for 'FAIL'.
--
--   auth.role() / auth.uid() read from request.jwt.claims, so we simulate the
--   supabase-js client by SET LOCAL request.jwt.claims (and SET LOCAL role
--   authenticated where RLS itself is under test).
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- Helper: create one auth user + one Starter-default workspace they own.
CREATE OR REPLACE FUNCTION public._test_entitlement_seed()
RETURNS TABLE (owner_id uuid, ws_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_ws uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, email, created_at, updated_at, aud, role)
  VALUES (v_owner, '00000000-0000-0000-0000-000000000000', 'owner@test', now(), now(), 'authenticated', 'authenticated');

  -- Seed runs as the connecting role (no JWT claims yet → auth.role() is NULL,
  -- so the INSERT guard enforces): omit billing columns, rely on the Starter
  -- defaults the migration installs. If this INSERT raised, the defaults and
  -- the guard disagree — which is itself a failure the migration must avoid.
  INSERT INTO public.workspaces (name, owner_id) VALUES ('Entitlement Test WS', v_owner)
  RETURNING id INTO v_ws;

  RETURN QUERY SELECT v_owner, v_ws;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — authenticated owner cannot escalate ANY billing column on UPDATE
-- (the literal #29 exploit). Each column attempted independently.
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v RECORD;
  v_blocked int := 0;
  v_total   int := 0;
  v_sql     text;
  -- column -> escalated value the attacker would send
  v_attacks text[][] := ARRAY[
    ARRAY['plan', '''business'''],
    ARRAY['document_limit', '9999'],
    ARRAY['documents_used', '0'],
    ARRAY['billing_interval', '''annual'''],
    ARRAY['stripe_customer_id', '''cus_hacked'''],
    ARRAY['stripe_subscription_id', '''sub_hacked'''],
    ARRAY['subscription_status', '''active'''],
    ARRAY['subscription_period_end', '''2099-01-01'''::text],
    ARRAY['max_archived_leases', '99999']
  ];
  v_attack text[];
BEGIN
  SELECT * INTO v FROM public._test_entitlement_seed();
  -- Force a non-default OLD value for documents_used so the "set back to 0"
  -- attack is a real change (otherwise IS DISTINCT FROM 0 would be false).
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE public.workspaces SET documents_used = 5 WHERE id = v.ws_id;

  -- Now act as the authenticated owner.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v.owner_id, 'role', 'authenticated')::text, true);

  FOREACH v_attack SLICE 1 IN ARRAY v_attacks LOOP
    v_total := v_total + 1;
    v_sql := format('UPDATE public.workspaces SET %I = %s WHERE id = %L',
                    v_attack[1], v_attack[2], v.ws_id);
    BEGIN
      EXECUTE v_sql;
      RAISE NOTICE 'TEST 1 (%): FAIL — escalation accepted', v_attack[1];
    EXCEPTION
      WHEN check_violation THEN v_blocked := v_blocked + 1;
    END;
  END LOOP;

  IF v_blocked = v_total THEN
    RAISE NOTICE 'TEST 1 (billing UPDATE escalation): PASS — all % columns blocked', v_total;
  ELSE
    RAISE NOTICE 'TEST 1 (billing UPDATE escalation): FAIL — only %/% blocked', v_blocked, v_total;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — authenticated owner CAN still edit non-billing settings (no over-block)
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM public._test_entitlement_seed();
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v.owner_id, 'role', 'authenticated')::text, true);

  UPDATE public.workspaces
    SET name = 'Renamed', timezone = 'America/Chicago', default_notification_days = 30
    WHERE id = v.ws_id;

  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = v.ws_id AND name = 'Renamed') THEN
    RAISE NOTICE 'TEST 2 (settings UPDATE allowed): PASS';
  ELSE
    RAISE NOTICE 'TEST 2 (settings UPDATE allowed): FAIL — legitimate settings edit was blocked';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — authenticated INSERT at Starter defaults succeeds (onboarding path);
-- a diverging INSERT (plan=business) is rejected.
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_ok boolean := false;
  v_blocked boolean := false;
BEGIN
  INSERT INTO auth.users (id, instance_id, email, created_at, updated_at, aud, role)
  VALUES (v_owner, '00000000-0000-0000-0000-000000000000', 'newowner@test', now(), now(), 'authenticated', 'authenticated');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- Onboarding-style INSERT: omit billing columns, rely on defaults + intended_plan.
  BEGIN
    INSERT INTO public.workspaces (name, owner_id, intended_plan)
    VALUES ('Onboarding WS', v_owner, 'business');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 3a (onboarding INSERT): FAIL — % / %', SQLERRM, SQLSTATE;
  END;

  -- Diverging INSERT: attacker sets plan directly.
  BEGIN
    INSERT INTO public.workspaces (name, owner_id, plan)
    VALUES ('Cheater WS', v_owner, 'business');
    RAISE NOTICE 'TEST 3b (diverging INSERT): FAIL — divergent plan accepted at creation';
  EXCEPTION
    WHEN check_violation THEN v_blocked := true;
  END;

  IF v_ok AND v_blocked THEN
    RAISE NOTICE 'TEST 3 (INSERT baseline pin): PASS';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — service_role (Stripe webhook) CAN promote entitlements
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM public._test_entitlement_seed();
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE public.workspaces
    SET plan = 'business', document_limit = 50, subscription_status = 'active'
    WHERE id = v.ws_id;

  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = v.ws_id AND plan = 'business' AND document_limit = 50) THEN
    RAISE NOTICE 'TEST 4 (service_role promotion): PASS';
  ELSE
    RAISE NOTICE 'TEST 4 (service_role promotion): FAIL — webhook path was blocked';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — UPDATE policy WITH CHECK blocks ownership reassignment
-- (RLS, so run under SET LOCAL role authenticated).
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v RECORD;
  v_other uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  SELECT * INTO v FROM public._test_entitlement_seed();

  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v.owner_id, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.workspaces SET owner_id = v_other WHERE id = v.ws_id;
    RAISE NOTICE 'TEST 5 (ownership reassignment): FAIL — owner_id reassigned away from self';
  EXCEPTION
    WHEN insufficient_privilege THEN v_caught := true;  -- new row violates RLS WITH CHECK
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 5 (ownership reassignment): PASS';
  END IF;
END $$;
ROLLBACK;

-- Cleanup the helper (kept transaction-local would be cleaner, but CREATE OR
-- REPLACE FUNCTION is committed above; drop it explicitly).
DROP FUNCTION IF EXISTS public._test_entitlement_seed();
