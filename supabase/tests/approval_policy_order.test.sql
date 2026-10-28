-- ─────────────────────────────────────────────────────────────────────────
-- set_approval_policy_order() — DB test matrix
-- Migration: supabase/migrations/20260719121000_set_approval_policy_order_rpc.sql
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers what a static test cannot prove: the authorization predicate, the
-- set-equality guard, the (N - i) * 100 assignment, the IS DISTINCT FROM
-- write guard, the audit row, the Vault liveness gate, and — the load-bearing
-- one — that a reorder does NOT bump approval_policies.version (which is what
-- keeps in-flight approvals from being rerouted).
--
-- HOW TO RUN
--   Against a NON-PRODUCTION database only (local `supabase start`, a branch,
--   or a dedicated staging project). Seeds and deletes its own data.
--     psql "$TEST_DATABASE_URL" -f supabase/tests/approval_policy_order.test.sql
--   Search the output for 'FAIL'.
--
-- PREREQUISITE: 20260719120000_approval_policies_version_ignores_priority.sql
--   must be applied. TEST 9 fails loudly if it is not.
--
-- AUTH SIMULATION: each block sets `request.jwt.claims` so auth.uid() returns
-- the acting user, but does NOT switch to the `authenticated` role — the
-- function authorizes on auth.uid(), and keeping the elevated role lets each
-- block seed and clean up. The EXECUTE grant itself is checked in TEST 11.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper — W1 (owner + admin member + editor member), W2 (outsider),
-- four rules in W1 all at the legacy priority 100, created oldest → newest.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_order_seed()
RETURNS TABLE (
  ws1 uuid, ws2 uuid,
  owner_user uuid, admin_user uuid, editor_user uuid, outside_user uuid,
  r_a uuid, r_b uuid, r_c uuid, r_d uuid,
  foreign_rule uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws1 uuid; v_ws2 uuid;
  v_owner uuid; v_admin uuid; v_editor uuid; v_outside uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_foreign uuid;
BEGIN
  v_owner   := gen_random_uuid();
  v_admin   := gen_random_uuid();
  v_editor  := gen_random_uuid();
  v_outside := gen_random_uuid();

  INSERT INTO auth.users (id, instance_id, email, created_at, updated_at, aud, role)
  VALUES
    (v_owner,   '00000000-0000-0000-0000-000000000000', 'order-owner@test',   now(), now(), 'authenticated', 'authenticated'),
    (v_admin,   '00000000-0000-0000-0000-000000000000', 'order-admin@test',   now(), now(), 'authenticated', 'authenticated'),
    (v_editor,  '00000000-0000-0000-0000-000000000000', 'order-editor@test',  now(), now(), 'authenticated', 'authenticated'),
    (v_outside, '00000000-0000-0000-0000-000000000000', 'order-outside@test', now(), now(), 'authenticated', 'authenticated');

  INSERT INTO public.workspaces (name, owner_id) VALUES ('Order WS1', v_owner) RETURNING id INTO v_ws1;
  INSERT INTO public.workspaces (name, owner_id) VALUES ('Order WS2', v_outside) RETURNING id INTO v_ws2;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws1, v_admin, 'admin'), (v_ws1, v_editor, 'editor'), (v_ws2, v_outside, 'admin');

  -- All four at priority 100 — exactly today's live data shape. created_at is
  -- forced so the engine tie-break (created_at ASC) is A → B → C → D.
  INSERT INTO public.approval_policies (workspace_id, name, priority, created_at, created_by, updated_by)
  VALUES (v_ws1, 'Rule A', 100, now() - interval '4 days', v_owner, v_owner) RETURNING id INTO v_a;
  INSERT INTO public.approval_policies (workspace_id, name, priority, created_at, created_by, updated_by)
  VALUES (v_ws1, 'Rule B', 100, now() - interval '3 days', v_owner, v_owner) RETURNING id INTO v_b;
  INSERT INTO public.approval_policies (workspace_id, name, priority, created_at, created_by, updated_by)
  VALUES (v_ws1, 'Rule C', 100, now() - interval '2 days', v_owner, v_owner) RETURNING id INTO v_c;
  INSERT INTO public.approval_policies (workspace_id, name, priority, created_at, created_by, updated_by)
  VALUES (v_ws1, 'Rule D', 100, now() - interval '1 days', v_owner, v_owner) RETURNING id INTO v_d;

  INSERT INTO public.approval_policies (workspace_id, name, priority, created_by, updated_by)
  VALUES (v_ws2, 'Foreign rule', 100, v_outside, v_outside) RETURNING id INTO v_foreign;

  RETURN QUERY SELECT v_ws1, v_ws2, v_owner, v_admin, v_editor, v_outside, v_a, v_b, v_c, v_d, v_foreign;
END;
$$;

-- Explicit uuid parameters (a `record` parameter is not portable across PG
-- versions for PL/pgSQL).
CREATE OR REPLACE FUNCTION public._test_order_cleanup(
  p_ws1 uuid, p_ws2 uuid, p_u1 uuid, p_u2 uuid, p_u3 uuid, p_u4 uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.workspaces WHERE id IN (p_ws1, p_ws2);
  DELETE FROM auth.users WHERE id IN (p_u1, p_u2, p_u3, p_u4);
END;
$$;

CREATE OR REPLACE FUNCTION public._test_act_as(p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — Authorization: outsider and non-admin member are refused; the
--          workspace owner (no member row needed) and an admin member pass.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  s RECORD; v_msg text; v_ids uuid[];
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  v_ids := ARRAY[s.r_a, s.r_b, s.r_c, s.r_d];

  -- Outsider (member of another workspace entirely).
  PERFORM public._test_act_as(s.outside_user);
  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, v_ids);
    RAISE NOTICE 'TEST 1a (outsider refused): FAIL — call was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg = 'Forbidden' THEN RAISE NOTICE 'TEST 1a (outsider refused): PASS';
    ELSE RAISE NOTICE 'TEST 1a (outsider refused): FAIL — got %', v_msg; END IF;
  END;

  -- Non-admin member (editor) — has read access, must not have order access.
  PERFORM public._test_act_as(s.editor_user);
  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, v_ids);
    RAISE NOTICE 'TEST 1b (editor refused): FAIL — call was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg = 'Forbidden' THEN RAISE NOTICE 'TEST 1b (editor refused): PASS';
    ELSE RAISE NOTICE 'TEST 1b (editor refused): FAIL — got %', v_msg; END IF;
  END;

  -- Anonymous (no JWT claim at all).
  PERFORM set_config('request.jwt.claims', NULL, true);
  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, v_ids);
    RAISE NOTICE 'TEST 1c (anonymous refused): FAIL — call was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg = 'Forbidden' THEN RAISE NOTICE 'TEST 1c (anonymous refused): PASS';
    ELSE RAISE NOTICE 'TEST 1c (anonymous refused): FAIL — got %', v_msg; END IF;
  END;

  -- Workspace owner, who has NO workspace_members row.
  PERFORM public._test_act_as(s.owner_user);
  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, v_ids);
    RAISE NOTICE 'TEST 1d (owner allowed): PASS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 1d (owner allowed): FAIL — got %', SQLERRM;
  END;

  -- Admin member.
  PERFORM public._test_act_as(s.admin_user);
  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_b, s.r_a, s.r_c, s.r_d]);
    RAISE NOTICE 'TEST 1e (admin member allowed): PASS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 1e (admin member allowed): FAIL — got %', SQLERRM;
  END;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — Assignment: priority = (N - i) * 100, strictly descending.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_got integer[];
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_d, s.r_c, s.r_b, s.r_a]);

  SELECT ARRAY[
    (SELECT priority FROM public.approval_policies WHERE id = s.r_d),
    (SELECT priority FROM public.approval_policies WHERE id = s.r_c),
    (SELECT priority FROM public.approval_policies WHERE id = s.r_b),
    (SELECT priority FROM public.approval_policies WHERE id = s.r_a)
  ] INTO v_got;

  IF v_got = ARRAY[400, 300, 200, 100] THEN
    RAISE NOTICE 'TEST 2 ((N-i)*100 assignment): PASS';
  ELSE
    RAISE NOTICE 'TEST 2 ((N-i)*100 assignment): FAIL — got %', v_got;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — The all-100 legacy state: the displayed order (engine order) saved
--          unchanged renormalizes without changing the effective order.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_before uuid[]; v_after uuid[];
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  SELECT array_agg(p.id ORDER BY p.priority DESC, p.created_at ASC, p.id ASC) INTO v_before
  FROM public.approval_policies p WHERE p.workspace_id = s.ws1;

  -- Save exactly what the screen shows, moving nothing.
  PERFORM public.set_approval_policy_order(s.ws1, v_before);

  SELECT array_agg(p.id ORDER BY p.priority DESC, p.created_at ASC, p.id ASC) INTO v_after
  FROM public.approval_policies p WHERE p.workspace_id = s.ws1;

  IF v_before = ARRAY[s.r_a, s.r_b, s.r_c, s.r_d] AND v_after = v_before THEN
    RAISE NOTICE 'TEST 3 (all-100 first save is order-preserving): PASS';
  ELSE
    RAISE NOTICE 'TEST 3 (all-100 first save is order-preserving): FAIL — before % after %', v_before, v_after;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — The IS DISTINCT FROM write guard: a single swap of an already
--          normalized set writes exactly two rows, and a no-op writes none.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_res jsonb;
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  -- Normalize first (400/300/200/100).
  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_a, s.r_b, s.r_c, s.r_d]);

  -- Swap the middle pair.
  v_res := public.set_approval_policy_order(s.ws1, ARRAY[s.r_a, s.r_c, s.r_b, s.r_d]);
  IF jsonb_array_length(v_res->'changed') = 2 THEN
    RAISE NOTICE 'TEST 4a (swap writes exactly 2 rows): PASS';
  ELSE
    RAISE NOTICE 'TEST 4a (swap writes exactly 2 rows): FAIL — changed=%', v_res->'changed';
  END IF;

  -- Re-submit the same order: nothing to write.
  v_res := public.set_approval_policy_order(s.ws1, ARRAY[s.r_a, s.r_c, s.r_b, s.r_d]);
  IF jsonb_array_length(v_res->'changed') = 0 AND jsonb_array_length(v_res->'moves') = 0 THEN
    RAISE NOTICE 'TEST 4b (no-op writes nothing): PASS';
  ELSE
    RAISE NOTICE 'TEST 4b (no-op writes nothing): FAIL — %', v_res;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — Set equality: duplicate, omission, extra, and a foreign-workspace
--          id all raise stale_policy_order, and none of them writes.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  s RECORD; v_msg text; v_priorities integer[];
  v_case text; v_arg uuid[];
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  FOR v_case, v_arg IN
    SELECT t.c, t.a FROM (VALUES
      ('duplicate',      ARRAY[s.r_a, s.r_a, s.r_c, s.r_d]),
      ('omission',       ARRAY[s.r_a, s.r_b, s.r_c]),
      ('extra',          ARRAY[s.r_a, s.r_b, s.r_c, s.r_d, gen_random_uuid()]),
      ('foreign id',     ARRAY[s.r_a, s.r_b, s.r_c, s.foreign_rule]),
      ('null element',   ARRAY[s.r_a, s.r_b, s.r_c, NULL::uuid])
    ) AS t(c, a)
  LOOP
    BEGIN
      PERFORM public.set_approval_policy_order(s.ws1, v_arg);
      RAISE NOTICE 'TEST 5 (% rejected): FAIL — call was accepted', v_case;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
      IF v_msg = 'stale_policy_order' THEN
        RAISE NOTICE 'TEST 5 (% rejected): PASS', v_case;
      ELSE
        RAISE NOTICE 'TEST 5 (% rejected): FAIL — got %', v_case, v_msg;
      END IF;
    END;
  END LOOP;

  -- Nothing was written by any rejected call.
  SELECT array_agg(DISTINCT priority) INTO v_priorities
  FROM public.approval_policies WHERE workspace_id = s.ws1;
  IF v_priorities = ARRAY[100] THEN
    RAISE NOTICE 'TEST 5f (rejected calls wrote nothing): PASS';
  ELSE
    RAISE NOTICE 'TEST 5f (rejected calls wrote nothing): FAIL — priorities %', v_priorities;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — A foreign-workspace id can never be repositioned through this RPC
--          (IDOR): calling with W2's own id set against W1 is refused, and
--          W2's rule keeps its priority.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_msg text; v_p integer;
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  BEGIN
    PERFORM public.set_approval_policy_order(s.ws2, ARRAY[s.foreign_rule]);
    RAISE NOTICE 'TEST 6 (cross-workspace refused): FAIL — call was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg = 'Forbidden' THEN RAISE NOTICE 'TEST 6 (cross-workspace refused): PASS';
    ELSE RAISE NOTICE 'TEST 6 (cross-workspace refused): FAIL — got %', v_msg; END IF;
  END;

  SELECT priority INTO v_p FROM public.approval_policies WHERE id = s.foreign_rule;
  IF v_p = 100 THEN
    RAISE NOTICE 'TEST 6b (foreign rule untouched): PASS';
  ELSE
    RAISE NOTICE 'TEST 6b (foreign rule untouched): FAIL — priority %', v_p;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 7 — Audit: one workspace_activity_log row per changing call, none for
--          a no-op, attributed to the acting user.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_rows integer; v_row RECORD;
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.admin_user);

  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_d, s.r_c, s.r_b, s.r_a]);
  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_d, s.r_c, s.r_b, s.r_a]);  -- no-op

  SELECT count(*)::integer INTO v_rows
  FROM public.workspace_activity_log
  WHERE workspace_id = s.ws1 AND event_type = 'approval_rules_reordered';

  SELECT * INTO v_row
  FROM public.workspace_activity_log
  WHERE workspace_id = s.ws1 AND event_type = 'approval_rules_reordered'
  ORDER BY created_at DESC LIMIT 1;

  IF v_rows = 1
     AND v_row.user_id = s.admin_user
     AND jsonb_array_length(v_row.details->'before') = 4
     AND jsonb_array_length(v_row.details->'after') = 4
     AND jsonb_array_length(v_row.details->'moves') > 0
  THEN
    RAISE NOTICE 'TEST 7 (one audit row, attributed, with before/after): PASS';
  ELSE
    RAISE NOTICE 'TEST 7 (one audit row, attributed, with before/after): FAIL — rows=% details=%', v_rows, v_row.details;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 8 — Vault / grace / soft-delete: a non-live workspace cannot reorder.
--          (SECURITY DEFINER bypasses the RESTRICTIVE RLS, so the function
--          re-asserts the gate itself.)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_msg text;
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  -- plan is an entitlement column guarded to service_role; act as the webhook
  -- would, then hand the session back to the owner for the call under test.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE public.workspaces SET plan = 'vault' WHERE id = s.ws1;
  PERFORM public._test_act_as(s.owner_user);

  BEGIN
    PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_d, s.r_c, s.r_b, s.r_a]);
    RAISE NOTICE 'TEST 8 (non-live workspace refused): FAIL — call was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg = 'workspace_not_live' THEN RAISE NOTICE 'TEST 8 (non-live workspace refused): PASS';
    ELSE RAISE NOTICE 'TEST 8 (non-live workspace refused): FAIL — got %', v_msg; END IF;
  END;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 9 — THE IN-FLIGHT SAFETY PROPERTY. A reorder must not bump
--          approval_policies.version. Fails if 20260719120000 (priority out
--          of the version-increment WHEN clause) has not been applied.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_versions integer[];
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_d, s.r_c, s.r_b, s.r_a]);

  SELECT array_agg(DISTINCT version) INTO v_versions
  FROM public.approval_policies WHERE workspace_id = s.ws1;

  IF v_versions = ARRAY[1] THEN
    RAISE NOTICE 'TEST 9 (reorder does not bump version): PASS';
  ELSE
    RAISE NOTICE 'TEST 9 (reorder does not bump version): FAIL — versions % — is 20260719120000 applied?', v_versions;
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 10 — Scope: the call touches no chain / step / lease row.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE s RECORD; v_chain integer; v_steps integer; v_reroutes integer;
BEGIN
  SELECT * INTO s FROM public._test_order_seed();
  PERFORM public._test_act_as(s.owner_user);

  SELECT count(*)::integer INTO v_reroutes FROM public.lease_reroute_events;
  SELECT count(*)::integer INTO v_chain FROM public.lease_approval_chain;
  SELECT count(*)::integer INTO v_steps FROM public.approval_chain_steps;

  PERFORM public.set_approval_policy_order(s.ws1, ARRAY[s.r_c, s.r_a, s.r_d, s.r_b]);

  IF v_reroutes = (SELECT count(*)::integer FROM public.lease_reroute_events)
     AND v_chain = (SELECT count(*)::integer FROM public.lease_approval_chain)
     AND v_steps = (SELECT count(*)::integer FROM public.approval_chain_steps)
  THEN
    RAISE NOTICE 'TEST 10 (no chain/step/reroute writes): PASS';
  ELSE
    RAISE NOTICE 'TEST 10 (no chain/step/reroute writes): FAIL';
  END IF;

  PERFORM public._test_order_cleanup(s.ws1, s.ws2, s.owner_user, s.admin_user, s.editor_user, s.outside_user);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 11 — Grants: authenticated may EXECUTE; anon and PUBLIC may not.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_auth boolean; v_anon boolean; v_public boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.set_approval_policy_order(uuid, uuid[])', 'EXECUTE')
    INTO v_auth;
  SELECT has_function_privilege('anon', 'public.set_approval_policy_order(uuid, uuid[])', 'EXECUTE')
    INTO v_anon;
  -- A grant to PUBLIC shows up as an ACL entry with an empty grantee.
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc pr
    JOIN pg_namespace n ON n.oid = pr.pronamespace
    CROSS JOIN LATERAL unnest(COALESCE(pr.proacl, ARRAY[]::aclitem[])) AS acl
    WHERE n.nspname = 'public'
      AND pr.proname = 'set_approval_policy_order'
      AND acl::text LIKE '=%'
  ) INTO v_public;

  IF v_auth AND NOT v_anon AND NOT v_public THEN
    RAISE NOTICE 'TEST 11 (grants): PASS';
  ELSE
    RAISE NOTICE 'TEST 11 (grants): FAIL — authenticated=% anon=% public=%', v_auth, v_anon, v_public;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Teardown of the test helpers.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_act_as(uuid);
DROP FUNCTION IF EXISTS public._test_order_cleanup(uuid, uuid, uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._test_order_seed();
