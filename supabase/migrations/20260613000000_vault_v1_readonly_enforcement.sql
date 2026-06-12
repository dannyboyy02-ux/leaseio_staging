-- Vault V1 — server-side read-only enforcement (KNOWN_ISSUES #75 → blocker;
-- PRODUCT_STRATEGY.md Decision 5; docs/VAULT_TIER_SPEC.md).
--
-- A workspace is NOT live when its subscription has fully ended
-- (canceled_at set — the grace window), it has been soft-deleted, or it is
-- on the Vault retention tier (plan = 'vault'; value ships in V2 — no rows
-- carry it yet, so this is forward-compatible and inert for Vault today).
-- Non-live workspaces are READ + EXPORT ONLY. Until now that was enforced
-- only in the UI plus three edge-function backstops; this migration makes
-- it a database property.
--
-- Mechanism: ADDITIVE `AS RESTRICTIVE` policies, one per write command per
-- table. Restrictive policies AND onto the existing permissive ones, so no
-- existing policy is modified, reads are untouched (no FOR SELECT policy
-- here, ever), and the whole layer reverts with DROP POLICY. service_role
-- bypasses RLS, so crons and edge functions are unaffected at this layer
-- (their gating is the companion code change).
--
-- DELIBERATELY NOT BLOCKED (each is a product decision, not an omission):
--   lease_reports        — report/export generation IS the Vault promise
--                          ("your repository, exportable") and grace keeps
--                          view+export open. Blocking exports here is a bug
--                          by definition (VAULT_TIER_SPEC invariants).
--   workspaces           — owner administration must survive: rename,
--                          owner-initiated deletion, and the UPDATE path
--                          under transfer-workspace-ownership. Entitlement
--                          columns are already guarded by the #29 trigger.
--   workspace_members    — the owner may still remove members (Vault is
--                          owner-only; shrinking access must stay possible).
--   profiles, user_preferences, user_out_of_office, dismissed_events,
--   notifications        — personal/user scope, not workspace lease data.
--   vendor_alert_log     — operator tooling.
--   summary_views, classification_corrections, lease_insights,
--   lease_governance_audit, processing_rate_limits — already service-role
--                          or token-gated write paths; nothing to restrict.

-- ── 1. Helpers (house pattern: SQL, STABLE, SECURITY DEFINER) ─────────────

CREATE OR REPLACE FUNCTION public.is_workspace_live(_workspace_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = _workspace_id
      AND w.canceled_at IS NULL
      AND w.soft_deleted_at IS NULL
      AND COALESCE(w.plan, '') <> 'vault'
  );
$$;

COMMENT ON FUNCTION public.is_workspace_live(uuid) IS
  'False when the workspace is in the cancellation grace window (canceled_at), soft-deleted, or on the Vault retention tier. Gates every member write via RESTRICTIVE policies (Vault V1, 2026-06-12). Reads and lease_reports (exports) are deliberately not gated.';

CREATE OR REPLACE FUNCTION public.is_lease_live(_lease_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.leases l
    JOIN public.workspaces w ON w.id = l.workspace_id
    WHERE l.id = _lease_id
      AND w.canceled_at IS NULL
      AND w.soft_deleted_at IS NULL
      AND COALESCE(w.plan, '') <> 'vault'
  );
$$;

COMMENT ON FUNCTION public.is_lease_live(uuid) IS
  'is_workspace_live() resolved through a lease id, for lease-keyed child tables.';

REVOKE ALL ON FUNCTION public.is_workspace_live(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_lease_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_live(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_lease_live(uuid) TO authenticated;

-- ── 2. Restrictive write gates ────────────────────────────────────────────
-- Generated per (table, key, command). DO block + duplicate_object guard
-- keeps the migration idempotent.

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- workspace_id-keyed
      ('leases',                 'workspace_id'),
      ('lease_documents',        'workspace_id'),
      ('lease_change_sets',      'workspace_id'),
      ('lease_unlock_requests',  'workspace_id'),
      ('lease_approval_chain',   'workspace_id'),
      ('lease_asc842_inputs',    'workspace_id'),
      ('approval_policies',      'workspace_id'),
      ('alert_rules',            'workspace_id'),
      ('invite_tokens',          'workspace_id'),
      ('risk_templates',         'workspace_id'),
      ('workspace_activity_log', 'workspace_id'),
      ('workspace_approvers',    'workspace_id'),
      ('workspace_roles',        'workspace_id'),
      -- lease_id-keyed
      ('rent_schedules',          'lease_id'),
      ('risks',                   'lease_id'),
      ('executed_term_edits',     'lease_id'),
      ('field_corrections',       'lease_id'),
      ('lease_activity_log',      'lease_id'),
      ('lease_approval_actions',  'lease_id'),
      ('lease_approvers',         'lease_id'),
      ('lease_field_confidence',  'lease_id'),
      ('lease_notifications',     'lease_id'),
      ('lease_nudges',            'lease_id'),
      ('lease_state_transitions', 'lease_id')
    ) AS t(tbl, key_col)
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.%I(%I))',
        'live workspace required for insert', spec.tbl,
        CASE spec.key_col WHEN 'workspace_id' THEN 'is_workspace_live' ELSE 'is_lease_live' END,
        spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.%I(%I))',
        'live workspace required for update', spec.tbl,
        CASE spec.key_col WHEN 'workspace_id' THEN 'is_workspace_live' ELSE 'is_lease_live' END,
        spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.%I(%I))',
        'live workspace required for delete', spec.tbl,
        CASE spec.key_col WHEN 'workspace_id' THEN 'is_workspace_live' ELSE 'is_lease_live' END,
        spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ── 3. Indirectly-keyed tables (explicit, not in the loop) ────────────────

-- lease_change_set_items → change_set_id → lease_change_sets.workspace_id
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.lease_change_set_items AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for update"
    ON public.lease_change_set_items AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for delete"
    ON public.lease_change_set_items AS RESTRICTIVE FOR DELETE TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- approval_chain_steps → policy_id → approval_policies.workspace_id
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.approval_chain_steps AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for update"
    ON public.approval_chain_steps AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for delete"
    ON public.approval_chain_steps AS RESTRICTIVE FOR DELETE TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
