-- Canonical asset-type matching for approval rules (2026-07-12, workspace-settings walkthrough).
--
-- PROBLEM: leases.asset_type carries three vocabularies for the same asset class:
--   * Path-1 request form (LeaseRequestForm) writes 'property'
--   * AI classifier (process_lease) writes 'real_estate'
--   * LeaseReview's config-driven dropdown writes the label ("Real Estate")
-- The approval-rule matcher compares approval_policies.match_asset_types to the
-- lease's asset_type with an EXACT match (`p_asset_type = ANY(match_asset_types)`
-- here; `.includes()` in resolve-approval-chain). So a rule authored as
-- 'property' silently failed to route an AI-classified 'real_estate' lease, and
-- vice versa — a rule that "looked" configured never fired. Departments/regions/
-- lease_types are single-vocabulary (workspace-config or a fixed enum), so ONLY
-- asset_type needs reconciliation.
--
-- FIX: a canonical token function used on BOTH sides of the asset-type compare.
-- It folds the real-estate synonyms to one token; every other value (equipment/
-- vehicle/other + any workspace-custom label) canonicalizes to its own key, so
-- exact per-workspace matching is unchanged. Kept in lockstep with the TS
-- `canonicalAssetType` (src/lib/assetTypes.ts) + the Deno copy in
-- resolve-approval-chain.
--
-- Idempotent: CREATE OR REPLACE on both functions.

-- Normalized key: lowercase, strip non-alphanumerics; then fold the one
-- real-estate synonym ('property') onto the normalized real-estate key.
-- IMMUTABLE so it's usable in query predicates / index expressions.
CREATE OR REPLACE FUNCTION public.canonical_asset_type(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN regexp_replace(lower(coalesce(p_value, '')), '[^a-z0-9]+', '', 'g') = 'property'
      THEN 'realestate'
    ELSE regexp_replace(lower(coalesce(p_value, '')), '[^a-z0-9]+', '', 'g')
  END;
$function$;

COMMENT ON FUNCTION public.canonical_asset_type(text) IS
  'Canonical asset-type token for equality across intake vocabularies (property/real_estate/"Real Estate" → realestate). Mirrors TS canonicalAssetType. Do not drift.';

-- Repo convention: RPCs/helpers are not executable by anon. This is a pure text
-- transform with no data access (harmless if left public), but keep it
-- convention-clean per _archive/20260502160030_phase1_revoke_rpc_anon.sql.
REVOKE ALL ON FUNCTION public.canonical_asset_type(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canonical_asset_type(text) TO authenticated, service_role;

-- Rewrite the preview RPC (the "Try it on a sample request" tester) to match
-- asset_type through the canonical token. Byte-for-byte identical to the prior
-- definition EXCEPT the asset_type predicate — the auth gate, fallback,
-- chain-build, and return shape are unchanged.
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
SET search_path TO 'public'
AS $function$
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

  -- Find matching policies, sorted by priority descending. asset_type is matched
  -- through canonical_asset_type on BOTH sides so property/real_estate/"Real
  -- Estate" are treated as one class (2026-07-12).
  SELECT * INTO v_policy
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
    AND p.is_active = true
    AND (
      cardinality(p.match_asset_types) = 0
      OR (
        -- A lease with no asset type must not satisfy a rule that specifies
        -- asset types (faithful to the prior `= ANY` semantics, where a NULL
        -- lease value matched nothing). canonical_asset_type(NULL/'') = '' —
        -- guard it so a blank never matches a (malformed) blank rule entry.
        public.canonical_asset_type(p_asset_type) <> ''
        AND public.canonical_asset_type(p_asset_type) IN (
          SELECT public.canonical_asset_type(x) FROM unnest(p.match_asset_types) AS x
        )
      )
    )
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
$function$;
