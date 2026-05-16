-- ============================================================================
-- Lease archive flag + per-plan archive cap
-- ============================================================================
-- Splits lease usage into two dimensions:
--   1. Active leases (existing) — counts toward plan's maxActiveLeases /
--      workspaces.document_limit.
--   2. Archived leases (new) — counts toward a separate cap
--      (workspaces.max_archived_leases).
--
-- Archived is an explicit boolean on leases, set by admin action — orthogonal
-- to lifecycle_status. An admin can archive a lease at any lifecycle stage to
-- free an active slot without losing the audit history. Archived leases stay
-- queryable and exportable; they just don't count against the active cap.
--
-- Locked leases must remain archive-able, so the prevent_locked_lease_edits()
-- trigger gets archived/archived_at/archived_by added to its ignored-keys
-- carve-out (alongside the existing vendor_* fields).
-- ============================================================================

-- 1. Lease archive columns + index
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS leases_archived_workspace_idx
  ON public.leases (workspace_id, archived);

-- 2. Workspace archive cap, backfilled from current plan tier
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS max_archived_leases integer;

UPDATE public.workspaces
   SET max_archived_leases =
     CASE plan
       WHEN 'business' THEN 250
       ELSE 50
     END
 WHERE max_archived_leases IS NULL;

-- 3. Extend the lock trigger carve-out for archive fields
CREATE OR REPLACE FUNCTION public.prevent_locked_lease_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  old_client_state jsonb;
  new_client_state jsonb;
  ignored_keys text[] := ARRAY[
    'updated_at',
    'vendor_name',
    'vendor_phone',
    'vendor_address_line1',
    'vendor_address_line2',
    'vendor_city',
    'vendor_state',
    'vendor_zip',
    'archived',
    'archived_at',
    'archived_by'
  ];
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.summary_share_token IS DISTINCT FROM OLD.summary_share_token
    OR NEW.summary_shared_at IS DISTINCT FROM OLD.summary_shared_at
    OR NEW.summary_last_viewed_at IS DISTINCT FROM OLD.summary_last_viewed_at
  THEN
    RAISE EXCEPTION 'Financial summary sharing fields are managed by the summary publishing workflow';
  END IF;

  IF OLD.model_locked IS TRUE THEN
    old_client_state := to_jsonb(OLD) - ignored_keys;
    new_client_state := to_jsonb(NEW) - ignored_keys;

    IF new_client_state IS DISTINCT FROM old_client_state THEN
      RAISE EXCEPTION 'Cannot modify a locked lease except through the governance workflow';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
