-- ============================================================================
-- Restore governance hardening (KNOWN_ISSUES #16 + #17)
-- ============================================================================
-- Both hardenings were originally installed in archived migrations
-- (_archive/20260426000003 + _archive/20260426000004) but were absent from
-- live production state when the P1-10 baseline review queried pg_policies
-- on 2026-05-16. Either never applied or silently reverted; attribution is
-- lost since schema_migrations.created_by was wiped during the P1-10
-- reconcile (use docs/ops/schema_migrations_pre_baseline_2026-05-16.json
-- for historical attribution lookups).
--
-- See docs/KNOWN_ISSUES.md items #16 and #17 for full investigation context.
--
-- Pre-apply checklist verified 2026-05-16 (separate beat from P1-10 squash
-- per the surfacing-vs-fixing separation rule in CLAUDE.md):
--
--   #16 — lease_governance_audit WITH CHECK (false) for authenticated:
--     - 4 writers identified, all in edge functions using
--       SUPABASE_SERVICE_ROLE_KEY (service_role bypasses RLS):
--         lease-governance-action/index.ts (INSERT batch)
--         request-lease-unlock/index.ts (INSERT)
--         delete-account/index.ts (UPDATE for actor PII scrub)
--         delete-workspace/index.ts (INSERT deletion event)
--     - Zero browser-side INSERTs (grep'd src/ for
--       "lease_governance_audit.*insert" — no matches).
--
--   #17 — lease_change_sets draft-only UPDATE for submitters:
--     - 3 edge function mutators, all service_role.
--     - 3 browser callers, ALL .select() reads (useNeedsAction.ts,
--       ApprovalQueue.tsx, LeaseReview.tsx).
--     - UI state-transition flows (cancel / approve / reject) all route
--       through supabase.functions.invoke('lease-governance-action', ...)
--       → service_role → bypasses RLS.
--     - No UI affordance exists for a submitter to directly edit a
--       change set after status flips to pending_approval. The
--       draft-only guard breaks nothing the UI offers.

-- ----------------------------------------------------------------------------
-- #16: lease_governance_audit INSERT must be append-only by service_role only.
-- The audit table is the system of record for unlock / change-set / relock
-- events; authenticated writers would invalidate attribution.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "workspace members can insert governance audit" ON public.lease_governance_audit;
DROP POLICY IF EXISTS "governance audit is service role append only" ON public.lease_governance_audit;

CREATE POLICY "governance audit is service role append only"
  ON public.lease_governance_audit FOR INSERT TO authenticated
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- #17: lease_change_sets UPDATE — submitters may only edit DRAFT sets.
-- Once status flips to pending_approval, only admin / financial_approver /
-- workspace owner may UPDATE (so they can approve / reject). Without this
-- guard, a submitter can modify proposed values after the approver has been
-- notified, defeating the staged-approval premise.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "submitters and approvers can update change sets" ON public.lease_change_sets;
DROP POLICY IF EXISTS "submitter can edit draft change sets" ON public.lease_change_sets;

CREATE POLICY "submitter can edit draft change sets"
  ON public.lease_change_sets FOR UPDATE
  TO authenticated
  USING (
    -- Submitter can only modify their own draft sets
    (
      submitted_by = auth.uid()
      AND status = 'draft'
      AND public.is_workspace_member(workspace_id, auth.uid())
    )
    OR
    -- Admin / financial_approver / workspace owner can approve or reject pending sets
    (
      status = 'pending_approval'
      AND public.is_workspace_member(workspace_id, auth.uid())
      AND (
        EXISTS (
          SELECT 1 FROM public.workspace_roles wr
          WHERE wr.workspace_id = lease_change_sets.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role IN ('admin', 'financial_approver')
        )
        OR EXISTS (
          SELECT 1 FROM public.workspaces w
          WHERE w.id = lease_change_sets.workspace_id
            AND w.owner_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- Update audit_rls_smoke_check() to assert both hardened policies exist AND
-- the old permissive policies are absent. The function returns a jsonb of
-- check_name => boolean. Operators (or a future cron) call this to confirm
-- the live policy surface matches the hardened intent. The check was
-- originally introduced in _archive/20260426000003 with one key
-- (`governance_audit_append_only`); extended here with three more.
--
-- Wiring this function to a scheduled cron with alerting is a separate beat
-- — filed in KNOWN_ISSUES per the operator-side decisions still owed
-- (alerting target, frequency, failure threshold).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'governance_audit_append_only', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_governance_audit'
        AND policyname = 'governance audit is service role append only'
    ),
    'governance_audit_no_member_insert', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_governance_audit'
        AND policyname = 'workspace members can insert governance audit'
    ),
    'change_set_draft_only_edit', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_change_sets'
        AND policyname = 'submitter can edit draft change sets'
    ),
    'change_set_no_unrestricted_update', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'lease_change_sets'
        AND policyname = 'submitters and approvers can update change sets'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
