-- ============================================================
-- ops_admins_table (P2-02)
--
-- Per audit P2-02 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- the original is_ops_admin helper in migration 20260509000000 hardcoded
-- the LeaseIO HQ workspace UUID (c9dad4c7-d04a-4d14-b846-8e017d662341).
-- Promoting a second operator required SQL hand-edit of that helper;
-- moving the project to a new Supabase environment required a manual
-- UUID swap. Brittle and hard to administer.
--
-- This migration replaces the hardcoded check with an explicit
-- public.ops_admins table. is_ops_admin now reads from that table.
-- Adding/removing an operator is a one-row INSERT/DELETE under
-- service-role credentials (the table has no authenticated INSERT
-- policy — escalation must go through a server-side path).
--
-- Also adds public.am_i_ops_admin() — a SECURITY DEFINER RPC the
-- frontend can call to gate the /app/admin/operations route. Previous
-- behavior was that non-ops users reached the route and saw an empty
-- dashboard (RLS filtered all data). Now the route component can
-- short-circuit with a clear unauthorized state.
-- ============================================================

-- ─── 1. Table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ops_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES auth.users(id),
  note       text
);

COMMENT ON TABLE public.ops_admins IS
  'Allowlist of users who can read Operational Monitoring data (vendor health, renewals, alerts). Replaces the hardcoded workspace UUID in is_ops_admin. Only mutated via service-role.';

ALTER TABLE public.ops_admins ENABLE ROW LEVEL SECURITY;

-- No authenticated INSERT/UPDATE/DELETE policies on purpose.
-- service_role bypasses RLS so server-side promotion paths work.
-- SELECT is allowed only via is_ops_admin / am_i_ops_admin RPCs.
DROP POLICY IF EXISTS "ops admins can see themselves" ON public.ops_admins;
CREATE POLICY "ops admins can see themselves"
  ON public.ops_admins FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ─── 2. Seed current operator ─────────────────────────────────────
-- Daniel's user_id from the LeaseIO HQ workspace owner. Same user the
-- prior is_ops_admin hardcode resolved to.
INSERT INTO public.ops_admins (user_id, note)
SELECT owner_id, 'Migrated from hardcoded is_ops_admin on 2026-05-15 (P2-02)'
FROM public.workspaces
WHERE id = 'c9dad4c7-d04a-4d14-b846-8e017d662341'::uuid
ON CONFLICT (user_id) DO NOTHING;

-- ─── 3. is_ops_admin reads from the table ─────────────────────────
CREATE OR REPLACE FUNCTION public.is_ops_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ops_admins WHERE user_id = _user_id
  );
$$;

COMMENT ON FUNCTION public.is_ops_admin(uuid) IS
  'Returns true when the user is in public.ops_admins. Replaced the workspace-UUID-hardcoded version on 2026-05-15 (P2-02).';

-- ─── 4. Frontend-callable gate ────────────────────────────────────
-- Thin wrapper so the OperationsPage route can short-circuit for
-- non-ops users with a clear unauthorized state instead of an empty
-- dashboard.
CREATE OR REPLACE FUNCTION public.am_i_ops_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_ops_admin(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.am_i_ops_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.am_i_ops_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.am_i_ops_admin() TO service_role;

COMMENT ON FUNCTION public.am_i_ops_admin() IS
  'SECURITY DEFINER wrapper around is_ops_admin(auth.uid()). Callable by authenticated users for frontend route gating. Returns false for unauthenticated.';
