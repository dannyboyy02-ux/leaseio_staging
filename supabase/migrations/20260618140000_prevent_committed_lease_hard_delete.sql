-- KNOWN_ISSUES #116 (audit DF1): a committed / finalized lease's ROW is not
-- client-hard-deletable. Completes the #77 guard (which already blocks deleting
-- a locked lease's source FILES in storage) by protecting the lease ROW itself
-- plus its ON DELETE CASCADE audit trail (lease_activity_log,
-- lease_governance_audit, lease_approval_chain, lease_unlock_requests, risks…).
-- Client hard-delete (ImportHistory's import-rollback path) is reserved for
-- never-committed imports (draft / NULL-lifecycle, not model_locked); a
-- committed lease must be ARCHIVED instead — archiving is restorable and
-- attributed (#79 / #92), hard-delete is not.
--
-- Enforced as a BEFORE DELETE trigger that RAISEs, rather than a RESTRICTIVE RLS
-- DELETE policy, because:
--   (a) it matches the leases table's existing guard-trigger family
--       (prevent_locked_lease_edits, prevent_unauthorized_lease_workflow_edits),
--       which are likewise plpgsql guards that RAISE; and
--   (b) a RAISE gives the client a clear, actionable error. A RESTRICTIVE DELETE
--       policy would instead silently match 0 rows, so ImportHistory would
--       falsely toast "Lease deleted successfully" while the row survived.
-- service_role (delete-workspace / delete-account, and any FK CASCADE they
-- drive when a workspace/user is deleted) bypasses — COALESCE(auth.role(),'')
-- = 'service_role' — mirroring prevent_locked_lease_edits exactly. (Row-level
-- triggers DO fire on FK CASCADE deletes, unlike RESTRICTIVE RLS policies, so a
-- trigger also catches the CASCADE paths the #83 note flagged — and correctly
-- exempts the only legitimate one, which runs as service_role.)
--
-- VERIFIED before writing (2026-06-18, repo):
--   * leases DELETE RLS "leases_delete_own_or_workspace_admin" (baseline:4206)
--     lets any lease creator OR workspace admin DELETE any lease via PostgREST,
--     with no lifecycle / lock check — the hole this closes.
--   * NO existing BEFORE DELETE trigger on leases (every current guard is BEFORE
--     or AFTER UPDATE) → this is the sole DELETE trigger, so no trigger-ordering
--     concern (alphabetical-name ordering only matters among same-event triggers).
--   * model_locked flips true only at ACTIVATION (lease-governance-action /
--     legacy-lease-action / LeaseReview activation path), so it does NOT cover
--     approved / executed / pending_counter_signature / fully_executed — hence
--     the disposable test is model_locked AND a lifecycle allowlist, not
--     model_locked alone.
--   * fresh & failed imports OMIT lifecycle_status on INSERT (status=
--     'Processing'/'Failed', process_lease:2302 etc.) → Postgres applies the
--     leases.lifecycle_status column DEFAULT 'draft' (baseline:1459), so they
--     land at 'draft', NOT NULL. 'draft' is therefore the normal, legitimate
--     ImportHistory rollback target (alongside a saved-but-not-submitted
--     request, which is also 'draft'). The IS NULL branch below is kept as a
--     defensive belt for any legacy / explicit-NULL row — either value is
--     disposable. Everything submitted-or-beyond is protected.

CREATE OR REPLACE FUNCTION public.prevent_committed_lease_hard_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Trusted server paths (delete-workspace / delete-account, plus any FK CASCADE
  -- they drive) run as service_role and are guard-exempt by design.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN OLD;
  END IF;

  -- Disposable imports: never committed and not finalized. ImportHistory's
  -- import-rollback path legitimately hard-deletes these. A positive allowlist
  -- (NULL / 'draft') is deliberate: any NEW lifecycle state added later defaults
  -- to PROTECTED (fail safe — preserve the audit trail), never to deletable.
  IF OLD.model_locked IS NOT TRUE
     AND (OLD.lifecycle_status IS NULL OR OLD.lifecycle_status = 'draft') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Cannot hard-delete a committed lease (lifecycle_status=%, model_locked=%). Archive it instead — archiving is restorable and preserves the audit trail.',
    OLD.lifecycle_status, OLD.model_locked
    USING ERRCODE = 'check_violation',
          HINT = 'Hard-delete is reserved for unconfirmed imports; use the lease''s Archive action for anything submitted or finalized.';
END;
$$;

ALTER FUNCTION public.prevent_committed_lease_hard_delete() OWNER TO postgres;

COMMENT ON FUNCTION public.prevent_committed_lease_hard_delete() IS
  'KNOWN_ISSUES #116: blocks client hard-delete of a committed/finalized lease (and the ON DELETE CASCADE destruction of its audit trail). Allows service_role (delete-workspace/-account + FK CASCADE) and disposable draft/NULL-lifecycle imports (ImportHistory rollback). Committed leases must be archived. 2026-06-18.';

DROP TRIGGER IF EXISTS prevent_committed_lease_hard_delete ON public.leases;
CREATE TRIGGER prevent_committed_lease_hard_delete
  BEFORE DELETE ON public.leases
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_committed_lease_hard_delete();
