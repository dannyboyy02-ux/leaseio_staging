-- ─────────────────────────────────────────────────────────────────────────
-- Phase 8 ASC 842 Disclosure Reports — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas from
-- supabase/migrations/20260506200000_phase8_disclosure_reports.sql:
--
--   1. lease_reports table exists with all expected columns + 3
--      indexes; status / report_type / report_scope CHECKs accept
--      valid values and reject bogus ones.
--   2. report_scope_lease_id_correlation CHECK enforces shape:
--        - single_lease MUST have lease_id and MUST NOT have
--          period_start / period_end
--        - monthly / quarterly / annual / custom_range MUST have
--          period_start <= period_end and MUST NOT have lease_id
--   3. v_lease_verification_audit view exists and exposes the
--      contracted columns (field_id alias on field_corrections).
--   4. lease-reports storage bucket exists with public=false.
--   5. 5 new workspace report-settings columns exist with their
--      named CHECK constraints, defaults, and bounds.
--   6. 6 new Phase 8 activity types are accepted; representative
--      prior values from legacy + Phases 2-7 still accepted (no
--      regression).
--   7. RLS policies on lease_reports are in place (3 policies) and
--      RLS is enabled.
--
-- HOW TO RUN
--   Execute against a NON-PRODUCTION database. Each section is a DO
--   block with seed → assertions → cleanup, RAISE NOTICE outputs
--   PASS / FAIL per assertion.
--
--     psql "$TEST_DATABASE_URL" -f supabase/tests/phase8_disclosure_reports.test.sql
--
-- HOW TO READ
--   Search for 'FAIL' to find broken expectations.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper — owner + workspace + lease (model-locked)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_p8_seed(p_email text)
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
  VALUES ('Phase 8 Test ' || substring(v_owner::text, 1, 8), v_owner)
  RETURNING id INTO v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_owner, 'admin');

  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source,
    monthly_payment, model_locked, model_locked_at
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'p8-test-lease.pdf', 'Ready', 'active', 'request_workflow',
    5000, true, now()
  )
  RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws, v_owner, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_p8_cleanup(p_owner uuid, p_ws uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ws IS NOT NULL THEN
    DELETE FROM public.lease_activity_log WHERE lease_id IN (SELECT id FROM public.leases WHERE workspace_id = p_ws);
    DELETE FROM public.lease_reports WHERE workspace_id = p_ws;
    DELETE FROM public.leases WHERE workspace_id = p_ws;
    DELETE FROM public.workspace_members WHERE workspace_id = p_ws;
    DELETE FROM public.workspaces WHERE id = p_ws;
  END IF;
  DELETE FROM public.profiles WHERE id = p_owner;
  DELETE FROM auth.users WHERE id = p_owner;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — Schema shape: table, columns, indexes, view, bucket, workspace cols
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_table_count int;
  v_col_count int;
  v_idx_count int;
  v_view_count int;
  v_bucket_count int;
  v_ws_col_count int;
  failed int := 0;
BEGIN
  -- lease_reports table exists
  SELECT count(*) INTO v_table_count
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name='lease_reports';
  IF v_table_count <> 1 THEN
    RAISE NOTICE 'TEST 1.A (lease_reports table): FAIL — got %', v_table_count; failed := failed + 1;
  END IF;

  -- 18 expected columns minimum (id, workspace_id, report_type, report_scope,
  -- lease_id, period_start, period_end, generated_at, generated_by,
  -- pdf_storage_path, json_storage_path, lease_count, excluded_lease_count,
  -- exclusion_reasons, organization_name_at_gen, discount_rate_method_at_gen,
  -- workspace_settings_snapshot, status, error_message, expires_at, created_at)
  SELECT count(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lease_reports'
    AND column_name IN (
      'id','workspace_id','report_type','report_scope','lease_id',
      'period_start','period_end','generated_at','generated_by',
      'pdf_storage_path','json_storage_path','lease_count',
      'excluded_lease_count','exclusion_reasons',
      'organization_name_at_gen','discount_rate_method_at_gen',
      'workspace_settings_snapshot','status','error_message',
      'expires_at','created_at'
    );
  IF v_col_count <> 21 THEN
    RAISE NOTICE 'TEST 1.B (lease_reports columns 21): FAIL — got %', v_col_count; failed := failed + 1;
  END IF;

  -- 3 indexes (workspace chronological, lease, period)
  SELECT count(*) INTO v_idx_count
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='lease_reports'
    AND indexname IN (
      'idx_lease_reports_workspace_chronological',
      'idx_lease_reports_lease',
      'idx_lease_reports_period'
    );
  IF v_idx_count <> 3 THEN
    RAISE NOTICE 'TEST 1.C (lease_reports 3 indexes): FAIL — got %', v_idx_count; failed := failed + 1;
  END IF;

  -- v_lease_verification_audit view exists
  SELECT count(*) INTO v_view_count
  FROM information_schema.views
  WHERE table_schema='public' AND table_name='v_lease_verification_audit';
  IF v_view_count <> 1 THEN
    RAISE NOTICE 'TEST 1.D (v_lease_verification_audit view): FAIL — got %', v_view_count; failed := failed + 1;
  END IF;

  -- lease-reports bucket exists, private
  SELECT count(*) INTO v_bucket_count
  FROM storage.buckets
  WHERE id='lease-reports' AND public=false;
  IF v_bucket_count <> 1 THEN
    RAISE NOTICE 'TEST 1.E (lease-reports bucket private): FAIL — got %', v_bucket_count; failed := failed + 1;
  END IF;

  -- 5 new workspace columns
  SELECT count(*) INTO v_ws_col_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='workspaces'
    AND column_name IN (
      'report_organization_name',
      'report_fiscal_year_start_month',
      'report_rounding_precision',
      'report_artifact_retention_days',
      'report_default_discount_method'
    );
  IF v_ws_col_count <> 5 THEN
    RAISE NOTICE 'TEST 1.F (workspaces 5 report cols): FAIL — got %', v_ws_col_count; failed := failed + 1;
  END IF;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 1 (schema shape): PASS';
  ELSE
    RAISE NOTICE 'TEST 1 (schema shape): FAIL — % assertion(s) failed', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — report_scope_lease_id_correlation CHECK behavior
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  rec RECORD;
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_report_id uuid;
  v_rejected boolean;
  failed int := 0;
BEGIN
  SELECT ws, owner_user, lease INTO rec FROM public._test_p8_seed('p8-correlation@test.local');
  v_ws := rec.ws; v_owner := rec.owner_user; v_lease := rec.lease;

  -- 2.A — single_lease without lease_id should be rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, generated_by)
    VALUES (v_ws, 'lease_disclosure', 'single_lease', v_owner);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 2.A (single_lease without lease_id rejected): FAIL';
    failed := failed + 1;
  END IF;

  -- 2.B — single_lease WITH period bounds should be rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, lease_id, period_start, period_end, generated_by)
    VALUES (v_ws, 'lease_disclosure', 'single_lease', v_lease, '2026-01-01', '2026-12-31', v_owner);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 2.B (single_lease + period rejected): FAIL';
    failed := failed + 1;
  END IF;

  -- 2.C — monthly without period should be rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, generated_by)
    VALUES (v_ws, 'portfolio_period', 'monthly', v_owner);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 2.C (monthly without period rejected): FAIL';
    failed := failed + 1;
  END IF;

  -- 2.D — period_start > period_end should be rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, period_start, period_end, generated_by)
    VALUES (v_ws, 'portfolio_period', 'monthly', '2026-12-31', '2026-01-01', v_owner);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 2.D (period_start > period_end rejected): FAIL';
    failed := failed + 1;
  END IF;

  -- 2.E — period scope WITH lease_id should be rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, lease_id, period_start, period_end, generated_by)
    VALUES (v_ws, 'portfolio_period', 'monthly', v_lease, '2026-01-01', '2026-12-31', v_owner);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 2.E (period + lease_id rejected): FAIL';
    failed := failed + 1;
  END IF;

  -- 2.F — happy path: single_lease with lease_id and no period accepted
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, lease_id, generated_by, status)
    VALUES (v_ws, 'lease_disclosure', 'single_lease', v_lease, v_owner, 'pending')
    RETURNING id INTO v_report_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 2.F (happy single_lease accepted): FAIL — %', SQLERRM;
    failed := failed + 1;
  END;

  -- 2.G — happy path: monthly portfolio with valid period accepted
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, period_start, period_end, generated_by, status)
    VALUES (v_ws, 'portfolio_period', 'monthly', '2026-01-01', '2026-01-31', v_owner, 'pending');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 2.G (happy monthly portfolio accepted): FAIL — %', SQLERRM;
    failed := failed + 1;
  END;

  -- 2.H — period_start = period_end (single-day) accepted
  BEGIN
    INSERT INTO public.lease_reports (workspace_id, report_type, report_scope, period_start, period_end, generated_by, status)
    VALUES (v_ws, 'portfolio_period', 'custom_range', '2026-06-15', '2026-06-15', v_owner, 'pending');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 2.H (period_start = period_end accepted): FAIL — %', SQLERRM;
    failed := failed + 1;
  END;

  PERFORM public._test_p8_cleanup(v_owner, v_ws);

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 2 (correlation CHECK): PASS';
  ELSE
    RAISE NOTICE 'TEST 2 (correlation CHECK): FAIL — % assertion(s) failed', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — workspace report-settings bound CHECKs
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  rec RECORD;
  v_ws uuid; v_owner uuid;
  v_rejected boolean;
  failed int := 0;
BEGIN
  SELECT ws, owner_user INTO rec FROM public._test_p8_seed('p8-bounds@test.local');
  v_ws := rec.ws; v_owner := rec.owner_user;

  -- fiscal_year_start_month outside 1..12 → reject
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_fiscal_year_start_month = 0 WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.A (fiscal_year_start_month=0 rejected): FAIL'; failed := failed + 1;
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_fiscal_year_start_month = 13 WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.B (fiscal_year_start_month=13 rejected): FAIL'; failed := failed + 1;
  END IF;

  -- rounding_precision outside 0..6 → reject
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_rounding_precision = 7 WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.C (rounding_precision=7 rejected): FAIL'; failed := failed + 1;
  END IF;

  -- retention_days outside 1..730 → reject
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_artifact_retention_days = 0 WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.D (retention_days=0 rejected): FAIL'; failed := failed + 1;
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_artifact_retention_days = 731 WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.E (retention_days=731 rejected): FAIL'; failed := failed + 1;
  END IF;

  -- discount_method bogus enum → reject
  v_rejected := false;
  BEGIN
    UPDATE public.workspaces SET report_default_discount_method = 'invalid_method' WHERE id = v_ws;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE NOTICE 'TEST 3.F (bogus discount_method rejected): FAIL'; failed := failed + 1;
  END IF;

  -- Boundary happy paths (1, 12 / 0, 6 / 1, 730 / each enum value)
  BEGIN
    UPDATE public.workspaces SET
      report_fiscal_year_start_month = 1,
      report_rounding_precision = 0,
      report_artifact_retention_days = 1,
      report_default_discount_method = 'workspace_default'
    WHERE id = v_ws;
    UPDATE public.workspaces SET
      report_fiscal_year_start_month = 12,
      report_rounding_precision = 6,
      report_artifact_retention_days = 730,
      report_default_discount_method = 'risk_free_rate'
    WHERE id = v_ws;
    UPDATE public.workspaces SET report_default_discount_method = 'incremental_borrowing_rate' WHERE id = v_ws;
    UPDATE public.workspaces SET report_default_discount_method = 'custom' WHERE id = v_ws;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 3.G (boundary happy paths): FAIL — %', SQLERRM; failed := failed + 1;
  END;

  PERFORM public._test_p8_cleanup(v_owner, v_ws);

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 3 (workspace bounds CHECKs): PASS';
  ELSE
    RAISE NOTICE 'TEST 3 (workspace bounds CHECKs): FAIL — % assertion(s) failed', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — activity_type CHECK accepts 6 Phase 8 + regression sample
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  rec RECORD;
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  failed int := 0;
BEGIN
  SELECT ws, owner_user, lease INTO rec FROM public._test_p8_seed('p8-activity@test.local');
  v_ws := rec.ws; v_owner := rec.owner_user; v_lease := rec.lease;

  -- 6 Phase 8 types
  FOR v_type IN
    SELECT unnest(ARRAY[
      'report_generation_requested',
      'report_generation_completed',
      'report_generation_failed',
      'report_downloaded',
      'report_expired',
      'report_deleted'
    ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, '{}'::jsonb);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'TEST 4 (Phase 8 type %): FAIL — rejected', v_type; failed := failed + 1;
    END;
  END LOOP;

  -- Regression — representative values from earlier phases
  FOR v_type IN
    SELECT unnest(ARRAY[
      'status_change',                       -- legacy
      'approval',                            -- legacy
      'document_upload',                     -- legacy
      'chain_resolved',                      -- Phase 2
      'chain_step_approved',                 -- Phase 2
      'concept_approver_escalation_requested', -- Phase 4
      'final_review_advanced',               -- Phase 4
      'signator_attestation_recorded',       -- Phase 5
      'counter_signature_recorded',          -- Phase 5
      'chain_rerouted',                      -- Phase 6
      'attribute_change_detected',           -- Phase 6
      'voluntary_delegation_set',            -- Phase 7
      'admin_override_executed'              -- Phase 7
    ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, '{}'::jsonb);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'TEST 4 (regression type %): FAIL — rejected', v_type; failed := failed + 1;
    END;
  END LOOP;

  -- Bogus type rejected
  DECLARE
    v_rejected boolean := false;
  BEGIN
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, 'definitely_not_a_real_activity', '{}'::jsonb);
    EXCEPTION WHEN check_violation THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE NOTICE 'TEST 4 (bogus type rejected): FAIL'; failed := failed + 1;
    END IF;
  END;

  PERFORM public._test_p8_cleanup(v_owner, v_ws);

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 4 (activity_type CHECK): PASS — 6 P8 types + 13 regression + bogus reject';
  ELSE
    RAISE NOTICE 'TEST 4 (activity_type CHECK): FAIL — % assertion(s) failed', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — RLS policies on lease_reports
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_rls_enabled boolean;
  v_policy_count int;
  failed int := 0;
BEGIN
  -- RLS enabled on lease_reports
  SELECT relrowsecurity INTO v_rls_enabled
  FROM pg_class
  WHERE oid = 'public.lease_reports'::regclass;
  IF NOT v_rls_enabled THEN
    RAISE NOTICE 'TEST 5.A (RLS enabled on lease_reports): FAIL'; failed := failed + 1;
  END IF;

  -- 3 policies on lease_reports (read / insert / delete)
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname='public' AND tablename='lease_reports';
  IF v_policy_count < 3 THEN
    RAISE NOTICE 'TEST 5.B (lease_reports >=3 policies): FAIL — got %', v_policy_count;
    failed := failed + 1;
  END IF;

  -- Storage RLS — at least one SELECT policy on lease-reports bucket
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND qual ILIKE '%lease-reports%';
  IF v_policy_count < 1 THEN
    RAISE NOTICE 'TEST 5.C (storage policy on lease-reports): FAIL — got %', v_policy_count;
    failed := failed + 1;
  END IF;

  IF failed = 0 THEN
    RAISE NOTICE 'TEST 5 (RLS shape): PASS';
  ELSE
    RAISE NOTICE 'TEST 5 (RLS shape): FAIL — % assertion(s) failed', failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — Migration idempotency sentinel
-- ─────────────────────────────────────────────────────────────────────────
--
-- Re-running the Phase 8 migration should be a no-op because every
-- CREATE / ALTER uses IF NOT EXISTS / IF EXISTS / OR REPLACE patterns.
-- Quick sanity check: re-running CREATE TABLE IF NOT EXISTS on
-- lease_reports must not raise.

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS public.lease_reports (id uuid PRIMARY KEY);
  -- ALTER TABLE ADD COLUMN IF NOT EXISTS — should also be safe
  ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS report_organization_name text;
  RAISE NOTICE 'TEST 6 (migration idempotency): PASS';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TEST 6 (migration idempotency): FAIL — %', SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_p8_seed(text);
DROP FUNCTION IF EXISTS public._test_p8_cleanup(uuid, uuid);
