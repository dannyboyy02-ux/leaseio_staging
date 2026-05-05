-- Owner Workspace Management — Checkpoint 1 schema
-- See docs/OWNER_WORKSPACE_MGMT_BUILD_SPEC.md for full context.
--
-- Adds the deleted_workspaces audit table. Survives the deletion of the
-- workspace itself for forensic + billing reconciliation purposes
-- (lease/member counts, storage objects purged, plan, deleted_by user).
--
-- The table is INSERT-only from the service role (the delete-workspace
-- edge function), with SELECT scoped to the original owner OR the actor
-- who performed the deletion. There is no UPDATE / DELETE policy — once
-- recorded, audit rows are immutable.
--
-- Per the schema-change rule in CLAUDE.md, this .sql is the source of
-- truth. Idempotent via IF NOT EXISTS + DROP-then-CREATE for policies.

-- ───────────────────────────────────────────────────────────────────────
-- 1. deleted_workspaces table
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deleted_workspaces (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Captured BEFORE the workspaces row goes away. Not a FK — the
  -- referenced row no longer exists by the time this is written.
  original_workspace_id       uuid NOT NULL,
  -- The owner at delete time. FK to auth.users so the row is invalidated
  -- if the owner's account is later deleted (audit trail follows account
  -- lifecycle).
  owner_id                    uuid NOT NULL,
  workspace_name              text,
  workspace_plan              text,
  lease_count_at_deletion     int,
  member_count_at_deletion    int,
  storage_objects_purged      int,
  deleted_at                  timestamptz NOT NULL DEFAULT now(),
  -- Who initiated the deletion. Usually the owner; may differ in future
  -- if admin-on-behalf flows are added (out of scope for v1 — owner-only).
  deleted_by                  uuid REFERENCES auth.users(id)
);

-- ───────────────────────────────────────────────────────────────────────
-- 2. Index — owner audit lookups
-- ───────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_deleted_workspaces_owner
  ON public.deleted_workspaces(owner_id, deleted_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- 3. RLS — owner / actor read; service-role-only write
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.deleted_workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners view own workspace deletions" ON public.deleted_workspaces;
CREATE POLICY "Owners view own workspace deletions"
  ON public.deleted_workspaces
  FOR SELECT
  USING (owner_id = auth.uid() OR deleted_by = auth.uid());

-- No INSERT / UPDATE / DELETE policies for the authenticated role.
-- The delete-workspace edge function inserts via the service role,
-- which bypasses RLS. Audit rows are immutable; UPDATE / DELETE are
-- never legitimate.

-- ───────────────────────────────────────────────────────────────────────
-- 4. Comment for future readers
-- ───────────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.deleted_workspaces IS
  'Forensic audit trail of workspace deletions. Written by the delete-workspace edge function; immutable thereafter. Survives the original workspaces row.';
