-- KNOWN_ISSUES #111 C5 (audit Class 3): make the reroute reconciliation atomic.
-- resolve-approval-chain's reroute path marked old chain rows superseded and
-- inserted the new rows as TWO separate PostgREST writes (index.ts:651-704),
-- each only console.error-ing on failure and CONTINUING. So a failed INSERT
-- after a successful supersede left the lease with its old steps superseded and
-- NO new active steps — zero approvers — while the function still reported
-- success. (Worse than the audit framed: the errors were swallowed, not retried.)
--
-- This RPC performs both writes in a single function body — one implicit
-- transaction — so if the INSERT fails the supersede UPDATE rolls back and the
-- lease never lands in a zero-approver state. The edge fn checks the result and
-- ABORTS the reroute on error instead of swallowing it.
--
-- SECURITY DEFINER, callable by service_role only (the edge fn), mirroring
-- create_firm_workspace_locked (20260616130000). lease_approval_chain has no row
-- triggers, so no guard-disable dance is needed. The caller builds the new rows
-- (including the Phase-7 columns) and passes them as jsonb, so no chain-
-- resolution logic is duplicated in SQL.
--
-- Scope: this closes the supersede+insert zero-approver gap (the named C5 bug).
-- The subsequent lifecycle/reroute_event/snapshot writes remain separate (they
-- use the edge fn's updateLifecycle/logStatusChange helpers); their failure is a
-- less-severe, pre-existing concern, not the zero-approver state C5 names.

CREATE OR REPLACE FUNCTION public.reroute_reconcile_chain_steps(
  p_superseded_ids uuid[],
  p_new_rows       jsonb
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_superseded_ids IS NOT NULL AND array_length(p_superseded_ids, 1) > 0 THEN
    UPDATE public.lease_approval_chain
      SET status = 'superseded'
      WHERE id = ANY (p_superseded_ids);
  END IF;

  IF p_new_rows IS NOT NULL
     AND jsonb_typeof(p_new_rows) = 'array'
     AND jsonb_array_length(p_new_rows) > 0 THEN
    INSERT INTO public.lease_approval_chain (
      lease_id, workspace_id, policy_id, policy_version, stage, step_order,
      parallel_group, approver_user_id, approver_role, delegate_user_id,
      delegate_after_days, is_required, status,
      effective_assignee_user_id, assignee_resolution_source, pending_since
    )
    SELECT
      (r->>'lease_id')::uuid,
      (r->>'workspace_id')::uuid,
      NULLIF(r->>'policy_id', '')::uuid,
      NULLIF(r->>'policy_version', '')::int,
      r->>'stage',
      (r->>'step_order')::int,
      COALESCE(NULLIF(r->>'parallel_group', '')::int, 1),
      NULLIF(r->>'approver_user_id', '')::uuid,
      r->>'approver_role',
      NULLIF(r->>'delegate_user_id', '')::uuid,
      NULLIF(r->>'delegate_after_days', '')::int,
      COALESCE((r->>'is_required')::boolean, true),
      COALESCE(NULLIF(r->>'status', ''), 'pending'),
      NULLIF(r->>'effective_assignee_user_id', '')::uuid,
      NULLIF(r->>'assignee_resolution_source', ''),
      NULLIF(r->>'pending_since', '')::timestamptz
    FROM jsonb_array_elements(p_new_rows) AS r;
  END IF;
END;
$$;

ALTER FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reroute_reconcile_chain_steps(uuid[], jsonb) TO service_role;
