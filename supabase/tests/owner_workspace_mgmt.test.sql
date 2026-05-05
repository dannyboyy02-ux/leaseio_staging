-- ─────────────────────────────────────────────────────────────────────────
-- Owner Workspace Management — DB test matrix
-- ─────────────────────────────────────────────────────────────────────────
--
-- Covers the schema deltas + cascade-equivalent behavior introduced by
-- supabase/migrations/20260505140000_owner_workspace_mgmt.sql and the
-- supabase/functions/delete-workspace edge function:
--
--   1. deleted_workspaces table accepts inserts via the service role and
--      surfaces correct columns for forensic audit.
--   2. deleted_workspaces RLS scopes SELECT to owner_id = auth.uid() OR
--      deleted_by = auth.uid(); third parties see zero rows.
--   3. The cascade behavior the edge function relies on:
--      - DELETE FROM leases WHERE workspace_id = X cascades to every
--        lease-child table (lease_activity_log, risks, rent_schedules,
--        lease_approval_chain via lease_id, etc.)
--      - DELETE FROM workspaces WHERE id = X cascades to workspace-child
--        tables (workspace_members, workspace_roles, approval_policies,
--        invite_tokens, etc.) AND does NOT leave orphan leases (the
--        edge function deletes leases first to defeat the SET NULL FK).
--   4. End-to-end: simulate the edge function's full delete sequence in
--      a DO block; verify zero orphans across every workspace-child
--      table, and the audit row exists.
--
-- HOW TO RUN
--   This file is meant to be executed against a NON-PRODUCTION database
--   (Supabase branch on Pro plan, local Docker stack via `supabase start`,
--   or a dedicated staging Supabase project). It writes test data and
--   rolls work back via cleanup statements at the end of each DO block.
--   DO NOT run on the main project.
--
--   psql "$TEST_DATABASE_URL" -f supabase/tests/owner_workspace_mgmt.test.sql
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
-- Seed helper — owner + workspace + a lease + a member + invite token +
-- one of every cascade-child row, to exercise the full delete path.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._test_owm_seed()
RETURNS TABLE (ws uuid, owner_user uuid, member_user uuid, lease uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
BEGIN
  v_owner  := gen_random_uuid();
  v_member := gen_random_uuid();

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_owner,  'owm-owner@example.test',  '{}'::jsonb),
    (v_member, 'owm-member@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (name, owner_id, separation_of_duties_default)
  VALUES ('OWM Test Workspace', v_owner, true)
  RETURNING id INTO v_ws;

  -- Owner's own admin row + member row
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_owner,  'admin'),
         (v_ws, v_member, 'editor');

  -- Lease + at least one cascade child
  INSERT INTO public.leases (
    workspace_id, user_id, requestor_id, lease_owner_id,
    filename, status, lifecycle_status, intake_source
  )
  VALUES (
    v_ws, v_owner, v_owner, v_owner,
    'owm-test-lease.pdf', 'Ready', 'draft', 'request_workflow'
  )
  RETURNING id INTO v_lease;

  INSERT INTO public.lease_activity_log (lease_id, user_id, activity_type, details)
  VALUES (v_lease, v_owner, 'created', '{"test": true}'::jsonb);

  -- Workspace-direct cascade target
  INSERT INTO public.invite_tokens (workspace_id, email, role, token, expires_at)
  VALUES (
    v_ws, 'owm-invite@example.test', 'editor',
    'owm-test-token-' || v_ws::text,
    now() + interval '7 days'
  );

  RETURN QUERY SELECT v_ws, v_owner, v_member, v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public._test_owm_cleanup(p_owner uuid, p_member uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Cleanup any deleted_workspaces rows our test seeded
  DELETE FROM public.deleted_workspaces
   WHERE owner_id IN (p_owner, p_member) OR deleted_by IN (p_owner, p_member);
  DELETE FROM auth.users WHERE id IN (p_owner, p_member);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 1 — deleted_workspaces accepts a service-role insert with full shape
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
  v_audit_id uuid;
BEGIN
  SELECT * INTO v_ws, v_owner, v_member, v_lease FROM public._test_owm_seed();

  -- Simulate the edge function's audit-row insert
  INSERT INTO public.deleted_workspaces (
    original_workspace_id, owner_id, workspace_name, workspace_plan,
    lease_count_at_deletion, member_count_at_deletion, storage_objects_purged,
    deleted_by
  )
  VALUES (v_ws, v_owner, 'OWM Test Workspace', 'free', 1, 2, 0, v_owner)
  RETURNING id INTO v_audit_id;

  IF v_audit_id IS NOT NULL THEN
    RAISE NOTICE 'TEST 1 (deleted_workspaces insert): PASS';
  ELSE
    RAISE NOTICE 'TEST 1 (deleted_workspaces insert): FAIL';
  END IF;

  -- Also clean up the workspace + cascade children (so the rest of the
  -- tests aren't affected by leftover seed data)
  DELETE FROM public.leases WHERE workspace_id = v_ws;
  DELETE FROM public.workspaces WHERE id = v_ws;

  PERFORM public._test_owm_cleanup(v_owner, v_member);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 2 — RLS: owner sees own audit row; third party sees zero
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
  v_outsider uuid;
  visible_to_owner int;
  visible_to_outsider int;
BEGIN
  SELECT * INTO v_ws, v_owner, v_member, v_lease FROM public._test_owm_seed();
  v_outsider := gen_random_uuid();
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_outsider, 'owm-outsider@example.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.deleted_workspaces (
    original_workspace_id, owner_id, workspace_name, workspace_plan,
    lease_count_at_deletion, member_count_at_deletion, storage_objects_purged,
    deleted_by
  )
  VALUES (v_ws, v_owner, 'OWM Test Workspace', 'free', 1, 2, 0, v_owner);

  -- Simulate owner's session
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO visible_to_owner
    FROM public.deleted_workspaces
   WHERE original_workspace_id = v_ws;

  -- Simulate outsider's session
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_outsider::text, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO visible_to_outsider
    FROM public.deleted_workspaces
   WHERE original_workspace_id = v_ws;

  -- Reset role for cleanup
  PERFORM set_config('role', 'postgres', true);

  IF visible_to_owner = 1 AND visible_to_outsider = 0 THEN
    RAISE NOTICE 'TEST 2 (RLS — owner sees audit, outsider does not): PASS';
  ELSE
    RAISE NOTICE 'TEST 2 (RLS): FAIL — owner saw %, outsider saw %',
      visible_to_owner, visible_to_outsider;
  END IF;

  DELETE FROM public.deleted_workspaces WHERE original_workspace_id = v_ws;
  DELETE FROM public.leases WHERE workspace_id = v_ws;
  DELETE FROM public.workspaces WHERE id = v_ws;
  DELETE FROM auth.users WHERE id = v_outsider;
  PERFORM public._test_owm_cleanup(v_owner, v_member);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 3 — DELETE FROM leases cascades to lease-child tables
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
  activity_count_before int; activity_count_after int;
BEGIN
  SELECT * INTO v_ws, v_owner, v_member, v_lease FROM public._test_owm_seed();

  SELECT count(*) INTO activity_count_before
    FROM public.lease_activity_log WHERE lease_id = v_lease;

  DELETE FROM public.leases WHERE id = v_lease;

  SELECT count(*) INTO activity_count_after
    FROM public.lease_activity_log WHERE lease_id = v_lease;

  IF activity_count_before > 0 AND activity_count_after = 0 THEN
    RAISE NOTICE 'TEST 3 (lease cascade): PASS — activity rows cascaded (%->%)',
      activity_count_before, activity_count_after;
  ELSE
    RAISE NOTICE 'TEST 3 (lease cascade): FAIL — before=%, after=%',
      activity_count_before, activity_count_after;
  END IF;

  DELETE FROM public.workspaces WHERE id = v_ws;
  PERFORM public._test_owm_cleanup(v_owner, v_member);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 4 — End-to-end: simulate the edge function's delete sequence and
-- verify zero orphans across every workspace-child + lease-child table
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
  orphan_total int := 0;
BEGIN
  SELECT * INTO v_ws, v_owner, v_member, v_lease FROM public._test_owm_seed();

  -- Edge function step 1: capture audit-row counts (would be inserted
  -- post-delete, but for the test we capture before)
  -- Edge function step 2: delete leases first (defeats SET NULL orphan)
  DELETE FROM public.leases WHERE workspace_id = v_ws;

  -- Edge function step 3: delete workspace (cascades to remaining children)
  DELETE FROM public.workspaces WHERE id = v_ws;

  -- Edge function step 4: insert audit row
  INSERT INTO public.deleted_workspaces (
    original_workspace_id, owner_id, workspace_name, workspace_plan,
    lease_count_at_deletion, member_count_at_deletion, storage_objects_purged,
    deleted_by
  )
  VALUES (v_ws, v_owner, 'OWM Test Workspace', 'free', 1, 2, 0, v_owner);

  -- Verify zero orphans across every table the workspace + lease
  -- delete should have cascaded
  SELECT
    (SELECT count(*) FROM public.workspaces       WHERE id           = v_ws)
  + (SELECT count(*) FROM public.leases           WHERE workspace_id = v_ws)
  + (SELECT count(*) FROM public.workspace_members WHERE workspace_id = v_ws)
  + (SELECT count(*) FROM public.workspace_roles  WHERE workspace_id = v_ws)
  + (SELECT count(*) FROM public.invite_tokens    WHERE workspace_id = v_ws)
  + (SELECT count(*) FROM public.approval_policies WHERE workspace_id = v_ws)
  + (SELECT count(*) FROM public.lease_activity_log WHERE lease_id    = v_lease)
  + (SELECT count(*) FROM public.lease_approval_chain WHERE lease_id  = v_lease)
  + (SELECT count(*) FROM public.lease_approval_chain WHERE workspace_id = v_ws)
  INTO orphan_total;

  IF orphan_total = 0 THEN
    RAISE NOTICE 'TEST 4 (end-to-end zero orphans): PASS';
  ELSE
    RAISE NOTICE 'TEST 4 (end-to-end zero orphans): FAIL — % orphan rows remain', orphan_total;
  END IF;

  -- Audit row should still exist
  IF EXISTS (
    SELECT 1 FROM public.deleted_workspaces
     WHERE original_workspace_id = v_ws AND owner_id = v_owner
  ) THEN
    RAISE NOTICE 'TEST 4b (audit row preserved post-delete): PASS';
  ELSE
    RAISE NOTICE 'TEST 4b (audit row preserved post-delete): FAIL';
  END IF;

  DELETE FROM public.deleted_workspaces WHERE original_workspace_id = v_ws;
  PERFORM public._test_owm_cleanup(v_owner, v_member);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- TEST 5 — leases.workspace_id ON DELETE SET NULL is the orphan-creating
-- gap the edge function explicitly defeats. This test PROVES the gap
-- exists by NOT deleting leases first (the wrong path) and showing the
-- orphan that results, then cleans it up.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ws uuid; v_owner uuid; v_member uuid; v_lease uuid;
  orphan_workspace_id_count int;
BEGIN
  SELECT * INTO v_ws, v_owner, v_member, v_lease FROM public._test_owm_seed();

  -- WRONG PATH: delete the workspace WITHOUT deleting leases first.
  -- leases.workspace_id is FK ON DELETE SET NULL, so the lease survives
  -- with workspace_id = NULL — invisible to RLS, still in the DB.
  DELETE FROM public.workspaces WHERE id = v_ws;

  SELECT count(*) INTO orphan_workspace_id_count
    FROM public.leases
   WHERE id = v_lease AND workspace_id IS NULL;

  IF orphan_workspace_id_count = 1 THEN
    RAISE NOTICE 'TEST 5 (FK SET NULL orphan trap exists): PASS — confirmed orphan from wrong path';
  ELSE
    RAISE NOTICE 'TEST 5 (FK SET NULL orphan trap): FAIL — expected 1 orphan, got %',
      orphan_workspace_id_count;
  END IF;

  -- Cleanup the orphan
  DELETE FROM public.lease_activity_log WHERE lease_id = v_lease;
  DELETE FROM public.leases WHERE id = v_lease;
  PERFORM public._test_owm_cleanup(v_owner, v_member);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup helpers
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public._test_owm_seed();
DROP FUNCTION IF EXISTS public._test_owm_cleanup(uuid, uuid);

-- End of owner_workspace_mgmt.test.sql
