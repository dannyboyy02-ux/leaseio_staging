-- Helper RPC for the Supabase monitoring adapter — storage size.
--
-- The supabase-js client cannot reach storage.objects via PostgREST
-- by default; the storage schema is not exposed in the API. The
-- 2026-05-11 monitoring smoke showed storage_bytes silently absent
-- (only db_size_bytes + paused_status landed). Exposing it as a
-- SECURITY DEFINER function lets the service-role client read the
-- aggregate without granting PostgREST schema-level access.

CREATE OR REPLACE FUNCTION public.storage_total_bytes()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage, pg_catalog
AS $$
  SELECT COALESCE(SUM((metadata->>'size')::bigint), 0)::bigint
  FROM storage.objects
  WHERE metadata ? 'size';
$$;

REVOKE ALL ON FUNCTION public.storage_total_bytes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_total_bytes() TO service_role;
