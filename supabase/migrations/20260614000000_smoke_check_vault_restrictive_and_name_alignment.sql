-- audit_rls_smoke_check(): account for the Vault V1 RESTRICTIVE policies and
-- align two governance SELECT-policy name assertions to the live names.
-- (KNOWN_ISSUES #26 unblock + #25 resolution.)
--
-- WHY (verified live 2026-06-14 against project wwkwoxxcprnjjufkbzac — the live
-- function returned SIX false keys, not the two #25/#26 predicted):
--
--   1-5. The five `*_only_one_*_policy` content checks assert "no policy on
--        (table, cmd) other than the expected hardened one" via
--        `policyname != '<expected>'`. They count ALL policies regardless of
--        PERMISSIVE/RESTRICTIVE. The Vault V1 read-only enforcement added a
--        RESTRICTIVE policy per write command ("live workspace required for
--        insert/update/delete") to lease_change_sets and lease_change_set_items
--        — a legitimate, additive restriction — so four of these checks now
--        return FALSE. This is stale-assertion drift, NOT a security finding.
--
--        FIX: add `AND permissive = 'PERMISSIVE'`. A RESTRICTIVE policy can only
--        AND further restrictions onto access; it can never GRANT access, so it
--        is irrelevant to a "duplicate/renamed grant" bypass tripwire. The
--        original anti-bypass intent (#16/#17: catch an unexpected PERMISSIVE
--        grant, including a FOR ALL one via `cmd IN (...,'ALL')`) is fully
--        preserved — a renamed permissive grant still trips. Applied uniformly
--        to all five `only_one` checks (incl. governance_audit, which passes
--        today) so the rule is consistent and survives any future RESTRICTIVE
--        policy on those tables.
--
--   6-7. governance_unlock_policy / governance_change_set_policy assert the
--        SELECT policy name `workspace access can view ...`. That rename
--        (archived migration _archive/20260426000003) never applied to prod
--        (#25); the live names are `workspace members can view ...` —
--        functionally identical (same workspace-membership predicate). Rather
--        than rename live policies (riskier, no behavior change), align the
--        assertion to the live names. Verified live: lease_unlock_requests ->
--        'workspace members can view unlock requests'; lease_change_sets ->
--        'workspace members can view change sets'.
--
-- Everything else in the function is reproduced verbatim. SECURITY DEFINER +
-- SET search_path preserved. Idempotent (CREATE OR REPLACE). Per CLAUDE.md this
-- migration was routed through security review BEFORE apply.

CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    -- ===== Original 15 keys (preserved verbatim from _archive/20260426000004) =====
    'is_workspace_member_function', EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_workspace_member'
    ),
    'workspace_members_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'workspace_members'
        AND policyname = 'Members can view workspace membership'
    ),
    'workspace_roles_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'workspace_roles'
        AND policyname = 'workspace_roles_select'
    ),
    'leases_select_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'leases'
        AND policyname = 'leases_select_own_or_workspace'
    ),
    'summary_views_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'summary_views'
        AND policyname = 'summary_views_select_workspace'
    ),
    'executed_legacy_storage_policies_removed', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN (
          'authenticated_upload_executed_leases',
          'authenticated_read_executed_leases',
          'authenticated_delete_executed_leases'
        )
    ),
    'executed_scoped_storage_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname = 'executed_leases_select'
    ),
    'strict_model_lock_trigger', EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname = 'enforce_model_lock'
        AND t.tgrelid = 'public.leases'::regclass
        AND NOT t.tgisinternal
    ),
    'strict_model_lock_function', EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'prevent_locked_lease_edits'
        AND pg_get_functiondef(p.oid) ILIKE '%service_role%'
        AND pg_get_functiondef(p.oid) ILIKE '%governance workflow%'
    ),
    'workspace_entitlement_guard', EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname = 'enforce_workspace_entitlement_guard'
        AND t.tgrelid = 'public.workspaces'::regclass
        AND NOT t.tgisinternal
    ),
    'workspace_subscription_columns', EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'workspaces'
        AND column_name = 'stripe_subscription_id'
    ),
    -- #25: aligned to the live policy names ('workspace members can view ...').
    -- The archived 'workspace access can view ...' rename never applied to prod;
    -- the live policies grant identical workspace-member SELECT access.
    'governance_unlock_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_unlock_requests'
        AND policyname = 'workspace members can view unlock requests'
    ),
    'governance_change_set_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND policyname = 'workspace members can view change sets'
    ),
    'governance_audit_append_guard', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_governance_audit'
        AND policyname = 'governance audit is service role append only'
    ),
    'governance_change_set_draft_only_edit', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND policyname = 'submitter can edit draft change sets'
    ),
    -- ===== New absence-checks (from prior migration 20260516130000) =====
    'governance_audit_no_member_insert', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_governance_audit'
        AND policyname = 'workspace members can insert governance audit'
    ),
    'change_set_no_unrestricted_update', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND policyname = 'submitters and approvers can update change sets'
    ),
    -- ===== New content-based absence-checks (H4 fix) =====
    -- These trip on ANY policy other than the expected hardened one on the
    -- affected (table, cmd) pair, defeating name-rename bypass.
    --
    -- cmd IN (...,'ALL') closes the FOR ALL blind spot: a CREATE POLICY
    -- ... FOR ALL stores cmd='ALL', not the specific operation.
    --
    -- permissive = 'PERMISSIVE' (added 2026-06-14, #26): a RESTRICTIVE policy
    -- can only narrow access, never grant it, so it cannot be a grant-bypass —
    -- exclude it. This lets the legitimate Vault V1 "live workspace required
    -- for ..." RESTRICTIVE policies coexist while the tripwire still catches any
    -- unexpected PERMISSIVE grant (incl. FOR ALL).
    --
    -- Deliberately narrow to INSERT and UPDATE on these two tables for the
    -- parent-table beat (#16 audit INSERT tampering, #17 change set UPDATE
    -- tampering); items mirror all three write cmds below.
    'governance_audit_only_one_insert_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_governance_audit'
        AND cmd IN ('INSERT', 'ALL')
        AND permissive = 'PERMISSIVE'
        AND policyname != 'governance audit is service role append only'
    ),
    'change_set_only_one_update_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND cmd IN ('UPDATE', 'ALL')
        AND permissive = 'PERMISSIVE'
        AND policyname != 'submitter can edit draft change sets'
    ),
    -- ===== H2 follow-up: items are draft-only too =====
    'change_set_items_draft_only_insert', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND policyname = 'draft-only insert change set items'
    ),
    'change_set_items_draft_only_update', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND policyname = 'draft-only update change set items'
    ),
    'change_set_items_draft_only_delete', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND policyname = 'draft-only delete change set items'
    ),
    -- ===== H2 follow-up content-based checks (parallel to parent) =====
    -- Same FOR ALL / name-rename bypass concern as the parent table; same
    -- permissive = 'PERMISSIVE' carve-out for the Vault RESTRICTIVE policies.
    'change_set_items_only_one_insert_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('INSERT', 'ALL')
        AND permissive = 'PERMISSIVE'
        AND policyname != 'draft-only insert change set items'
    ),
    'change_set_items_only_one_update_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('UPDATE', 'ALL')
        AND permissive = 'PERMISSIVE'
        AND policyname != 'draft-only update change set items'
    ),
    'change_set_items_only_one_delete_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('DELETE', 'ALL')
        AND permissive = 'PERMISSIVE'
        AND policyname != 'draft-only delete change set items'
    ),
    -- ===== H1-extended: field-level immutability trigger =====
    'change_set_field_tampering_trigger', (
      EXISTS (
        SELECT 1 FROM pg_trigger t
        WHERE t.tgname = 'prevent_change_set_field_tampering'
          AND t.tgrelid = 'public.lease_change_sets'::regclass
          AND NOT t.tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'prevent_change_set_field_tampering'
          AND pg_get_functiondef(p.oid) ILIKE '%workspace_id is immutable%'
          AND pg_get_functiondef(p.oid) ILIKE '%submitted_by is immutable%'
          AND pg_get_functiondef(p.oid) ILIKE '%auth.role()%'
      )
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO service_role;

-- Refresh the catalog triage legend (a bare CREATE OR REPLACE preserves the OID
-- and thus the prior COMMENT, but re-assert it so it reflects the #26/#25 edits).
COMMENT ON FUNCTION public.audit_rls_smoke_check() IS
  'Returns jsonb of policy/trigger/function existence checks for governance hardening. Triage categories: A=drift candidates (false = file new KNOWN_ISSUES, address in a separate beat); B=name-based prior-migration assertions (false = stop and investigate, prior migration likely diverged from live state); C=this-migration''s hardening (false = active vulnerability survived or migration apply failed). The 5 *_only_one_*_policy checks filter to permissive=''PERMISSIVE'' (#26): RESTRICTIVE policies (e.g. Vault V1 "live workspace required for ...") only narrow access and cannot be a grant-bypass, so they are excluded; an unexpected PERMISSIVE grant (incl. FOR ALL) still trips. governance_unlock_policy / governance_change_set_policy assert the live SELECT names "workspace members can view ..." (#25). See migration 20260517000000_governance_hardening_followup.sql header for the full key->category mapping.';
