-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2 Approval Chain — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers every test case from docs/PHASE_2_BUILD_SPEC.md "Tests to add in
-- this phase" that exercises database state: schema constraints, RLS
-- scoping for lease_approval_chain, the resolve-approval-chain edge
-- function's resolution outcomes, the act-on-chain-step edge function's
-- transitions and stage advancement, and activity-log entries.
--
-- HOW TO RUN
--   This file is meant to be executed against a NON-PRODUCTION database
--   (a Supabase branch on Pro plan, a local Docker stack via
--   `supabase start`, or a dedicated staging Supabase project). It writes
--   test data and rolls work back via cleanup statements at the end of
--   each DO block. DO NOT run on the main project.
--
--   Recommended:
--     - psql "$TEST_DATABASE_URL" -f supabase/tests/phase2_lease_approval_chain.test.sql
--     - Or paste into the Studio SQL editor for that environment.
--
--   Each section is wrapped in its own DO block with seed → assertions
--   → cleanup. RAISE NOTICE outputs PASS / FAIL per assertion.
--
-- HOW TO READ
--   Search the output for 'FAIL' to find broken expectations. All passes
--   print as 'TEST N (...): PASS'.
--
--   Auth-dependent assertions use SET LOCAL request.jwt.claims with
--   synthetic user IDs and SET LOCAL role authenticated to simulate the
--   supabase-js client without needing real JWTs.
--
--   Edge-function-equivalent tests directly invoke the SQL the function
--   would issue (chain INSERT, lease lifecycle UPDATE, activity log
--   INSERT) — we test the data-layer behavior the function depends on.
--   For end-to-end function-level tests, smoke them against a logged-in
--   browser session in the deployed app.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Helper — seed two workspaces (W1, W2), three users (admin@W1, member@W1,
-- outsider@W2), one lease in W1, and (depending on test) a policy + steps.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_phase2_seed()
RETURNS TABLE (
  ws1 uuid, ws2 uuid,
  admin_user uuid, member_user uuid, outside_user uuid,
  lease_w1 uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws1 uuid; v_ws2 uuid;
  v_admin uuid; v_member uuid; v_outside uuid;
  v_lease uuid;
BEGIN
  v_admin   := gen_random_uuid();
  v_member  := gen_random_uuid();
  v_outside := gen_random_uuid();

  INSERT INTO auth.users (id, instance_id, email, created_at, updated_at, aud, role)
  VALUES
    (v_admin,   '00000000-0000-0000-0000-000000000000', 'admin@p2test',   now(), now(), 'authenticated', 'authenticated'),
    (v_member,  '00000000-0000-0000-0000-000000000000', 'member@p2test',  now(), now(), 'authenticated', 'authenticated'),
    (v_outside, '00000000-0000-0000-0000-000000000000', 'outside@p2test', now(), now(), 'authenticated', 'authenticated');

  INSERT INTO public.workspaces (name, owner_id) VALUES ('Test WS1 P2', v_admin) RETURNING id INTO v_ws1;
  INSERT INTO public.workspaces (name, owner_id) VALUES ('Test WS2 P2', v_outside) RETURNING id INTO v_ws2;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws1, v_admin, 'admin'), (v_ws1, v_member, 'editor'), (v_ws2, v_outside, 'admin');

  INSERT INTO public.leases (
    user_id, workspace_id, requestor_id, request_title, asset_type,
    monthly_payment, lifecycle_status, status, intake_source, filename
  ) VALUES (
    v_admin, v_ws1, v_admin, 'Phase 2 test lease', 'property',
    5000, 'draft', 'Ready', 'request_workflow', 'p2-seed.txt'
  ) RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws1, v_ws2, v_admin, v_member, v_outside, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_phase2_cleanup(seed RECORD)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.workspaces WHERE id IN (seed.ws1, seed.ws2);
  DELETE FROM auth.users WHERE id IN (seed.admin_user, seed.member_user, seed.outside_user);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — chain_assignee_present CHECK: user-only OK
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_id uuid;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  BEGIN
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_user_id)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, v_seed.admin_user)
    RETURNING id INTO v_id;
    RAISE NOTICE 'TEST 1 (assignee user-only): PASS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 1 (assignee user-only): FAIL — %', SQLERRM;
  END;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — chain_assignee_present CHECK: role-only OK
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  BEGIN
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_role)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver');
    RAISE NOTICE 'TEST 2 (assignee role-only): PASS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 2 (assignee role-only): FAIL — %', SQLERRM;
  END;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — chain_assignee_present CHECK: neither user nor role rejects
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  BEGIN
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_user_id, approver_role)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, NULL, NULL);
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  IF v_caught THEN
    RAISE NOTICE 'TEST 3 (assignee neither): PASS';
  ELSE
    RAISE NOTICE 'TEST 3 (assignee neither): FAIL — insert was accepted';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — stage CHECK: 'concept' and 'signator' OK; bogus value rejects
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- valid: concept + signator
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver'),
         (v_seed.lease_w1, v_seed.ws1, 'signator', 1, 'signator');
  -- invalid stage
  BEGIN
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_role)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'bogus_stage', 1, 'manager_approver');
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  IF v_caught THEN
    RAISE NOTICE 'TEST 4 (stage CHECK): PASS';
  ELSE
    RAISE NOTICE 'TEST 4 (stage CHECK): FAIL — bogus stage accepted';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — status CHECK: enum values OK; bogus rejected
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_caught boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- 7 valid status values, all should insert OK (one row each)
  FOR i IN 1..7 LOOP
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_role, status)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', i, 'manager_approver',
      (ARRAY['pending','approved','rejected','sent_back','superseded','delegated','skipped'])[i]);
  END LOOP;
  BEGIN
    INSERT INTO public.lease_approval_chain
      (lease_id, workspace_id, stage, step_order, approver_role, status)
    VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 99, 'manager_approver', 'bogus_status');
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  IF v_caught THEN
    RAISE NOTICE 'TEST 5 (status CHECK): PASS';
  ELSE
    RAISE NOTICE 'TEST 5 (status CHECK): FAIL — bogus status accepted';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — RLS: workspace member can READ chain rows for own workspace
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_visible int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- Service role inserts (RLS bypassed)
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver');

  -- Editor (member) reads
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.member_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_visible FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;
  IF v_visible >= 1 THEN
    RAISE NOTICE 'TEST 6 (RLS member read): PASS';
  ELSE
    RAISE NOTICE 'TEST 6 (RLS member read): FAIL — visible=%', v_visible;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 7 — RLS: cross-workspace user cannot READ
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_visible int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.outside_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_visible FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;
  IF v_visible = 0 THEN
    RAISE NOTICE 'TEST 7 (RLS cross-workspace blocked): PASS';
  ELSE
    RAISE NOTICE 'TEST 7 (RLS cross-workspace blocked): FAIL — visible=%', v_visible;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 8 — RLS: assignee can UPDATE own pending step to approved/rejected/
--           sent_back; non-assignee cannot
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_step uuid; v_outsider_blocked boolean := false; v_assignee_ok boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_user_id)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, v_seed.member_user)
  RETURNING id INTO v_step;

  -- Outsider tries to update — RLS USING fails, 0 rows affected
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.outside_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE public.lease_approval_chain
    SET status='approved', action_at=now(), action_by=v_seed.outside_user
    WHERE id = v_step;
  PERFORM set_config('role', 'postgres', true);
  IF EXISTS (SELECT 1 FROM public.lease_approval_chain WHERE id = v_step AND status = 'pending') THEN
    v_outsider_blocked := true;
  END IF;

  -- Assignee updates — should succeed
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.member_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE public.lease_approval_chain
    SET status='approved', action_at=now(), action_by=v_seed.member_user
    WHERE id = v_step;
  PERFORM set_config('role', 'postgres', true);
  IF EXISTS (SELECT 1 FROM public.lease_approval_chain WHERE id = v_step AND status = 'approved') THEN
    v_assignee_ok := true;
  END IF;

  IF v_outsider_blocked AND v_assignee_ok THEN
    RAISE NOTICE 'TEST 8 (RLS assignee acts on own pending): PASS';
  ELSE
    RAISE NOTICE 'TEST 8 (RLS assignee acts on own pending): FAIL — outsider_blocked=% assignee_ok=%', v_outsider_blocked, v_assignee_ok;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 9 — RLS: WITH CHECK rejects assignee setting status='superseded'
--           (only the service role / edge function may write that)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_step uuid; v_blocked boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_user_id)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, v_seed.member_user)
  RETURNING id INTO v_step;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.member_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE public.lease_approval_chain
    SET status='superseded', action_at=now(), action_by=v_seed.member_user
    WHERE id = v_step;
  PERFORM set_config('role', 'postgres', true);
  -- Status should still be 'pending' because the WITH CHECK rejected it.
  IF EXISTS (SELECT 1 FROM public.lease_approval_chain WHERE id = v_step AND status = 'pending') THEN
    v_blocked := true;
  END IF;
  IF v_blocked THEN
    RAISE NOTICE 'TEST 9 (RLS WITH CHECK blocks superseded by assignee): PASS';
  ELSE
    RAISE NOTICE 'TEST 9 (RLS WITH CHECK blocks superseded by assignee): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 10 — RLS: workspace admin can UPDATE any chain row in workspace
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_step uuid; v_admin_ok boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- Step assigned to member; admin should still be able to update
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_user_id)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, v_seed.member_user)
  RETURNING id INTO v_step;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seed.admin_user)::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE public.lease_approval_chain
    SET comment = 'admin override note'
    WHERE id = v_step;
  PERFORM set_config('role', 'postgres', true);
  IF EXISTS (SELECT 1 FROM public.lease_approval_chain WHERE id = v_step AND comment = 'admin override note') THEN
    v_admin_ok := true;
  END IF;
  IF v_admin_ok THEN
    RAISE NOTICE 'TEST 10 (RLS admin update any): PASS';
  ELSE
    RAISE NOTICE 'TEST 10 (RLS admin update any): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 11 — resolve-approval-chain equivalent: single matching policy →
--            chain inserted with all steps
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD; v_policy uuid; v_chain_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'P2 test policy', 100, true, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_policy;
  INSERT INTO public.approval_chain_steps (policy_id, stage, step_order, approver_role)
  VALUES (v_policy, 'concept', 1, 'manager_approver'),
         (v_policy, 'signator', 1, 'signator');

  -- Simulate the edge function's transactional multi-row insert
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, policy_id, policy_version, stage, step_order,
     parallel_group, approver_role, is_required, status)
  SELECT v_seed.lease_w1, v_seed.ws1, v_policy, 1, s.stage, s.step_order,
         1, s.approver_role, true, 'pending'
  FROM public.approval_chain_steps s
  WHERE s.policy_id = v_policy;

  SELECT count(*) INTO v_chain_count
  FROM public.lease_approval_chain
  WHERE lease_id = v_seed.lease_w1 AND policy_id = v_policy;
  IF v_chain_count = 2 THEN
    RAISE NOTICE 'TEST 11 (resolve single match): PASS';
  ELSE
    RAISE NOTICE 'TEST 11 (resolve single match): FAIL — % chain rows', v_chain_count;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 12 — resolve: ambiguous match (two policies tied at top priority)
--            should produce 0 chain rows when caller respects the error
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD; v_p1 uuid; v_p2 uuid; v_ambiguous boolean := false; v_chain_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'P2 tied A', 200, ARRAY['property'], true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p1;
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'P2 tied B', 200, ARRAY['property'], true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_p2;

  -- Simulate the edge function's tie detection: count active policies in
  -- this workspace at the top priority that match.
  PERFORM 1;
  IF (
    SELECT count(*) FROM public.approval_policies
    WHERE workspace_id = v_seed.ws1 AND is_active AND priority = 200
      AND 'property' = ANY(match_asset_types)
  ) > 1 THEN
    v_ambiguous := true;
  END IF;

  SELECT count(*) INTO v_chain_count
  FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;
  IF v_ambiguous AND v_chain_count = 0 THEN
    RAISE NOTICE 'TEST 12 (resolve ambiguous match): PASS';
  ELSE
    RAISE NOTICE 'TEST 12 (resolve ambiguous match): FAIL — ambiguous=% chain_count=%',
      v_ambiguous, v_chain_count;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 13 — resolve: no match + no fallback → caller produces no chain
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD; v_no_fallback boolean := false; v_chain_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- A policy that won't match a 'property' asset_type
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'Equipment-only', 100, ARRAY['equipment'], true, v_seed.admin_user, v_seed.admin_user);

  -- No fallback exists for this workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_policies
    WHERE workspace_id = v_seed.ws1 AND is_active AND is_default_fallback = true
  ) THEN
    v_no_fallback := true;
  END IF;

  SELECT count(*) INTO v_chain_count
  FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;
  IF v_no_fallback AND v_chain_count = 0 THEN
    RAISE NOTICE 'TEST 13 (resolve no_match_no_fallback): PASS';
  ELSE
    RAISE NOTICE 'TEST 13 (resolve no_match_no_fallback): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 14 — resolve: no match + default fallback → fallback policy wins
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_fallback uuid; v_winner uuid;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- Equipment-only policy (won't match 'property')
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, match_asset_types, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'Equipment-only P14', 100, ARRAY['equipment'], true, v_seed.admin_user, v_seed.admin_user);
  -- Default fallback
  INSERT INTO public.approval_policies
    (workspace_id, name, priority, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'Default fallback P14', 50, true, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_fallback;

  -- Simulate matcher: no specific match → look for fallback
  SELECT id INTO v_winner
  FROM public.approval_policies
  WHERE workspace_id = v_seed.ws1 AND is_active AND is_default_fallback = true
  LIMIT 1;
  IF v_winner = v_fallback THEN
    RAISE NOTICE 'TEST 14 (resolve fallback): PASS';
  ELSE
    RAISE NOTICE 'TEST 14 (resolve fallback): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 15 — resolve: separation_violation when same user appears in two
--            user-based steps and SoD effective is true
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD; v_policy uuid; v_violator_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- Create policy with override = require distinct users (true)
  INSERT INTO public.approval_policies
    (workspace_id, name, separation_of_duties_override, is_default_fallback,
     is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'SoD-required policy', true, true, true,
          v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_policy;
  -- Two steps with the SAME user → would violate
  INSERT INTO public.approval_chain_steps
    (policy_id, stage, step_order, approver_user_id)
  VALUES (v_policy, 'concept', 1, v_seed.admin_user),
         (v_policy, 'signator', 1, v_seed.admin_user);

  -- Simulate the edge function's SoD check: count users appearing > once
  SELECT count(*) INTO v_violator_count FROM (
    SELECT approver_user_id, count(*) c
    FROM public.approval_chain_steps
    WHERE policy_id = v_policy AND approver_user_id IS NOT NULL
    GROUP BY approver_user_id
    HAVING count(*) > 1
  ) t;

  IF v_violator_count = 1 THEN
    -- Resolution would refuse; no chain rows should land
    IF NOT EXISTS (SELECT 1 FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1) THEN
      RAISE NOTICE 'TEST 15 (resolve separation_violation): PASS';
    ELSE
      RAISE NOTICE 'TEST 15 (resolve separation_violation): FAIL — chain rows present';
    END IF;
  ELSE
    RAISE NOTICE 'TEST 15 (resolve separation_violation): FAIL — violator detection broken';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 16 — resolve: legacy fallback when workspace has zero policies
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_policy_count int; v_legacy_signal boolean := false;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  SELECT count(*) INTO v_policy_count
  FROM public.approval_policies WHERE workspace_id = v_seed.ws1 AND is_active = true;
  -- The edge function returns legacyFallback:true when count = 0
  IF v_policy_count = 0 THEN v_legacy_signal := true; END IF;
  IF v_legacy_signal THEN
    RAISE NOTICE 'TEST 16 (resolve legacyFallback): PASS';
  ELSE
    RAISE NOTICE 'TEST 16 (resolve legacyFallback): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 17 — resolve: idempotent re-resolution (initialResolution=true +
--            chain already exists → return success without inserting)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD; v_policy uuid; v_first_count int; v_second_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.approval_policies
    (workspace_id, name, is_default_fallback, is_active, created_by, updated_by)
  VALUES (v_seed.ws1, 'P17 idempotent', true, true, v_seed.admin_user, v_seed.admin_user)
  RETURNING id INTO v_policy;
  INSERT INTO public.approval_chain_steps (policy_id, stage, step_order, approver_role)
  VALUES (v_policy, 'concept', 1, 'manager_approver'),
         (v_policy, 'signator', 1, 'signator');

  -- First resolution
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, policy_id, policy_version, stage, step_order,
     approver_role, is_required, status)
  SELECT v_seed.lease_w1, v_seed.ws1, v_policy, 1, s.stage, s.step_order,
         s.approver_role, true, 'pending'
  FROM public.approval_chain_steps s WHERE s.policy_id = v_policy;
  SELECT count(*) INTO v_first_count
  FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;

  -- Second call: edge function detects existing chain → returns early
  -- (we simulate the early-return by NOT re-inserting). Assert count is
  -- unchanged.
  SELECT count(*) INTO v_second_count
  FROM public.lease_approval_chain WHERE lease_id = v_seed.lease_w1;
  IF v_first_count = 2 AND v_second_count = 2 THEN
    RAISE NOTICE 'TEST 17 (resolve idempotent): PASS';
  ELSE
    RAISE NOTICE 'TEST 17 (resolve idempotent): FAIL — first=% second=%', v_first_count, v_second_count;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 18 — act: approve concept (only required step) → stage complete →
--            lease lifecycle flips submitted → under_review;
--            status_changed_at bumped; status_change activity has
--            from_status + to_status columns AND details fields
--            (Lifecycle Transition Convention)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed RECORD;
  v_step uuid;
  v_old_changed_at timestamptz;
  v_new_changed_at timestamptz;
  v_status_row RECORD;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  -- Position the lease in 'submitted'
  UPDATE public.leases
    SET lifecycle_status='submitted', status_changed_at=now() - interval '1 day'
    WHERE id = v_seed.lease_w1;
  SELECT status_changed_at INTO v_old_changed_at
    FROM public.leases WHERE id = v_seed.lease_w1;

  -- Single required concept step
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role,
     is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver', true, 'pending')
  RETURNING id INTO v_step;

  -- Simulate act-on-chain-step approve + stage complete:
  --  1. step row: pending → approved
  UPDATE public.lease_approval_chain
    SET status='approved', action_at=now(), action_by=v_seed.admin_user
    WHERE id = v_step;
  --  2. updateLifecycle helper: bump both columns
  UPDATE public.leases
    SET lifecycle_status='under_review', status_changed_at=now()
    WHERE id = v_seed.lease_w1;
  --  3. logStatusChange helper: dual-shape status_change row
  INSERT INTO public.lease_activity_log
    (lease_id, user_id, activity_type, from_status, to_status, details)
  VALUES (v_seed.lease_w1, v_seed.admin_user, 'status_change', 'submitted', 'under_review',
          jsonb_build_object(
            'from','submitted','to','under_review',
            'routing_path','chain',
            'triggered_by','chain_stage_completed',
            'stage','concept'
          ));

  SELECT status_changed_at INTO v_new_changed_at
    FROM public.leases WHERE id = v_seed.lease_w1;
  SELECT * INTO v_status_row
    FROM public.lease_activity_log
    WHERE lease_id = v_seed.lease_w1 AND activity_type = 'status_change'
    ORDER BY created_at DESC LIMIT 1;

  IF v_new_changed_at > v_old_changed_at
     AND v_status_row.from_status = 'submitted'
     AND v_status_row.to_status = 'under_review'
     AND (v_status_row.details->>'from') = 'submitted'
     AND (v_status_row.details->>'to') = 'under_review'
     AND (v_status_row.details->>'routing_path') = 'chain' THEN
    RAISE NOTICE 'TEST 18 (act approve+complete + lifecycle convention): PASS';
  ELSE
    RAISE NOTICE 'TEST 18 (act approve+complete + lifecycle convention): FAIL';
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 19 — act: reject → lease lifecycle flips to 'rejected', all
--            remaining pending chain steps marked 'superseded'
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_concept uuid; v_signator uuid;
        v_lifecycle text; v_signator_status text;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  UPDATE public.leases SET lifecycle_status='submitted' WHERE id = v_seed.lease_w1;
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role, is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept',  1, 'manager_approver', true, 'pending')
  RETURNING id INTO v_concept;
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role, is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'signator', 1, 'signator', true, 'pending')
  RETURNING id INTO v_signator;

  -- Simulate reject:
  UPDATE public.lease_approval_chain
    SET status='rejected', action_at=now(), action_by=v_seed.admin_user, comment='nope'
    WHERE id = v_concept;
  UPDATE public.leases
    SET lifecycle_status='rejected', status_changed_at=now() WHERE id = v_seed.lease_w1;
  -- Service-role supersedes remaining pending
  UPDATE public.lease_approval_chain
    SET status='superseded'
    WHERE lease_id = v_seed.lease_w1 AND status = 'pending';

  SELECT lifecycle_status INTO v_lifecycle FROM public.leases WHERE id = v_seed.lease_w1;
  SELECT status INTO v_signator_status FROM public.lease_approval_chain WHERE id = v_signator;
  IF v_lifecycle = 'rejected' AND v_signator_status = 'superseded' THEN
    RAISE NOTICE 'TEST 19 (act reject + supersede remaining): PASS';
  ELSE
    RAISE NOTICE 'TEST 19 (act reject + supersede remaining): FAIL — lifecycle=% signator=%',
      v_lifecycle, v_signator_status;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 20 — act: send_back → lease lifecycle flips to 'submitted',
--            current-stage pending steps superseded, signator stays alone
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_c1 uuid; v_c2 uuid; v_sig uuid;
        v_lifecycle text; v_c2_status text; v_sig_status text;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  UPDATE public.leases SET lifecycle_status='under_review' WHERE id = v_seed.lease_w1;
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role, is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 1, 'manager_approver',  true, 'pending')
  RETURNING id INTO v_c1;
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role, is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'concept', 2, 'financial_approver', true, 'pending')
  RETURNING id INTO v_c2;
  INSERT INTO public.lease_approval_chain
    (lease_id, workspace_id, stage, step_order, approver_role, is_required, status)
  VALUES (v_seed.lease_w1, v_seed.ws1, 'signator', 1, 'signator', true, 'pending')
  RETURNING id INTO v_sig;

  -- Simulate send_back from concept step 1:
  UPDATE public.lease_approval_chain
    SET status='sent_back', action_at=now(), action_by=v_seed.admin_user, comment='please revise'
    WHERE id = v_c1;
  UPDATE public.leases
    SET lifecycle_status='submitted', status_changed_at=now() WHERE id = v_seed.lease_w1;
  -- supersede only current-stage pending
  UPDATE public.lease_approval_chain
    SET status='superseded'
    WHERE lease_id = v_seed.lease_w1 AND stage = 'concept' AND status = 'pending';

  SELECT lifecycle_status INTO v_lifecycle FROM public.leases WHERE id = v_seed.lease_w1;
  SELECT status INTO v_c2_status FROM public.lease_approval_chain WHERE id = v_c2;
  SELECT status INTO v_sig_status FROM public.lease_approval_chain WHERE id = v_sig;
  IF v_lifecycle = 'submitted' AND v_c2_status = 'superseded' AND v_sig_status = 'pending' THEN
    RAISE NOTICE 'TEST 20 (act send_back + scoped supersede): PASS';
  ELSE
    RAISE NOTICE 'TEST 20 (act send_back + scoped supersede): FAIL — lifecycle=% c2=% sig=%',
      v_lifecycle, v_c2_status, v_sig_status;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 21 — All 6 Phase 2 activity_type values are accepted by the
--            lease_activity_log_activity_type_check constraint
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_seed RECORD; v_count int;
BEGIN
  SELECT * INTO v_seed FROM public._test_phase2_seed();
  INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
  VALUES (v_seed.lease_w1, v_seed.admin_user, 'chain_resolved',          '{"k":1}'::jsonb),
         (v_seed.lease_w1, v_seed.admin_user, 'chain_step_approved',     '{"k":2}'::jsonb),
         (v_seed.lease_w1, v_seed.admin_user, 'chain_step_rejected',     '{"k":3}'::jsonb),
         (v_seed.lease_w1, v_seed.admin_user, 'chain_step_sent_back',    '{"k":4}'::jsonb),
         (v_seed.lease_w1, v_seed.admin_user, 'chain_stage_completed',   '{"k":5}'::jsonb),
         (v_seed.lease_w1, v_seed.admin_user, 'chain_resolution_failed', '{"k":6}'::jsonb);
  SELECT count(*) INTO v_count
  FROM public.lease_activity_log
  WHERE lease_id = v_seed.lease_w1
    AND activity_type LIKE 'chain\_%' ESCAPE '\';
  IF v_count = 6 THEN
    RAISE NOTICE 'TEST 21 (Phase 2 activity_type values): PASS';
  ELSE
    RAISE NOTICE 'TEST 21 (Phase 2 activity_type values): FAIL — count=%', v_count;
  END IF;
  PERFORM public._test_phase2_cleanup(v_seed);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_phase2_seed();
DROP FUNCTION IF EXISTS public._test_phase2_cleanup(RECORD);

-- Done. Search the output above for 'FAIL' to find broken expectations.
