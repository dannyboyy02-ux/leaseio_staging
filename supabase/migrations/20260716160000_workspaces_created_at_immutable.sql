-- P0-h HIGH-1 fix (security review 2026-07-16): the monetization gate in
-- process_lease grandfathers workspaces created before the enforcement date. But
-- `workspaces.created_at` is client-writable — the workspaces UPDATE policy
-- allows owner/accepted-admin, and neither the #29 entitlement guard nor any
-- other guard protects created_at. So a never-subscribed owner could
--   PATCH /workspaces?id=eq.<mine> {"created_at":"2020-01-01T00:00:00Z"}
-- and permanently grandfather themselves past the paywall (free Starter
-- processing forever).
--
-- FIX: make created_at immutable for any non-service_role writer. A small
-- SINGLE-COLUMN guard (disjoint from the entitlement guard's column set, per the
-- CLAUDE.md trigger-ordering rule) — created_at is legitimately only ever set at
-- INSERT (DB default now()); nothing should update it.

CREATE OR REPLACE FUNCTION public.prevent_workspaces_created_at_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- service_role (webhook / edge functions) may do anything; everything that is
  -- NOT explicit service_role is treated as an untrusted writer.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workspaces.created_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_workspaces_created_at_edit ON public.workspaces;
CREATE TRIGGER trg_prevent_workspaces_created_at_edit
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_workspaces_created_at_edit();
