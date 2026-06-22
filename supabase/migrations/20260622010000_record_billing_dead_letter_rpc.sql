-- ─────────────────────────────────────────────────────────────────────────
-- record_billing_dead_letter — the service-role webhook's single writer into
-- billing_dead_letters (#65). Atomic upsert-with-recurrence-bump: the first
-- capture (created_at / amount_cents / raw_metadata / purchased_by / ...) stays
-- FROZEN, and a retry of the same (source, stripe_object_id, reason) only moves
-- last_seen_at + attempt_count. supabase-js's upsert can't express selective
-- DO UPDATE columns or the attempt_count + 1 increment, hence this RPC.
--
-- SECURITY INVOKER (deliberately NOT DEFINER): the only caller is the
-- stripe-webhook running as service_role, which has BYPASSRLS — so the INSERT
-- lands despite billing_dead_letters' FORCE ROW LEVEL SECURITY. A DEFINER
-- function owned by postgres would ITSELF be subject to FORCE RLS (postgres
-- lacks BYPASSRLS) and the insert would be denied. EXECUTE is restricted to
-- service_role; and even if some client could call it, INVOKER means it runs as
-- that client → RLS denies the write (there is no client INSERT policy). So a
-- browser session can neither call it nor forge a dead-letter row through it.
-- search_path is pinned to public to close the search-path-injection vector.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_billing_dead_letter(
  p_source               text,
  p_reason               text,
  p_stripe_object_id     text,
  p_stripe_event_id      text DEFAULT NULL,
  p_stripe_customer_id   text DEFAULT NULL,
  p_claimed_workspace_id text DEFAULT NULL,
  p_amount_cents         integer DEFAULT NULL,
  p_purchased_by         uuid DEFAULT NULL,
  p_raw_metadata         jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.billing_dead_letters (
    source, reason, stripe_object_id, stripe_event_id, stripe_customer_id,
    claimed_workspace_id, amount_cents, purchased_by, raw_metadata
  ) VALUES (
    p_source, p_reason, p_stripe_object_id, p_stripe_event_id, p_stripe_customer_id,
    p_claimed_workspace_id, p_amount_cents, p_purchased_by, COALESCE(p_raw_metadata, '{}'::jsonb)
  )
  ON CONFLICT (source, stripe_object_id, reason) DO UPDATE
    SET last_seen_at  = now(),
        attempt_count = public.billing_dead_letters.attempt_count + 1;
$$;

-- CREATE OR REPLACE FUNCTION grants EXECUTE to PUBLIC by default — strip it and
-- the client roles, leaving only service_role (the webhook).
REVOKE ALL ON FUNCTION public.record_billing_dead_letter(text, text, text, text, text, text, integer, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_billing_dead_letter(text, text, text, text, text, text, integer, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_billing_dead_letter(text, text, text, text, text, text, integer, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_billing_dead_letter(text, text, text, text, text, text, integer, uuid, jsonb) TO service_role;
