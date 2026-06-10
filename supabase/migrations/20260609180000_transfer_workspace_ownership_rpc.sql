-- Phase 3 hardening: atomic ownership transfer (2026-06-09 reviewer pass).
--
-- The transfer-workspace-ownership edge function originally performed three
-- sequential service-role writes (promote target, demote prior owner, swap
-- workspaces.owner_id) plus a trailing audit insert. Reviewer findings:
--   - CRITICAL: a lost-update race (two concurrent transfers) let the loser
--     return ok:true AND write an owner_transferred audit row for a swap
--     that matched zero rows — the audit trail asserting something the
--     database did not do.
--   - HIGH: the target-promote was zero-row-blind (transfer racing a
--     member-removal of the target).
--   - HIGH: no transaction across the writes — a partial failure left an
--     unlogged admin promotion.
-- This RPC performs validation + every mutation + the audit row in ONE
-- transaction under FOR UPDATE of the workspace row. Any RAISE rolls the
-- whole transfer back, so the audit row exists if and only if the transfer
-- committed.
--
-- Service-role only: the workspaces UPDATE RLS policy intentionally blocks
-- authenticated owner_id reassignment. Callers must come through the
-- transfer-workspace-ownership edge function, which verifies the JWT and
-- passes the caller id explicitly as p_caller_id.

CREATE OR REPLACE FUNCTION public.transfer_workspace_ownership_locked(
  p_workspace_id uuid,
  p_caller_id uuid,
  p_target_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws RECORD;
  v_target RECORD;
BEGIN
  -- Lock the workspace row: serializes concurrent transfers (and any other
  -- owner_id change) for the duration of the transaction.
  SELECT id, owner_id, stripe_customer_id INTO v_ws
  FROM public.workspaces
  WHERE id = p_workspace_id
  FOR UPDATE;

  -- Same answer for "missing" and "not yours" — no workspace-existence
  -- oracle for non-owners.
  IF NOT FOUND OR v_ws.owner_id IS DISTINCT FROM p_caller_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF p_target_user_id = v_ws.owner_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_owner');
  END IF;

  -- Accepted member only (spec §4.2(2)); user_id equality implies NOT NULL.
  -- FOR UPDATE: a concurrent removal of this member row blocks until we
  -- commit, closing the validate-then-promote window.
  SELECT id, role INTO v_target
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id
    AND user_id = p_target_user_id
    AND accepted_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_accepted_member');
  END IF;

  -- 1. Promote target to admin. Row is locked above so zero rows is
  -- impossible; assert anyway — RAISE rolls back the whole transfer.
  UPDATE public.workspace_members SET role = 'admin' WHERE id = v_target.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_conflict: target member row vanished';
  END IF;

  -- 2. Mandatorily demote prior owner to admin — upsert when they have no
  -- member row (workspaces created via the create-workspace edge function
  -- do not give the owner one). Never strand the prior owner.
  UPDATE public.workspace_members SET role = 'admin'
  WHERE workspace_id = p_workspace_id AND user_id = v_ws.owner_id;
  IF NOT FOUND THEN
    INSERT INTO public.workspace_members (workspace_id, user_id, role, invited_at, accepted_at)
    VALUES (p_workspace_id, v_ws.owner_id, 'admin', now(), now());
  END IF;

  -- 3. Swap owner. Guarded on the prior owner AND serialized by the row
  -- lock; zero rows is impossible, assert anyway.
  UPDATE public.workspaces SET owner_id = p_target_user_id
  WHERE id = p_workspace_id AND owner_id = v_ws.owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_conflict: owner changed concurrently';
  END IF;

  -- 4. Audit row in the SAME transaction — the trail asserts the transfer
  -- if and only if the database committed it. Shape per spec §4.2(4),
  -- plus target_prior_role so the target's before-state is recoverable
  -- from this one row.
  INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
  VALUES (
    p_workspace_id,
    p_caller_id,
    'owner_transferred',
    jsonb_build_object(
      'from', v_ws.owner_id,
      'to', p_target_user_id,
      'prior_owner_new_role', 'admin',
      'target_prior_role', v_target.role,
      'billing_remains_on_customer', v_ws.stripe_customer_id,
      'billing_transferred', false
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'new_owner_id', p_target_user_id,
    'billing_transferred', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_workspace_ownership_locked(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_workspace_ownership_locked(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.transfer_workspace_ownership_locked(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_workspace_ownership_locked(uuid, uuid, uuid) TO service_role;
