-- Helper RPC for the Supabase monitoring adapter.
--
-- The Supabase Management API does not expose a public database-size
-- endpoint; the spec-suggested /v1/projects/{ref}/usage endpoint
-- doesn't actually exist (verified via probe 2026-05-11). To get
-- db_size_bytes for the monitoring dashboard, we expose
-- pg_database_size('postgres') as an RPC that the service-role
-- client can invoke via supabase.rpc().
--
-- SECURITY DEFINER so the function can read system catalogs
-- regardless of caller permissions; revoke from public to ensure
-- only authenticated/service-role callers reach it.

CREATE OR REPLACE FUNCTION public.pg_database_size_postgres()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT pg_database_size('postgres');
$$;

REVOKE ALL ON FUNCTION public.pg_database_size_postgres() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pg_database_size_postgres() TO service_role;
