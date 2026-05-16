-- ============================================================
-- profiles_email_lookup_index (P2-11)
--
-- Per audit P2-11 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- get-invite-info and accept-invite both called
-- supabaseAdmin.auth.admin.listUsers() to check whether an invited
-- email already had a LeaseIO account. That call is unpaginated and
-- returns only the first page (50 users by default). Once the user
-- table exceeds the page size, the check silently misses real
-- accounts — the invite UI sends the new-user path to someone who
-- already has an account, and accept-invite's takeover guard fails
-- open.
--
-- The fix replaces listUsers() with a public.profiles lookup keyed
-- on email. profiles is maintained 1:1 with auth.users via the
-- on_auth_user_created trigger (verified 4:4:4 parity on live).
-- Add a case-insensitive index so the lookup is O(1) regardless
-- of user count.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON public.profiles (lower(email));

COMMENT ON INDEX public.idx_profiles_email_lower IS
  'Case-insensitive lookup for the invite-acceptance flow (P2-11). Used by get-invite-info + accept-invite to decide existing-account vs new-user path.';
