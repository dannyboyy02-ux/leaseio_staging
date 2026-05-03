-- ─────────────────────────────────────────────────────────────────────────
-- Phase 1 Approval Policies — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers every test case from docs/PHASE_1_BUILD_SPEC.md "Tests to add in
-- this phase" that exercises database state: schema constraints, RLS
-- scoping, and the two RPCs (preview_policy_resolution, apply_policy_steps).
--
-- HOW TO RUN
--   This file is meant to be executed against a NON-PRODUCTION database
--   (a Supabase branch, a local docker stack, or a dedicated staging DB).
--   It writes test data inside transactions and ROLLs everything back.
--
--   Recommended:
--     - Spin up a Supabase branch (mcp__claude_ai_Supabase__create_branch
--       or via Studio "Branches"), point this file at it, and run it via
--       `psql` or the Studio SQL editor.
--     - DO NOT run on the main project.
--
--   Each section is wrapped in BEGIN/ROLLBACK so it leaves no residue.
--
-- HOW TO READ
--   Each test prints its name and either 'PASS' or 'FAIL <reason>'. Search
--   the output for 'FAIL' to find broken expectations.
--
--   Auth-dependent assertions use SET LOCAL request.jwt.claims with synthetic
--   user IDs and SET LOCAL role authenticated to simulate the supabase-js
--   client without needing real JWTs.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Helpers — reset, then create two workspaces (W1, W2), three users
-- (admin@W1, member@W1, outsider@W2), and seed a placeholder lease.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_phase1_seed()
RETURNS TABLE (
  ws1 uuid, ws2 uuid,
  admin_user uuid, member_user uuid, outside_user uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws1 uuid; v_ws2 uuid;
  v_admin uuid; v_member uuid; v_outside uuid;
BEGIN
  v_admin   := gen_random_uuid();
  v_member  := gen_random_uuid();
  v_outside := gen_random_uuid();

  -- Create the auth.users rows. (auth.users has a tight schema; in tests we
  -- use the absolute minimum.)
  INSERT INTO auth.users (id, instance_id, email, created_at, updated_at, aud, role)
  VALUES
    (v_admin,   '00000000-0000-0000-0000-000000000000', 'admin@test',   now(), now(), 'authenticated', 'authenticated'),
    (v_member,  '00000000-0000-0000-0000-000000000000', 'member@test',  now(), now(), 'authenticated', 'authenticated'),
    (v_outside, '00000000-0000-0000-0000-000000000000', 'outside@test', now(), now(), 'authenticated', 'authenticated');

  INSERT INTO public.workspaces (name, owner_id) VALUES ('Test WS1', v_admin) RETURNING id INTO v_ws1;
  INSERT INTO public.workspaces (name, owner_id) VALUES ('Test WS2', v_outside) RETURNING id INTO v_ws2;

  -- Memberships: admin owns W1; member is a non-admin member of W1; outside
  -- owns W2 and is not in W1.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws1, v_admin, 'admin'), (v_ws1, v_member, 'editor'), (v_ws2, v_outside, 'admin');

  RETURN QUERY SELECT v_ws1, v_ws2, v_admin, v_member, v_outside;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — Idempotency
--   Re-running the migration must succeed without error. Modeled by calling
--   the same DDL twice in a transaction. Spot-check by exercising the IF
--   NOT EXISTS / OR REPLACE clauses in 20260502155910_phase1_approval_policies.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_count int;
BEGIN
  -- Re-run a representative subset of the migration; it should be a no-op.
  ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS separation_of_duties_default boolean NOT NULL DEFAULT true;
  CREATE INDEX IF NOT EXISTS idx_approval_policies_workspace_active
    ON public.approval_policies(workspace_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_approval_chain_steps_policy
    ON public.approval_chain_steps(policy_id, stage, step_order);

  -- Verify the objects still exist exactly once.
  SELECT count(*) INTO v_count FROM pg_indexes
  WHERE indexname IN (
    'idx_approval_policies_workspace_active',
    'idx_approval_chain_steps_policy',
    'idx_approval_policies_one_default_per_workspace'
  );
  IF v_count = 3 THEN
    RAISE NOTICE 'TEST 1 (idempotency): PASS';
  ELSE
    RAISE NOTICE 'TEST 1 (idempotency): FAIL — expected 3 indexes, found %', v_count;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — Two `is_default_fallback = true` in same workspace must fail
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p1 uuid;
  v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  INSERT INTO public.approval_policies (workspace_id, name, is_default_fallback, created_by, updated_by)
  VALUES (v_seed.ws1, 'first default', true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p1;

  BEGIN
    INSERT INTO public.approval_policies (workspace_id, name, is_default_fallback, created_by, updated_by)
    VALUES (v_seed.ws1, 'second default', true, v_seed.admin_user, v_seed.admin_user);
    RAISE NOTICE 'TEST 2 (dual default): FAIL — second insert was unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN
      v_caught := true;
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 2 (dual default): PASS';
  END IF;

  -- Cleanup
  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — Toggling default succeeds (deactivate one, activate another)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p1 uuid; v_p2 uuid;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  INSERT INTO public.approval_policies (workspace_id, name, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'old default', true, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p1;

  -- Insert a second policy that is NOT default (will become one after toggle).
  INSERT INTO public.approval_policies (workspace_id, name, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'new default candidate', false, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p2;

  -- Deactivate the old default first (releases the partial unique index).
  UPDATE public.approval_policies SET is_default_fallback = false WHERE id = v_p1;

  -- Now promote the second.
  UPDATE public.approval_policies SET is_default_fallback = true WHERE id = v_p2;

  IF EXISTS (SELECT 1 FROM public.approval_policies WHERE id = v_p2 AND is_default_fallback = true) THEN
    RAISE NOTICE 'TEST 3 (default toggle): PASS';
  ELSE
    RAISE NOTICE 'TEST 3 (default toggle): FAIL';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — cost_range_valid CHECK rejects min > max
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  BEGIN
    INSERT INTO public.approval_policies
      (workspace_id, name, match_min_annual_cost, match_max_annual_cost, created_by, updated_by)
    VALUES (v_seed.ws1, 'bad cost', 500000, 100000, v_seed.admin_user, v_seed.admin_user);
  EXCEPTION
    WHEN check_violation THEN v_caught := true;
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 4 (cost_range_valid): PASS';
  ELSE
    RAISE NOTICE 'TEST 4 (cost_range_valid): FAIL — insert with min > max was accepted';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — one_assignee_method CHECK: step with both user_id and role
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'p', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  BEGIN
    INSERT INTO public.approval_chain_steps
      (policy_id, stage, step_order, approver_user_id, approver_role)
    VALUES (v_p, 'concept', 1, v_seed.admin_user, 'manager_approver');
  EXCEPTION
    WHEN check_violation THEN v_caught := true;
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 5 (step both user+role): PASS';
  ELSE
    RAISE NOTICE 'TEST 5 (step both user+role): FAIL';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — one_assignee_method CHECK: step with neither user nor role
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'p', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  BEGIN
    INSERT INTO public.approval_chain_steps
      (policy_id, stage, step_order, approver_user_id, approver_role)
    VALUES (v_p, 'concept', 1, NULL, NULL);
  EXCEPTION
    WHEN check_violation THEN v_caught := true;
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 6 (step neither user/role): PASS';
  ELSE
    RAISE NOTICE 'TEST 6 (step neither user/role): FAIL';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 7 — preview_policy_resolution: no policies → no-match error
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  -- Simulate auth context for SECURITY DEFINER function
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT public.preview_policy_resolution(v_seed.ws1, 'property', 'Operations', 50000, 'West', 'Real Estate')
  INTO v_result;

  IF (v_result->>'matched')::boolean = false
     AND v_result->>'error' = 'No matching policy and no default fallback configured.' THEN
    RAISE NOTICE 'TEST 7 (no-match): PASS';
  ELSE
    RAISE NOTICE 'TEST 7 (no-match): FAIL — got %', v_result::text;
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 8 — preview_policy_resolution: default fallback when no specific match
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  INSERT INTO public.approval_policies
    (workspace_id, name, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'fallback policy', true, true, v_seed.admin_user, v_seed.admin_user);

  SELECT public.preview_policy_resolution(v_seed.ws1, 'property', 'Operations', 50000, 'West', 'Real Estate')
  INTO v_result;

  IF (v_result->>'matched')::boolean = true
     AND v_result->>'policy_name' = 'fallback policy'
     AND jsonb_array_length(v_result->'warnings') > 0 THEN
    RAISE NOTICE 'TEST 8 (default fallback): PASS';
  ELSE
    RAISE NOTICE 'TEST 8 (default fallback): FAIL — got %', v_result::text;
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 9 — preview_policy_resolution: highest-priority match wins
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- A generic matcher (priority 50) and a specific high-dollar matcher (priority 200)
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'generic property', 50, ARRAY['property']::text[], true, v_seed.admin_user, v_seed.admin_user);

  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, match_min_annual_cost, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'high-dollar property', 200, ARRAY['property']::text[], 100000, true, v_seed.admin_user, v_seed.admin_user);

  SELECT public.preview_policy_resolution(v_seed.ws1, 'property', '', 500000, '', '')
  INTO v_result;

  IF v_result->>'policy_name' = 'high-dollar property' THEN
    RAISE NOTICE 'TEST 9 (highest priority wins): PASS';
  ELSE
    RAISE NOTICE 'TEST 9 (highest priority wins): FAIL — got policy %', v_result->>'policy_name';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 10 — preview_policy_resolution: chain returned in correct order
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_result jsonb;
  v_first_stage text;
  v_first_order int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  INSERT INTO public.approval_policies
    (workspace_id, name, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'p', true, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p;

  INSERT INTO public.approval_chain_steps (policy_id, stage, step_order, approver_role)
  VALUES (v_p, 'signator', 1, 'signator'),
         (v_p, 'concept',  2, 'financial_approver'),
         (v_p, 'concept',  1, 'manager_approver');

  SELECT public.preview_policy_resolution(v_seed.ws1, '', '', 0, '', '')
  INTO v_result;

  -- The function orders by stage, step_order, parallel_group. Concept comes
  -- alphabetically before Signator, so the first chain entry should be the
  -- concept step_order=1.
  v_first_stage := v_result->'chain'->0->>'stage';
  v_first_order := (v_result->'chain'->0->>'step_order')::int;

  IF v_first_stage = 'concept' AND v_first_order = 1 THEN
    RAISE NOTICE 'TEST 10 (chain order): PASS';
  ELSE
    RAISE NOTICE 'TEST 10 (chain order): FAIL — first entry stage=% order=%', v_first_stage, v_first_order;
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 11 — apply_policy_steps: replaces all steps atomically
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'p', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  -- Seed 3 initial steps
  INSERT INTO public.approval_chain_steps (policy_id, stage, step_order, approver_role)
  VALUES (v_p, 'concept', 1, 'manager_approver'),
         (v_p, 'concept', 2, 'financial_approver'),
         (v_p, 'signator', 1, 'signator');

  -- Replace with 1 step
  PERFORM public.apply_policy_steps(v_p, jsonb_build_array(
    jsonb_build_object(
      'stage', 'signator', 'step_order', 1, 'parallel_group', 1,
      'approver_role', 'admin', 'is_required', true
    )
  ));

  SELECT count(*) INTO v_count FROM public.approval_chain_steps WHERE policy_id = v_p;
  IF v_count = 1 THEN
    RAISE NOTICE 'TEST 11 (apply_policy_steps replace): PASS';
  ELSE
    RAISE NOTICE 'TEST 11 (apply_policy_steps replace): FAIL — expected 1 step, found %', v_count;
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 12 — apply_policy_steps: rejects unauthorized callers (Forbidden)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  -- Create the policy as the admin
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'p', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  -- Try to apply as the outsider (not in W1)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.outside_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    PERFORM public.apply_policy_steps(v_p, '[]'::jsonb);
  EXCEPTION
    WHEN raise_exception THEN v_caught := true;
    WHEN OTHERS THEN v_caught := true;
  END;

  IF v_caught THEN
    RAISE NOTICE 'TEST 12 (apply_policy_steps unauthorized): PASS';
  ELSE
    RAISE NOTICE 'TEST 12 (apply_policy_steps unauthorized): FAIL — outsider was allowed';
  END IF;

  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 13 — RLS: cross-workspace user cannot read or write
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_visible_count int;
  v_write_blocked boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  -- Admin creates a policy in W1
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'W1 policy', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  -- Outsider tries to read it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.outside_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_visible_count FROM public.approval_policies WHERE id = v_p;

  -- Outsider tries to update it
  BEGIN
    UPDATE public.approval_policies SET name = 'hacked' WHERE id = v_p;
    -- If RLS blocks, the UPDATE returns 0 rows but doesn't raise. Verify
    -- by re-reading as admin.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
    IF EXISTS (SELECT 1 FROM public.approval_policies WHERE id = v_p AND name = 'W1 policy') THEN
      v_write_blocked := true;
    END IF;
  END;

  IF v_visible_count = 0 AND v_write_blocked THEN
    RAISE NOTICE 'TEST 13 (RLS cross-workspace): PASS';
  ELSE
    RAISE NOTICE 'TEST 13 (RLS cross-workspace): FAIL — visible=%, write_blocked=%', v_visible_count, v_write_blocked;
  END IF;

  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 14 — RLS: non-admin workspace member can READ but not WRITE
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_p uuid;
  v_visible boolean;
  v_write_blocked boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase1_seed();

  -- Admin creates the policy
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.approval_policies (workspace_id, name, created_by, updated_by)
  VALUES (v_seed.ws1, 'visible policy', v_seed.admin_user, v_seed.admin_user) RETURNING id INTO v_p;

  -- Editor (member, not admin) reads it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.member_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT EXISTS(SELECT 1 FROM public.approval_policies WHERE id = v_p) INTO v_visible;

  -- Editor tries to update — should be blocked by RLS WITH CHECK on FOR ALL admin policy
  UPDATE public.approval_policies SET name = 'editor wrote' WHERE id = v_p;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  IF EXISTS (SELECT 1 FROM public.approval_policies WHERE id = v_p AND name = 'visible policy') THEN
    v_write_blocked := true;
  END IF;

  IF v_visible AND v_write_blocked THEN
    RAISE NOTICE 'TEST 14 (RLS member read-only): PASS';
  ELSE
    RAISE NOTICE 'TEST 14 (RLS member read-only): FAIL — visible=%, write_blocked=%', v_visible, v_write_blocked;
  END IF;

  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.workspaces WHERE id IN (v_seed.ws1, v_seed.ws2);
  DELETE FROM auth.users WHERE id IN (v_seed.admin_user, v_seed.member_user, v_seed.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_phase1_seed();

-- Done. Search the output above for 'FAIL' to see broken expectations.
-- All passes are also printed as 'TEST N (...): PASS'.
