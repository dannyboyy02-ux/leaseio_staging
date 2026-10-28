-- Move 2 (D2, 2026-07-18) — preview_policy_resolution learns signator inheritance.
--
-- A rule may now skip the signature stage (stage 2). At submission the engine
-- (resolve-approval-chain) MATERIALIZES the signature stage for a one-stage
-- policy by cloning its concept steps into signator rows. The "Try it on a
-- sample request" tester calls this RPC, so the preview must show the SAME
-- inherited signature stage the engine will write — otherwise a one-stage rule
-- would preview "no signature step" while the live chain has one (and the
-- request form would drop its Signature badge). This migration closes exactly
-- that lie.
--
-- The body is byte-for-byte identical to migration 20260712140000
-- (canonical_asset_type_matching) — same SECURITY DEFINER, same
-- SET search_path TO 'public', same membership auth gate, same asset-type
-- canonical fold and the same match predicate on BOTH sides — EXCEPT two
-- additions after v_chain is built:
--   (1) if the matched policy has NO signator steps, append a jsonb_agg over its
--       CONCEPT steps re-tagged 'stage' => 'signator' with an extra
--       'inherited' => true key (ORDER BY step_order, parallel_group), and set
--       v_signator_inherited := true. Guarded on the concept agg being non-null
--       so a (malformed) zero-step policy is unchanged.
--   (2) 'signator_inherited' is added to the returned jsonb_build_object.
--
-- Idempotent by CREATE OR REPLACE. Existing grants (authenticated + service_role
-- from the baseline, and the archived anon REVOKE) are PRESERVED by REPLACE — a
-- CREATE OR REPLACE does not reset privileges — so this migration deliberately
-- does not re-issue GRANT/REVOKE.
--
-- SECURITY-SENSITIVE (SECURITY DEFINER RPC): route lease-security-scanner +
-- lease-repository-integrity-reviewer BEFORE applying via MCP apply_migration,
-- per the CLAUDE.md security-migration rule.

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
  v_inherited_signator jsonb;
  v_signator_inherited boolean := false;
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

  -- Move 2 (D2): if the matched policy has NO signator steps, the signature
  -- stage inherits the concept steps — mirror the engine's chain-creation-time
  -- materialization so the preview equals the live chain. Re-tag each concept
  -- step 'signator' with an 'inherited' => true marker. Guarded on the concept
  -- agg being non-null so a malformed zero-step policy is left unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_chain_steps s
    WHERE s.policy_id = v_policy.id AND s.stage = 'signator'
  ) THEN
    SELECT jsonb_agg(
      jsonb_build_object(
        'stage', 'signator',
        'step_order', s.step_order,
        'parallel_group', s.parallel_group,
        'approver_user_id', s.approver_user_id,
        'approver_role', s.approver_role,
        'delegate_user_id', s.delegate_user_id,
        'is_required', s.is_required,
        'inherited', true
      )
      ORDER BY s.step_order, s.parallel_group
    ) INTO v_inherited_signator
    FROM public.approval_chain_steps s
    WHERE s.policy_id = v_policy.id AND s.stage = 'concept';

    IF v_inherited_signator IS NOT NULL THEN
      v_chain := COALESCE(v_chain, '[]'::jsonb) || v_inherited_signator;
      v_signator_inherited := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'matched', true,
    'policy_id', v_policy.id,
    'policy_name', v_policy.name,
    'policy_priority', v_policy.priority,
    'policy_version', v_policy.version,
    'separation_override', v_policy.separation_of_duties_override,
    'chain', COALESCE(v_chain, '[]'::jsonb),
    'signator_inherited', v_signator_inherited,
    'warnings', to_jsonb(v_warnings)
  );
END;
$function$;

COMMENT ON FUNCTION public.preview_policy_resolution(uuid, text, text, numeric, text, text) IS
  'Approval-rule preview (tester). Matcher is kept byte-in-lockstep with resolve-approval-chain (canonical asset fold + exact department/region/lease_type + inclusive cost bounds). Move 2 (2026-07-18): a matched policy with no signator steps returns an INHERITED signature stage (concept steps re-tagged, inherited=true) + signator_inherited=true, mirroring the engine''s chain-creation materialization.';
