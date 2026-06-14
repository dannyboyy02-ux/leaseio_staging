-- Lease archive attribution guard (KNOWN_ISSUES #78, core half).
--
-- VERIFIED (live DB, 2026-06-13): the leases archive columns (archived,
-- archived_at, archived_by) are guarded by NO trigger — prevent_locked_lease_-
-- edits lists all three in its ignored_keys (so even a model_locked lease is
-- archivable), and prevent_unauthorized_lease_workflow_edits guards only
-- lifecycle/approval/lock columns. The permissive UPDATE policy lets any
-- workspace editor set archived=true via PostgREST with a forged archived_by
-- and a client-clock archived_at; the admin gate + audit logging are UI-only.
--
-- Fix: a BEFORE UPDATE trigger that, for authenticated (non-service-role)
-- writers, (a) requires admin/owner to toggle archived, (b) stamps
-- archived_by/archived_at server-side from the authenticated identity, and
-- (c) forbids touching the attribution columns without an archived toggle.
-- Mirrors the #29 / read-only-config guard shape (auth.role() bypass,
-- check_violation). Owns ONLY the three archive columns — disjoint from
-- prevent_locked_lease_edits (ignores them) and prevent_unauthorized_lease_-
-- workflow_edits (doesn't reference them), so the BEFORE-UPDATE triggers never
-- contend on a shared column regardless of alphabetical firing order. The name
-- sorts before enforce_model_lock, which ignores archive columns, so the
-- attribution stamp this writes is never re-inspected by the lock guard.
--
-- NOTE this closes the archive half of #78. The companion half — constraining
-- the "Users can create activity entries" INSERT policy to a client-insertable
-- activity_type allowlist with user_id = auth.uid() (it currently allows any of
-- ~100 types and user_id IS NULL, i.e. forged system attribution) — is tracked
-- separately (KNOWN_ISSUES #90): it spans the whole audit vocabulary + ~10
-- client insert sites and needs per-type adjudication, not a same-pass rush.

CREATE OR REPLACE FUNCTION public.enforce_lease_archive_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Nothing archive-related changed: not our concern.
  IF NEW.archived    IS NOT DISTINCT FROM OLD.archived
     AND NEW.archived_by IS NOT DISTINCT FROM OLD.archived_by
     AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    RETURN NEW;
  END IF;

  -- Attribution columns can never be set on their own by a client — they are
  -- stamped below only when `archived` actually toggles. Revert any standalone
  -- tamper so a client can't backdate/forge attribution without a real toggle.
  IF NEW.archived IS NOT DISTINCT FROM OLD.archived THEN
    NEW.archived_by := OLD.archived_by;
    NEW.archived_at := OLD.archived_at;
    RETURN NEW;
  END IF;

  -- `archived` is toggling: require workspace admin/owner.
  SELECT (w.owner_id = auth.uid())
         OR EXISTS (
           SELECT 1 FROM public.workspace_members m
           WHERE m.workspace_id = NEW.workspace_id
             AND m.user_id = auth.uid()
             AND m.role = 'admin'
             AND m.accepted_at IS NOT NULL)
    INTO v_is_admin
  FROM public.workspaces w
  WHERE w.id = NEW.workspace_id;

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Only a workspace admin or owner may archive or restore a lease'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Stamp attribution server-side, overriding any client-supplied values.
  IF NEW.archived THEN
    NEW.archived_by := auth.uid();
    NEW.archived_at := now();
  ELSE
    NEW.archived_by := NULL;
    NEW.archived_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_lease_archive_attribution() IS
  'KNOWN_ISSUES #78 (archive half): non-service-role archive/restore of a lease requires workspace admin/owner; archived_by/archived_at are stamped server-side from auth.uid()/now() and cannot be set independently. Owns leases columns archived, archived_by, archived_at — disjoint from prevent_locked_lease_edits (ignores them) and prevent_unauthorized_lease_workflow_edits. 2026-06-13.';

DROP TRIGGER IF EXISTS enforce_lease_archive_attribution ON public.leases;
CREATE TRIGGER enforce_lease_archive_attribution
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_archive_attribution();
