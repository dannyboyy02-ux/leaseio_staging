-- ============================================================================
-- Phase 10 / #105-B — create_firm_workspace_locked()
-- ============================================================================
-- Atomic creation of a firm-bound child workspace. Mirrors
-- create_workspace_locked() (20260609120000) but for firm children:
--   * eligibility is FIRM membership (the create-firm-workspace edge fn checks
--     firm_admin/owner), NOT ownership of a prior Business workspace
--   * the workspace is inserted WITH firm_id — the Phase 9 triggers then set
--     plan='business', firm_joined_at, and increment the firm child counter
--     (which RAISES if the firm's child_workspace_limit is reached)
--   * NO independent Stripe subscription — firm billing covers the child via the
--     firm subscription's quantity (the edge fn syncs quantity after this)
--
-- SECURITY DEFINER: called by the create-firm-workspace edge fn via the
-- service-role client, so auth.role()='service_role' flows in and the Phase 9
-- firm-binding guard permits the firm_id INSERT. Idempotent on idempotency_key.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_firm_workspace_locked(
  p_firm_id         uuid,
  p_owner_id        uuid,
  p_name            text,
  p_idempotency_key text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_workspace_id uuid;
  v_existing     public.workspace_creation_requests%ROWTYPE;
  v_clean_name   text := btrim(coalesce(p_name, ''));
BEGIN
  IF p_firm_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'firm_id and owner_id are required' USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_clean_name) < 1 OR length(v_clean_name) > 100 THEN
    RETURN jsonb_build_object('status', 'invalid_name');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialize per firm: two concurrent creates can't both slip past the child
  -- limit (the counter trigger is the hard backstop; this avoids the race).
  PERFORM pg_advisory_xact_lock(hashtext(p_firm_id::text));

  -- Idempotency: a repeated key returns the prior workspace, no new work.
  SELECT * INTO v_existing
    FROM public.workspace_creation_requests
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'workspace_id', v_existing.workspace_id);
  END IF;

  -- Insert the firm-bound workspace. Phase 9 triggers fire here: plan→'business',
  -- firm_joined_at set, child counter incremented (RAISES if over the limit).
  INSERT INTO public.workspaces (name, owner_id, firm_id)
    VALUES (v_clean_name, p_owner_id, p_firm_id)
    RETURNING id INTO v_workspace_id;

  -- Owner's admin membership (mirrors create_workspace_locked / Onboarding).
  INSERT INTO public.workspace_members (workspace_id, user_id, role, invited_at, accepted_at)
    VALUES (v_workspace_id, p_owner_id, 'admin', now(), now());

  INSERT INTO public.workspace_creation_requests (idempotency_key, owner_id, workspace_id, status)
    VALUES (p_idempotency_key, p_owner_id, v_workspace_id, 'confirmed');

  INSERT INTO public.workspace_activity_log (workspace_id, user_id, event_type, details)
    VALUES (v_workspace_id, p_owner_id, 'created',
            jsonb_build_object('idempotency_key', p_idempotency_key, 'name', v_clean_name, 'firm_id', p_firm_id));

  RETURN jsonb_build_object('status', 'created', 'workspace_id', v_workspace_id);
END;
$$;

ALTER FUNCTION public.create_firm_workspace_locked(uuid, uuid, text, text) OWNER TO postgres;

-- Callable by the service role only (the edge fn); revoke from anon/authenticated.
REVOKE ALL ON FUNCTION public.create_firm_workspace_locked(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_firm_workspace_locked(uuid, uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_firm_workspace_locked(uuid, uuid, text, text) TO service_role;
