-- ============================================================================
-- Locked-lease vendor carve-out
-- ============================================================================
-- Once a lease is model_locked = true, prevent_locked_lease_edits() blocks
-- every column change. That's correct for almost everything: a locked lease
-- is the system of record. But finance teams need to keep vendor contact
-- info current (phone numbers change, an address moves) without going
-- through the unlock + governance change-set workflow.
--
-- This migration adds vendor_* columns to the trigger's ignored-keys list,
-- so updates to those specific fields pass through even when the lease is
-- locked. All other columns remain governance-only.
-- ============================================================================

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
    'vendor_zip'
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
