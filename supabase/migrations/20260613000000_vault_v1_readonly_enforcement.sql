-- Vault V1 — server-side read-only enforcement (KNOWN_ISSUES #75 → blocker;
-- PRODUCT_STRATEGY.md Decision 5; docs/VAULT_TIER_SPEC.md).
--
-- A workspace is NOT live when its subscription has fully ended
-- (canceled_at set — the grace window), it has been soft-deleted, or it is
-- on the Vault retention tier (plan = 'vault'; value ships in V2 — no rows
-- carry it yet, so this is forward-compatible and inert for Vault today).
-- Non-live workspaces are READ + EXPORT ONLY at the database layer.
--
-- Mechanism: ADDITIVE `AS RESTRICTIVE` policies, one per write command per
-- table. Restrictive policies AND onto the existing permissive ones, so no
-- existing policy is modified, reads are untouched (no FOR SELECT policy
-- here, ever), and the whole layer reverts with DROP POLICY. Policies are
-- role-unscoped (PUBLIC) so a future anon-writable permissive policy cannot
-- bypass the layer; service_role bypasses RLS wholesale, so crons and edge
-- functions are unaffected HERE — their gating is the companion
-- _shared/workspace_live.ts pass landing in the same change set.
--
-- Failure shapes (review round 2, 2026-06-13):
--   INSERT/UPDATE → loud 42501 (WITH CHECK violation), never a silent no-op.
--   DELETE        → silent zero-row no-op (Postgres has no DELETE WITH
--                   CHECK). ACCEPTED RESIDUAL: a blocked delete reports
--                   0 rows, which clients may render as success.
--   Missing table/column at apply time aborts the migration — intentional
--   fail-closed (the DO blocks guard only duplicate_object).
--
-- DELIBERATELY NOT BLOCKED (each is a product decision, not an omission):
--   lease_reports          — report/export generation IS the Vault promise
--                            ("your repository, exportable") and grace keeps
--                            view+export open. Gating exports = bug by
--                            definition (VAULT_TIER_SPEC invariants).
--   workspace_activity_log — CARVE-OUT (integrity review round 1 CRITICAL):
--                            the actions that legitimately remain open below
--                            (rename, member removal) write their audit rows
--                            client-side into this table. Blocking the audit
--                            INSERT while its subject mutations stay open
--                            manufactures unattributable owner actions in the
--                            exact tier sold on audit-defensibility. An
--                            append-only audit table stays writable; the
--                            proper server-side audit triggers are the
--                            KNOWN_ISSUES #53–55 remediation.
--   workspaces             — the ONLY authenticated write path that needs to
--                            stay open is owner rename (owner-initiated
--                            deletion and ownership transfer run as
--                            service_role/SECURITY DEFINER and bypass RLS
--                            regardless). Entitlement + lifecycle columns are
--                            guarded by the #29 trigger, so no
--                            self-resurrection path exists.
--   workspace_members DELETE — the owner may still REMOVE members (Vault is
--                            owner-only; shrinking access must stay
--                            possible). INSERT/UPDATE are gated below.
--   notifications UPDATE/DELETE — a user marking/clearing their OWN
--                            notifications is personal read-state. INSERT is
--                            gated below (workspace-keyed row creation).
--   profiles, user_preferences, user_out_of_office, dismissed_events
--                          — personal/user scope, not workspace lease data.
--   vendor_alert_log       — operator tooling.
--   lease_attribute_snapshots, lease_reroute_events, chain_step_overrides,
--   chain_step_voluntary_delegations — SELECT-only to clients (service-role
--                            write paths); nothing to restrict.
--
-- NOTE lease_activity_log IS gated (in the loop below) — unlike
-- workspace_activity_log, security review round 2 verified no surviving
-- client flow needs its INSERT in a non-live workspace (every client writer
-- logs after a parent mutation that is itself gated); leaving it open would
-- only permit fabricating audit history in a frozen repository.
--   summary_views, classification_corrections, lease_insights,
--   lease_governance_audit, processing_rate_limits — already service-role
--                            or token-gated write paths; nothing to restrict.

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
  'False when the workspace is in the cancellation grace window (canceled_at), soft-deleted, or on the Vault retention tier. Gates member writes via RESTRICTIVE policies (Vault V1). Reads and lease_reports (exports) are deliberately not gated. Known + accepted: callable by any authenticated user on arbitrary uuids, so it is an existence∧liveness oracle — false conflates nonexistent with non-live, uuids are unguessable, surface matches is_workspace_member (security review 2026-06-13).';

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
  'is_workspace_live() resolved through a lease id, for lease-keyed child tables. Same oracle caveat as is_workspace_live.';

REVOKE ALL ON FUNCTION public.is_workspace_live(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_lease_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_live(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_lease_live(uuid) TO authenticated;

-- ── 2. Restrictive write gates (loop-generated) ───────────────────────────
-- INSERT and UPDATE use WITH CHECK so blocked writes raise 42501 loudly
-- (a USING-only UPDATE filters to zero rows and clients toast "saved" for
-- writes that never landed — integrity review round 1 HIGH). UPDATE keeps
-- USING (true): row visibility for update remains the permissive policies'
-- job; liveness is checked on the NEW row, which also blocks re-pointing a
-- row into a non-live workspace.

DO $$
DECLARE
  spec record;
  fn text;
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
      ('workspace_approvers',    'workspace_id'),
      ('workspace_roles',        'workspace_id'),
      -- lease_id-keyed
      ('lease_activity_log',      'lease_id'),
      ('rent_schedules',          'lease_id'),
      ('risks',                   'lease_id'),
      ('executed_term_edits',     'lease_id'),
      ('field_corrections',       'lease_id'),
      ('lease_approval_actions',  'lease_id'),
      ('lease_approvers',         'lease_id'),
      ('lease_field_confidence',  'lease_id'),
      ('lease_notifications',     'lease_id'),
      ('lease_nudges',            'lease_id'),
      ('lease_state_transitions', 'lease_id')
    ) AS t(tbl, key_col)
  LOOP
    fn := CASE spec.key_col WHEN 'workspace_id' THEN 'is_workspace_live' ELSE 'is_lease_live' END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK (public.%I(%I))',
        'live workspace required for insert', spec.tbl, fn, spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (public.%I(%I))',
        'live workspace required for update', spec.tbl, fn, spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE USING (public.%I(%I))',
        'live workspace required for delete', spec.tbl, fn, spec.key_col);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ── 3. Tables with command subsets or indirect keys (explicit) ────────────

-- workspace_members: gate INSERT + UPDATE (no growing/escalating membership
-- of a non-live workspace — security review round 1); DELETE stays open.
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.workspace_members AS RESTRICTIVE FOR INSERT
    WITH CHECK (public.is_workspace_live(workspace_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for update"
    ON public.workspace_members AS RESTRICTIVE FOR UPDATE
    USING (true) WITH CHECK (public.is_workspace_live(workspace_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- notifications: gate INSERT only (workspace-keyed row creation; the
-- "notifications_service_insert" permissive policy is member-writable
-- despite its name). UPDATE/DELETE are the user's own read-state.
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.notifications AS RESTRICTIVE FOR INSERT
    WITH CHECK (public.is_workspace_live(workspace_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- lease_change_set_items → change_set_id → lease_change_sets.workspace_id
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.lease_change_set_items AS RESTRICTIVE FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for update"
    ON public.lease_change_set_items AS RESTRICTIVE FOR UPDATE
    USING (true) WITH CHECK (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for delete"
    ON public.lease_change_set_items AS RESTRICTIVE FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = change_set_id AND public.is_workspace_live(cs.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- approval_chain_steps → policy_id → approval_policies.workspace_id
DO $$
BEGIN
  CREATE POLICY "live workspace required for insert"
    ON public.approval_chain_steps AS RESTRICTIVE FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for update"
    ON public.approval_chain_steps AS RESTRICTIVE FOR UPDATE
    USING (true) WITH CHECK (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE POLICY "live workspace required for delete"
    ON public.approval_chain_steps AS RESTRICTIVE FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = policy_id AND public.is_workspace_live(p.workspace_id)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. storage.objects — the files themselves (security review round 1) ───
-- The read-only promise is meaningless if the PDFs can be destroyed.
-- Bucket conventions: lease-documents + lease-reports are {workspace_id}/…;
-- leases + executed-leases are {uploader_uid}/… and resolve liveness through
-- the lease row that references the object. lease-reports stays UNGATED
-- (export promise — the client uploads report PDFs there).
-- Residual (accepted): a leases/executed-leases object not yet referenced by
-- any lease row can't be liveness-resolved and stays writable — that costs
-- storage spend only; the corresponding lease creation is gated in
-- process_lease.

DO $$
BEGIN
  CREATE POLICY "live workspace required for object insert"
    ON storage.objects AS RESTRICTIVE FOR INSERT
    WITH CHECK (
      CASE bucket_id
        WHEN 'lease-documents' THEN public.is_workspace_live(((storage.foldername(name))[1])::uuid)
        ELSE true
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "live workspace required for object update"
    ON storage.objects AS RESTRICTIVE FOR UPDATE
    USING (
      CASE bucket_id
        WHEN 'lease-documents' THEN public.is_workspace_live(((storage.foldername(name))[1])::uuid)
        WHEN 'leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.storage_path = name AND NOT public.is_lease_live(l.id))
        WHEN 'executed-leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.executed_storage_path = name AND NOT public.is_lease_live(l.id))
        ELSE true
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "live workspace required for object delete"
    ON storage.objects AS RESTRICTIVE FOR DELETE
    USING (
      CASE bucket_id
        WHEN 'lease-documents' THEN public.is_workspace_live(((storage.foldername(name))[1])::uuid)
        WHEN 'leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.storage_path = name AND NOT public.is_lease_live(l.id))
        WHEN 'executed-leases' THEN NOT EXISTS (
          SELECT 1 FROM public.leases l
          WHERE l.executed_storage_path = name AND NOT public.is_lease_live(l.id))
        ELSE true
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 5. Indexes for the storage liveness subqueries (security round 2 LOW) ──
-- The leases/executed-leases bucket policies join on these paths; without
-- indexes every gated storage UPDATE/DELETE seq-scans leases.

CREATE INDEX IF NOT EXISTS idx_leases_storage_path
  ON public.leases (storage_path);
CREATE INDEX IF NOT EXISTS idx_leases_executed_storage_path
  ON public.leases (executed_storage_path);
