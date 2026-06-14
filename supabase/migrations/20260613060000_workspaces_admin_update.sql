-- Workspace settings: admins can edit (KNOWN_ISSUES #70).
--
-- BEFORE (live, verified 2026-06-13): the ONLY workspaces UPDATE policy is
-- "Owners can update their workspaces" USING (owner_id = auth.uid()) — owner-
-- only. But the UI gates workspace-settings editing on
-- canEditWorkspaceSettings = isAdmin (admin OR owner). So a non-owner admin's
-- save matches 0 rows under RLS, returns NO error, and falsely toasts success
-- (silent no-op + lying UI). Product decision (2026-06-13): admins manage
-- workspace settings; owner stays exclusive for billing, ownership, deletion.
--
-- This widens the row-level UPDATE policy to accepted admins. Safety rests on
-- the existing COLUMN-level guards, which fire on every UPDATE regardless of
-- which policy permitted the row:
--   • #29 entitlement guard (prevent_workspace_entitlement_edits) blocks ALL
--     non-service-role changes to the 15 billing/lifecycle columns — so admins
--     (and owners) still cannot touch plan/limits/stripe/cancellation columns.
--   • read-only config guard (prevent_readonly_workspace_config_edits) blocks
--     config-column edits when the workspace is non-live (grace/soft-deleted/
--     vault).
-- The columns this newly lets admins edit are exactly the workspace-settings
-- columns the UI exposes (name, timezone, default_notification_days,
-- discount_rate, covenant/approval thresholds, backdoor_enabled, the
-- asset/department/region/location/building option lists,
-- separation_of_duties_default, counter_signature_default_due_days, report_*),
-- which is the #70 intent.
--
-- NEW exposure that needs its own guard: owner_id. With admins able to UPDATE
-- the row, an admin could set owner_id = self (privilege escalation to owner)
-- — there is currently no owner_id guard (the owner-only policy was the only
-- thing preventing it). Add a BEFORE UPDATE trigger blocking owner_id changes
-- by any non-service-role writer; legitimate ownership transfer runs through
-- transfer-workspace-ownership (service_role, RLS/trigger-exempt).
--
-- FLAGGED for review (not guarded here): intended_plan becomes admin-writable
-- (not in #29's set). It is the abandoned-checkout recovery hint — low-stakes
-- — but confirm acceptable vs. adding it to a guard.

-- NOTE on the dropped WITH CHECK: the prior policy (20260522000000) carried
-- WITH CHECK (owner_id = auth.uid()). Recreating WITHOUT it is REQUIRED, not
-- incidental: that WITH CHECK would force a non-owner admin's resulting row to
-- have owner_id = the admin's uid (false), re-blocking the very admin edits
-- this migration enables. owner_id immutability is instead enforced by the
-- BEFORE UPDATE trigger below — strictly stronger (it also stops an OWNER from
-- handing off ownership via a raw PATCH, which the old WITH CHECK permitted).
-- USING is reused as the post-update check; the entitlement/config/owner
-- column guards (triggers) carry per-column WITH-CHECK responsibility.

-- ── 1. Widen the UPDATE policy to owners + accepted admins ─────────────────
DROP POLICY IF EXISTS "Owners can update their workspaces" ON public.workspaces;

CREATE POLICY "Owners and admins can update their workspaces"
  ON public.workspaces
  FOR UPDATE
  TO public
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id = workspaces.id
        AND m.user_id = auth.uid()
        AND m.role = 'admin'
        AND m.accepted_at IS NOT NULL
    )
  );

-- ── 2. Guard owner_id against client reassignment (escalation prevention) ───
CREATE OR REPLACE FUNCTION public.prevent_workspace_owner_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'workspaces.owner_id can only be changed by the ownership-transfer flow'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_workspace_owner_reassignment() IS
  'KNOWN_ISSUES #70: now that admins can UPDATE workspaces, block non-service-role owner_id reassignment (escalation). Ownership transfer goes through transfer-workspace-ownership (service_role). Owns ONLY owner_id — disjoint from the #29 entitlement guard, the read-only config guard, and update_workspaces_updated_at. 2026-06-13.';

DROP TRIGGER IF EXISTS enforce_workspace_owner_immutable ON public.workspaces;
CREATE TRIGGER enforce_workspace_owner_immutable
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_workspace_owner_reassignment();
