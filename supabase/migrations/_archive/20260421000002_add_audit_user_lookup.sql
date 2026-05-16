-- Helper: look up an auth user ID by email — used by the audit-session edge function (service role only)
CREATE OR REPLACE FUNCTION public.get_audit_user_id(p_email TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id FROM auth.users WHERE email = lower(p_email) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_audit_user_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_audit_user_id(TEXT) TO service_role;

COMMENT ON FUNCTION public.get_audit_user_id IS
  'Returns the auth.users.id for a given email. Used server-side by audit-session edge function. Not callable by anon or authenticated roles.';
