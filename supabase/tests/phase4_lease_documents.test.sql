-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4 Negotiation Document Tracking — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas + trigger behavior from
-- supabase/migrations/20260505160000_phase4_lease_documents.sql AND the
-- storage RLS rework from
-- supabase/migrations/20260505180000_phase4_lease_documents_storage_rls_fix.sql:
--
--   1. lease_documents table accepts every document_type CHECK value
--      and rejects unknowns.
--   2. is_current_latest unique partial index prevents two
--      simultaneously-latest rows per lease.
--   3. The lease-documents storage bucket exists with the expected
--      configuration (private, 50MB limit).
--   4. AFTER INSERT trigger maintains is_current_latest:
--        - the new row gets is_current_latest = true
--        - the prior latest gets is_current_latest = false +
--          superseded_by + superseded_at populated
--   5. The 5 Phase 4 activity_type values are accepted by the
--      lease_activity_log CHECK constraint; all 36 prior values still
--      accepted (regression).
--   6. Phase 4's storage RLS path-prefix check matches
--      ((storage.foldername(name))[1])::uuid against workspace
--      membership (verified via policy expression introspection rather
--      than a live storage upload, which requires real-user JWTs we
--      don't simulate here).
--
-- HOW TO RUN
--   Execute against a NON-PRODUCTION database. Each section is a DO
--   block with seed → assertions → cleanup. RAISE NOTICE outputs
--   PASS / FAIL per assertion.
--
--   psql "$TEST_DATABASE_URL" -f supabase/tests/phase4_lease_documents.test.sql
--
-- HOW TO READ
--   Search for 'FAIL' to find broken expectations.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP off

-- ─────────────────────────────────────────────────────────────────────────
-- Seed helper — owner, workspace, lease.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_p4_seed()
RETURNS TABLE (ws uuid, owner_user uuid, lease uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
BEGIN
  v_owner := gen_random_uuid();
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_owner, 'p4-owner@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default)
  VALUES ('Phase 4 Test Workspace', v_owner, true)
  RETURNING id INTO v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_owner, 'admin');

  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'p4-test-lease.pdf', 'Ready', 'in_negotiation', 'request_workflow'
  )
  RETURNING id INTO v_lease;

  RETURN QUERY SELECT v_ws, v_owner, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_p4_cleanup(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Cascades: lease_documents → lease (via lease_id), workspace_members,
  -- workspace_roles, etc. all CASCADE off workspaces.
  DELETE FROM public.workspaces WHERE owner_id = p_owner;
  DELETE FROM auth.users WHERE id = p_owner;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — document_type CHECK accepts all 11 spec values
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  passed_count int := 0;
  failed_count int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  FOR v_type IN SELECT unnest(ARRAY[
    'concept_attachment', 'loi', 'draft', 'redline', 'counter_redline',
    'final_negotiated', 'our_signed', 'fully_executed_counterparty_returned',
    'amendment', 'side_letter', 'other'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_documents (
        lease_id, workspace_id, document_type, iteration_number,
        version_number, storage_path, filename, uploaded_by
      )
      VALUES (
        v_lease, v_ws, v_type, 1, passed_count + failed_count + 1,
        v_ws::text || '/' || v_lease::text || '/test-' || v_type,
        v_type || '.pdf', v_owner
      );
      passed_count := passed_count + 1;
    EXCEPTION WHEN check_violation THEN
      failed_count := failed_count + 1;
      RAISE NOTICE 'TEST 1.X (document_type=%): FAIL — CHECK rejected a spec value', v_type;
    END;
  END LOOP;

  IF passed_count = 11 AND failed_count = 0 THEN
    RAISE NOTICE 'TEST 1 (document_type acceptance): PASS — all 11 values accepted';
  ELSE
    RAISE NOTICE 'TEST 1 (document_type acceptance): FAIL — passed=%, failed=%',
      passed_count, failed_count;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — document_type CHECK rejects unknown values
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  bogus text;
  rejected_count int := 0;
  total int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  FOR bogus IN SELECT unnest(ARRAY[
    'DRAFT', 'pdf', 'made_up', 'concept', 'finalized', ''
  ])
  LOOP
    total := total + 1;
    BEGIN
      INSERT INTO public.lease_documents (
        lease_id, workspace_id, document_type, iteration_number,
        version_number, storage_path, filename, uploaded_by
      )
      VALUES (
        v_lease, v_ws, bogus, 1, total,
        v_ws::text || '/' || v_lease::text || '/bogus-' || total::text,
        'bogus.pdf', v_owner
      );
      RAISE NOTICE 'TEST 2.% (bogus=%): FAIL — CHECK accepted invalid value', total, bogus;
    EXCEPTION WHEN check_violation THEN
      rejected_count := rejected_count + 1;
    END;
  END LOOP;

  IF rejected_count = total THEN
    RAISE NOTICE 'TEST 2 (unknown document_type rejection): PASS — % / % rejected',
      rejected_count, total;
  ELSE
    RAISE NOTICE 'TEST 2 (unknown document_type rejection): FAIL — only % / % rejected',
      rejected_count, total;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — is_current_latest unique partial index prevents two latest
-- ─────────────────────────────────────────────────────────────────────────
--
-- Insert two rows; the trigger leaves only one with is_current_latest=true.
-- Then attempt to manually flip the older row to is_current_latest=true
-- without the trigger demoting the newer; the unique partial index must
-- reject the duplicate.

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_id1 uuid; v_id2 uuid;
  unique_violation_caught boolean := false;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease, v_ws, 'draft', 1, 1,
    v_ws::text || '/' || v_lease::text || '/d1', 'd1.pdf', v_owner
  ) RETURNING id INTO v_id1;

  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease, v_ws, 'redline', 1, 2,
    v_ws::text || '/' || v_lease::text || '/d2', 'd2.pdf', v_owner
  ) RETURNING id INTO v_id2;

  -- Try to flip the old row back to latest. Trigger doesn't fire on
  -- UPDATE, so the unique partial index is the safety net.
  BEGIN
    UPDATE public.lease_documents SET is_current_latest = true WHERE id = v_id1;
    RAISE NOTICE 'TEST 3 (unique partial index): FAIL — accepted two latest rows';
  EXCEPTION WHEN unique_violation THEN
    unique_violation_caught := true;
  END;

  IF unique_violation_caught THEN
    RAISE NOTICE 'TEST 3 (unique partial index prevents two latest): PASS';
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — Storage bucket exists with expected configuration
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  bucket_count int;
  is_private boolean;
  size_limit bigint;
BEGIN
  SELECT count(*), bool_or(NOT public), max(file_size_limit)
    INTO bucket_count, is_private, size_limit
    FROM storage.buckets WHERE id = 'lease-documents';

  IF bucket_count = 1 AND is_private = true AND size_limit = 52428800 THEN
    RAISE NOTICE 'TEST 4 (lease-documents bucket): PASS — private, 50MB limit';
  ELSE
    RAISE NOTICE 'TEST 4 (lease-documents bucket): FAIL — count=%, private=%, size=%',
      bucket_count, is_private, size_limit;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — AFTER INSERT trigger promotes new row + demotes prior latest
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_id1 uuid; v_id2 uuid; v_id3 uuid;
  row1_latest boolean; row1_superseded_by uuid; row1_superseded_at timestamptz;
  row2_latest boolean; row2_superseded_by uuid; row2_superseded_at timestamptz;
  row3_latest boolean; row3_superseded_by uuid; row3_superseded_at timestamptz;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  -- Insert three rows in sequence. The trigger should promote each new
  -- row to latest and demote the prior with superseded_by/at populated.
  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease, v_ws, 'draft', 1, 1,
    v_ws::text || '/' || v_lease::text || '/d1', 'd1.pdf', v_owner
  ) RETURNING id INTO v_id1;

  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease, v_ws, 'redline', 1, 2,
    v_ws::text || '/' || v_lease::text || '/d2', 'd2.pdf', v_owner
  ) RETURNING id INTO v_id2;

  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease, v_ws, 'counter_redline', 2, 1,
    v_ws::text || '/' || v_lease::text || '/d3', 'd3.pdf', v_owner
  ) RETURNING id INTO v_id3;

  SELECT is_current_latest, superseded_by, superseded_at
    INTO row1_latest, row1_superseded_by, row1_superseded_at
    FROM public.lease_documents WHERE id = v_id1;
  SELECT is_current_latest, superseded_by, superseded_at
    INTO row2_latest, row2_superseded_by, row2_superseded_at
    FROM public.lease_documents WHERE id = v_id2;
  SELECT is_current_latest, superseded_by, superseded_at
    INTO row3_latest, row3_superseded_by, row3_superseded_at
    FROM public.lease_documents WHERE id = v_id3;

  -- Expected state after the three inserts:
  --   row1: is_current_latest=false, superseded_by=row2.id (or row3 if
  --         the trigger chained both — actually it only updates rows
  --         where is_current_latest=true, so row1 was demoted by row2's
  --         insert with superseded_by=row2; row3's insert demotes row2
  --         not row1).
  --   row2: is_current_latest=false, superseded_by=row3.id
  --   row3: is_current_latest=true, superseded_by=null
  IF row1_latest = false AND row1_superseded_by = v_id2 AND row1_superseded_at IS NOT NULL THEN
    RAISE NOTICE 'TEST 5a (row1 demoted by row2): PASS';
  ELSE
    RAISE NOTICE 'TEST 5a (row1 demoted): FAIL — latest=%, superseded_by=% (expected %)',
      row1_latest, row1_superseded_by, v_id2;
  END IF;

  IF row2_latest = false AND row2_superseded_by = v_id3 AND row2_superseded_at IS NOT NULL THEN
    RAISE NOTICE 'TEST 5b (row2 demoted by row3): PASS';
  ELSE
    RAISE NOTICE 'TEST 5b (row2 demoted): FAIL — latest=%, superseded_by=% (expected %)',
      row2_latest, row2_superseded_by, v_id3;
  END IF;

  IF row3_latest = true AND row3_superseded_by IS NULL AND row3_superseded_at IS NULL THEN
    RAISE NOTICE 'TEST 5c (row3 is current latest): PASS';
  ELSE
    RAISE NOTICE 'TEST 5c (row3 latest): FAIL — latest=%, superseded_by=%',
      row3_latest, row3_superseded_by;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 6 — Exactly one is_current_latest row per lease at all times
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  latest_count int;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  -- Insert 5 rows; the trigger should keep exactly 1 latest at all times.
  FOR i IN 1..5 LOOP
    INSERT INTO public.lease_documents (
      lease_id, workspace_id, document_type, iteration_number,
      version_number, storage_path, filename, uploaded_by
    ) VALUES (
      v_lease, v_ws, 'draft', i, 1,
      v_ws::text || '/' || v_lease::text || '/d' || i::text, 'd' || i::text || '.pdf', v_owner
    );
  END LOOP;

  SELECT count(*) INTO latest_count
    FROM public.lease_documents
   WHERE lease_id = v_lease AND is_current_latest = true;

  IF latest_count = 1 THEN
    RAISE NOTICE 'TEST 6 (exactly one latest after 5 inserts): PASS';
  ELSE
    RAISE NOTICE 'TEST 6 (exactly one latest): FAIL — got % latest rows', latest_count;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 7 — Phase 4 activity_type values accepted; prior 36 still accepted
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_lease uuid;
  v_type text;
  p4_passed int := 0; p4_failed int := 0;
  legacy_passed int := 0; legacy_failed int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_lease FROM public._test_p4_seed();

  -- Phase 4 additions
  FOR v_type IN SELECT unnest(ARRAY[
    'document_iteration_uploaded',
    'document_iteration_superseded',
    'negotiation_escalated_to_concept',
    'document_marked_final_negotiated',
    'document_lineage_corrected'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, jsonb_build_object('test', true));
      p4_passed := p4_passed + 1;
    EXCEPTION WHEN check_violation THEN
      p4_failed := p4_failed + 1;
      RAISE NOTICE 'TEST 7.X (Phase 4 activity_type=%): FAIL', v_type;
    END;
  END LOOP;

  -- Spot-check: 36 prior values still work (24 pre-Phase-2 + 6 Phase 2 + 6 Phase 3)
  FOR v_type IN SELECT unnest(ARRAY[
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'unlock_approved',
    'unlock_requested', 'change_canceled', 'change_set_submitted',
    'change_set_approved', 'change_set_rejected', 'change_set_self_approved',
    'risk_dismissed', 'risk_restored', 'risk_added',
    'change_submitted', 'change_approved', 'change_rejected',
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded'
  ])
  LOOP
    BEGIN
      INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
      VALUES (v_lease, v_owner, v_type, jsonb_build_object('test', true));
      legacy_passed := legacy_passed + 1;
    EXCEPTION WHEN check_violation THEN
      legacy_failed := legacy_failed + 1;
      RAISE NOTICE 'TEST 7.X (legacy activity_type=%): FAIL — pre-existing value rejected', v_type;
    END;
  END LOOP;

  IF p4_passed = 5 AND p4_failed = 0 THEN
    RAISE NOTICE 'TEST 7a (Phase 4 activity_types accepted): PASS — all 5';
  ELSE
    RAISE NOTICE 'TEST 7a: FAIL — passed=%, failed=%', p4_passed, p4_failed;
  END IF;

  IF legacy_passed = 36 AND legacy_failed = 0 THEN
    RAISE NOTICE 'TEST 7b (36 prior activity_types preserved): PASS';
  ELSE
    RAISE NOTICE 'TEST 7b: FAIL — passed=%, failed=%', legacy_passed, legacy_failed;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 8 — Storage RLS uses path-prefix workspace check (post-fix)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Verifies via policy-expression introspection (the original Phase 4
-- migration's RLS required a metadata row at upload time, which conflicts
-- with the spec's upload-then-insert flow; the follow-on migration
-- 20260505180000 swapped to path-prefix). Live storage uploads require
-- real-user JWTs that this test file doesn't simulate; the introspection
-- check verifies the policy SHAPE landed correctly.

DO $$
DECLARE
  upload_expr text;
  read_expr text;
  delete_expr text;
  all_use_path_prefix boolean;
BEGIN
  SELECT pg_get_expr(polwithcheck, polrelid) INTO upload_expr
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'workspace members upload to lease-documents';
  SELECT pg_get_expr(polqual, polrelid) INTO read_expr
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'workspace members read lease-documents';
  SELECT pg_get_expr(polqual, polrelid) INTO delete_expr
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'admins delete from lease-documents';

  all_use_path_prefix := (upload_expr LIKE '%storage.foldername%' AND read_expr LIKE '%storage.foldername%' AND delete_expr LIKE '%storage.foldername%');

  IF all_use_path_prefix THEN
    RAISE NOTICE 'TEST 8 (storage RLS path-prefix shape): PASS — all 3 policies use storage.foldername';
  ELSE
    RAISE NOTICE 'TEST 8 (storage RLS path-prefix shape): FAIL — upload=%, read=%, delete=%',
      upload_expr LIKE '%storage.foldername%',
      read_expr LIKE '%storage.foldername%',
      delete_expr LIKE '%storage.foldername%';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 9 — RLS: lease_documents SELECT scoped to workspace members
-- ─────────────────────────────────────────────────────────────────────────
--
-- Simulate two users: owner (member of W1) and outsider (member of W2).
-- Outsider must see zero rows from W1's documents.

DO $$
DECLARE
  v_ws1 uuid; v_owner1 uuid; v_lease1 uuid;
  v_ws2 uuid; v_owner2 uuid; v_lease2 uuid;
  visible_to_owner1 int;
  visible_to_outsider int;
BEGIN
  SELECT * INTO v_ws1, v_owner1, v_lease1 FROM public._test_p4_seed();
  SELECT * INTO v_ws2, v_owner2, v_lease2 FROM public._test_p4_seed();

  -- Insert a document into v_ws1's lease
  INSERT INTO public.lease_documents (
    lease_id, workspace_id, document_type, iteration_number,
    version_number, storage_path, filename, uploaded_by
  ) VALUES (
    v_lease1, v_ws1, 'draft', 1, 1,
    v_ws1::text || '/' || v_lease1::text || '/secret', 'secret.pdf', v_owner1
  );

  -- Owner of W1 sees their own document
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO visible_to_owner1
    FROM public.lease_documents WHERE lease_id = v_lease1;

  -- Outsider (W2 owner, not W1 member) sees nothing
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner2::text, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO visible_to_outsider
    FROM public.lease_documents WHERE lease_id = v_lease1;

  PERFORM set_config('role', 'postgres', true);

  IF visible_to_owner1 = 1 AND visible_to_outsider = 0 THEN
    RAISE NOTICE 'TEST 9 (lease_documents RLS scoping): PASS';
  ELSE
    RAISE NOTICE 'TEST 9 (RLS): FAIL — owner saw %, outsider saw %',
      visible_to_owner1, visible_to_outsider;
  END IF;

  PERFORM public._test_p4_cleanup(v_owner1);
  PERFORM public._test_p4_cleanup(v_owner2);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_p4_seed();
DROP FUNCTION IF EXISTS public._test_p4_cleanup(uuid);

-- End of phase4_lease_documents.test.sql
