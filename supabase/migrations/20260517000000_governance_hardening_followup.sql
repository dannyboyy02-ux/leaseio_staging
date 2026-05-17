-- ============================================================================
-- Governance hardening follow-up — completes #16 + #17
-- ============================================================================
-- The prior migration (20260516130000_restore_governance_hardening.sql) closed
-- the named permissive policies but reviewer pass surfaced four incompletenesses:
--
--   C1 — audit_rls_smoke_check() was CREATE OR REPLACE'd as a 4-key function,
--        silently dropping 11 pre-existing assertion keys (model-lock trigger,
--        entitlement guard, is_workspace_member function, storage scoping
--        policies, etc.). The smoke check was the system's only automated
--        regression detector; shrinking it from 15 keys to 4 is exactly the
--        silent-coverage-regression pattern the function was meant to prevent.
--
--   H1 — `WITH CHECK (true)` on the lease_change_sets UPDATE policy let a
--        submitter who satisfied USING (own draft) PATCH the row directly
--        via PostgREST to flip status='pending_approval', bypassing the
--        lease-governance-action edge function that's supposed to be the
--        only writer of state-transition audit rows. The prior migration
--        faithfully reproduced this weakness from the archived original
--        instead of recognizing the archived original was also incomplete.
--
--   H2 — lease_change_set_items (the child table holding actual proposed
--        values) had no status gate. A submitter could INSERT/UPDATE/DELETE
--        items directly via PostgREST on a pending_approval parent set,
--        modifying what the approver sees AFTER they were notified.
--        Locking the parent without locking the children was a partial fix.
--
--   H4 — Smoke check was name-based, bypassable by a new permissive policy
--        with a different name (which is exactly how #16/#17 happened —
--        policy names drifted over time, some via Studio edits with no
--        migration trail).
--
-- Pre-apply this time: routed through lease-repository-integrity-reviewer,
-- lease-security-scanner, and lease-test-author BEFORE db push. New rule
-- for any migration touching RLS policies, role grants, SECURITY DEFINER
-- functions, or audit infrastructure: reviewers BEFORE push, not after.
--
-- ----------------------------------------------------------------------------
-- Eyeball-round clarifications (added before reviewer routing)
-- ----------------------------------------------------------------------------
--
-- Symmetric WITH CHECK on lease_change_sets UPDATE — intended behavior:
--   - Submitter PATCH status 'draft' -> 'pending_approval' via PostgREST is
--     DENIED: NEW.status='pending_approval' fails the submitter branch
--     (which requires status='draft') and submitter isn't admin so the
--     approver branch fails too.
--   - Approver PATCH status 'pending_approval' -> 'approved' (or 'rejected'
--     or 'canceled') via PostgREST is DENIED: NEW.status='approved' fails
--     the submitter branch (requires 'draft') and fails the approver branch
--     (requires 'pending_approval').
--   - ALL state transitions must go through lease-governance-action edge
--     function (service_role bypasses RLS), which writes the corresponding
--     lease_governance_audit row in the same transaction.
--
-- H2 lease_change_set_items DELETE — what's being narrowed:
--   Before this migration the policy was:
--     CREATE POLICY "workspace members can delete change set items"
--       FOR DELETE USING (
--         change_set_id IN (
--           SELECT id FROM lease_change_sets WHERE workspace_id IN (
--             SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
--           )
--         )
--       );
--   Any workspace member could delete any item regardless of parent status.
--   This migration narrows DELETE (and INSERT, UPDATE) to require
--   parent.status='draft'.
--
-- Role scope inconsistency on lease_change_set_items — accepted explicitly:
--   The existing SELECT policy is on the {public} role; this migration's
--   INSERT/UPDATE/DELETE policies are on {authenticated}. Mixed scoping
--   is functionally identical here (the workspace_member subquery returns
--   zero rows for the anon role since auth.uid() is NULL), but it is
--   inconsistent. Normalizing SELECT to {authenticated} is a behavior
--   change requiring its own threat analysis (would anon clients with the
--   anon key relying on the workspace_member subquery's null-handling
--   experience any change?) and is filed as future work in KNOWN_ISSUES,
--   not bundled here.
--
-- Smoke check external consumer:
--   `scripts/smoke-audit-hardening.mjs` (invoked via `npm run smoke:security`,
--   wired into `.github/workflows/ci.yml` line 81). The script is key-name
--   agnostic — it iterates every key returned by `audit_rls_smoke_check()`
--   and fails the CI step if any key is not `true`. Verbatim preservation
--   of the 15 original key names is still correct, but for that reason
--   (no broken assertions on currently-true keys), not for external naming
--   compatibility. The smoke step is currently skipped in CI because the
--   four SUPABASE_* secrets aren't configured; once they are, every false
--   key returned by the expanded smoke check will fail-close the CI step
--   — which is the intended drift-surfacing behavior.
--
-- ----------------------------------------------------------------------------
-- Bundled edge function change
-- ----------------------------------------------------------------------------
-- This migration is paired with an edge function change in
-- supabase/functions/lease-governance-action/index.ts lines 601 and 680.
-- Both UPDATE sites previously overwrote `submitted_by` with `user.id`
-- on the draft → pending_approval (or approved) transition. After the
-- field-tampering trigger added below, that overwrite raises
-- check_violation in the approve_unlock_request flow (where the
-- original requester != the admin acting on their behalf), breaking the
-- whole admin-self-approve path.
--
-- The edge function change removes the `submitted_by: user.id` lines.
-- Net effect: the requester's identity stays attributed in
-- `submitted_by`; the admin's identity is captured in `reviewed_by` +
-- `self_approved=true` + the audit/activity rows. The trigger and the
-- edge function now agree on the column's semantics ("who submitted
-- for approval" = "who created the draft", not "who finalized it").
--
-- Historical-data inflection: applies ONLY to change sets created via
-- the approve_unlock_request flow (admin acts on behalf of an external
-- requester). Pre-migration these have submitted_by = admin (the
-- overwrite bug); post-migration they will correctly have
-- submitted_by = original requester. Direct-unlock change sets (admin
-- creates and submits their own draft) have submitted_by = admin both
-- pre- and post-migration — that value is semantically correct
-- because the admin IS the submitter in a direct-unlock flow.
-- Future audit-log readers comparing pre/post records should: (a)
-- distinguish the two flow paths by inspecting lease_unlock_requests
-- joins (only approve_unlock_request rows have requested_by != admin),
-- (b) identify the migration apply timestamp as the inflection point
-- for that subset. Not backfilling — the pre-migration data isn't
-- wrong for direct-unlock and is captured-at-wrong-moment (not
-- semantically wrong) for approve_unlock_request. If the audit
-- package generator (Phase 8) is touched later, add a one-line note
-- there: "pre-2026-05-17 approve_unlock_request change sets have
-- submitted_by pointing to the admin; refer to lease_unlock_requests.requested_by
-- for original requester attribution on those records."
--
-- ----------------------------------------------------------------------------
-- Expected post-apply behavior of audit_rls_smoke_check() — IMPORTANT
-- ----------------------------------------------------------------------------
-- This migration restores all 15 original assertion keys plus 11 new
-- ones (5 from prior migration's intent + 6 new in this follow-up),
-- 26 total. The keys split into THREE categories with DIFFERENT
-- triage rules:
--
-- Category A — 13 DRIFT-CANDIDATE keys (may legitimately return FALSE):
--   is_workspace_member_function, workspace_members_policy,
--   workspace_roles_policy, leases_select_policy, summary_views_policy,
--   executed_legacy_storage_policies_removed, executed_scoped_storage_policy,
--   strict_model_lock_trigger, strict_model_lock_function,
--   workspace_entitlement_guard, workspace_subscription_columns,
--   governance_unlock_policy, governance_change_set_policy.
--
--   These were watching unrelated guards that the smoke check spent
--   weeks shrunk-to-4-keys unable to assert. Any FALSE return on these
--   is a candidate KNOWN_ISSUES entry — file as new issue with stub
--   remediation, address in a separate scoped beat. Do NOT bundle
--   drift fixes into this migration. Each false key is a new beat.
--
--   Note on governance_unlock_policy and governance_change_set_policy:
--   these assert the existence of `"workspace access can view ..."`
--   SELECT policies that were defined in archived migration
--   _archive/20260426000003_audit_remediation.sql but never applied to
--   prod. The live DB has the baseline's `"workspace members can view
--   ..."` policies under different names — functionally equivalent,
--   semantically different. These two keys WILL return FALSE on first
--   smoke run post-apply; that is drift, not migration failure. See
--   KNOWN_ISSUES #25 for the rename beat that will restore Category B
--   posture on these two keys.
--
-- Category B — 4 NAME-BASED keys MUST return TRUE post-apply:
--   governance_audit_append_guard, governance_change_set_draft_only_edit
--     (created by prior migration 20260516130000 under the names the
--     prior migration assigned them; if FALSE post-apply, either that
--     migration failed mid-execution AND was never retried, OR a
--     subsequent Studio edit / migration dropped/renamed the policy)
--   governance_audit_no_member_insert, change_set_no_unrestricted_update
--     (absence checks confirming prior migration's DROPs took effect;
--     if FALSE post-apply, the old permissive policy was re-created
--     under its original name by some path after the prior migration —
--     a same-name re-creation, not a rename, since the asserted absent
--     name is the original permissive one)
--
--   Either failure mode means the live policy state diverges from what
--   prior migrations committed. Stop and investigate immediately —
--   this is not routine triage. Recover by inspecting pg_policies for
--   the named policy and tracing how it got into its current state
--   (typically Studio audit history or migration history).
--
-- Category C — 9 NEW HARDENING keys MUST return TRUE (this migration
-- failed to apply, OR an active vulnerability survived):
--   governance_audit_only_one_insert_policy: any other INSERT policy
--     on lease_governance_audit means a permissive bypass survived
--   change_set_only_one_update_policy: same for lease_change_sets UPDATE
--   change_set_items_only_one_insert_policy / update_policy / delete_policy:
--     same content-based check for the items table (closes the FOR ALL
--     bypass on items, parallel to the parent)
--   change_set_items_draft_only_insert / update / delete: this
--     migration's items name-based hardening either applied or it didn't
--   change_set_field_tampering_trigger: this migration's trigger
--     either exists or it doesn't
--
--   These should NEVER legitimately return FALSE. If they do, either
--   this migration failed to apply or a permissive policy was added
--   AFTER apply via a path that bypassed migration review (Studio,
--   another migration). Both are active-vulnerability signals.
--
-- Total: 13 (A) + 4 (B) + 9 (C) = 26 keys.

-- ----------------------------------------------------------------------------
-- H1: Tighten WITH CHECK on lease_change_sets UPDATE policy.
-- WITH CHECK mirrors USING so the row that satisfies access (OLD) and the
-- row after write (NEW) must both satisfy the same predicate. Practical
-- effect: submitter cannot flip status='draft' -> 'pending_approval' via
-- PostgREST PATCH (NEW.status='pending_approval' fails the submitter branch
-- which requires status='draft'); approver cannot flip pending->approved
-- via PostgREST PATCH (NEW.status='approved' fails the approver branch
-- which requires status='pending_approval'). All state transitions must
-- go through lease-governance-action edge function (service_role bypasses
-- RLS, so the edge function is unaffected).
--
-- Field-level invariant enforcement (submitted_by immutable, workspace_id
-- immutable) is out of scope for RLS — those would require BEFORE UPDATE
-- triggers. Filed for future consideration if needed.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "submitter can edit draft change sets" ON public.lease_change_sets;

CREATE POLICY "submitter can edit draft change sets"
  ON public.lease_change_sets FOR UPDATE
  TO authenticated
  USING (
    (
      submitted_by = auth.uid()
      AND status = 'draft'
      AND public.is_workspace_member(workspace_id, auth.uid())
    )
    OR
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
  WITH CHECK (
    -- Mirror of USING — the row after UPDATE must also satisfy access.
    -- Blocks PostgREST PATCH attempts to escalate status or change ownership.
    (
      submitted_by = auth.uid()
      AND status = 'draft'
      AND public.is_workspace_member(workspace_id, auth.uid())
    )
    OR
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
  );

-- ----------------------------------------------------------------------------
-- H2: Status-gate lease_change_set_items INSERT / UPDATE / DELETE.
-- The parent's status must be 'draft' for any authenticated mutation.
-- Service_role (edge function path) bypasses RLS and continues to work.
-- SELECT stays open to workspace members — read-only is harmless and the
-- approver needs to read items on pending_approval sets to review them.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "workspace members can insert change set items" ON public.lease_change_set_items;
DROP POLICY IF EXISTS "workspace members can update change set items" ON public.lease_change_set_items;
DROP POLICY IF EXISTS "workspace members can delete change set items" ON public.lease_change_set_items;

CREATE POLICY "draft-only insert change set items"
  ON public.lease_change_set_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

CREATE POLICY "draft-only update change set items"
  ON public.lease_change_set_items FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  )
  WITH CHECK (
    -- Same predicate on NEW: prevents moving an item to a non-draft parent
    -- as part of an UPDATE (which would otherwise look like a clean edit
    -- but actually inject an item into a pending_approval set).
    EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

CREATE POLICY "draft-only delete change set items"
  ON public.lease_change_set_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.lease_change_sets cs
      WHERE cs.id = lease_change_set_items.change_set_id
        AND cs.status = 'draft'
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- H1-extended: Field-level immutability trigger.
-- RLS WITH CHECK closes the policy-bypass class (PostgREST PATCH to escalate
-- status) but cannot enforce that an UPDATE preserves submitted_by or
-- workspace_id values — RLS expressions evaluate NEW row, not OLD-vs-NEW
-- deltas. Two real attack vectors that WITH CHECK alone leaves open:
--
--   1. Submitter PATCHes submitted_by = colleague_user_id on their own
--      draft. WITH CHECK passes (NEW row is still draft, NEW.submitted_by
--      satisfies the workspace_member check for that colleague). Approver
--      later sees a set "submitted by" someone who didn't author it. Same
--      audit-attribution defeat as #16, different table.
--
--   2. Submitter PATCHes workspace_id = sibling_workspace_id on their own
--      draft, slipping it into another workspace's queue. WITH CHECK passes
--      if the submitter is a member of both workspaces.
--
-- BEFORE UPDATE trigger enforces both invariants at the data layer:
--   - workspace_id is fully immutable (cannot change post-INSERT)
--   - submitted_by is immutable once non-NULL (allows NULL -> user_id
--     transition during the initial submit flow; rejects user_A -> user_B
--     and user_id -> NULL)
--
-- Trigger applies to ALL roles, including service_role. Edge functions do
-- not legitimately mutate either field today (verified by grep), so this
-- has zero impact on the happy path. If a future migration needs to
-- relocate a change set across workspaces or reassign authorship, it
-- writes a dedicated migration (auditable, reviewable) instead of doing
-- it via the edge function — which is the desired posture.
-- ----------------------------------------------------------------------------
-- prevent_change_set_field_tampering — comprehensive column coverage.
--
-- COLUMN POLICY (exhaustive over all 15 columns of lease_change_sets):
--
-- Universal-immutable (5 columns — no role bypass): id, lease_id,
--   workspace_id, submitted_by, created_at. These define row identity,
--   tenant boundary, authorship, and forensic provenance. Mutating any
--   of them — even from service_role — requires a dedicated auditable
--   migration, never an ad-hoc UPDATE from any code path.
--
-- Service-role-only mutable (9 columns — edge function carve-out):
--   status, unlock_request_id, submitted_at, reviewed_by, reviewed_at,
--   review_note, self_approved, requested_approver_id, change_summary.
--   These are governance-attack-surface columns: either capture governance
--   state and approval routing (the first 8), OR are read by downstream
--   consumers — display in ApprovalQueue.tsx/LeaseReview.tsx for
--   approver decision-making, content of `lease_governance_audit` rows —
--   and therefore part of the same tamper-resistance posture even though
--   not semantically a state field.
--
--   change_summary specifically: has no current authenticated writer
--   (verified by grep of src/ and supabase/functions/), so moving it
--   here is zero functional regression. Round 4 review surfaced that
--   leaving it authenticated-mutable mis-categorized it: the rule is
--   "approver can PATCH on pending_approval = governance attack surface"
--   and change_summary is approver-visible. Adding it to the carve-out
--   keeps the rule consistent and closes the approver-tampering vector.
--
-- Authenticated-mutable (1 column — deliberately uncovered):
--
--   updated_at: managed by the separate `lease_change_sets_updated_at`
--   BEFORE UPDATE trigger (function `set_updated_at`) which rewrites
--   NEW.updated_at = now() on every UPDATE regardless of role. The
--   resilient reason to leave updated_at out of any check here is that
--   set_updated_at is the authoritative writer of this column for every
--   UPDATE under every role. Adding a tampering check on updated_at
--   would couple this trigger to alphabetical trigger naming
--   (`lease_change_sets_updated_at` < `prevent_change_set_field_tampering`
--   means set_updated_at fires first, but that's incidental). Keep the
--   disjoint-columns pattern: set_updated_at owns updated_at, this
--   trigger owns the other 14.
--
--   INVARIANT: set_updated_at is the sole BEFORE UPDATE writer of
--   updated_at on this table. If a future migration adds another
--   BEFORE UPDATE trigger that writes updated_at (e.g., a Realtime
--   trigger or audit-timestamp trigger), this exclusion needs to be
--   revisited — otherwise opacity about which trigger owns the value
--   becomes a forensic blind spot. Cross-check: query pg_trigger
--   filtered to lease_change_sets BEFORE UPDATE before adding any
--   new trigger here.
CREATE OR REPLACE FUNCTION public.prevent_change_set_field_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- ==== Universal-immutable: id, lease_id, workspace_id, submitted_by,
  -- created_at (no role bypass, including service_role and direct DB) ====
  IF OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'lease_change_sets.id is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.lease_id IS DISTINCT FROM NEW.lease_id THEN
    RAISE EXCEPTION 'lease_change_sets.lease_id is immutable (attempted change from % to %)',
      OLD.lease_id, NEW.lease_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'lease_change_sets.workspace_id is immutable (attempted change from % to %)',
      OLD.workspace_id, NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- submitted_by is NOT NULL per schema. The IS NOT NULL guard is
  -- defensive-only — would also apply if the column were ever made
  -- nullable in a future migration.
  IF OLD.submitted_by IS NOT NULL AND OLD.submitted_by IS DISTINCT FROM NEW.submitted_by THEN
    RAISE EXCEPTION 'lease_change_sets.submitted_by is immutable once set (attempted change from % to %)',
      OLD.submitted_by, NEW.submitted_by
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'lease_change_sets.created_at is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ==== Service-role-only mutability: status, unlock_request_id,
  -- submitted_at, reviewed_by, reviewed_at, review_note, self_approved,
  -- requested_approver_id ====
  --
  -- The COALESCE(auth.role(), '') = 'service_role' predicate matches
  -- the canonical pattern used by prevent_locked_lease_edits. auth.role()
  -- returns 'service_role' for SUPABASE_SERVICE_ROLE_KEY calls,
  -- 'authenticated' for browser JWTs, NULL for direct DB connections.
  -- COALESCE-to-empty means the check enforces for everything EXCEPT
  -- explicit service_role — including direct DB writes from migrations,
  -- which is the right posture (any legitimate ad-hoc relocation of
  -- governance state writes its own auditable migration).
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'lease_change_sets.status is only mutable by the governance edge function (attempted % -> %)',
        OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.unlock_request_id IS DISTINCT FROM NEW.unlock_request_id THEN
      RAISE EXCEPTION 'lease_change_sets.unlock_request_id is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.submitted_at IS DISTINCT FROM NEW.submitted_at THEN
      RAISE EXCEPTION 'lease_change_sets.submitted_at is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by THEN
      RAISE EXCEPTION 'lease_change_sets.reviewed_by is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at THEN
      RAISE EXCEPTION 'lease_change_sets.reviewed_at is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.review_note IS DISTINCT FROM NEW.review_note THEN
      RAISE EXCEPTION 'lease_change_sets.review_note is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.self_approved IS DISTINCT FROM NEW.self_approved THEN
      RAISE EXCEPTION 'lease_change_sets.self_approved is only mutable by the governance edge function (attempted % -> %)',
        OLD.self_approved, NEW.self_approved
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.requested_approver_id IS DISTINCT FROM NEW.requested_approver_id THEN
      RAISE EXCEPTION 'lease_change_sets.requested_approver_id is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;

    -- change_summary: not a governance-state field per se, but read by
    -- approver-facing UI (ApprovalQueue.tsx, LeaseReview.tsx) and is the
    -- submitter's narrative of what they're proposing. An approver
    -- PATCH'ing this on a pending_approval set could misrepresent the
    -- submitter's intent at decision time. No current authenticated
    -- writer exists, so this guard creates zero regression.
    IF OLD.change_summary IS DISTINCT FROM NEW.change_summary THEN
      RAISE EXCEPTION 'lease_change_sets.change_summary is only mutable by the governance edge function'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_change_set_field_tampering() OWNER TO postgres;

DROP TRIGGER IF EXISTS prevent_change_set_field_tampering ON public.lease_change_sets;

CREATE TRIGGER prevent_change_set_field_tampering
  BEFORE UPDATE ON public.lease_change_sets
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_change_set_field_tampering();

-- ----------------------------------------------------------------------------
-- C1 + H4: Restore audit_rls_smoke_check() as a SUPERSET of the original 15
-- assertion keys, add 2 new absence-checks from the prior migration, and
-- add 2 new content-based assertions that catch the name-bypass class.
--
-- All 15 original key names are preserved verbatim so any external
-- consumer (operator dashboards, future cron health-check) keyed to the
-- old names continues to work.
--
-- The two `*_only_*` content-based keys count policies by (table, cmd)
-- and assert that no policy other than the expected hardened one exists.
-- This closes the H4 gap: a future Studio edit creating a new permissive
-- policy with a different name would trip the count assertion even if the
-- name-based assertions stayed true.
-- ----------------------------------------------------------------------------
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
    'governance_unlock_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_unlock_requests'
        AND policyname = 'workspace access can view unlock requests'
    ),
    'governance_change_set_policy', EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND policyname = 'workspace access can view change sets'
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
    -- These trip on ANY policy other than the expected hardened one on
    -- the affected (table, cmd) pair, defeating name-rename bypass.
    --
    -- cmd IN (...,'ALL') closes the FOR ALL blind spot: a CREATE POLICY
    -- ... FOR ALL stores cmd='ALL', not the specific operation. Without
    -- this, a future Studio edit creating a FOR ALL policy with any
    -- name would satisfy UPDATE/INSERT semantics but evade the cmd
    -- equality filter, and the assertion would silently return true.
    --
    -- Deliberately narrow to INSERT and UPDATE on these two tables —
    -- not DELETE or SELECT. The named scope of this beat is closing
    -- #16 (audit INSERT tampering) and #17 (change set UPDATE
    -- tampering). DELETE on lease_change_sets goes through a separate
    -- policy chain (lease_change_sets_delete) and SELECT is read-only.
    -- Extending content-based checks to DELETE/SELECT is a separate
    -- defense-in-depth beat — filed in KNOWN_ISSUES if/when needed.
    'governance_audit_only_one_insert_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_governance_audit'
        AND cmd IN ('INSERT', 'ALL')
        AND policyname != 'governance audit is service role append only'
    ),
    'change_set_only_one_update_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_sets'
        AND cmd IN ('UPDATE', 'ALL')
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
    -- Same FOR ALL / name-rename bypass concern as the parent table.
    -- Trip on ANY policy other than the expected hardened one on the
    -- (table, cmd) pair. cmd IN (..., 'ALL') closes the FOR ALL blind
    -- spot. Three keys mirror the three policies (INSERT, UPDATE, DELETE).
    'change_set_items_only_one_insert_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('INSERT', 'ALL')
        AND policyname != 'draft-only insert change set items'
    ),
    'change_set_items_only_one_update_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('UPDATE', 'ALL')
        AND policyname != 'draft-only update change set items'
    ),
    'change_set_items_only_one_delete_policy', NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_change_set_items'
        AND cmd IN ('DELETE', 'ALL')
        AND policyname != 'draft-only delete change set items'
    ),
    -- ===== H1-extended: field-level immutability trigger =====
    -- Content-based check: not just trigger row exists, but function body
    -- contains three behaviorally distinct anchor phrases. Each anchor
    -- proves a different invariant survives any silent CREATE OR REPLACE:
    --   - 'workspace_id is immutable'      → universal-immutability section present
    --   - 'submitted_by is immutable'      → attribution-immutability survives
    --   - 'auth.role()'                    → service-role carve-out exists at all
    -- Three distinct properties rather than five close paraphrases — a
    -- stylistic refactor of error messages would have to break all three
    -- separately, which is unlikely without intent.
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

-- ----------------------------------------------------------------------------
-- C1 part 2: restore GRANT EXECUTE TO service_role (was present on both
-- archived versions, dropped by the prior migration). Required for future
-- cron-based invocation paths that run under service_role credentials.
-- TO authenticated grant is preserved per the archived pattern; tightening
-- to service_role-only is a separate decision (M2 from security review,
-- not in this beat's scope).
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO service_role;

-- COMMENT ON FUNCTION encodes the three-category triage rule in the
-- DB catalog so an operator running `\df+ audit_rls_smoke_check` or
-- inspecting Studio gets the protocol without having to open this
-- migration file. Survives function-replace if the next CREATE OR
-- REPLACE FUNCTION doesn't carry its own COMMENT.
COMMENT ON FUNCTION public.audit_rls_smoke_check() IS
  'Returns jsonb of policy/trigger/function existence checks for governance hardening. Triage categories: A=drift candidates (false = file new KNOWN_ISSUES, address in a separate beat); B=name-based prior-migration assertions (false = stop and investigate, prior migration likely diverged from live state); C=this-migration''s hardening (false = active vulnerability survived or migration apply failed). See migration 20260517000000_governance_hardening_followup.sql header for the full key->category mapping.';
