-- ============================================================================
-- Workspace Management — Phase 1 (multi-workspace for Business)
-- Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md (v2, pressure-tested 2026-06-09)
-- ============================================================================
--
-- Adds two tables that back the owner-level multi-workspace feature:
--   1. workspace_activity_log     — append-only workspace lifecycle audit
--   2. workspace_creation_requests — idempotency guard for create-workspace
--
-- No changes to the `workspaces` entitlement model: the create-workspace edge
-- function inserts at the Starter baseline (the entitlement guard's service_role
-- carve-out applies) and the Stripe webhook remains the SOLE writer of the
-- billing/entitlement columns. Multi-workspace ownership is already legal at the
-- DB layer (owner_id has a non-unique index; no UNIQUE constraint) — this
-- migration adds NO firm_id and no grouping entity (firm layer stays dormant).
--
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS throughout. Safe to replay.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. workspace_activity_log — workspace-lifecycle audit
-- ----------------------------------------------------------------------------
-- There is no workspace-level event log today (lease_activity_log is
-- lease-scoped). event_type intentionally has NO 'deleted' value: deletions are
-- recorded in the existing durable public.deleted_workspaces table (written by
-- delete-workspace BEFORE the cascade); a 'deleted' row here would cascade away
-- with the workspace.
CREATE TABLE IF NOT EXISTS public.workspace_activity_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type   text NOT NULL,   -- created | activated | renamed | owner_transferred | member_added | member_removed
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_log_workspace_id
  ON public.workspace_activity_log (workspace_id, created_at DESC);

ALTER TABLE public.workspace_activity_log ENABLE ROW LEVEL SECURITY;

-- Read: any member of the workspace. is_workspace_member (baseline:386-401)
-- returns true for members AND the owner, so no redundant owner_id OR-branch is
-- needed (verified by pressure-test).
DROP POLICY IF EXISTS "Members read workspace activity" ON public.workspace_activity_log;
CREATE POLICY "Members read workspace activity"
  ON public.workspace_activity_log
  FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Write (authenticated): constrained, mirrors lease_activity_log's existing
-- INSERT policy (baseline:3811). Lets the CLIENT-SIDE lifecycle writers (rename,
-- member add/remove from MembersPanel) log directly. Service-role functions
-- (create-workspace, transfer, sweep) also write, bypassing RLS. The actor must
-- be a member of the workspace and must stamp themselves as user_id (NULL is
-- allowed for system writes that arrive via authenticated context, matching the
-- lease_activity_log shape).
DROP POLICY IF EXISTS "Members insert workspace activity" ON public.workspace_activity_log;
CREATE POLICY "Members insert workspace activity"
  ON public.workspace_activity_log
  FOR INSERT
  WITH CHECK (
    ((user_id = auth.uid()) OR (user_id IS NULL))
    AND public.is_workspace_member(workspace_id, auth.uid())
  );

-- No UPDATE/DELETE policy → authenticated edits/deletes are denied (append-only
-- audit). Only service_role (which bypasses RLS) could ever mutate a row.

COMMENT ON TABLE public.workspace_activity_log IS
  'Append-only workspace-lifecycle audit (created/activated/renamed/owner_transferred/member_*). '
  'Deletions are recorded in deleted_workspaces, not here (FK cascade would remove them). '
  'Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md.';

-- ----------------------------------------------------------------------------
-- 2. workspace_creation_requests — idempotency guard for create-workspace
-- ----------------------------------------------------------------------------
-- The dedupe row is the FIRST write in create-workspace's confirm path. A
-- double-submit hits the PK unique violation and short-circuits before any
-- workspace insert or Stripe subscription is created, preventing duplicate
-- workspaces / double $499 charges (pressure-test CRITICAL). Service-role only.
CREATE TABLE IF NOT EXISTS public.workspace_creation_requests (
  idempotency_key text PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | active | failed | canceled
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_creation_requests_owner
  ON public.workspace_creation_requests (owner_id, created_at DESC);

-- Partial index to make the abandonment sweep's scan cheap.
CREATE INDEX IF NOT EXISTS idx_workspace_creation_requests_pending
  ON public.workspace_creation_requests (created_at)
  WHERE status = 'pending';

ALTER TABLE public.workspace_creation_requests ENABLE ROW LEVEL SECURITY;

-- No authenticated policy: RLS on + no permissive policy = deny all
-- authenticated access. The create-workspace / sweep edge functions read and
-- write this table under service_role (bypasses RLS).

COMMENT ON TABLE public.workspace_creation_requests IS
  'Idempotency guard for create-workspace. First write in the confirm path; PK '
  'collision short-circuits a double-submit. status: pending|active|failed|canceled. '
  'Service-role only. Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md.';

-- ----------------------------------------------------------------------------
-- 3. create_workspace_locked() — atomic eligibility + cap + insert
-- ----------------------------------------------------------------------------
-- PostgREST runs each statement in its own transaction, so the create-workspace
-- edge function cannot hold pg_advisory_xact_lock across a separate count+insert.
-- This function does the whole gated insert in ONE transaction:
--   advisory lock (per owner) → idempotency check → Business eligibility →
--   live cap COUNT → workspace insert (Starter baseline) → admin member row →
--   dedupe row → audit row.
-- The advisory lock serializes concurrent confirms for the same owner so two
-- requests cannot both pass COUNT < cap (pressure-test TOCTOU fix).
--
-- The workspace is inserted at the Starter baseline; the entitlement guard
-- permits Starter-default inserts, and the Stripe webhook (the SOLE entitlement
-- writer) promotes it to Business after the edge function's subscription is paid.
-- This function performs NO Stripe call and writes NO billing/entitlement
-- columns — it is purely the atomic DB half.
--
-- SECURITY DEFINER + service_role-only EXECUTE: a direct authenticated call
-- would let a Business owner mint an extra Starter workspace without the $499
-- subscription the edge function attaches. Restricting EXECUTE to service_role
-- forces every creation through the paying edge-function path.
CREATE OR REPLACE FUNCTION public.create_workspace_locked(
  p_owner_id        uuid,
  p_name            text,
  p_idempotency_key text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cap             int := 10;   -- WORKSPACE_LIMITS.business (mirror of _shared/workspace_limits.ts)
  v_owned_count     int;
  v_business_count  int;
  v_workspace_id    uuid;
  v_existing        public.workspace_creation_requests%ROWTYPE;
  v_clean_name      text := btrim(coalesce(p_name, ''));
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'owner_id is required' USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_clean_name) < 1 OR length(v_clean_name) > 100 THEN
    RETURN jsonb_build_object('status', 'invalid_name');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialize per owner: two concurrent confirms can't both pass the cap.
  PERFORM pg_advisory_xact_lock(hashtext(p_owner_id::text));

  -- Idempotency: a repeated key returns the prior outcome, no new work.
  SELECT * INTO v_existing
    FROM public.workspace_creation_requests
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'workspace_id', v_existing.workspace_id,
      'request_status', v_existing.status
    );
  END IF;

  -- Eligibility: caller must already own an active/trialing Business workspace.
  SELECT count(*) INTO v_business_count
    FROM public.workspaces
    WHERE owner_id = p_owner_id
      AND plan = 'business'
      AND subscription_status IN ('active', 'trialing');
  IF v_business_count < 1 THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Cap: live count of owned workspaces must be under the Business cap.
  SELECT count(*) INTO v_owned_count
    FROM public.workspaces
    WHERE owner_id = p_owner_id;
  IF v_owned_count >= v_cap THEN
    RETURN jsonb_build_object('status', 'cap_reached', 'count', v_owned_count, 'cap', v_cap);
  END IF;

  -- Insert workspace at the Starter baseline (guard permits; webhook promotes).
  INSERT INTO public.workspaces (name, owner_id)
    VALUES (v_clean_name, p_owner_id)
    RETURNING id INTO v_workspace_id;

  -- Admin member row — mirrors Onboarding.tsx exactly.
  INSERT INTO public.workspace_members (workspace_id, user_id, role, invited_at, accepted_at)
    VALUES (v_workspace_id, p_owner_id, 'admin', now(), now());

  -- Idempotency record, linked to the workspace.
  INSERT INTO public.workspace_creation_requests (idempotency_key, owner_id, workspace_id, status)
    VALUES (p_idempotency_key, p_owner_id, v_workspace_id, 'pending');

  -- Audit: created (correlation id = idempotency_key).
  INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
    VALUES (v_workspace_id, p_owner_id, 'created',
            jsonb_build_object('idempotency_key', p_idempotency_key, 'name', v_clean_name));

  RETURN jsonb_build_object('status', 'created', 'workspace_id', v_workspace_id);
END;
$$;

ALTER FUNCTION public.create_workspace_locked(uuid, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_workspace_locked(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_workspace_locked(uuid, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.create_workspace_locked(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_locked(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.create_workspace_locked(uuid, text, text) IS
  'Atomic gated workspace insert for create-workspace (advisory-locked per owner): '
  'idempotency + Business eligibility + live cap + Starter-baseline insert + member '
  'row + dedupe + audit. No Stripe, no entitlement writes. service_role EXECUTE only '
  '(forces creation through the paying edge-function path). Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md.';
