-- ============================================================================
-- profiles: explicit INSERT/UPDATE/DELETE policies
-- ============================================================================
-- The profiles table had RLS enabled but no explicit INSERT/UPDATE/DELETE
-- policies, leaving its UPDATE behavior implicit. This migration adds the
-- missing policies and constrains UPDATE so that current_workspace_id can only
-- be set to a workspace the user actually belongs to (via is_workspace_member,
-- which includes the owner case).
--
-- We deliberately do NOT add `FORCE ROW LEVEL SECURITY` here. The
-- handle_new_user() SECURITY DEFINER trigger inserts a profile row during the
-- auth signup flow at a moment when auth.uid() is NULL — forcing RLS would
-- reject those inserts and break every signup. The INSERT policy is therefore
-- permissive (WITH CHECK true). All other policies enforce ownership.
-- ============================================================================

DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
CREATE POLICY profiles_insert_self ON public.profiles
  FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND (
      current_workspace_id IS NULL
      OR public.is_workspace_member(current_workspace_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS profiles_delete_self ON public.profiles;
CREATE POLICY profiles_delete_self ON public.profiles
  FOR DELETE
  USING (id = auth.uid());
