-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6 Chain Rerouting — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas + trigger behavior from
-- supabase/migrations/20260506000000_phase6_chain_rerouting.sql:
--
--   1. New tables exist with correct columns + indexes:
--        - lease_attribute_snapshots (snapshot per chain resolution)
--        - lease_reroute_events (audit row per reroute)
--   2. New leases.reroute_evaluation_pending column exists, NOT NULL,
--      default false.
--   3. detect_lease_attribute_change BEFORE UPDATE trigger:
--        - Fires on chain-driven non-terminal lease + policy-triggering
--          attribute change → flag=true, attribute_change_detected
--          activity row written
--        - Does NOT fire for legacy lease (no chain rows)
--        - Does NOT fire for terminal lease (rejected/cancelled/expired)
--        - Does NOT fire for non-policy-triggering attribute change
--          (e.g., updated_at-only)
--   4. lease_reroute_events detection_mode CHECK accepts the 3 valid
--      values; rejects unknowns.
--   5. 9 new Phase 6 activity types accepted; representative prior
--      values (legacy, Phase 2-5) still accepted (regression).
--   6. Migration idempotency sentinel via ADD COLUMN IF NOT EXISTS,
--      CREATE TABLE IF NOT EXISTS.
--
-- HOW TO RUN
--   Execute against a NON-PRODUCTION database. Each section is a DO
--   block with seed → assertions → cleanup. RAISE NOTICE outputs
--   PASS / FAIL per assertion. Use a SELECT result wrapper instead of
--   RAISE NOTICE if your runner doesn't surface notices (the trigger
--   semantic test below uses that pattern).
--
--   psql "$TEST_DATABASE_URL" -f supabase/tests/phase6_chain_rerouting.test.sql
--
-- HOW TO READ
--   Search for 'FAIL' to find broken expectations.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper — owner, profile, workspace, lease.
-- Phase 5 helpers used the same shape; Phase 6 keeps it lean and
-- explicit (no separate cleanup function — each test cleans up inline
-- in FK-safe order: leases → workspaces → users).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_p6_seed(p_email text)
RETURNS TABLE (ws uuid, owner_user uuid, lease uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
BEGIN
  v_owner := gen_random_uuid();
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_owner, p_email, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email)
  VALUES (v_owner, p_email)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (name, owner_id)
  VALUES ('Phase 6 Test ' || substring(v_owner::text, 1, 8), v_owner)
  RETURNING id INTO v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_owner, 'admin');

  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source, monthly_payment
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'p6-test-lease.pdf', 'Ready', 'in_negotiation', 'request_workflow', 4000
  )
  RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws, v_owner, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_p6_cleanup(p_owner uuid, p_ws uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ws IS NOT NULL THEN
    DELETE FROM public.lease_activity_log WHERE lease_id IN (SELECT id FROM public.leases WHERE workspace_id = p_ws);
    DELETE FROM public.lease_attribute_snapshots WHERE workspace_id = p_ws;
    DELETE FROM public.lease_reroute_events WHERE workspace_id = p_ws;
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
-- TEST 1 — new lease columns + tables shape
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_flag_default text;
  v_flag_nullable text;
  v_flag_type text;
  v_snapshots_count int;
  v_events_count int;
  failed int := 0;
BEGIN
  -- leases.reroute_evaluation_pending — NOT NULL DEFAULT false, boolean
  SELECT column_default, is_nullable, data_type
    INTO v_flag_default, v_flag_nullable, v_flag_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='leases' AND column_name='reroute_evaluation_pending';
  IF v_flag_type IS NULL OR v_flag_type <> 'boolean' THEN
    RAISE NOTICE 'TEST 1.A (reroute_evaluation_pending type): FAIL — got %', v_flag_type;
    failed := failed + 1;
  END IF;
  IF v_flag_nullable <> 'NO' THEN
    RAISE NOTICE 'TEST 1.B (reroute_evaluation_pending NOT NULL): FAIL — got %', v_flag_nullable;
    failed := failed + 1;
  END IF;
  IF v_flag_default IS NULL OR v_flag_default NOT LIKE 'false%' THEN
    RAISE NOTICE 'TEST 1.C (reroute_evaluation_pending default false): FAIL — got %', v_flag_default;
    failed := failed + 1;
  END IF;

  -- Tables exist
  SELECT count(*) INTO v_snapshots_count
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name='lease_attribute_snapshots';
  IF v_snapshots_count <> 1 THEN
    RAISE NOTICE 'TEST 1.D (lease_attribute_snapshots): FAIL — table missing';
    failed := failed + 1;
  END IF;

  SELECT count(*) INTO v_events_count
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name='lease_reroute_events';
  IF v_events_count <> 1 THEN
    RAISE NOTICE 'TEST 1.E (lease_reroute_events): FAIL — table missing';
    failed := failed + 1;
  END IF;

  -- Indexes — three new ones from the migration
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='idx_lease_attribute_snapshots_lease_chronological'
  ) THEN
    RAISE NOTICE 'TEST 1.F (snapshots index): FAIL';
    failed := failed + 1;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='idx_lease_reroute_events_lease_chronological'
  ) THEN
    RAISE NOTICE 'TEST 1.G (reroute events index): FAIL';
    failed := failed + 1;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='idx_lease_reroute_events_workspace_chain_violations'
  ) THEN
    RAISE NOTICE 'TEST 1.H (chain violations partial index): FAIL';
    failed := failed + 1;
  END IF;

  -- Trigger + function present
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='leases_detect_attribute_change') THEN
    RAISE NOTICE 'TEST 1.I (trigger present): FAIL';
    failed := failed + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='detect_lease_attribute_change') THEN
    RAISE NOTICE 'TEST 1.J (function present): FAIL';
    failed := failed + 1;
  END IF;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 1 (schema shape): PASS';
  ELSE
    RAISE NOTICE 'TEST 1: FAIL — % failures', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — detect_lease_attribute_change trigger semantics
-- ─────────────────────────────────────────────────────────────────────────
--
-- Three lease shapes exercised:
--   A. chain-driven non-terminal lease  → flag=true, audit row written
--   B. legacy lease (no chain rows)     → flag=false, no audit row
--   C. terminal-state lease (rejected)  → flag=false, no audit row
--
-- All three get a policy-triggering attribute UPDATE (monthly_payment).

DO $$
DECLARE
  v_owner uuid; v_ws uuid;
  v_chain_lease uuid; v_legacy_lease uuid; v_rejected_lease uuid;
  v_chain_flag boolean; v_legacy_flag boolean; v_rejected_flag boolean;
  v_chain_audit int; v_legacy_audit int; v_rejected_audit int;
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_chain_lease FROM public._test_p6_seed('p6-trigger@example.test');
  -- Add chain row to make the chain lease "chain-driven"
  INSERT INTO public.lease_approval_chain (lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, is_required, status)
  VALUES (v_chain_lease, v_ws, 'concept', 1, 1, v_owner, true, 'approved');

  -- Legacy lease (no chain rows)
  INSERT INTO public.leases (workspace_id, user_id, requestor_id, lease_owner_id, filename, status, lifecycle_status, intake_source, monthly_payment)
  VALUES (v_ws, v_owner, v_owner, v_owner, 'legacy.pdf', 'Ready', 'submitted', 'request_workflow', 4000)
  RETURNING id INTO v_legacy_lease;

  -- Terminal-state lease with chain row
  INSERT INTO public.leases (workspace_id, user_id, requestor_id, lease_owner_id, filename, status, lifecycle_status, intake_source, monthly_payment)
  VALUES (v_ws, v_owner, v_owner, v_owner, 'rejected.pdf', 'Ready', 'rejected', 'request_workflow', 4000)
  RETURNING id INTO v_rejected_lease;
  INSERT INTO public.lease_approval_chain (lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, is_required, status)
  VALUES (v_rejected_lease, v_ws, 'concept', 1, 1, v_owner, true, 'approved');

  -- Trigger via policy-triggering attribute UPDATE
  UPDATE public.leases SET monthly_payment = 7000
   WHERE id IN (v_chain_lease, v_legacy_lease, v_rejected_lease);

  SELECT reroute_evaluation_pending INTO v_chain_flag FROM public.leases WHERE id = v_chain_lease;
  SELECT reroute_evaluation_pending INTO v_legacy_flag FROM public.leases WHERE id = v_legacy_lease;
  SELECT reroute_evaluation_pending INTO v_rejected_flag FROM public.leases WHERE id = v_rejected_lease;
  SELECT count(*) INTO v_chain_audit FROM public.lease_activity_log
   WHERE lease_id = v_chain_lease AND activity_type = 'attribute_change_detected';
  SELECT count(*) INTO v_legacy_audit FROM public.lease_activity_log
   WHERE lease_id = v_legacy_lease AND activity_type = 'attribute_change_detected';
  SELECT count(*) INTO v_rejected_audit FROM public.lease_activity_log
   WHERE lease_id = v_rejected_lease AND activity_type = 'attribute_change_detected';

  IF v_chain_flag IS NOT TRUE THEN
    RAISE NOTICE 'TEST 2.A (chain lease flag): FAIL — got %', v_chain_flag;
    failed := failed + 1;
  END IF;
  IF v_chain_audit <> 1 THEN
    RAISE NOTICE 'TEST 2.B (chain lease audit row): FAIL — got % rows', v_chain_audit;
    failed := failed + 1;
  END IF;
  IF v_legacy_flag IS NOT FALSE THEN
    RAISE NOTICE 'TEST 2.C (legacy lease flag): FAIL — got % (expected false)', v_legacy_flag;
    failed := failed + 1;
  END IF;
  IF v_legacy_audit <> 0 THEN
    RAISE NOTICE 'TEST 2.D (legacy lease audit row): FAIL — got % rows (expected 0)', v_legacy_audit;
    failed := failed + 1;
  END IF;
  IF v_rejected_flag IS NOT FALSE THEN
    RAISE NOTICE 'TEST 2.E (terminal lease flag): FAIL — got % (expected false)', v_rejected_flag;
    failed := failed + 1;
  END IF;
  IF v_rejected_audit <> 0 THEN
    RAISE NOTICE 'TEST 2.F (terminal lease audit row): FAIL — got % rows (expected 0)', v_rejected_audit;
    failed := failed + 1;
  END IF;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 2 (trigger semantics): PASS — chain fires, legacy doesn''t, terminal doesn''t';
  ELSE
    RAISE NOTICE 'TEST 2: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p6_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — trigger ignores non-policy-triggering attribute changes
-- ─────────────────────────────────────────────────────────────────────────
--
-- The trigger only compares the 5 policy-triggering attributes. A
-- non-policy field (e.g., notes, request_title) should NOT fire it.

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid;
  v_flag boolean; v_audit int;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p6_seed('p6-noop@example.test');
  INSERT INTO public.lease_approval_chain (lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, is_required, status)
  VALUES (v_lease, v_ws, 'concept', 1, 1, v_owner, true, 'approved');

  -- Update a non-policy column. notes is on the leases table.
  UPDATE public.leases SET notes = 'just a typo fix' WHERE id = v_lease;

  SELECT reroute_evaluation_pending INTO v_flag FROM public.leases WHERE id = v_lease;
  SELECT count(*) INTO v_audit FROM public.lease_activity_log
   WHERE lease_id = v_lease AND activity_type = 'attribute_change_detected';

  IF v_flag IS FALSE AND v_audit = 0 THEN
    RAISE NOTICE 'TEST 3 (non-policy attr): PASS — flag stays false, no audit row';
  ELSE
    RAISE NOTICE 'TEST 3 (non-policy attr): FAIL — flag=%, audit=%', v_flag, v_audit;
  END IF;

  PERFORM public._test_p6_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — lease_reroute_events detection_mode CHECK
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid;
  m text;
  passed int := 0; failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p6_seed('p6-detmode@example.test');

  FOR m IN SELECT unnest(ARRAY['auto', 'manual_admin', 'manual_audit'])
  LOOP
    BEGIN
      INSERT INTO public.lease_reroute_events (
        lease_id, workspace_id, trigger_reason,
        changed_attributes, prior_lifecycle_status, new_lifecycle_status,
        detection_mode
      ) VALUES (
        v_lease, v_ws, 'test',
        '{"x":{"from":1,"to":2}}'::jsonb, 'in_negotiation', 'concept_under_review',
        m
      );
      passed := passed + 1;
    EXCEPTION WHEN check_violation THEN
      failed := failed + 1;
      RAISE NOTICE 'TEST 4.A (mode=%): FAIL — CHECK rejected valid value', m;
    END;
  END LOOP;

  -- Reject unknowns
  BEGIN
    INSERT INTO public.lease_reroute_events (
      lease_id, workspace_id, trigger_reason,
      changed_attributes, prior_lifecycle_status, new_lifecycle_status,
      detection_mode
    ) VALUES (
      v_lease, v_ws, 'test',
      '{}'::jsonb, 'in_negotiation', 'concept_under_review',
      'made_up_mode'
    );
    RAISE NOTICE 'TEST 4.B (reject bogus): FAIL — accepted invalid value';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
    NULL;
  END;

  IF passed = 3 AND failed = 0 THEN
    RAISE NOTICE 'TEST 4 (detection_mode CHECK): PASS';
  ELSE
    RAISE NOTICE 'TEST 4: FAIL — passed=% failed=%', passed, failed;
  END IF;

  PERFORM public._test_p6_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — Phase 6 activity types accepted + cross-phase regression
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid; v_ws uuid; v_lease uuid;
  t text;
  passed int := 0; failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p6_seed('p6-acttype@example.test');

  -- Phase 6 additions
  FOR t IN SELECT unnest(ARRAY[
    'attribute_change_detected',
    'chain_rerouted',
    'chain_reroute_skipped_no_match',
    'chain_violation_entered',
    'chain_violation_resolved',
    'reroute_audit_run',
    'manual_reroute_requested',
    'manual_reroute_approved',
    'manual_reroute_rejected'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, t, '{}'::jsonb);
      passed := passed + 1;
    EXCEPTION WHEN check_violation THEN
      failed := failed + 1;
      RAISE NOTICE 'TEST 5.A (Phase 6 type=%): FAIL — CHECK rejected', t;
    END;
  END LOOP;

  IF passed = 9 AND failed = 0 THEN
    RAISE NOTICE 'TEST 5.A (Phase 6 activity types): PASS — all 9 accepted';
  ELSE
    RAISE NOTICE 'TEST 5.A: FAIL — passed=% failed=%', passed, failed;
  END IF;

  -- Cross-phase regression — representative values from each prior phase
  passed := 0; failed := 0;
  FOR t IN SELECT unnest(ARRAY[
    -- Legacy / pre-Phase 2
    'status_change', 'created', 'comment',
    -- Phase 2
    'chain_resolved', 'chain_step_approved', 'chain_stage_completed',
    -- Phase 3
    'concept_stage_entered', 'pending_counter_signature_started', 'fully_executed_recorded',
    -- Phase 4
    'document_iteration_uploaded', 'negotiation_escalated_to_concept', 'document_marked_final_negotiated',
    -- Phase 5
    'signator_attestation_recorded', 'counter_signature_received', 'execution_owner_assigned',
    'final_review_returned_to_negotiation'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, t, '{}'::jsonb);
      passed := passed + 1;
    EXCEPTION WHEN check_violation THEN
      failed := failed + 1;
      RAISE NOTICE 'TEST 5.B (regression %): FAIL — CHECK now rejects prior value', t;
    END;
  END LOOP;
  IF failed = 0 THEN
    RAISE NOTICE 'TEST 5.B (cross-phase regression): PASS — % representative prior values still accepted', passed;
  ELSE
    RAISE NOTICE 'TEST 5.B: FAIL — % regressions', failed;
  END IF;

  PERFORM public._test_p6_cleanup(v_owner, v_ws);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — Migration idempotency sentinel
-- ─────────────────────────────────────────────────────────────────────────
--
-- Re-runs the additive parts of the Phase 6 migration. ADD COLUMN
-- IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, DROP POLICY IF EXISTS / CREATE POLICY all should no-op.

DO $$
BEGIN
  ALTER TABLE public.leases
    ADD COLUMN IF NOT EXISTS reroute_evaluation_pending boolean NOT NULL DEFAULT false;
  RAISE NOTICE 'TEST 6.A (lease column idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.A: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS public.lease_attribute_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    chain_resolution_at timestamptz NOT NULL DEFAULT now(),
    raw_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.lease_reroute_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    trigger_reason text NOT NULL,
    changed_attributes jsonb NOT NULL,
    prior_lifecycle_status text NOT NULL,
    new_lifecycle_status text NOT NULL,
    detection_mode text NOT NULL CHECK (detection_mode IN ('auto', 'manual_admin', 'manual_audit')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  RAISE NOTICE 'TEST 6.B (table idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.B: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_p6_seed(text);
DROP FUNCTION IF EXISTS public._test_p6_cleanup(uuid, uuid);

\echo Phase 6 test matrix complete. Search 'FAIL' above to find broken expectations.
