-- P0-d — stop account deletion from destroying OTHER tenants' leases (2026-07-16).
--
-- `leases.user_id -> profiles` was ON DELETE CASCADE. Deleting a user's profile
-- (the last step of account deletion) therefore CASCADE-deleted EVERY lease that
-- user had uploaded — INCLUDING leases they uploaded into OTHER tenants'
-- (their employer's) workspaces — silently erasing the employer's
-- audit-defensible repository. This is the schema half of the cross-tenant
-- data-loss bug; the delete-account edge function is the code half (it also
-- deleted leases explicitly by user_id — removed in the same change).
--
-- FIX: ON DELETE SET NULL, so a departing uploader's account deletion leaves the
-- lease intact in its rightful workspace and only clears the uploader
-- attribution (exactly how lease_activity_log.user_id already behaves). Requires
-- user_id to be nullable (workspace_id already is).
--
-- NOTE: leases with a NULL user_id are only ever produced by profile deletion.
-- The lease's storage paths are stored on the row (storage_path /
-- executed_storage_path), not re-derived from user_id, so file references
-- survive. Attribution readers already tolerate a null actor (#90 convention).

ALTER TABLE public.leases ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.leases DROP CONSTRAINT IF EXISTS leases_user_id_fkey;
ALTER TABLE public.leases
  ADD CONSTRAINT leases_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
