-- ============================================================================
-- Phase 1 — set_approval_policy_order(): the ONLY write path for rule order.
--
-- The Approval Rules redesign removes the "priority" integer from the product
-- entirely. Admins express order as intent ("move this up", "check this
-- first"), and the client sends THE FULL INTENDED ORDER as an array of ids.
-- This function turns that intent into the `priority` integers the engine
-- reads. No other code path may write approval_policies.priority from the UI.
--
-- ---------------------------------------------------------------------------
-- HARD DEPENDENCY — APPLY ORDER (do not violate)
-- ---------------------------------------------------------------------------
-- This migration MUST apply AFTER
--   20260719120000_approval_policies_version_ignores_priority.sql
-- which removes `OLD.priority IS DISTINCT FROM NEW.priority` from the
-- `approval_policies_version_increment` WHEN clause.
--
-- WHY THIS IS LOAD-BEARING: `lease_approval_chain` snapshots policy_id +
-- policy_version, and resolve-approval-chain compares
-- `snapshot.policy_version === newPolicy.version` to decide whether an
-- in-flight lease's chain needs reconciling. If the trigger still watched
-- `priority`, EVERY reorder would bump `version` on the rules it touches, and
-- every in-flight lease pinned to one of them would fail that short-circuit —
-- dropping its next benign attribute edit into the full reconcile path and
-- writing a fabricated `lease_reroute_events` row with zero real step changes,
-- on the exact governance table the repository-integrity lane defends.
-- In short: without 20260719120000 applied first, a reorder can REROUTE
-- APPROVALS THAT ARE ALREADY IN FLIGHT. Do not apply this file alone.
--
-- Defence in depth, in case that trigger change is ever reverted: the UPDATE
-- below carries `AND p.priority IS DISTINCT FROM d.new_priority`, so a single
-- swap writes exactly two rows rather than all N. The blast radius of a
-- regression is bounded to the rows the admin actually moved.
--
-- This function writes exactly ONE column (`priority`) on exactly ONE table
-- (`approval_policies`). It never touches approval_chain_steps,
-- lease_approval_chain, approval-chain step rows, or leases.lifecycle_status.
--
-- ---------------------------------------------------------------------------
-- THE ALL-100 LEGACY STATE (why the first save cannot silently reroute)
-- ---------------------------------------------------------------------------
-- Every real rule in production today sits at priority = 100. There is
-- deliberately NO backfill migration: the list screen reads with the engine's
-- exact total order — `priority DESC, created_at ASC, id ASC` — which is
-- byte-identical to resolve-approval-chain's matchPolicy() comparator
-- (priority desc → created_at asc → a.id.localeCompare(b.id)) and to
-- preview_policy_resolution's ORDER BY. So the order the admin SEES on first
-- paint already IS the order the engine evaluates, with zero writes on load.
--
-- The assignment below is strictly descending — priority(i) = (N - i) * 100
-- for a 0-based index i — so re-sorting the result by that same total order
-- reproduces the submitted sequence exactly. Consequence: a first call that
-- submits the displayed (i.e. engine) order renormalizes 100/100/100/100 to
-- 400/300/200/100 and changes NOTHING about which rule wins for any request.
-- Normalization is lazy, per workspace, and only ever on explicit user intent.
-- Gaps of 100 are by design: an API-authored row can land between two rules
-- without forcing a renumber.
--
-- ---------------------------------------------------------------------------
-- CONCURRENCY — optimistic set equality
-- ---------------------------------------------------------------------------
-- p_ordered_ids must be EXACTLY the set of that workspace's approval_policies
-- ids: no duplicates, no omissions, no extras, no ids from another workspace.
-- If another admin added, deleted, or reordered rules since the client loaded
-- the list, the assertion fails and the call raises `stale_policy_order`; the
-- UI refetches and asks the user to redo the move. A move never silently lands
-- a rule somewhere the user did not choose, and a stale client can never
-- resurrect a deleted rule's position or drop a new rule to the bottom.
--
-- ---------------------------------------------------------------------------
-- SECURITY-SENSITIVE (SECURITY DEFINER RPC on an approval-routing table):
-- route lease-security-scanner + lease-repository-integrity-reviewer BEFORE
-- applying via apply_migration, per the CLAUDE.md security-migration rule.
--
-- Idempotent: CREATE OR REPLACE + unconditional REVOKE/GRANT. Safe to replay.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_approval_policy_order(
  p_workspace_id uuid,
  p_ordered_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_count      integer;   -- length of p_ordered_ids
  v_distinct   integer;   -- distinct, non-NULL elements of p_ordered_ids
  v_existing   integer;   -- rules currently in the workspace
  v_before     jsonb;
  v_before_ids uuid[];
  v_after      jsonb;
  v_changed    jsonb;
  v_moves      jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_ordered_ids IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments';
  END IF;

  -- ── 1. AUTHORIZATION ────────────────────────────────────────────────────
  -- Owner-or-admin, checked explicitly inside the body because SECURITY
  -- DEFINER bypasses RLS. has_workspace_permission(ws, uid, 'admin') is
  -- semantically identical to the live "workspace admins write policies
  -- update" RLS predicate (workspace owner UNION workspace_members with
  -- role = 'admin'), so this grants no access RLS would not already grant.
  -- Deliberately NOT firm-aware, matching that policy exactly.
  IF v_actor IS NULL
     OR NOT public.has_workspace_permission(p_workspace_id, v_actor, 'admin'::public.workspace_role)
  THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- ── 2. LIVENESS ─────────────────────────────────────────────────────────
  -- approval_policies carries the Vault V1 RESTRICTIVE "live workspace
  -- required for update" policy. SECURITY DEFINER bypasses RLS, so that gate
  -- must be re-asserted here or this RPC becomes a hole around the read-only
  -- tier (grace window / soft-deleted / Vault).
  IF NOT public.is_workspace_live(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_not_live';
  END IF;

  -- ── 3. LOCK the workspace's rule set ────────────────────────────────────
  -- Serializes concurrent reorders of the same workspace. Locking in id order
  -- gives every caller the same acquisition order, so two simultaneous
  -- reorders queue instead of deadlocking. (A rule INSERTed by another admin
  -- after this snapshot is a phantom we cannot lock; it is caught by the
  -- set-equality assertion below on the next call, and until then it keeps
  -- its own priority — new rules insert at max(priority) + 100.)
  PERFORM 1
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
  ORDER BY p.id
  FOR UPDATE;

  -- ── 4. SET-EQUALITY ASSERTION (the concurrency guard) ───────────────────
  SELECT count(*)::integer, count(DISTINCT e)::integer
    INTO v_count, v_distinct
  FROM unnest(p_ordered_ids) AS e;

  SELECT count(*)::integer INTO v_existing
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id;

  -- Empty in, empty here: nothing to order. Not an error, not a write.
  IF v_count = 0 AND v_existing = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'workspace_id', p_workspace_id,
      'count', 0,
      'changed', '[]'::jsonb,
      'moves', '[]'::jsonb,
      'order', '[]'::jsonb
    );
  END IF;

  -- NULL element, duplicate, wrong length, or an id that is not a rule of
  -- THIS workspace (which also blocks cross-workspace id injection). All four
  -- collapse to one client-visible condition; DETAIL distinguishes them for
  -- the logs. count(*) = count(DISTINCT e) = v_existing plus "every element
  -- belongs to this workspace" implies exact set equality by pigeonhole.
  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'stale_policy_order'
      USING DETAIL = 'p_ordered_ids contains a duplicate or NULL id';
  END IF;

  IF v_count <> v_existing THEN
    RAISE EXCEPTION 'stale_policy_order'
      USING DETAIL = format('expected %s rule ids, received %s', v_existing, v_count);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_ordered_ids) AS e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = e AND p.workspace_id = p_workspace_id
    )
  ) THEN
    RAISE EXCEPTION 'stale_policy_order'
      USING DETAIL = 'p_ordered_ids contains an id that is not a rule of this workspace';
  END IF;

  -- ── 5. BEFORE snapshot, in the engine's total order ─────────────────────
  SELECT jsonb_agg(
           jsonb_build_object('position', x.ord, 'id', x.id, 'name', x.name, 'priority', x.priority)
           ORDER BY x.ord
         ),
         array_agg(x.id ORDER BY x.ord)
    INTO v_before, v_before_ids
  FROM (
    SELECT p.id, p.name, p.priority,
           row_number() OVER (ORDER BY p.priority DESC, p.created_at ASC, p.id ASC) AS ord
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
  ) x;

  -- ── 6. ASSIGN priority = (N - i) * 100, 0-based from the top ────────────
  -- Strictly descending, so `ORDER BY priority DESC, created_at ASC, id ASC`
  -- (the engine's read order) reproduces p_ordered_ids exactly. Four rules →
  -- 400 / 300 / 200 / 100.
  --
  -- `priority IS DISTINCT FROM d.new_priority` is the write guard: a single
  -- swap touches exactly two rows, not N. It bounds both the write cost and
  -- the audit/version blast radius (see the APPLY ORDER note at the top).
  WITH desired AS (
    SELECT o.policy_id,
           ((v_count - (o.ord - 1)) * 100)::integer AS new_priority
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS o(policy_id, ord)
  ),
  updated AS (
    UPDATE public.approval_policies p
       SET priority = d.new_priority
      FROM desired d
     WHERE p.id = d.policy_id
       AND p.workspace_id = p_workspace_id
       AND p.priority IS DISTINCT FROM d.new_priority
    RETURNING p.id, p.name, p.priority
  )
  SELECT jsonb_agg(
           jsonb_build_object('id', u.id, 'name', u.name, 'priority', u.priority)
           ORDER BY u.priority DESC
         )
    INTO v_changed
  FROM updated u;

  -- `updated_by` is deliberately NOT written: reordering is not an edit to the
  -- rule's own definition (who it matches, who approves), and stamping it
  -- would make an untouched rule read as edited. Attribution for the reorder
  -- lives in the workspace_activity_log row below. `updated_at` moves because
  -- of the pre-existing set_updated_at trigger; `version` does not move,
  -- by design (20260719120000).

  v_changed := COALESCE(v_changed, '[]'::jsonb);

  -- ── 7. AFTER snapshot + per-rule from/to positions ──────────────────────
  SELECT jsonb_agg(
           jsonb_build_object('position', o.ord, 'id', o.policy_id, 'name', p.name, 'priority', p.priority)
           ORDER BY o.ord
         )
    INTO v_after
  FROM unnest(p_ordered_ids) WITH ORDINALITY AS o(policy_id, ord)
  JOIN public.approval_policies p ON p.id = o.policy_id;

  SELECT jsonb_agg(
           jsonb_build_object(
             'id', o.policy_id,
             'name', p.name,
             'from_position', array_position(v_before_ids, o.policy_id),
             'to_position', o.ord
           )
           ORDER BY o.ord
         )
    INTO v_moves
  FROM unnest(p_ordered_ids) WITH ORDINALITY AS o(policy_id, ord)
  JOIN public.approval_policies p ON p.id = o.policy_id
  WHERE array_position(v_before_ids, o.policy_id) IS DISTINCT FROM o.ord;

  v_moves := COALESCE(v_moves, '[]'::jsonb);

  -- ── 8. AUDIT — reordering IS a routing change ───────────────────────────
  -- One row per call that actually wrote something, in the SAME transaction,
  -- so the trail asserts the reorder if and only if the database committed it.
  -- A no-op call (submitted order already in effect) writes nothing at all —
  -- neither policy rows nor audit noise.
  IF jsonb_array_length(v_changed) > 0 THEN
    INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
    VALUES (
      p_workspace_id,
      v_actor,
      'approval_rules_reordered',
      jsonb_build_object(
        'source', 'set_approval_policy_order',
        'rule_count', v_count,
        'moves', v_moves,
        'changed', v_changed,
        'before', COALESCE(v_before, '[]'::jsonb),
        'after', COALESCE(v_after, '[]'::jsonb)
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workspace_id', p_workspace_id,
    'count', v_count,
    'changed', v_changed,
    'moves', v_moves,
    'order', COALESCE(v_after, '[]'::jsonb)
  );
END;
$$;

-- Pin the definer identity regardless of which role applies the migration
-- (CLI vs Studio/MCP differ) — parity with is_workspace_member et al.
ALTER FUNCTION public.set_approval_policy_order(uuid, uuid[]) OWNER TO postgres;

-- The browser calls this directly via supabase.rpc(). service_role is NOT
-- granted: the function derives its actor from auth.uid(), which is NULL under
-- service_role, so such a call could only ever raise 'Forbidden'.
REVOKE ALL ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.set_approval_policy_order(uuid, uuid[]) IS
  'The ONLY write path for approval_policies.priority from the app. Takes the full intended order as an id array and assigns priority = (N - i) * 100, 0-based from the top — strictly descending, gapped by 100, so the engine read order (priority DESC, created_at ASC, id ASC) reproduces the submitted sequence. Owner-or-admin only (has_workspace_permission ''admin'', matching the approval_policies UPDATE RLS predicate) and live-workspace only (re-asserts the Vault V1 restrictive gate that SECURITY DEFINER bypasses). Asserts p_ordered_ids is exactly the workspace''s rule-id set — duplicates, omissions, extras, and foreign ids all raise ''stale_policy_order'' so the UI can reload rather than reorder a stale list. Writes only rows whose priority actually changes (IS DISTINCT FROM), audits one workspace_activity_log row (event_type ''approval_rules_reordered'') per changing call, and touches no chain, step, or lease row. REQUIRES 20260719120000 (priority removed from the version-bump trigger) to have been applied first — otherwise a reorder bumps policy_version and can reroute in-flight approvals.';
