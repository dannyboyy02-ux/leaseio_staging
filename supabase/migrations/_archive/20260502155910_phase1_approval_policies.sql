-- Phase 1 — Configurable Approval Policies
-- See docs/PHASE_1_BUILD_SPEC.md for full context.
-- Purely additive: schema + RPCs + admin UI scaffolding. No runtime behavior
-- changes; legacy parallel manager_approver / financial_approver flow stays
-- intact until Phase 2.
--
-- This file mirrors the migration applied to the live Supabase project on
-- 2026-05-02 (version 20260502155910). It is idempotent — safe to run on
-- environments that already have these objects, and on fresh ones.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Workspace-level setting
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS separation_of_duties_default boolean NOT NULL DEFAULT true;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. approval_policies table
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.approval_policies (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name                            text NOT NULL,
  description                     text,
  priority                        integer NOT NULL DEFAULT 100,
  match_asset_types               text[] NOT NULL DEFAULT '{}',
  match_departments               text[] NOT NULL DEFAULT '{}',
  match_min_annual_cost           numeric,
  match_max_annual_cost           numeric,
  match_regions                   text[] NOT NULL DEFAULT '{}',
  match_lease_types               text[] NOT NULL DEFAULT '{}',
  separation_of_duties_override   boolean,
  is_default_fallback             boolean NOT NULL DEFAULT false,
  version                         integer NOT NULL DEFAULT 1,
  is_active                       boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid NOT NULL REFERENCES auth.users(id),
  updated_by                      uuid NOT NULL REFERENCES auth.users(id),
  CONSTRAINT cost_range_valid CHECK (
    match_min_annual_cost IS NULL OR
    match_max_annual_cost IS NULL OR
    match_min_annual_cost <= match_max_annual_cost
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_policies_workspace_active
  ON public.approval_policies(workspace_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_policies_one_default_per_workspace
  ON public.approval_policies(workspace_id)
  WHERE is_default_fallback = true AND is_active = true;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. approval_chain_steps table
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.approval_chain_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           uuid NOT NULL REFERENCES public.approval_policies(id) ON DELETE CASCADE,
  stage               text NOT NULL CHECK (stage IN ('concept', 'signator')),
  step_order          integer NOT NULL,
  parallel_group      integer NOT NULL DEFAULT 1,
  approver_user_id    uuid REFERENCES auth.users(id),
  approver_role       text CHECK (approver_role IN ('submitter', 'manager_approver', 'financial_approver', 'signator', 'admin')),
  delegate_user_id    uuid REFERENCES auth.users(id),
  delegate_after_days integer CHECK (delegate_after_days IS NULL OR delegate_after_days > 0),
  is_required         boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_assignee_method CHECK (
    (approver_user_id IS NOT NULL AND approver_role IS NULL) OR
    (approver_user_id IS NULL AND approver_role IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_chain_steps_policy
  ON public.approval_chain_steps(policy_id, stage, step_order);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. updated_at + version-increment triggers
-- ───────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS approval_policies_updated_at ON public.approval_policies;
CREATE TRIGGER approval_policies_updated_at
  BEFORE UPDATE ON public.approval_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.increment_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approval_policies_version_increment ON public.approval_policies;
CREATE TRIGGER approval_policies_version_increment
  BEFORE UPDATE ON public.approval_policies
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR
    OLD.match_asset_types IS DISTINCT FROM NEW.match_asset_types OR
    OLD.match_departments IS DISTINCT FROM NEW.match_departments OR
    OLD.match_min_annual_cost IS DISTINCT FROM NEW.match_min_annual_cost OR
    OLD.match_max_annual_cost IS DISTINCT FROM NEW.match_max_annual_cost OR
    OLD.match_regions IS DISTINCT FROM NEW.match_regions OR
    OLD.match_lease_types IS DISTINCT FROM NEW.match_lease_types OR
    OLD.priority IS DISTINCT FROM NEW.priority OR
    OLD.separation_of_duties_override IS DISTINCT FROM NEW.separation_of_duties_override
  )
  EXECUTE FUNCTION public.increment_policy_version();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_chain_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read policies" ON public.approval_policies;
CREATE POLICY "workspace members read policies"
  ON public.approval_policies FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "workspace admins write policies" ON public.approval_policies;
CREATE POLICY "workspace admins write policies"
  ON public.approval_policies FOR ALL
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "members read steps via policy" ON public.approval_chain_steps;
CREATE POLICY "members read steps via policy"
  ON public.approval_chain_steps FOR SELECT
  USING (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
        UNION
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "admins write steps via policy" ON public.approval_chain_steps;
CREATE POLICY "admins write steps via policy"
  ON public.approval_chain_steps FOR ALL
  USING (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
      )
    )
  )
  WITH CHECK (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
      )
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Extend workspace_roles.role check constraint to include 'signator'
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workspace_roles
  DROP CONSTRAINT IF EXISTS workspace_roles_role_check;

ALTER TABLE public.workspace_roles
  ADD CONSTRAINT workspace_roles_role_check
  CHECK (role IN ('submitter', 'manager_approver', 'financial_approver', 'signator', 'admin'));

-- ───────────────────────────────────────────────────────────────────────────
-- 7. RPC: preview_policy_resolution (read-only)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.preview_policy_resolution(
  p_workspace_id uuid,
  p_asset_type text,
  p_department text,
  p_annual_cost numeric,
  p_region text,
  p_lease_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy public.approval_policies;
  v_chain jsonb;
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  -- Caller must have membership/ownership in the workspace being queried.
  -- Belt-and-suspenders since the function is SECURITY DEFINER.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_id = auth.uid()
    UNION
    SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Find matching policies, sorted by priority descending
  SELECT * INTO v_policy
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
    AND p.is_active = true
    AND (cardinality(p.match_asset_types) = 0 OR p_asset_type = ANY(p.match_asset_types))
    AND (cardinality(p.match_departments) = 0 OR p_department = ANY(p.match_departments))
    AND (p.match_min_annual_cost IS NULL OR p_annual_cost >= p.match_min_annual_cost)
    AND (p.match_max_annual_cost IS NULL OR p_annual_cost <= p.match_max_annual_cost)
    AND (cardinality(p.match_regions) = 0 OR p_region = ANY(p.match_regions))
    AND (cardinality(p.match_lease_types) = 0 OR p_lease_type = ANY(p.match_lease_types))
  ORDER BY p.priority DESC, p.created_at ASC
  LIMIT 1;

  -- Fall back to default policy if none matched
  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.is_default_fallback = true
    LIMIT 1;

    IF v_policy.id IS NULL THEN
      RETURN jsonb_build_object(
        'matched', false,
        'error', 'No matching policy and no default fallback configured.'
      );
    END IF;

    v_warnings := array_append(v_warnings, 'No specific match; using default fallback policy.');
  END IF;

  -- Build resolved chain
  SELECT jsonb_agg(
    jsonb_build_object(
      'stage', s.stage,
      'step_order', s.step_order,
      'parallel_group', s.parallel_group,
      'approver_user_id', s.approver_user_id,
      'approver_role', s.approver_role,
      'delegate_user_id', s.delegate_user_id,
      'is_required', s.is_required
    )
    ORDER BY s.stage, s.step_order, s.parallel_group
  ) INTO v_chain
  FROM public.approval_chain_steps s
  WHERE s.policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'matched', true,
    'policy_id', v_policy.id,
    'policy_name', v_policy.name,
    'policy_priority', v_policy.priority,
    'policy_version', v_policy.version,
    'separation_override', v_policy.separation_of_duties_override,
    'chain', COALESCE(v_chain, '[]'::jsonb),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.preview_policy_resolution(uuid, text, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_policy_resolution(uuid, text, text, numeric, text, text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. RPC: apply_policy_steps (atomic chain replacement)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_policy_steps(
  p_policy_id uuid,
  p_steps jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Auth check: caller must be admin/owner of the policy's workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.id = p_policy_id
      AND (
        p.workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
        OR p.workspace_id IN (
          SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  DELETE FROM public.approval_chain_steps WHERE policy_id = p_policy_id;

  INSERT INTO public.approval_chain_steps (
    policy_id, stage, step_order, parallel_group,
    approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required
  )
  SELECT
    p_policy_id,
    (s->>'stage')::text,
    (s->>'step_order')::integer,
    COALESCE((s->>'parallel_group')::integer, 1),
    NULLIF(s->>'approver_user_id', '')::uuid,
    NULLIF(s->>'approver_role', ''),
    NULLIF(s->>'delegate_user_id', '')::uuid,
    NULLIF(s->>'delegate_after_days', '')::integer,
    COALESCE((s->>'is_required')::boolean, true)
  FROM jsonb_array_elements(p_steps) AS s;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_policy_steps(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_policy_steps(uuid, jsonb) TO authenticated;
