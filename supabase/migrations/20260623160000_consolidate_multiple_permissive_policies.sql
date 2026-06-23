-- Cluster D (performance) — consolidate multiple_permissive_policies (2026-06-23).
--
-- Source: Supabase performance advisor lint 0006 (multiple_permissive_policies).
-- When >1 PERMISSIVE policy applies to the same (role, command) on a table,
-- Postgres evaluates EACH per query. The fix is to collapse the overlapping
-- permissive policies for a command into ONE policy whose predicate is the
-- OR-union of the originals.
--
-- WHY THIS IS SEMANTICS-PRESERVING (the load-bearing argument):
-- Postgres combines permissive policies for a command by OR-ing their USING
-- (row visibility) and OR-ing their WITH CHECK (new-row constraint). So the set
-- of rows a user may read/write under {policy A OR policy B} separately is, BY
-- DEFINITION, identical to the set under a single policy `USING (A.using OR
-- B.using) WITH CHECK (A.check OR B.check)`. This migration only rewrites WHICH
-- policy objects carry those predicates — never the effective predicate. It
-- cannot widen or narrow any tenant/role boundary.
--
-- Per-command derivation rule used below:
--   * A cmd='ALL' policy contributes to all four commands. For INSERT its check
--     is its WITH CHECK if present, else its USING (Postgres uses USING as the
--     check when WITH CHECK is omitted).
--   * SELECT/DELETE policies contribute USING only; INSERT contributes WITH
--     CHECK only; UPDATE contributes both.
--   * RESTRICTIVE policies (the "live workspace required for ..." Vault/grace
--     write-gates) are AND-combined, NOT part of this lint, and are left
--     entirely untouched — they remain per-command and still AND with the new
--     consolidated permissive policy exactly as before.
--
-- auth.uid() is written wrapped as (select auth.uid()) throughout, consistent
-- with 20260623140000 (already applied) — these CREATE statements would
-- otherwise reintroduce the auth_rls_initplan lint.
--
-- DROP + CREATE runs in the migration runner's single transaction; DDL takes a
-- table lock, so concurrent statements block until commit and never observe a
-- window with the old policy dropped and the new one not yet created.
--
-- KNOWN-ISSUE NOTE (profiles UPDATE = KNOWN_ISSUES #106): profiles_update_self's
-- current_workspace_id WITH CHECK guard is ALREADY dead today — profiles_update_own
-- is a permissive UPDATE policy whose (absent) WITH CHECK defaults to its USING
-- (id = auth.uid()), and the OR-union of the two checks reduces to (id =
-- auth.uid()). This migration PRESERVES that current effective behavior (it does
-- not silently re-enable the guard); enforcing the guard is a separate
-- authorization decision tracked in #106.

-- ──────────────────────────────────────────────────────────────────────────
-- alert_rules: ALL(manage: admin|owner) + SELECT(select: member). Split ALL into
-- per-command writes; merge reads (member OR admin|owner).
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "alert_rules_manage" ON public.alert_rules;
DROP POLICY IF EXISTS "alert_rules_select" ON public.alert_rules;

CREATE POLICY "alert_rules_select" ON public.alert_rules FOR SELECT
  USING (
    (workspace_id IN (SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid())))
    OR (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (select auth.uid()) AND wm.role = 'admin'::workspace_role))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
  );
CREATE POLICY "alert_rules_insert" ON public.alert_rules FOR INSERT
  WITH CHECK (
    (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (select auth.uid()) AND wm.role = 'admin'::workspace_role))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
  );
CREATE POLICY "alert_rules_update" ON public.alert_rules FOR UPDATE
  USING (
    (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (select auth.uid()) AND wm.role = 'admin'::workspace_role))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
  )
  WITH CHECK (
    (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (select auth.uid()) AND wm.role = 'admin'::workspace_role))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
  );
CREATE POLICY "alert_rules_delete" ON public.alert_rules FOR DELETE
  USING (
    (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (select auth.uid()) AND wm.role = 'admin'::workspace_role))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- approval_chain_steps: ALL(admins write) + SELECT(members read). Split + merge.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admins write steps via policy" ON public.approval_chain_steps;
DROP POLICY IF EXISTS "members read steps via policy" ON public.approval_chain_steps;

CREATE POLICY "members read steps via policy" ON public.approval_chain_steps FOR SELECT
  USING (
    (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid())
        UNION SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid()))))
    OR (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role)))
  );
CREATE POLICY "admins write steps insert" ON public.approval_chain_steps FOR INSERT
  WITH CHECK (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role)));
CREATE POLICY "admins write steps update" ON public.approval_chain_steps FOR UPDATE
  USING (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role)))
  WITH CHECK (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role)));
CREATE POLICY "admins write steps delete" ON public.approval_chain_steps FOR DELETE
  USING (policy_id IN (SELECT approval_policies.id FROM approval_policies WHERE approval_policies.workspace_id IN (
        SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role)));

-- ──────────────────────────────────────────────────────────────────────────
-- approval_policies: ALL(admins write) + SELECT(members read). Split + merge.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "workspace admins write policies" ON public.approval_policies;
DROP POLICY IF EXISTS "workspace members read policies" ON public.approval_policies;

CREATE POLICY "workspace members read policies" ON public.approval_policies FOR SELECT
  USING (
    (workspace_id IN (SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid())
        UNION SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())))
    OR (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role))
  );
CREATE POLICY "workspace admins write policies insert" ON public.approval_policies FOR INSERT
  WITH CHECK (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role));
CREATE POLICY "workspace admins write policies update" ON public.approval_policies FOR UPDATE
  USING (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role))
  WITH CHECK (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role));
CREATE POLICY "workspace admins write policies delete" ON public.approval_policies FOR DELETE
  USING (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role));

-- ──────────────────────────────────────────────────────────────────────────
-- firm_invitations: ALL(admins) + ALL(owner) + SELECT(members read).
-- Merge per command: SELECT = member OR admin OR owner; writes = admin OR owner.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "firm admins manage member invitations" ON public.firm_invitations;
DROP POLICY IF EXISTS "firm owner manages all invitations" ON public.firm_invitations;
DROP POLICY IF EXISTS "firm members read invitations" ON public.firm_invitations;

CREATE POLICY "firm invitations read" ON public.firm_invitations FOR SELECT
  USING (
    is_firm_member(firm_id, (select auth.uid()))
    OR (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_invitations.firm_id AND f.owner_id = (select auth.uid())))
  );
CREATE POLICY "firm invitations insert" ON public.firm_invitations FOR INSERT
  WITH CHECK (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text AND invited_by = (select auth.uid()))
    OR ((EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_invitations.firm_id AND f.owner_id = (select auth.uid()))) AND invited_by = (select auth.uid()))
  );
CREATE POLICY "firm invitations update" ON public.firm_invitations FOR UPDATE
  USING (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_invitations.firm_id AND f.owner_id = (select auth.uid())))
  )
  WITH CHECK (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text AND invited_by = (select auth.uid()))
    OR ((EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_invitations.firm_id AND f.owner_id = (select auth.uid()))) AND invited_by = (select auth.uid()))
  );
CREATE POLICY "firm invitations delete" ON public.firm_invitations FOR DELETE
  USING (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_invitations.firm_id AND f.owner_id = (select auth.uid())))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- firm_members: ALL(admins) + ALL(owner) + SELECT(members read).
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "firm admins manage members" ON public.firm_members;
DROP POLICY IF EXISTS "firm owner manages all membership" ON public.firm_members;
DROP POLICY IF EXISTS "firm members read membership" ON public.firm_members;

CREATE POLICY "firm members read" ON public.firm_members FOR SELECT
  USING (
    is_firm_member(firm_id, (select auth.uid()))
    OR (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_members.firm_id AND f.owner_id = (select auth.uid())))
  );
CREATE POLICY "firm members insert" ON public.firm_members FOR INSERT
  WITH CHECK (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_members.firm_id AND f.owner_id = (select auth.uid())))
  );
CREATE POLICY "firm members update" ON public.firm_members FOR UPDATE
  USING (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_members.firm_id AND f.owner_id = (select auth.uid())))
  )
  WITH CHECK (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_members.firm_id AND f.owner_id = (select auth.uid())))
  );
CREATE POLICY "firm members delete" ON public.firm_members FOR DELETE
  USING (
    (is_firm_admin(firm_id, (select auth.uid())) AND role = 'firm_member'::text)
    OR (EXISTS (SELECT 1 FROM firms f WHERE f.id = firm_members.firm_id AND f.owner_id = (select auth.uid())))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- invite_tokens: two SELECT policies (owner-view + invitee-view). Merge SELECT
-- only; INSERT/DELETE policies are single per command and left untouched.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Owners can view workspace invites" ON public.invite_tokens;
DROP POLICY IF EXISTS "Users can view invites sent to them" ON public.invite_tokens;

CREATE POLICY "invite_tokens_select" ON public.invite_tokens FOR SELECT
  USING (
    is_workspace_owner(workspace_id, (select auth.uid()))
    OR (email = ((SELECT users.email FROM auth.users WHERE users.id = (select auth.uid()))::text))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- lease_approval_chain: two UPDATE policies (admin update + assignee acts).
-- Merge UPDATE only; SELECT policy is single and left untouched.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admins update chain in workspace" ON public.lease_approval_chain;
DROP POLICY IF EXISTS "assignee acts on own pending step" ON public.lease_approval_chain;

CREATE POLICY "lease_approval_chain_update" ON public.lease_approval_chain FOR UPDATE
  USING (
    (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role))
    OR ((status = 'pending'::text) AND ((approver_user_id = (select auth.uid()))
        OR ((approver_role IS NOT NULL) AND (EXISTS (SELECT 1 FROM workspace_roles wr WHERE wr.workspace_id = lease_approval_chain.workspace_id AND wr.user_id = (select auth.uid()) AND wr.role = lease_approval_chain.approver_role)))))
  )
  WITH CHECK (
    (workspace_id IN (SELECT workspaces.id FROM workspaces WHERE workspaces.owner_id = (select auth.uid())
        UNION SELECT workspace_members.workspace_id FROM workspace_members WHERE workspace_members.user_id = (select auth.uid()) AND workspace_members.role = 'admin'::workspace_role))
    OR ((action_by = (select auth.uid())) AND (status = ANY (ARRAY['approved'::text, 'rejected'::text, 'sent_back'::text])))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- profiles: two UPDATE policies (update_own + update_self). Merge UPDATE only;
-- delete/insert/select policies left untouched. See #106 note in header — the
-- OR-union of checks reduces to (id = auth.uid()), preserving current behavior.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;

CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  USING (id = (select auth.uid()))
  WITH CHECK (id = (select auth.uid()));

-- ──────────────────────────────────────────────────────────────────────────
-- workspace_approvers: ALL(owners manage) + SELECT(members view). Split + merge.
-- The ALL policy had no WITH CHECK → its INSERT/UPDATE check defaults to its
-- USING (is_workspace_owner); preserved explicitly below.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Workspace owners can manage approvers" ON public.workspace_approvers;
DROP POLICY IF EXISTS "Workspace members can view approvers" ON public.workspace_approvers;

CREATE POLICY "Workspace members can view approvers" ON public.workspace_approvers FOR SELECT
  USING (
    is_workspace_member(workspace_id, (select auth.uid()))
    OR is_workspace_owner(workspace_id, (select auth.uid()))
  );
CREATE POLICY "Workspace owners insert approvers" ON public.workspace_approvers FOR INSERT
  WITH CHECK (is_workspace_owner(workspace_id, (select auth.uid())));
CREATE POLICY "Workspace owners update approvers" ON public.workspace_approvers FOR UPDATE
  USING (is_workspace_owner(workspace_id, (select auth.uid())))
  WITH CHECK (is_workspace_owner(workspace_id, (select auth.uid())));
CREATE POLICY "Workspace owners delete approvers" ON public.workspace_approvers FOR DELETE
  USING (is_workspace_owner(workspace_id, (select auth.uid())));
