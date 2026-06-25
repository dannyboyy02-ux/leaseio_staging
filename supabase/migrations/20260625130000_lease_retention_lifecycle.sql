-- Leases redesign Phase 3 — lease-level soft-delete + 14-day retention + purge.
--
-- Adds an admin "Delete" capability DISTINCT from Archive:
--   * Archive (#79/#92)  — operational hide; restorable INDEFINITELY; lease row
--     stays intact forever; frees an active slot. Owned by the
--     enforce_lease_archive_attribution guard (archived/archived_at/archived_by).
--   * Delete (THIS)      — admin destroys a lease; it is SOFT-deleted (hidden
--     everywhere, frees an active slot), the row is RETAINED 14 days for
--     restore-on-request, then the nightly process-lease-retention cron
--     HARD-purges it (row + ON DELETE CASCADE audit trail + storage), writing a
--     durable deleted_leases forensic row first. Restore before purge clears the
--     columns and brings everything back.
--
-- WRITERS (service_role only): the delete-lease / restore-lease edge functions
-- (soft-delete + restore) and the process-lease-retention cron (purge). A client
-- can never set/clear the retention columns directly — enforced by the new
-- enforce_lease_retention_columns guard below. This mirrors the workspace
-- cancellation lifecycle (20260612160000) one row down: per-lease instead of
-- per-workspace.
--
-- WHY a service-role function and not a guarded client UPDATE (like archive):
-- prevent_locked_lease_edits (baseline:526) REJECTS any authenticated change to
-- a model_locked lease for columns NOT in its ignored_keys allowlist, and the
-- retention columns are deliberately NOT added there. The admin Delete must work
-- on a committed/locked lease ("always available to the admin"), so the write
-- must run as service_role (which prevent_locked_lease_edits exempts, :547). The
-- subsequent hard purge likewise needs service_role to clear
-- prevent_committed_lease_hard_delete (20260618140000).
--
-- SECURITY-SENSITIVE (RLS policy + guard trigger + service-role-only table):
-- route reviewer routing BEFORE db push (CLAUDE.md).

-- ── 1. Retention lifecycle columns ───────────────────────────────────────────
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS deleted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after     timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by      uuid,
  ADD COLUMN IF NOT EXISTS deletion_reason text;

COMMENT ON COLUMN public.leases.deleted_at IS
  'Set by the delete-lease edge function when an admin soft-deletes the lease: hidden from all authenticated reads (leases_hide_soft_deleted restrictive RLS), excluded from active counts, frees a slot. NULL = live. Cleared by restore-lease. Service-role only (enforce_lease_retention_columns guard).';
COMMENT ON COLUMN public.leases.purge_after IS
  'deleted_at + 14 days: after this the process-lease-retention cron hard-purges the lease (row + CASCADE audit + storage; forensic row in deleted_leases survives). Service-role only.';
COMMENT ON COLUMN public.leases.deleted_by IS
  'auth.uid() of the admin who soft-deleted the lease (NULL for any system path). Service-role only.';
COMMENT ON COLUMN public.leases.deletion_reason IS
  'Optional free-text reason captured at soft-delete. Service-role only.';

-- Cron due-row scan: partial index over the small set of soft-deleted leases.
CREATE INDEX IF NOT EXISTS leases_purge_after_idx
  ON public.leases (purge_after)
  WHERE deleted_at IS NOT NULL;

-- ── 2. Hide soft-deleted leases from EVERY authenticated read ────────────────
-- A single RESTRICTIVE SELECT policy ANDs with the permissive
-- leases_select_own_or_workspace policy, so soft-deleted leases vanish from the
-- Leases list, Dashboard, Portfolio, Reports, the AI assistant, and the
-- AppContext quota counts at once — no per-query churn, no risk of a surface
-- leaking a "deleted" lease. service_role bypasses RLS entirely, so the
-- edge functions + cron still see them. Authenticated-only: anon already has no
-- lease access via the permissive policy.
DROP POLICY IF EXISTS leases_hide_soft_deleted ON public.leases;
CREATE POLICY leases_hide_soft_deleted ON public.leases
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL);

-- ── 3. Retention columns are service-role-managed (disjoint-column guard) ─────
-- Mirrors enforce_lease_archive_attribution's shape: this guard OWNS exactly the
-- four retention columns and no others, so it composes with the existing leases
-- BEFORE-UPDATE triggers (prevent_locked_lease_edits, enforce_lease_archive_
-- attribution, prevent_unauthorized_lease_workflow_edits) without trigger-order
-- contention — Postgres fires them alphabetically by name, but they touch
-- DISJOINT column sets. A normal authenticated edit leaves the retention columns
-- equal to OLD (both NULL), so IS DISTINCT FROM is false and the edit passes.
CREATE OR REPLACE FUNCTION public.enforce_lease_retention_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- delete-lease / restore-lease / process-lease-retention run as service_role.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL
       OR NEW.purge_after IS NOT NULL
       OR NEW.deleted_by IS NOT NULL
       OR NEW.deletion_reason IS NOT NULL THEN
      RAISE EXCEPTION 'lease retention columns (deleted_at/purge_after/deleted_by/deletion_reason) are managed by the delete-lease/restore-lease edge functions and cannot be set directly'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: none of the four may change from an authenticated session.
  IF NEW.deleted_at      IS DISTINCT FROM OLD.deleted_at
     OR NEW.purge_after     IS DISTINCT FROM OLD.purge_after
     OR NEW.deleted_by      IS DISTINCT FROM OLD.deleted_by
     OR NEW.deletion_reason IS DISTINCT FROM OLD.deletion_reason THEN
    RAISE EXCEPTION 'lease retention columns (deleted_at/purge_after/deleted_by/deletion_reason) are managed by the delete-lease/restore-lease edge functions and cannot be changed directly'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_lease_retention_columns() OWNER TO postgres;

COMMENT ON FUNCTION public.enforce_lease_retention_columns() IS
  'Phase 3 lease-retention guard. Blocks any non-service-role INSERT/UPDATE that sets or changes leases.deleted_at/purge_after/deleted_by/deletion_reason. DISJOINT column ownership from enforce_lease_archive_attribution (archived*) and the #29/workflow guards — composes without trigger-order contention. The delete-lease/restore-lease/process-lease-retention service-role paths are the only writers. 2026-06-25.';

DROP TRIGGER IF EXISTS enforce_lease_retention_columns ON public.leases;
CREATE TRIGGER enforce_lease_retention_columns
  BEFORE INSERT OR UPDATE ON public.leases
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_lease_retention_columns();

-- ── 4. Forensic survivability (deleted_leases) ───────────────────────────────
-- The lease row + its ON DELETE CASCADE audit trail (lease_activity_log,
-- lease_governance_audit, lease_approval_chain, …) are destroyed at purge. This
-- durable row is the proof the lease existed, who deleted it, its state at
-- deletion, and that the 14-day window elapsed. One row per lease — a retried
-- partial purge RESUMES against the existing row (UNIQUE) instead of inserting a
-- contradictory duplicate. Shaped like deleted_workspaces, but its ACCESS
-- posture mirrors the stricter cancellation_notices (service-role-only, no
-- member SELECT policy) — forensic data is not customer-readable.
CREATE TABLE IF NOT EXISTS public.deleted_leases (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_lease_id          uuid NOT NULL,
  workspace_id               uuid,
  filename                   text,
  request_title              text,
  lifecycle_status_at_deletion text,
  model_locked_at_deletion   boolean,
  deleted_at                 timestamptz NOT NULL,
  deleted_by                 uuid,
  purge_after                timestamptz,
  purged_at                  timestamptz NOT NULL DEFAULT now(),
  storage_objects_purged     integer NOT NULL DEFAULT 0,
  details                    jsonb,
  UNIQUE (original_lease_id)
);

COMMENT ON TABLE public.deleted_leases IS
  'Forensic audit trail of HARD-purged leases. Written only by the process-lease-retention cron (service_role) immediately before the lease row + CASCADE audit + storage are destroyed; immutable thereafter. Survives the original leases row. One row per original_lease_id (idempotent resume).';

ALTER TABLE public.deleted_leases ENABLE ROW LEVEL SECURITY;
-- Internal operational/forensic ledger: service_role only, no member policies.
REVOKE ALL ON public.deleted_leases FROM PUBLIC, anon, authenticated;
