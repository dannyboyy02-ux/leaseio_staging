-- Move 1 (D1, 2026-07-18) — preview_policy_resolution tells the truth about
-- ties, empty chains, and the no-match → default-approver fallback.
--
-- CONTEXT: the engine (resolve-approval-chain) now (a) breaks a priority tie
-- deterministically (older rule wins) instead of 409'ing "ambiguous", and
-- (b) routes a no-rule-match request through the legacy workspace default
-- approvers (manager_approver → financial_approver) instead of 409'ing, keeping
-- the 409 ONLY when there are also no default approvers. This RPC (the "Try it
-- on a sample request" tester + the request-form route preview) must speak the
-- same truths, or the tester would show a confident single match for a tie the
-- engine now attributes, and a scary red "blocked" for a request the engine now
-- routes to defaults.
--
-- This migration is a SUPERSET of 20260718130000 (signator inheritance): a
-- CREATE OR REPLACE fully redefines the function, so the last-applied definition
-- must also carry the Move 2 inheritance — hence the signator block is repeated
-- here verbatim. Applying 130000 then 150000 leaves the function with BOTH.
--
-- Additive, structured signal only (codes/booleans the UI localizes); the
-- `error` strings are back-compat text for a not-yet-redeployed frontend.
--   * ORDER BY gains `p.id ASC` (total order — mirrors the engine's
--     `a.id.localeCompare(b.id)` final tiebreak).
--   * 'tie'         — {tied_policies:[{id,name}], winner_reason:'created_at'}
--                     when >1 active policy co-matches at the winning priority.
--   * 'empty_chain' — true when the resolved chain is empty (a matched rule with
--                     no steps; the engine 409s no_match_no_fallback on submit).
--   * 'fallback'    — 'legacy_default' (+ 'legacy' {has_manager_approver,
--                     has_financial_approver}) when no rule + no fallback policy
--                     matched but workspace_roles default approvers exist; else
--                     'none' (the truly-blocked case).
--
-- ENGINE-LOCKSTEP CONTRACT (do not drift): the match predicate below is
-- byte-identical to 20260712140000 and to resolve-approval-chain's matchPolicy()
-- (canonical asset fold on both sides + empty-asset guard; exact department /
-- region / lease_type equality; inclusive min/max annual cost). The precedence
-- ladder is: matching rule > explicit is_default_fallback policy > legacy
-- workspace_roles default approvers > blocked (matched:false, fallback:'none').
-- The total order is priority DESC, created_at ASC, id ASC on BOTH sides.
--
-- The new workspace_roles probe runs inside the already-membership-gated
-- SECURITY DEFINER body; the caller could already read workspace_roles under
-- RLS, so this adds no data exposure. Idempotent by CREATE OR REPLACE; existing
-- grants (authenticated + service_role; anon revoked in the archive) are
-- PRESERVED by REPLACE — this migration deliberately does not re-issue
-- GRANT/REVOKE.
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
  v_matched_by_rule boolean := false;
  v_win_priority integer;
  v_tied jsonb;
  v_mgr boolean := false;
  v_fin boolean := false;
  v_result jsonb;
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

  -- Find matching policies. asset_type is matched through canonical_asset_type on
  -- BOTH sides so property/real_estate/"Real Estate" are treated as one class.
  -- Total order priority DESC, created_at ASC, id ASC — the id key mirrors the
  -- engine's final tiebreak so two same-created_at policies order identically.
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
  ORDER BY p.priority DESC, p.created_at ASC, p.id ASC
  LIMIT 1;

  v_matched_by_rule := v_policy.id IS NOT NULL;

  -- Move 1: deterministic tie truthfulness. When the winner shares its priority
  -- with other co-matching active policies, list them (excluding the winner) so
  -- the tester can say "tied with X — the older rule wins". Same match predicate
  -- as above; jsonb_agg is NULL when no peer ties, so v_tied stays absent then.
  IF v_matched_by_rule THEN
    v_win_priority := v_policy.priority;
    SELECT jsonb_agg(
      jsonb_build_object('id', p.id, 'name', p.name)
      ORDER BY p.created_at ASC, p.id ASC
    )
    INTO v_tied
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.priority = v_win_priority
      AND p.id <> v_policy.id
      AND (
        cardinality(p.match_asset_types) = 0
        OR (
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
      AND (cardinality(p.match_lease_types) = 0 OR p_lease_type = ANY(p.match_lease_types));
  END IF;

  -- Fall back to an explicit default-fallback policy if no rule matched.
  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.is_default_fallback = true
    LIMIT 1;

    -- Move 1: no rule AND no explicit fallback policy. Probe the legacy
    -- workspace_roles default approvers — the engine routes there instead of
    -- 409'ing. Report 'legacy_default' (a successful route) when either default
    -- approver exists; only 'none' is the truly-blocked case.
    IF v_policy.id IS NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.workspace_roles
        WHERE workspace_id = p_workspace_id AND role = 'manager_approver'
      ) INTO v_mgr;
      SELECT EXISTS (
        SELECT 1 FROM public.workspace_roles
        WHERE workspace_id = p_workspace_id AND role = 'financial_approver'
      ) INTO v_fin;

      IF v_mgr OR v_fin THEN
        RETURN jsonb_build_object(
          'matched', false,
          'fallback', 'legacy_default',
          'legacy', jsonb_build_object(
            'has_manager_approver', v_mgr,
            'has_financial_approver', v_fin
          ),
          'error', 'No rule matches; the request will route to the workspace default approvers.'
        );
      ELSE
        RETURN jsonb_build_object(
          'matched', false,
          'fallback', 'none',
          'error', 'No matching policy and no default fallback configured.'
        );
      END IF;
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

  -- Move 2 (D2): a matched policy with NO signator steps inherits its concept
  -- steps into the signature stage — mirror the engine's chain-creation-time
  -- materialization so the preview equals the live chain. Guarded on the concept
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

  v_result := jsonb_build_object(
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

  -- Move 1: attach the deterministic-tie signal (winner already chosen above).
  IF v_tied IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'tie', jsonb_build_object('tied_policies', v_tied, 'winner_reason', 'created_at')
    );
  END IF;

  -- Move 1: flag an empty resolved chain (a UI-authored rule can't be empty, but
  -- an API-authored one can; the engine 409s no_match_no_fallback on submit).
  IF COALESCE(v_chain, '[]'::jsonb) = '[]'::jsonb THEN
    v_result := v_result || jsonb_build_object('empty_chain', true);
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.preview_policy_resolution(uuid, text, text, numeric, text, text) IS
  'Approval-rule preview (tester + request-form route preview). Matcher kept byte-in-lockstep with resolve-approval-chain matchPolicy() (canonical asset fold + empty-asset guard; exact department/region/lease_type; inclusive cost bounds). Total order: priority DESC, created_at ASC, id ASC. Precedence ladder: matching rule > explicit is_default_fallback policy > legacy workspace_roles default approvers > blocked. Move 1 (2026-07-18): returns structured tie / empty_chain / fallback(legacy_default|none) + legacy{has_manager_approver,has_financial_approver}; the `error` strings are back-compat only. Move 2: a matched policy with no signator steps returns an inherited signature stage + signator_inherited=true.';
