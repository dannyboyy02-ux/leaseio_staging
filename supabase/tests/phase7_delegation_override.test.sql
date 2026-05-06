-- ─────────────────────────────────────────────────────────────────────────
-- Phase 7 Delegation, Override, and Exception Handling — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas + CHECK constraints from
-- supabase/migrations/20260506100000_phase7_delegation_override.sql:
--
--   1. Schema shape — 3 new tables, 4 new chain columns, 7 new
--      indexes, 1 trigger, 4 new CHECK constraints
--   2. user_out_of_office CHECK constraints:
--      - ooo_valid_window rejects starts_at >= ends_at
--      - ooo_no_self_delegation rejects user_id == delegate_user_id
--   3. chain_step_overrides CHECK constraints:
--      - override_reason length(trim()) >= 20 enforced
--      - override_action enum (5 values) enforced
--   4. chain_step_voluntary_delegations CHECK:
--      - vd_no_self_delegation rejects delegated_by == delegated_to
--   5. lease_approval_chain.assignee_resolution_source CHECK:
--      - 6 valid sources accepted; NULL allowed (pre-Phase-7 rows)
--      - bogus values rejected
--   6. 13 new Phase 7 activity types accepted; cross-phase regression
--      sample (legacy + Phases 2-6) still accepted
--   7. Migration idempotency sentinel
--
-- HOW TO RUN
--   psql "$TEST_DATABASE_URL" -f supabase/tests/phase7_delegation_override.test.sql
--
-- HOW TO READ
--   Search for 'FAIL' to find broken expectations.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_p7_seed(p_email text)
RETURNS TABLE (ws uuid, owner_user uuid, lease uuid, chain_step uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid; v_step uuid;
BEGIN
  v_owner := gen_random_uuid();
  INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (v_owner, p_email, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email)
    VALUES (v_owner, p_email)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workspaces (name, owner_id)
    VALUES ('Phase 7 Test ' || substring(v_owner::text, 1, 8), v_owner)
    RETURNING id INTO v_ws;
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (v_ws, v_owner, 'admin');
  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'p7-test-lease.pdf', 'Ready', 'in_negotiation', 'request_workflow'
  )
  RETURNING id INTO v_lease;
  INSERT INTO public.lease_approval_chain (
    lease_id, workspace_id, stage, step_order, parallel_group,
    approver_user_id, is_required, status
  )
  VALUES (v_lease, v_ws, 'concept', 1, 1, v_owner, true, 'pending')
  RETURNING id INTO v_step;

  RETURN QUERY SELECT v_ws, v_owner, v_lease, v_step;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_p7_cleanup(p_owner uuid, p_ws uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ws IS NOT NULL THEN
    DELETE FROM public.lease_activity_log WHERE lease_id IN (SELECT id FROM public.leases WHERE workspace_id = p_ws);
    DELETE FROM public.chain_step_overrides WHERE workspace_id = p_ws;
    DELETE FROM public.chain_step_voluntary_delegations WHERE workspace_id = p_ws;
    DELETE FROM public.user_out_of_office WHERE workspace_id = p_ws;
    DELETE FROM public.lease_approval_chain WHERE workspace_id = p_ws;
    DELETE FROM public.leases WHERE workspace_id = p_ws;
    DELETE FROM public.workspace_members WHERE workspace_id = p_ws;
    DELETE FROM public.workspaces WHERE id = p_ws;
  END IF;
  DELETE FROM public.profiles WHERE id = p_owner;
  DELETE FROM auth.users WHERE id = p_owner;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — schema shape
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE failed int := 0;
BEGIN
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='user_out_of_office') <> 1 THEN
    RAISE NOTICE 'TEST 1.A (user_out_of_office table): FAIL'; failed := failed + 1;
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='chain_step_overrides') <> 1 THEN
    RAISE NOTICE 'TEST 1.B (chain_step_overrides table): FAIL'; failed := failed + 1;
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='chain_step_voluntary_delegations') <> 1 THEN
    RAISE NOTICE 'TEST 1.C (chain_step_voluntary_delegations table): FAIL'; failed := failed + 1;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='lease_approval_chain' AND column_name IN ('pending_since','delegate_activated_at','effective_assignee_user_id','assignee_resolution_source')) <> 4 THEN
    RAISE NOTICE 'TEST 1.D (4 new chain columns): FAIL'; failed := failed + 1;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('ooo_valid_window','ooo_no_self_delegation','vd_no_self_delegation','lease_approval_chain_assignee_source_check')) <> 4 THEN
    RAISE NOTICE 'TEST 1.E (4 new CHECK constraints): FAIL'; failed := failed + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='user_out_of_office_updated_at') THEN
    RAISE NOTICE 'TEST 1.F (OOO updated_at trigger): FAIL'; failed := failed + 1;
  END IF;

  IF failed = 0 THEN RAISE NOTICE 'TEST 1 (schema shape): PASS';
  ELSE RAISE NOTICE 'TEST 1: FAIL — % failures', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — OOO CHECK constraints
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid; v_step uuid;
  v_other uuid := gen_random_uuid();
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease, v_step FROM public._test_p7_seed('p7-ooo@example.test');
  -- Need a second workspace member to be the delegate
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_other, 'p7-ooo-other@x.test', '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (v_other, 'p7-ooo-other@x.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES (v_ws, v_other, 'editor');

  -- A. ooo_valid_window rejects starts >= ends
  BEGIN
    INSERT INTO public.user_out_of_office (user_id, workspace_id, starts_at, ends_at, delegate_user_id)
    VALUES (v_owner, v_ws, '2026-06-10T00:00:00Z'::timestamptz, '2026-06-09T00:00:00Z'::timestamptz, v_other);
    RAISE NOTICE 'TEST 2.A (starts >= ends): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  -- B. ooo_no_self_delegation rejects user_id == delegate_user_id
  BEGIN
    INSERT INTO public.user_out_of_office (user_id, workspace_id, starts_at, ends_at, delegate_user_id)
    VALUES (v_owner, v_ws, '2026-06-10T00:00:00Z'::timestamptz, '2026-06-15T00:00:00Z'::timestamptz, v_owner);
    RAISE NOTICE 'TEST 2.B (self delegation): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  -- C. Valid window + distinct delegate accepted
  BEGIN
    INSERT INTO public.user_out_of_office (user_id, workspace_id, starts_at, ends_at, delegate_user_id)
    VALUES (v_owner, v_ws, '2026-06-10T00:00:00Z'::timestamptz, '2026-06-15T00:00:00Z'::timestamptz, v_other);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 2.C (valid OOO): FAIL — % %', SQLSTATE, SQLERRM; failed := failed + 1;
  END;

  IF failed = 0 THEN RAISE NOTICE 'TEST 2 (OOO CHECK constraints): PASS';
  ELSE RAISE NOTICE 'TEST 2: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p7_cleanup(v_owner, v_ws);
  DELETE FROM public.profiles WHERE id = v_other;
  DELETE FROM auth.users WHERE id = v_other;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — chain_step_overrides CHECK constraints
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid; v_step uuid;
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease, v_step FROM public._test_p7_seed('p7-override@example.test');

  -- A. override_reason length < 20 rejected
  BEGIN
    INSERT INTO public.chain_step_overrides (chain_step_id, lease_id, workspace_id, override_action, override_by, override_reason)
    VALUES (v_step, v_lease, v_ws, 'approve', v_owner, 'too short');
    RAISE NOTICE 'TEST 3.A (reason <20 chars): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  -- B. override_reason exactly 20 chars accepted (boundary)
  BEGIN
    INSERT INTO public.chain_step_overrides (chain_step_id, lease_id, workspace_id, override_action, override_by, override_reason)
    VALUES (v_step, v_lease, v_ws, 'approve', v_owner, '12345678901234567890');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 3.B (reason exactly 20): FAIL — % %', SQLSTATE, SQLERRM; failed := failed + 1;
  END;

  -- C. override_reason whitespace-padded but trim < 20 rejected
  BEGIN
    INSERT INTO public.chain_step_overrides (chain_step_id, lease_id, workspace_id, override_action, override_by, override_reason)
    VALUES (v_step, v_lease, v_ws, 'approve', v_owner, '   short   ');
    RAISE NOTICE 'TEST 3.C (whitespace trimmed <20): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  -- D. override_action enum: 5 valid values
  FOR i IN 1..5 LOOP
    DECLARE a text := (ARRAY['approve','reject','send_back','reassign','cancel_step'])[i];
    BEGIN
      BEGIN
        INSERT INTO public.chain_step_overrides (chain_step_id, lease_id, workspace_id, override_action, override_by, override_reason)
        VALUES (v_step, v_lease, v_ws, a, v_owner, 'Reason text padding 20+');
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'TEST 3.D (action=%): FAIL — % %', a, SQLSTATE, SQLERRM; failed := failed + 1;
      END;
    END;
  END LOOP;

  -- E. bogus action rejected
  BEGIN
    INSERT INTO public.chain_step_overrides (chain_step_id, lease_id, workspace_id, override_action, override_by, override_reason)
    VALUES (v_step, v_lease, v_ws, 'made_up_action', v_owner, 'Reason text padding 20+');
    RAISE NOTICE 'TEST 3.E (bogus action): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  IF failed = 0 THEN RAISE NOTICE 'TEST 3 (overrides CHECK constraints): PASS';
  ELSE RAISE NOTICE 'TEST 3: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p7_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — voluntary delegation CHECK + assignee source CHECK
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid; v_step uuid;
  v_other uuid := gen_random_uuid();
  src text;
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease, v_step FROM public._test_p7_seed('p7-vd@example.test');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_other, 'p7-vd-other@x.test', '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (v_other, 'p7-vd-other@x.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES (v_ws, v_other, 'editor');

  -- A. vd_no_self_delegation rejects delegated_by == delegated_to
  BEGIN
    INSERT INTO public.chain_step_voluntary_delegations (chain_step_id, lease_id, workspace_id, delegated_by, delegated_to)
    VALUES (v_step, v_lease, v_ws, v_owner, v_owner);
    RAISE NOTICE 'TEST 4.A (vd self): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  -- B. valid distinct delegation accepted
  BEGIN
    INSERT INTO public.chain_step_voluntary_delegations (chain_step_id, lease_id, workspace_id, delegated_by, delegated_to)
    VALUES (v_step, v_lease, v_ws, v_owner, v_other);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 4.B (valid vd): FAIL — % %', SQLSTATE, SQLERRM; failed := failed + 1;
  END;

  -- C. assignee_resolution_source: 6 valid values + NULL all accepted
  FOR src IN SELECT unnest(ARRAY['policy_user','policy_role','policy_delegate','ooo_delegate','voluntary_delegate','admin_reassign']) LOOP
    BEGIN
      UPDATE public.lease_approval_chain SET assignee_resolution_source = src WHERE id = v_step;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'TEST 4.C (source=%): FAIL — CHECK rejected valid value', src; failed := failed + 1;
    END;
  END LOOP;
  -- NULL accepted
  UPDATE public.lease_approval_chain SET assignee_resolution_source = NULL WHERE id = v_step;

  -- D. bogus source rejected
  BEGIN
    UPDATE public.lease_approval_chain SET assignee_resolution_source = 'made_up' WHERE id = v_step;
    RAISE NOTICE 'TEST 4.D (bogus source): FAIL — accepted'; failed := failed + 1;
  EXCEPTION WHEN check_violation THEN END;

  IF failed = 0 THEN RAISE NOTICE 'TEST 4 (vd CHECK + assignee source CHECK): PASS';
  ELSE RAISE NOTICE 'TEST 4: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p7_cleanup(v_owner, v_ws);
  DELETE FROM public.profiles WHERE id = v_other;
  DELETE FROM auth.users WHERE id = v_other;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — Phase 7 activity types + cross-phase regression
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid; v_step uuid;
  t text; passed int := 0; failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease, v_step FROM public._test_p7_seed('p7-acttype@example.test');

  -- 13 Phase 7 additions
  FOR t IN SELECT unnest(ARRAY[
    'step_pending_started',
    'delegate_timer_started',
    'delegate_activated',
    'voluntary_delegation_created',
    'voluntary_delegation_revoked',
    'admin_override_executed',
    'ooo_declared',
    'ooo_revoked',
    'ooo_routed_step',
    'stuck_chain_detected',
    'stuck_chain_resolved',
    'deactivated_approver_reassigned',
    'policy_assignee_validation_failed'
  ]) LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, t, '{}'::jsonb);
      passed := passed + 1;
    EXCEPTION WHEN check_violation THEN
      failed := failed + 1; RAISE NOTICE 'TEST 5.A (P7 type=%): FAIL', t;
    END;
  END LOOP;
  IF passed = 13 AND failed = 0 THEN
    RAISE NOTICE 'TEST 5.A (13 Phase 7 activity types): PASS';
  ELSE
    RAISE NOTICE 'TEST 5.A: FAIL — passed=% failed=%', passed, failed;
  END IF;

  -- Cross-phase regression — representative samples from each prior phase
  passed := 0; failed := 0;
  FOR t IN SELECT unnest(ARRAY[
    -- Legacy + pre-Phase 2
    'status_change', 'created', 'comment',
    -- Phase 2
    'chain_resolved', 'chain_step_approved', 'chain_stage_completed',
    -- Phase 3
    'concept_stage_entered', 'pending_counter_signature_started',
    -- Phase 4
    'document_iteration_uploaded', 'document_marked_final_negotiated',
    -- Phase 5
    'signator_attestation_recorded', 'counter_signature_received',
    'final_review_returned_to_negotiation',
    -- Phase 6
    'attribute_change_detected', 'chain_rerouted', 'chain_violation_entered',
    'chain_violation_resolved', 'manual_reroute_requested'
  ]) LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, t, '{}'::jsonb);
      passed := passed + 1;
    EXCEPTION WHEN check_violation THEN
      failed := failed + 1; RAISE NOTICE 'TEST 5.B (regression %): FAIL', t;
    END;
  END LOOP;
  IF failed = 0 THEN
    RAISE NOTICE 'TEST 5.B (cross-phase regression): PASS — % representative prior values still accepted', passed;
  ELSE
    RAISE NOTICE 'TEST 5.B: FAIL — % regressions', failed;
  END IF;

  PERFORM public._test_p7_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — Migration idempotency sentinel
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  ALTER TABLE public.lease_approval_chain
    ADD COLUMN IF NOT EXISTS pending_since        timestamptz,
    ADD COLUMN IF NOT EXISTS delegate_activated_at timestamptz,
    ADD COLUMN IF NOT EXISTS effective_assignee_user_id uuid,
    ADD COLUMN IF NOT EXISTS assignee_resolution_source text;
  RAISE NOTICE 'TEST 6.A (chain column idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.A: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS public.user_out_of_office (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    delegate_user_id uuid NOT NULL REFERENCES auth.users(id),
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT ooo_valid_window CHECK (starts_at < ends_at),
    CONSTRAINT ooo_no_self_delegation CHECK (user_id <> delegate_user_id)
  );
  RAISE NOTICE 'TEST 6.B (table idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.B: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_p7_seed(text);
DROP FUNCTION IF EXISTS public._test_p7_cleanup(uuid, uuid);

\echo Phase 7 test matrix complete. Search 'FAIL' above to find broken expectations.
