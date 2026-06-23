-- Cluster D (performance) — wrap bare auth.uid() in RLS policies (2026-06-23).
--
-- Source: Supabase performance advisor lint 0003 (auth_rls_initplan). 134 RLS
-- policies in `public` call `auth.uid()` BARE inside their USING / WITH CHECK
-- expressions. Postgres re-evaluates a bare volatile-looking call per ROW; the
-- documented fix is to wrap it in a scalar subselect — `(select auth.uid())` —
-- which the planner hoists to an InitPlan and evaluates ONCE per statement.
--
-- SEMANTICS ARE UNCHANGED. auth.uid() returns the same value for every row in a
-- statement, so `x = auth.uid()` and `x = (select auth.uid())` are logically
-- identical predicates — the wrap only changes WHEN the call is evaluated
-- (once vs per-row), never the boolean result. This is a pure performance change;
-- it cannot widen or narrow what any policy admits, so it does not alter tenant
-- isolation or any authorization boundary.
--
-- Verified pre-write against the live catalog (pg_policies, public schema):
--   * 134 policies reference auth.uid(); 0 reference auth.role()/auth.jwt()/
--     current_setting() — so a single substitution covers every flagged policy.
--   * 0 policies are already wrapped — no double-wrap hazard on first run.
--
-- This is written as a guarded generator rather than 134 hand-rolled ALTERs:
--   * It reads each policy's CURRENT USING/WITH CHECK from pg_policies and only
--     rewrites the auth.uid() token, preserving the rest of the predicate
--     verbatim (no chance of a hand-transcription drift in a 134-policy edit).
--   * ALTER POLICY changes the expressions in place — it never drops a policy,
--     so there is no window where a table sits unprotected mid-migration.
--   * IDEMPOTENT / re-runnable: the WHERE clause skips any policy already wrapped
--     (its expression then contains the rendered marker `( SELECT auth.uid()`),
--     and regexp_replace never re-scans its own replacement, so re-applying is a
--     no-op. The whole DO block runs in the migration runner's transaction, so a
--     mid-run failure rolls back cleanly (no partial state).
--
-- NOTE (separate, NOT addressed here): advisor lint 0004 (multiple_permissive_
-- policies, ~90 findings, mostly firm_invitations/firm_members) is a structural
-- policy-consolidation change with real semantic risk and is deliberately left
-- to its own reviewed migration. Wrapping auth.uid() does not affect that lint.

DO $$
DECLARE
  r record;
  new_using text;
  new_check text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual ~ 'auth\.uid\(\)' OR with_check ~ 'auth\.uid\(\)')
      -- idempotency: skip policies already wrapped (rendered form contains
      -- "( SELECT auth.uid()"); none match on first run (verified 0 wrapped).
      AND coalesce(qual, '')       !~ '\(\s*SELECT\s+auth\.uid\(\)'
      AND coalesce(with_check, '') !~ '\(\s*SELECT\s+auth\.uid\(\)'
  LOOP
    new_using := CASE
      WHEN r.qual IS NOT NULL
      THEN ' USING (' || regexp_replace(r.qual, 'auth\.uid\(\)', '(select auth.uid())', 'g') || ')'
      ELSE '' END;
    new_check := CASE
      WHEN r.with_check IS NOT NULL
      THEN ' WITH CHECK (' || regexp_replace(r.with_check, 'auth\.uid\(\)', '(select auth.uid())', 'g') || ')'
      ELSE '' END;

    EXECUTE format('ALTER POLICY %I ON %I.%I%s%s',
                   r.policyname, r.schemaname, r.tablename, new_using, new_check);

    RAISE NOTICE 'wrapped auth.uid() in policy %.% : %', r.schemaname, r.tablename, r.policyname;
  END LOOP;
END $$;
