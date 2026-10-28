-- ============================================================================
-- Phase 0 / migration 2 of 2 — retire `is_default_fallback` as a ROUTING
-- mechanism (owner decision D-Q1, ratified).
--
-- APPLY ORDER: this file MUST apply AFTER
-- 20260719120000_approval_policies_version_ignores_priority.sql.
--
-- WHY THAT ORDER (stated explicitly, per the Phase-0 brief): step (b) below
-- writes `approval_policies.priority`. Until 20260719120000 lands, `priority`
-- sits in the `approval_policies_version_increment` WHEN clause
-- (baseline_schema.sql:3043), so that write would bump `version` on every
-- converted rule. Any lease already in flight against one of those rules would
-- then fail resolve-approval-chain's `snapshot.policy_version === newPolicy.version`
-- short-circuit and drop into the full reconcile path on its next benign edit —
-- fabricating a `lease_reroute_events` row for a change that altered no step.
-- Sequencing removes that FABRICATION. It does not, and cannot, make routing
-- immutable for in-flight work — see the in-flight note under (a)(b)(c) below.
--
-- The alternative — ALTER TABLE ... DISABLE TRIGGER inside this transaction —
-- was REJECTED. It requires table-owner privilege, it takes an ACCESS EXCLUSIVE
-- lock on a live routing table, and a failure between disable and re-enable
-- leaves the version trigger silently off. Sequencing two ordinary migrations is
-- strictly safer and leaves the correct end state even if this one is replayed.
--
-- WHAT THIS MIGRATION DOES
--   (a) For every workspace that has an `is_default_fallback = true` rule:
--       pin that rule LAST in the workspace's evaluation order. "Last" is
--       defined by the engine's exact total order — priority DESC, created_at
--       ASC, id ASC — so "last" means "strictly the lowest priority in the
--       workspace". Its matching behaviour as a NORMAL rule is preserved and,
--       for the first time, visible.
--   (b) Clear the flag (`is_default_fallback = false`).
--   (c) Write one `workspace_activity_log` row per affected workspace recording
--       the conversion (actor NULL = system/migration write).
--   It touches NO `lease_approval_chain` row and NO `approval_chain_steps` row.
--   A lease previously routed via the fallback branch keeps its snapshot and its
--   existing steps: this migration itself reroutes nothing.
--
--   HONEST LIMIT (D-Q5): "reroutes nothing" is a statement about this migration,
--   NOT a promise that an in-flight lease is pinned forever. If that lease's own
--   attributes later change materially, resolve-approval-chain re-evaluates it
--   against the CURRENT rule set — which, after this migration, no longer has a
--   fallback rung — so a different rule (or the legacy default approvers) can win
--   and the chain is rebuilt. That is the intended reroute design, not a defect.
--   It is disclosed rather than frozen: the engine writes a
--   `chain_routing_rule_changed` lease_activity_log row naming the prior rule,
--   the new rule, and why. Do not cite this migration as an in-flight-routing
--   immutability guarantee; there is none, by design.
--   `is_active` is deliberately NOT flipped: a fallback rule that the admin had
--   switched OFF stays off. That was the whole bug — the engine ignored
--   `is_active` on this branch and routed through a switched-off rule anyway.
--
--   (d) Remove `is_default_fallback` from the precedence ladder of
--       public.preview_policy_resolution, so the tester and the request-form
--       route preview agree with the post-Phase-0 engine.
--
-- THE COLUMN IS NOW INERT. `approval_policies.is_default_fallback` and its
-- partial unique index `idx_approval_policies_one_default_per_workspace` are
-- deliberately LEFT IN PLACE: this migration removes the column's ability to
-- ROUTE anything, it does not destroy authored data. After the companion
-- resolve-approval-chain redeploy, nothing in the product reads it for routing.
-- Dropping the column and the index is a separate, later cleanup.
--
-- THE MATCHING ENGINE ALSO CHANGES: supabase/functions/resolve-approval-chain
-- drops `matched[0] ?? allPolicies.find(p => p.is_default_fallback === true)`
-- (index.ts:386 — note it never checked `is_active`, which is how a switched-off
-- starred rule could still route every unmatched request). That function MUST be
-- redeployed after these migrations apply and BEFORE any frontend that assumes
-- the fallback branch is gone.
--
-- Idempotent: the data loop is a no-op on replay (no rows left with the flag
-- set); the RPC is CREATE OR REPLACE.
--
-- SECURITY-SENSITIVE (SECURITY DEFINER RPC + a write to an approval-routing
-- governance table): route lease-security-scanner +
-- lease-repository-integrity-reviewer BEFORE applying via apply_migration, per
-- the CLAUDE.md security-migration rule.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (a)(b)(c) Data migration: convert each flagged rule into an ordinary rule
--           pinned last, then clear the flag.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r            record;
  v_min_other  integer;
  v_new        integer;
  v_lift       integer;
BEGIN
  FOR r IN
    SELECT id, workspace_id, name, priority, is_active
    FROM public.approval_policies
    WHERE is_default_fallback = true
    ORDER BY workspace_id, created_at, id
  LOOP
    -- Lowest priority among the OTHER rules in this workspace (NULL when the
    -- flagged rule is the only one).
    SELECT MIN(p.priority)
      INTO v_min_other
      FROM public.approval_policies p
     WHERE p.workspace_id = r.workspace_id
       AND p.id <> r.id;

    IF v_min_other IS NULL THEN
      -- Sole rule in the workspace: it is trivially last. Keep its priority,
      -- but never leave a non-positive value behind (approvalPolicyValidation
      -- requires a positive integer, so a 0 or negative would make the rule
      -- unsavable in the editor).
      v_new := GREATEST(r.priority, 1);

    ELSIF v_min_other > 1 THEN
      -- Normal case. min(other) - 100 keeps the ×100 gap convention; the
      -- GREATEST floor keeps the value positive when the workspace already sits
      -- at the legacy all-100 default (100 - 100 = 0 → 1). Either way the
      -- converted rule ends up STRICTLY below every other rule, so the engine's
      -- `priority DESC` puts it last with no tie to break.
      v_new := GREATEST(1, v_min_other - 100);

    ELSE
      -- v_min_other <= 1: there is no positive room beneath the existing rules.
      -- Lift every OTHER rule by a uniform offset (preserving their relative
      -- order exactly) so the converted rule can sit at 1, strictly last.
      -- Defensive: the UI has always written positive priorities >= 1, so this
      -- branch is not expected to fire on real data.
      v_lift := 2 - v_min_other;
      UPDATE public.approval_policies p
         SET priority = p.priority + v_lift
       WHERE p.workspace_id = r.workspace_id
         AND p.id <> r.id
         AND p.priority IS DISTINCT FROM (p.priority + v_lift);
      v_new := 1;
    END IF;

    -- Single UPDATE: pin last + clear the flag together. `IS DISTINCT FROM`
    -- guards keep the write to what actually changed. Post-20260719120000 the
    -- priority write does NOT bump `version`; `is_default_fallback` was never in
    -- the version trigger's WHEN clause.
    UPDATE public.approval_policies
       SET priority = v_new,
           is_default_fallback = false
     WHERE id = r.id;

    INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
    VALUES (
      r.workspace_id,
      NULL,
      'approval_policy_fallback_retired',
      jsonb_build_object(
        'policy_id',        r.id,
        'policy_name',      r.name,
        'was_active',       r.is_active,
        'prior_priority',   r.priority,
        'new_priority',     v_new,
        'migration',        '20260719120100_retire_is_default_fallback_routing',
        'reason',           'is_default_fallback retired as a routing mechanism (D-Q1); rule converted to an ordinary rule checked last'
      )
    );
  END LOOP;
END $$;

COMMENT ON COLUMN public.approval_policies.is_default_fallback IS
  'INERT as of 20260719120100 (D-Q1). Historically this flag made a rule the silent catch-all in resolve-approval-chain and preview_policy_resolution — and the engine branch never checked is_active, so a switched-off rule could still route every unmatched request. Both the engine branch and the RPC ladder entry are removed; every previously-flagged rule was converted to an ordinary rule pinned last and the flag cleared. The column and its partial unique index are retained only so authored data is not destroyed; nothing reads them for routing. Dropping them is a separate later cleanup.';

-- ----------------------------------------------------------------------------
-- (d) preview_policy_resolution — precedence ladder loses is_default_fallback.
--
-- COMPLETE SUPERSET of 20260718150000 (which was itself a superset of
-- 20260718130000). A CREATE OR REPLACE fully redefines the function, so every
-- feature of the last-applied definition is reproduced here:
--   * Move 1: membership gate; canonical-asset matcher in byte-lockstep with
--     resolve-approval-chain's matchPolicy(); total order priority DESC,
--     created_at ASC, id ASC; structured `tie` {tied_policies, winner_reason};
--     `empty_chain`; `fallback` ('legacy_default' | 'none') + `legacy`
--     {has_manager_approver, has_financial_approver}; back-compat `error` text.
--   * Move 2: a matched policy with NO signator steps inherits its concept steps
--     into the signature stage (+ `signator_inherited: true`).
-- The ONLY behavioural delta is the removal of the is_default_fallback lookup
-- between "no rule matched" and the workspace_roles probe — the RPC now goes
-- straight from no-match to the legacy default approvers, exactly like the
-- post-Phase-0 engine. The now-unreachable warning string
-- 'No specific match; using default fallback policy.' is removed with it;
-- v_warnings is retained (still returned as `warnings`) so the response shape
-- is unchanged.
--
-- Grants (authenticated + service_role; anon revoked in the archive) are
-- PRESERVED by REPLACE — this migration deliberately does not re-issue
-- GRANT/REVOKE.
-- ----------------------------------------------------------------------------

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

  -- D-Q1 (Phase 0): the is_default_fallback lookup that used to sit HERE is
  -- GONE. It was a second, invisible catch-all: it never filtered is_active, so
  -- a switched-off starred rule could catch every unmatched request. No rule
  -- match now goes straight to the legacy workspace_roles default approvers —
  -- byte-for-byte the post-Phase-0 engine's ladder:
  --     matching rule > legacy workspace_roles default approvers > blocked.
  IF v_policy.id IS NULL THEN
    -- Move 1: no rule matched. Probe the legacy workspace_roles default
    -- approvers — the engine routes there instead of 409'ing. Report
    -- 'legacy_default' (a successful route) when either default approver exists;
    -- only 'none' is the truly-blocked case.
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
  'Approval-rule preview (tester + request-form route preview). Matcher kept byte-in-lockstep with resolve-approval-chain matchPolicy() (canonical asset fold + empty-asset guard; exact department/region/lease_type; inclusive cost bounds). Total order: priority DESC, created_at ASC, id ASC. Precedence ladder as of 20260719120100 (D-Q1): matching rule > legacy workspace_roles default approvers > blocked — the is_default_fallback rung is RETIRED (it never filtered is_active, so a switched-off rule could silently catch every unmatched request; the engine branch is removed in the same phase). Move 1 (2026-07-18): returns structured tie / empty_chain / fallback(legacy_default|none) + legacy{has_manager_approver,has_financial_approver}; the `error` strings are back-compat only. Move 2: a matched policy with no signator steps returns an inherited signature stage + signator_inherited=true.';
