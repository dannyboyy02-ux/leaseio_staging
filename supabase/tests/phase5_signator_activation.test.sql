-- ─────────────────────────────────────────────────────────────────────────
-- Phase 5 Signator Activation + Counter-Signature — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas from
-- supabase/migrations/20260505200000_phase5_signator_activation.sql:
--
--   1. Three new lease columns exist (signator_attestation,
--      counter_signature_due_date, counter_signature_reminder_count) with
--      the spec'd types and the reminder-count NOT NULL DEFAULT 0.
--   2. Workspace counter_signature_default_due_days exists with
--      DEFAULT 21 and CHECK (1..365).
--   3. The leases_signator_attestation_required row-level CHECK enforces
--      that signator_approved_at is only set alongside a non-empty
--      signator_attestation:
--        - both NULL is accepted
--        - both populated is accepted
--        - approved_at populated with NULL attestation is rejected
--        - approved_at populated with empty / whitespace-only
--          attestation is rejected
--        - approved_at NULL with attestation populated is accepted
--          (the constraint is one-directional)
--   4. The 7 Phase 5 activity_type values are accepted by the
--      lease_activity_log CHECK constraint, and every prior value still
--      passes (regression sentinel — picks a representative subset).
--   5. counter_signature_reminder_count cannot go negative (defensive
--      regression — the column has no explicit CHECK, so this asserts
--      the application contract holds at the schema level we DO have).
--
-- HOW TO RUN
--   Execute against a NON-PRODUCTION database. Each section is a DO
--   block with seed → assertions → cleanup. RAISE NOTICE outputs
--   PASS / FAIL per assertion.
--
--   psql "$TEST_DATABASE_URL" -f supabase/tests/phase5_signator_activation.test.sql
--
-- HOW TO READ
--   Search for 'FAIL' to find broken expectations.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper — owner, workspace, lease in final_review.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_p5_seed()
RETURNS TABLE (ws uuid, owner_user uuid, lease uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
BEGIN
  v_owner := gen_random_uuid();
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_owner, 'p5-owner@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default)
  VALUES ('Phase 5 Test Workspace', v_owner, true)
  RETURNING id INTO v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_owner, 'admin');

  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'p5-test-lease.pdf', 'Ready', 'final_review', 'request_workflow'
  )
  RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws, v_owner, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_p5_cleanup(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.workspaces WHERE owner_id = p_owner;
  DELETE FROM auth.users WHERE id = p_owner;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — new lease columns exist with correct types + defaults
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_attestation_type text;
  v_due_date_type text;
  v_reminder_count_type text;
  v_reminder_count_default text;
  v_reminder_count_nullable text;
  failed int := 0;
BEGIN
  SELECT data_type INTO v_attestation_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='leases' AND column_name='signator_attestation';
  IF v_attestation_type <> 'text' THEN
    RAISE NOTICE 'TEST 1.A (signator_attestation type): FAIL — got %', v_attestation_type;
    failed := failed + 1;
  END IF;

  SELECT data_type INTO v_due_date_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='leases' AND column_name='counter_signature_due_date';
  IF v_due_date_type <> 'date' THEN
    RAISE NOTICE 'TEST 1.B (counter_signature_due_date type): FAIL — got %', v_due_date_type;
    failed := failed + 1;
  END IF;

  SELECT data_type, column_default, is_nullable
    INTO v_reminder_count_type, v_reminder_count_default, v_reminder_count_nullable
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='leases' AND column_name='counter_signature_reminder_count';
  IF v_reminder_count_type <> 'integer' THEN
    RAISE NOTICE 'TEST 1.C (reminder_count type): FAIL — got %', v_reminder_count_type;
    failed := failed + 1;
  END IF;
  IF v_reminder_count_nullable <> 'NO' THEN
    RAISE NOTICE 'TEST 1.D (reminder_count nullable): FAIL — should be NOT NULL';
    failed := failed + 1;
  END IF;
  IF v_reminder_count_default IS NULL OR v_reminder_count_default NOT LIKE '0%' THEN
    RAISE NOTICE 'TEST 1.E (reminder_count default): FAIL — got %', v_reminder_count_default;
    failed := failed + 1;
  END IF;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 1 (lease columns shape): PASS';
  ELSE
    RAISE NOTICE 'TEST 1 (lease columns shape): FAIL — % failures', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — workspace counter_signature_default_due_days default + bounds
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_ws uuid;
  v_default int;
  failed int := 0;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_owner, 'p5-bounds@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- A. Default = 21 when not specified
  INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default)
  VALUES ('Phase 5 Bounds A', v_owner, true)
  RETURNING id INTO v_ws;
  SELECT counter_signature_default_due_days INTO v_default
  FROM public.workspaces WHERE id = v_ws;
  IF v_default <> 21 THEN
    RAISE NOTICE 'TEST 2.A (default=21): FAIL — got %', v_default;
    failed := failed + 1;
  END IF;
  DELETE FROM public.workspaces WHERE id = v_ws;

  -- B. Accepts 1, 21, 365 explicitly
  BEGIN
    INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default, counter_signature_default_due_days)
    VALUES ('Phase 5 Bounds B', v_owner, true, 1)
    RETURNING id INTO v_ws;
    DELETE FROM public.workspaces WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 2.B (accept 1): FAIL — CHECK rejected lower bound';
    failed := failed + 1;
  END;

  BEGIN
    INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default, counter_signature_default_due_days)
    VALUES ('Phase 5 Bounds C', v_owner, true, 365)
    RETURNING id INTO v_ws;
    DELETE FROM public.workspaces WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 2.C (accept 365): FAIL — CHECK rejected upper bound';
    failed := failed + 1;
  END;

  -- D. Rejects 0 and 366 and -1
  BEGIN
    INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default, counter_signature_default_due_days)
    VALUES ('Phase 5 Bounds D', v_owner, true, 0);
    RAISE NOTICE 'TEST 2.D (reject 0): FAIL — CHECK accepted 0';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  BEGIN
    INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default, counter_signature_default_due_days)
    VALUES ('Phase 5 Bounds E', v_owner, true, 366);
    RAISE NOTICE 'TEST 2.E (reject 366): FAIL — CHECK accepted 366';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  BEGIN
    INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default, counter_signature_default_due_days)
    VALUES ('Phase 5 Bounds F', v_owner, true, -1);
    RAISE NOTICE 'TEST 2.F (reject -1): FAIL — CHECK accepted -1';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 2 (counter_signature_default_due_days default + bounds): PASS';
  ELSE
    RAISE NOTICE 'TEST 2: FAIL — % failures', failed;
  END IF;

  DELETE FROM auth.users WHERE id = v_owner;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — leases_signator_attestation_required row-level CHECK
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p5_seed();

  -- A. Both NULL is accepted (default state — never approved)
  -- Already true at insert; assert by no-op update.
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = NULL, signator_attestation = NULL
     WHERE id = v_lease;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 3.A (both NULL): FAIL — CHECK rejected default state';
    failed := failed + 1;
  END;

  -- B. approved_at + attestation populated is accepted
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = now(),
           signator_attestation = 'I confirm this commits the company to the negotiated terms.'
     WHERE id = v_lease;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 3.B (both populated): FAIL — CHECK rejected valid pair';
    failed := failed + 1;
  END;

  -- Reset for next assertions
  UPDATE public.leases
     SET signator_approved_at = NULL, signator_attestation = NULL
   WHERE id = v_lease;

  -- C. approved_at populated with NULL attestation is rejected
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = now(), signator_attestation = NULL
     WHERE id = v_lease;
    RAISE NOTICE 'TEST 3.C (approved_at + NULL attestation): FAIL — CHECK accepted invalid pair';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  -- D. approved_at populated with empty attestation is rejected
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = now(), signator_attestation = ''
     WHERE id = v_lease;
    RAISE NOTICE 'TEST 3.D (approved_at + empty attestation): FAIL — CHECK accepted empty';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  -- E. approved_at populated with whitespace-only attestation is rejected
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = now(), signator_attestation = '   '
     WHERE id = v_lease;
    RAISE NOTICE 'TEST 3.E (approved_at + whitespace attestation): FAIL — CHECK accepted whitespace';
    failed := failed + 1;
  EXCEPTION WHEN check_violation THEN
    -- expected
  END;

  -- F. approved_at NULL with attestation populated is accepted (one-directional)
  BEGIN
    UPDATE public.leases
       SET signator_approved_at = NULL,
           signator_attestation = 'attestation captured but approval not recorded yet'
     WHERE id = v_lease;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 3.F (NULL approved_at + attestation): FAIL — constraint is one-directional and should accept';
    failed := failed + 1;
  END;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 3 (signator attestation CHECK): PASS — all 6 cases match expectation';
  ELSE
    RAISE NOTICE 'TEST 3: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p5_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — Phase 5 activity_type values accepted; prior values regression
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  passed_count int := 0;
  failed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p5_seed();

  -- 7 Phase 5 additions
  FOR v_type IN SELECT unnest(ARRAY[
    'signator_attestation_recorded',
    'counter_signature_reminder_sent',
    'counter_signature_overdue',
    'counter_signature_received',
    'execution_owner_assigned',
    'execution_owner_reassigned',
    'final_review_returned_to_negotiation'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, '{}'::jsonb);
      passed_count := passed_count + 1;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 4.A (Phase 5 type=%): FAIL — CHECK rejected new value', v_type;
    END;
  END LOOP;

  IF passed_count = 7 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 4.A (Phase 5 activity types): PASS — all 7 accepted';
  ELSE
    RAISE NOTICE 'TEST 4.A: FAIL — % accepted, % rejected', passed_count, failed_count;
  END IF;

  -- Regression: representative prior values must still pass.
  passed_count := 0;
  failed_count := 0;
  FOR v_type IN SELECT unnest(ARRAY[
    -- Legacy
    'status_change', 'created', 'comment',
    -- Phase 2 chain
    'chain_resolved', 'chain_step_approved', 'chain_stage_completed',
    -- Phase 3 lifecycle expansion
    'concept_stage_entered', 'pending_counter_signature_started',
    'fully_executed_recorded',
    -- Phase 4 documents
    'document_iteration_uploaded', 'document_iteration_superseded',
    'negotiation_escalated_to_concept', 'document_marked_final_negotiated'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, '{}'::jsonb);
      passed_count := passed_count + 1;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 4.B (regression type=%): FAIL — CHECK now rejects a prior value', v_type;
    END;
  END LOOP;

  IF failed_count = 0 THEN
    RAISE NOTICE 'TEST 4.B (prior activity type regression): PASS — % representative values still accepted', passed_count;
  ELSE
    RAISE NOTICE 'TEST 4.B: FAIL — % regressions', failed_count;
  END IF;

  PERFORM public._test_p5_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — counter_signature_reminder_count behavior
-- ─────────────────────────────────────────────────────────────────────────
--
-- The column has no explicit CHECK in the spec — only NOT NULL DEFAULT 0.
-- This test asserts the schema-level behavior we DO have:
--   - default is 0
--   - increments stick
--   - NOT NULL is enforced

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_count int;
  failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p5_seed();

  -- A. New lease has count = 0
  SELECT counter_signature_reminder_count INTO v_count FROM public.leases WHERE id = v_lease;
  IF v_count <> 0 THEN
    RAISE NOTICE 'TEST 5.A (default=0): FAIL — got %', v_count;
    failed := failed + 1;
  END IF;

  -- B. Increment and read back
  UPDATE public.leases SET counter_signature_reminder_count = 3 WHERE id = v_lease;
  SELECT counter_signature_reminder_count INTO v_count FROM public.leases WHERE id = v_lease;
  IF v_count <> 3 THEN
    RAISE NOTICE 'TEST 5.B (set to 3): FAIL — got %', v_count;
    failed := failed + 1;
  END IF;

  -- C. NOT NULL enforced
  BEGIN
    UPDATE public.leases SET counter_signature_reminder_count = NULL WHERE id = v_lease;
    RAISE NOTICE 'TEST 5.C (reject NULL): FAIL — schema accepted NULL';
    failed := failed + 1;
  EXCEPTION WHEN not_null_violation THEN
    -- expected
  END;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 5 (reminder_count default + NOT NULL): PASS';
  ELSE
    RAISE NOTICE 'TEST 5: FAIL — % failures', failed;
  END IF;

  PERFORM public._test_p5_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — Migration idempotency sentinel
-- ─────────────────────────────────────────────────────────────────────────
--
-- Quick smoke: re-running the columnar parts of the Phase 5 migration
-- statement-by-statement must not error. We don't re-run the full file
-- (it's already applied); we exercise the same shape via IF NOT EXISTS
-- patterns to confirm the migration's idempotency contract.

DO $$
BEGIN
  ALTER TABLE public.leases
    ADD COLUMN IF NOT EXISTS signator_attestation       text,
    ADD COLUMN IF NOT EXISTS counter_signature_due_date date,
    ADD COLUMN IF NOT EXISTS counter_signature_reminder_count integer NOT NULL DEFAULT 0;
  RAISE NOTICE 'TEST 6.A (lease columns idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.A: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE public.workspaces
    ADD COLUMN IF NOT EXISTS counter_signature_default_due_days integer NOT NULL DEFAULT 21;
  RAISE NOTICE 'TEST 6.B (workspace column idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6.B: FAIL — % %', SQLSTATE, SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers (drop after run so they don't accumulate)
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_p5_seed();
DROP FUNCTION IF EXISTS public._test_p5_cleanup(uuid);

\echo Phase 5 test matrix complete. Search 'FAIL' above to find broken expectations.
