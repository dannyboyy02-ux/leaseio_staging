-- P0-c — close the free-workspace INSERT hole (2026-07-16, v2).
--
-- The baseline INSERT policy on public.workspaces was:
--   "Users can create workspaces" WITH CHECK (owner_id = auth.uid())
-- i.e. any authenticated user could client-INSERT UNLIMITED workspaces straight
-- from the browser/PostgREST — each a fresh Starter workspace resetting the
-- 15-doc monthly AI quota — bypassing the paid multi-workspace path
-- (create_workspace_locked, $499/mo) and the cap. The paywall was not a wall.
--
-- v1 of this migration tried a per-row `WITH CHECK (count_owned_workspaces = 0)`.
-- SECURITY REVIEW PROVED THAT INSUFFICIENT: a WITH CHECK count subquery can't see
-- the sibling rows of the SAME multi-row INSERT, so `.insert([...N copies...])`
-- (one PostgREST statement) slips every row past count=0. An RLS count cannot
-- enforce a ≤1 invariant against a bulk insert.
--
-- FIX (v2): NO client INSERT is allowed at all (policy → WITH CHECK (false)).
-- The ONE legitimate client path — first-workspace onboarding — goes through a
-- SECURITY DEFINER RPC that takes a PER-USER advisory lock (serializing
-- concurrent calls) and atomically checks "owns zero workspaces" before
-- inserting the workspace + owner membership. Additional workspaces still go
-- through create_workspace_locked (service_role) and firm children through
-- create_firm_workspace (service_role) — both bypass RLS as before.

-- ── first-workspace RPC: advisory-locked, count-checked, atomic ───────────
CREATE OR REPLACE FUNCTION public.create_first_workspace(
  p_name text,
  p_intended_plan text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ws_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'name_required';
  END IF;

  -- Serialize per user: two concurrent calls can't both pass the count check.
  PERFORM pg_advisory_xact_lock(hashtext('create_first_workspace:' || v_uid::text));

  IF (SELECT count(*) FROM public.workspaces WHERE owner_id = v_uid) > 0 THEN
    RAISE EXCEPTION 'already_has_workspace';
  END IF;

  INSERT INTO public.workspaces (name, owner_id, intended_plan)
  VALUES (left(v_name, 120), v_uid, p_intended_plan)
  RETURNING id INTO v_ws_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role, invited_at, accepted_at)
  VALUES (v_ws_id, v_uid, 'admin', now(), now());

  RETURN v_ws_id;
END;
$$;

ALTER FUNCTION public.create_first_workspace(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_first_workspace(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_first_workspace(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_first_workspace(text, text) TO authenticated;

COMMENT ON FUNCTION public.create_first_workspace(text, text) IS
  'P0-c: the only client path to a first (free) workspace — advisory-locked + count-checked so it cannot mint more than one. owner_id is derived from auth.uid(), never client-supplied.';

-- ── Client INSERT is fully closed; all creation goes through the RPCs ─────
DROP POLICY IF EXISTS "Users can create workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Users can create their first workspace" ON public.workspaces;
CREATE POLICY "Workspace creation is server-mediated"
  ON public.workspaces FOR INSERT TO authenticated
  WITH CHECK (false);
