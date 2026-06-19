-- ============================================================================
-- KNOWN_ISSUES #112 (audit W1 + B2) — firm child-counter never decremented on
-- workspace DELETE.
-- ----------------------------------------------------------------------------
-- maintain_firm_child_workspace_counter handles INSERT / UPDATE of
-- workspaces.firm_id, but its trigger fired only `BEFORE INSERT OR UPDATE OF
-- firm_id` — DELETE was excluded. So hard-deleting a firm-bound workspace (via
-- the service-role delete-workspace / delete-account fns) NEVER decremented
-- firms.child_workspaces_used: the counter drifts UP permanently and the firm
-- falsely hits child_workspace_limit, unable to bind new children. The #107
-- reconcile cron does NOT fix this — it only recomputes the Stripe *quantity*,
-- never the counter column — so this drift is otherwise irreversible without a
-- manual reconcile.
--
-- Fix: add a DELETE branch to the counter fn + fire the trigger on DELETE, then
-- one-time-reconcile any counter that already drifted.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.maintain_firm_child_workspace_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_used  integer;
BEGIN
  -- Workspace joining a firm
  IF (TG_OP = 'INSERT' AND NEW.firm_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.firm_id IS NOT NULL AND OLD.firm_id IS DISTINCT FROM NEW.firm_id) THEN
    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Firm has reached its child workspace limit of %. Increase the limit or remove an existing child first.', v_limit;
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1, updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  -- Workspace leaving a firm
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NULL) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1), updated_at = now()
     WHERE id = OLD.firm_id;
  END IF;

  -- Workspace moving between firms
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NOT NULL AND OLD.firm_id <> NEW.firm_id) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1), updated_at = now()
     WHERE id = OLD.firm_id;

    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Destination firm has reached its child workspace limit.';
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1, updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  -- #112: Workspace DELETED while bound to a firm — the firm loses a child.
  -- GREATEST(0, …) keeps the counter non-negative even if it was already low.
  IF (TG_OP = 'DELETE' AND OLD.firm_id IS NOT NULL) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1), updated_at = now()
     WHERE id = OLD.firm_id;
  END IF;

  -- A BEFORE DELETE trigger must RETURN OLD to allow the delete to proceed.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Recreate the trigger to ALSO fire on DELETE (was INSERT/UPDATE-of-firm_id only).
DROP TRIGGER IF EXISTS workspaces_firm_counter ON public.workspaces;
CREATE TRIGGER workspaces_firm_counter
  BEFORE INSERT OR DELETE OR UPDATE OF firm_id ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.maintain_firm_child_workspace_counter();

-- One-time reconcile: correct any counter that already drifted from past
-- firm-bound-workspace deletes. Idempotent — only touches rows where the stored
-- counter disagrees with the live child count.
-- NOTE: child_workspaces_used is system-managed — enforce_firm_entitlement_guard
-- RAISEs on any UPDATE to it unless auth.role()='service_role'. A migration runs
-- as the table owner (NOT service_role), so we disable that guard for just this
-- reconcile and re-enable it in the SAME transaction (DDL is transactional, so
-- no concurrent session ever observes the guard disabled).
ALTER TABLE public.firms DISABLE TRIGGER enforce_firm_entitlement_guard;
UPDATE public.firms f
   SET child_workspaces_used = sub.cnt, updated_at = now()
  FROM (
    SELECT fr.id, COUNT(w.id)::integer AS cnt
      FROM public.firms fr
      LEFT JOIN public.workspaces w ON w.firm_id = fr.id
     GROUP BY fr.id
  ) sub
 WHERE f.id = sub.id
   AND f.child_workspaces_used <> sub.cnt;
ALTER TABLE public.firms ENABLE TRIGGER enforce_firm_entitlement_guard;
