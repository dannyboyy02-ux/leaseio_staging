-- ─────────────────────────────────────────────────────────────────────────
-- Phase 3 Lifecycle Expansion — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas introduced by
-- supabase/migrations/20260503110000_phase3_lifecycle_expansion.sql:
--
--   1. leases.lifecycle_status CHECK accepts all 16 values (9 legacy +
--      7 chain) and rejects unknowns.
--   2. The 5 new lease columns (concept_approved_at, signator_approved_at,
--      counter_signed_at, fully_executed_at, execution_owner_id) accept
--      null and valid values; execution_owner_id rejects bogus FKs.
--   3. lease_activity_log.activity_type accepts the 6 new Phase 3 values
--      and continues to accept all pre-existing values (24 pre-Phase-2 +
--      6 Phase 2 = 30) so prior writers keep working.
--
-- HOW TO RUN
--   This file is meant to be executed against a NON-PRODUCTION database
--   (a Supabase branch on Pro plan, a local Docker stack via
--   `supabase start`, or a dedicated staging Supabase project). It writes
--   test data and rolls work back via cleanup statements at the end of
--   each DO block. DO NOT run on the main project.
--
--   Recommended:
--     - psql "$TEST_DATABASE_URL" -f supabase/tests/phase3_lifecycle_expansion.test.sql
--     - Or paste into the Studio SQL editor for that environment.
--
--   Each section is wrapped in its own DO block with seed → assertions
--   → cleanup. RAISE NOTICE outputs PASS / FAIL per assertion.
--
-- HOW TO READ
--   Search the output for 'FAIL' to find broken expectations. All passes
--   print as 'TEST N (...): PASS'.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Helper — seed a workspace + an owner + a draft lease.
-- The lease is created in the safest pre-state ('draft') so the per-test
-- block can flip lifecycle_status freely without violating FK constraints.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_phase3_seed()
RETURNS TABLE (ws uuid, owner_user uuid, lease uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
BEGIN
  v_owner := gen_random_uuid();

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_owner, 'phase3-owner@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default)
  VALUES ('Phase 3 Test Workspace', v_owner, true)
  RETURNING id INTO v_ws;

  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'phase3-test-lease.pdf', 'Ready', 'draft', 'request_workflow'
  )
  RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws, v_owner, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_phase3_cleanup(p_ws uuid, p_owner uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.lease_activity_log
   WHERE lease_id IN (SELECT id FROM public.leases WHERE workspace_id = p_ws);
  DELETE FROM public.leases WHERE workspace_id = p_ws;
  DELETE FROM public.workspaces WHERE id = p_ws;
  DELETE FROM auth.users WHERE id = p_owner;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — leases.lifecycle_status CHECK accepts all 16 values
-- ─────────────────────────────────────────────────────────────────────────
--
-- Iterates the full vocabulary: 9 legacy + 7 chain. Each value is set
-- via UPDATE; any rejection by the CHECK constraint raises and the test
-- block surfaces a FAIL.

DO $$
DECLARE
  s record; v_ws uuid; v_owner uuid; v_lease uuid;
  failed_count int := 0;
  passed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  FOR s IN
    SELECT unnest(ARRAY[
      -- Legacy
      'draft', 'submitted', 'under_review', 'approved', 'executed',
      'active', 'expired', 'rejected', 'cancelled',
      -- Chain
      'concept_submitted', 'concept_under_review', 'in_negotiation',
      'final_review', 'pending_counter_signature', 'fully_executed',
      'chain_violation'
    ]) AS status_value
  LOOP
    BEGIN
      UPDATE public.leases SET lifecycle_status = s.status_value WHERE id = v_lease;
      passed_count := passed_count + 1;
      RAISE NOTICE 'TEST 1.% (status=%): PASS', passed_count, s.status_value;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 1.X (status=%): FAIL — CHECK rejected a valid value', s.status_value;
    END;
  END LOOP;

  IF passed_count = 16 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 1 (16-state acceptance): PASS — all 16 values accepted';
  ELSE
    RAISE NOTICE 'TEST 1 (16-state acceptance): FAIL — passed=%, failed=%', passed_count, failed_count;
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — leases.lifecycle_status CHECK rejects unknown values
-- ─────────────────────────────────────────────────────────────────────────
--
-- A few sentinel values that have appeared in older specs / drafts but
-- are NOT in the live constraint. These must be rejected.

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  bogus text;
  rejected_count int := 0;
  total int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  FOR bogus IN SELECT unnest(ARRAY[
    'needs_review',
    'failed',
    'in_review',
    'awaiting_signature',
    'COMPLETE',         -- legitimate value but wrong case
    'concept_rejected', -- plausible but unspecified
    ''                  -- empty
  ])
  LOOP
    total := total + 1;
    BEGIN
      UPDATE public.leases SET lifecycle_status = bogus WHERE id = v_lease;
      RAISE NOTICE 'TEST 2.% (bogus=%): FAIL — CHECK accepted a value not in the spec', total, bogus;
    EXCEPTION WHEN check_violation THEN
      rejected_count := rejected_count + 1;
      RAISE NOTICE 'TEST 2.% (bogus=%): PASS — rejected as expected', total, bogus;
    END;
  END LOOP;

  IF rejected_count = total THEN
    RAISE NOTICE 'TEST 2 (unknown rejection): PASS — % / % rejected', rejected_count, total;
  ELSE
    RAISE NOTICE 'TEST 2 (unknown rejection): FAIL — only % / % rejected', rejected_count, total;
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — 5 new lease columns accept null and valid values
-- ─────────────────────────────────────────────────────────────────────────
--
-- All five columns are nullable (default NULL after migration). The four
-- timestamp columns accept any timestamptz; execution_owner_id accepts
-- a real auth.users.id and rejects a bogus uuid via the FK constraint.

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_ts timestamptz := now();
  ok_null boolean := false; ok_set boolean := false;
  fk_rejected boolean := false;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  -- 3a. All 5 columns accept NULL (initial state after migration).
  -- The seeded lease starts with all 5 NULL — verify directly.
  IF EXISTS (
    SELECT 1 FROM public.leases
     WHERE id = v_lease
       AND concept_approved_at IS NULL
       AND signator_approved_at IS NULL
       AND counter_signed_at IS NULL
       AND fully_executed_at IS NULL
       AND execution_owner_id IS NULL
  ) THEN
    ok_null := true;
    RAISE NOTICE 'TEST 3a (5 columns nullable on insert): PASS';
  ELSE
    RAISE NOTICE 'TEST 3a (5 columns nullable on insert): FAIL';
  END IF;

  -- 3b. All 5 columns accept valid values via UPDATE.
  BEGIN
    UPDATE public.leases SET
      concept_approved_at  = v_ts,
      signator_approved_at = v_ts,
      counter_signed_at    = v_ts,
      fully_executed_at    = v_ts,
      execution_owner_id   = v_owner
    WHERE id = v_lease;
    ok_set := true;
    RAISE NOTICE 'TEST 3b (5 columns accept valid values): PASS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 3b (5 columns accept valid values): FAIL — %', SQLERRM;
  END;

  -- 3c. execution_owner_id rejects a bogus UUID via the auth.users FK.
  BEGIN
    UPDATE public.leases
       SET execution_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
     WHERE id = v_lease;
    RAISE NOTICE 'TEST 3c (execution_owner_id FK enforcement): FAIL — accepted unknown user';
  EXCEPTION WHEN foreign_key_violation THEN
    fk_rejected := true;
    RAISE NOTICE 'TEST 3c (execution_owner_id FK enforcement): PASS';
  END;

  IF ok_null AND ok_set AND fk_rejected THEN
    RAISE NOTICE 'TEST 3 (new lease columns): PASS';
  ELSE
    RAISE NOTICE 'TEST 3 (new lease columns): FAIL';
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — lease_activity_log accepts the 6 new Phase 3 activity types
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  passed_count int := 0;
  failed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  FOR v_type IN SELECT unnest(ARRAY[
    'concept_stage_entered',
    'concept_stage_completed',
    'negotiation_stage_entered',
    'final_review_stage_entered',
    'pending_counter_signature_started',
    'fully_executed_recorded'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, jsonb_build_object('test', true));
      passed_count := passed_count + 1;
      RAISE NOTICE 'TEST 4.% (activity_type=%): PASS', passed_count, v_type;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 4.X (activity_type=%): FAIL — CHECK rejected a Phase 3 value', v_type;
    END;
  END LOOP;

  IF passed_count = 6 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 4 (Phase 3 activity_type acceptance): PASS — all 6 accepted';
  ELSE
    RAISE NOTICE 'TEST 4 (Phase 3 activity_type acceptance): FAIL — passed=%, failed=%', passed_count, failed_count;
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — pre-existing activity_type values still accepted
-- ─────────────────────────────────────────────────────────────────────────
--
-- Spot-check: re-add the 30 prior values (24 pre-Phase-2 + 6 Phase 2)
-- and confirm none regressed. If any of these break, downstream writers
-- (process_lease, retry_lease, the Phase 2 chain functions) start failing
-- silently in production.

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  passed_count int := 0;
  failed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  FOR v_type IN SELECT unnest(ARRAY[
    -- Pre-Phase-2 (24)
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'unlock_approved',
    'unlock_requested', 'change_canceled', 'change_set_submitted',
    'change_set_approved', 'change_set_rejected', 'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added',
    'change_submitted', 'change_approved', 'change_rejected',
    -- Phase 2 (6)
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, jsonb_build_object('test', true));
      passed_count := passed_count + 1;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 5.X (activity_type=%): FAIL — pre-existing value rejected by post-Phase-3 constraint', v_type;
    END;
  END LOOP;

  IF passed_count = 30 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 5 (legacy + Phase 2 activity_type preserved): PASS — all 30 accepted';
  ELSE
    RAISE NOTICE 'TEST 5 (legacy + Phase 2 activity_type preserved): FAIL — passed=%, failed=%', passed_count, failed_count;
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — pre-existing lifecycle_status values still accepted
-- ─────────────────────────────────────────────────────────────────────────
--
-- Defensive check: confirm none of the 9 legacy lifecycle_status values
-- were dropped by the Phase 3 CHECK swap. (The TEST 1 loop already covers
-- them, but this duplicate framing surfaces a regression specific to
-- "legacy values disappeared after migration" rather than "all 16 broken".)

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_legacy text;
  passed_count int := 0;
  failed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_phase3_seed();

  FOR v_legacy IN SELECT unnest(ARRAY[
    'draft', 'submitted', 'under_review', 'approved', 'executed',
    'active', 'expired', 'rejected', 'cancelled'
  ])
  LOOP
    BEGIN
      UPDATE public.leases SET lifecycle_status = v_legacy WHERE id = v_lease;
      passed_count := passed_count + 1;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 6.X (legacy=%): FAIL — pre-existing value rejected by Phase 3 CHECK', v_legacy;
    END;
  END LOOP;

  IF passed_count = 9 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 6 (legacy lifecycle_status preserved): PASS — all 9 accepted';
  ELSE
    RAISE NOTICE 'TEST 6 (legacy lifecycle_status preserved): FAIL — passed=%, failed=%', passed_count, failed_count;
  END IF;

  PERFORM public._test_phase3_cleanup(v_ws, v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers (drop after the file completes)
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_phase3_seed();
DROP FUNCTION IF EXISTS public._test_phase3_cleanup(uuid, uuid);

-- End of phase3_lifecycle_expansion.test.sql
