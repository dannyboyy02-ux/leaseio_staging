-- Destruction guards (KNOWN_ISSUES #83 + #77). Two restrictive policies that
-- close client-reachable destruction paths the permissive policies left open.
-- Same additive AS-RESTRICTIVE pattern as the Vault V1 layer (20260613000000):
-- restrictive policies AND onto existing permissive ones; service_role bypasses
-- RLS wholesale, so the legitimate server paths are unaffected.
--
-- VERIFIED before writing (2026-06-13, live DB + code):
--   #83: the permissive "Owners can delete their workspaces" (USING owner_id =
--        auth.uid()) is live; both legitimate deletion paths — delete-workspace
--        AND delete-account — use the SERVICE_ROLE client (delete-account's
--        client is named supabaseClient but is built with SERVICE_ROLE_KEY), so
--        they bypass RLS. No client (authenticated/anon) path legitimately
--        DELETEs a workspace; the only such path is the unattributable bulk
--        destruction this closes.
--   #77: the three lease-related storage DELETE policies ("Users can delete own
--        lease files", executed_leases_delete, "admins delete from
--        lease-documents") are all permissive with NO model_locked check; the
--        DB row guard prevent_locked_lease_edits does not cover raw storage API
--        deletes of a locked lease's source PDF.

-- ── #83: workspaces are not client-deletable ──────────────────────────────
-- Owner-initiated deletion must go through the delete-workspace edge function
-- (service_role), which writes the forensic deleted_workspaces row and runs
-- the Stripe + bucket cleanup. Drop the permissive policy (so default-deny
-- applies to DELETE for authenticated/anon) AND add a restrictive deny as a
-- durable backstop against any future permissive DELETE policy. This is also
-- the one client path that could destroy a frozen (grace/Vault) repository,
-- because FK CASCADE child deletes are not subject to the Vault restrictive
-- DELETE policies (KNOWN_ISSUES #83 Vault note).
DROP POLICY IF EXISTS "Owners can delete their workspaces" ON public.workspaces;

DO $$
BEGIN
  CREATE POLICY "workspace deletes are server-only"
    ON public.workspaces AS RESTRICTIVE FOR DELETE
    USING (false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON POLICY "workspace deletes are server-only" ON public.workspaces IS
  'KNOWN_ISSUES #83: client (authenticated/anon) DELETE of a workspace is denied — it bypassed the deleted_workspaces forensic row and could CASCADE-destroy a frozen repository. Deletion goes through delete-workspace/delete-account (service_role, RLS-exempt). 2026-06-13.';

-- ── #77: a model-locked lease's source files are not deletable ─────────────
-- prevent_locked_lease_edits guards the leases ROW; this guards the source
-- PDFs in storage. Blocks deleting an object that a model_locked lease still
-- references. Path conventions match the Vault V1 storage policies: leases
-- bucket → leases.storage_path = name; executed-leases → executed_storage_path
-- = name (idx_leases_storage_path / idx_leases_executed_storage_path from V1
-- support these subqueries). lease-documents / lease-reports are unaffected
-- (ELSE true). service_role (delete-workspace/lifecycle purge) bypasses.
DO $$
BEGIN
  CREATE POLICY "locked lease source files are not deletable"
    ON storage.objects AS RESTRICTIVE FOR DELETE
    USING (
      CASE bucket_id
        WHEN 'leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.storage_path = name AND l.model_locked)
        WHEN 'executed-leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.executed_storage_path = name AND l.model_locked)
        ELSE true
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
