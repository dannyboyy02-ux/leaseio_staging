-- Atomic replace of a workspace's functional-role assignments (audit finding D3).
--
-- The client previously did a DELETE then a SEPARATE INSERT against
-- workspace_roles (two PostgREST calls, not one transaction). If the INSERT
-- failed after the DELETE had already committed, EVERY functional-role
-- assignment for the workspace was wiped while a generic "failed to save" toast
-- showed — silent, destructive data loss on a permissions table, with the next
-- page load showing the roles mysteriously gone. This wraps the replace in a
-- single transaction (a plpgsql function body is atomic): any failure rolls back
-- the DELETE too, so the roles are never partially wiped.
--
-- SECURITY INVOKER: the inner DELETE/INSERT still pass through the existing
-- workspace_roles RLS (workspace owner OR admin member) — no privilege
-- escalation. The explicit authorization guard below exists so an unauthorized
-- caller gets a clean error instead of a silent no-op: under RLS alone a DELETE
-- by a non-member simply affects 0 rows, and with empty assignments the function
-- would otherwise "succeed" doing nothing.
--
-- Attribution: functional roles drive approval routing, so a change is
-- audit-sensitive. The structural-role changer (MemberRoleSelect) already logs
-- 'member_role_changed' to workspace_activity_log; this writes the parallel
-- 'functional_roles_changed' row IN THE SAME TRANSACTION (the trail asserts the
-- change iff it committed), capturing actor + old→new set. event_type is
-- free-text (no CHECK), so no enum migration is needed; the activity-log INSERT
-- RLS (user_id = auth.uid() AND is_workspace_member) is satisfied by the
-- already-proven owner/admin caller stamping themselves.
--
-- Idempotent: CREATE OR REPLACE + idempotent GRANT.

CREATE OR REPLACE FUNCTION public.set_workspace_roles(
  p_workspace_id uuid,
  p_assignments  jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
  END IF;

  -- Mirror the workspace_roles INSERT/DELETE RLS (owner or admin member).
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces w
      WHERE w.id = p_workspace_id AND w.owner_id = auth.uid()
    UNION
    SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id = p_workspace_id
        AND m.user_id = auth.uid()
        AND m.role = 'admin'::public.workspace_role
  ) THEN
    RAISE EXCEPTION 'not authorized to manage roles for this workspace'
      USING ERRCODE = '42501';
  END IF;

  -- Snapshot the current set for the audit's old→new (before the replace).
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('user_id', user_id, 'role', role)
                     ORDER BY user_id, role),
           '[]'::jsonb)
    INTO v_old
    FROM public.workspace_roles
    WHERE workspace_id = p_workspace_id;

  -- Atomic replace. A failure on the INSERT (RLS WITH CHECK, the role CHECK
  -- constraint, a bad cast) rolls the whole function back, including the DELETE.
  DELETE FROM public.workspace_roles WHERE workspace_id = p_workspace_id;

  INSERT INTO public.workspace_roles (workspace_id, user_id, role)
  SELECT p_workspace_id,
         (a->>'user_id')::uuid,
         a->>'role'
  FROM jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) AS a;

  -- Attribution row (same transaction — see header).
  INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
  VALUES (
    p_workspace_id,
    auth.uid(),
    'functional_roles_changed',
    jsonb_build_object('old', v_old, 'new', coalesce(p_assignments, '[]'::jsonb))
  );
END;
$$;

-- Least-privilege: CREATE FUNCTION grants EXECUTE to PUBLIC by default, which
-- would let `anon` invoke this DML function. The guard rejects an anon caller
-- (auth.uid() IS NULL → 42501), but anon shouldn't reach it at all. The client
-- calls this as `authenticated`.
REVOKE ALL ON FUNCTION public.set_workspace_roles(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_workspace_roles(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_workspace_roles(uuid, jsonb) TO authenticated;
