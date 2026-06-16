-- ============================================================================
-- Phase 10 — Firm UX Layer (foundation migration)
-- ============================================================================
-- Builds the schema the customer-facing firm UX rides on:
--   1. profiles.current_firm_id        — persists firm-context selection
--   2. firm_invitations                — email-invite firm members (mirrors invite_tokens)
--   3. firm_workspace_join_requests     — two-party bring-a-workspace-into-a-firm flow
--   4. firm_activity_log activity_type CHECK — self-describing audit (decision #1)
--   5. v_firm_user_pending_actions      — cross-workspace inbox aggregate
--
-- SECURITY MIGRATION — route reviewers BEFORE apply (RLS + the inbox view's
-- cross-tenant surface). Idempotent (IF NOT EXISTS / OR REPLACE / DROP-then-CREATE).
--
-- DEVIATIONS FROM PHASE_10_BUILD_SPEC (input, not specification — corrected here):
--   * [D1] The inbox view is a PLAIN (owner-privileged) view, NOT
--     security_invoker. The spec assumed security_invoker + an app-side
--     auth.uid() filter, but lease_approval_chain and lease_unlock_requests
--     SELECT policies gate on DIRECT workspace_members (not the firm-aware
--     is_workspace_member), so a security_invoker view returns an EMPTY inbox
--     for exactly the firm-derived members it serves. Broadly opening those two
--     tables' RLS would over-expose ALL child chains to every firm member; the
--     inbox only needs a user's OWN routed actions. So the view bypasses RLS by
--     owner privilege and does its own airtight, least-privilege scoping in the
--     WHERE clause (effective firm membership incl. owner = auth.uid(),
--     restrict_firm_access=false, per-branch action routing). This is the
--     inverse of the Phase 9 view fix and is the safer choice HERE.
--   * [D2] firm_invitations enforces owner-only-mints-admins (Phase 9 HIGH-3
--     parity): an admin can only create/manage role='firm_member' invitations;
--     only the firm owner mints role='firm_admin'. The spec's flat
--     "admins manage invitations FOR ALL" would let an admin invite a
--     firm_admin and bypass the rule when accept-firm-invitation service-role-
--     inserts the membership.
--   * [D3] firm_workspace_join_requests has NO client UPDATE/DELETE policy.
--     State transitions (approve/reject/cancel) are service-role-only via the
--     act-on/cancel edge functions (CP3) — mirrors how workspace invites
--     transition via accept-invite. A client UPDATE policy would let an
--     initiator self-approve their own join request (set status='approved').
--   * [D4] one-pending-per-pair is a PARTIAL UNIQUE INDEX WHERE status='pending'
--     (not the spec's UNIQUE(firm_id,workspace_id,status), which would block a
--     second 'rejected' row and break legitimate request history).
-- ============================================================================

-- ============================================================================
-- 1. profiles.current_firm_id — persists firm-context selection (mirrors
--    current_workspace_id). ON DELETE SET NULL so deleting a firm doesn't
--    orphan the profile.
-- ============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS current_firm_id uuid REFERENCES public.firms(id) ON DELETE SET NULL;

-- ============================================================================
-- 2. firm_invitations — email invites for firm membership. Mirrors the
--    workspace invite_tokens lifecycle (sent → accepted | revoked). Acceptance
--    is service-role-only (accept-firm-invitation edge fn, CP3) — the invitee
--    is not yet a firm member, so they cannot reach the row via RLS.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.firm_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL CHECK (role IN ('firm_admin', 'firm_member')),
  invited_by    uuid NOT NULL REFERENCES auth.users(id),
  invited_at    timestamptz NOT NULL DEFAULT now(),
  token         text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES auth.users(id),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES auth.users(id),
  CONSTRAINT firm_invitation_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT firm_invitation_one_state CHECK (
    (accepted_at IS NULL AND revoked_at IS NULL) OR
    (accepted_at IS NOT NULL AND revoked_at IS NULL) OR
    (accepted_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_firm_invitations_firm
  ON public.firm_invitations(firm_id, invited_at DESC);

CREATE INDEX IF NOT EXISTS idx_firm_invitations_email_pending
  ON public.firm_invitations(LOWER(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_firm_invitations_token
  ON public.firm_invitations(token)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ============================================================================
-- 3. firm_workspace_join_requests — two-party flow to bind an existing
--    workspace into a firm. request_direction names who initiates and who
--    approves:
--      firm_to_workspace — firm admin initiates; workspace owner/admin approves
--      workspace_to_firm — workspace owner/admin initiates; firm admin approves
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.firm_workspace_join_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by      uuid NOT NULL REFERENCES auth.users(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  request_direction text NOT NULL CHECK (request_direction IN ('firm_to_workspace', 'workspace_to_firm')),
  message           text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  acted_at          timestamptz,
  acted_by          uuid REFERENCES auth.users(id),
  decision_note     text,
  expires_at        timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

-- [D4] One PENDING request per (firm, workspace) pair; history of
-- rejected/cancelled/expired rows is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_firm_workspace_join_one_pending
  ON public.firm_workspace_join_requests(firm_id, workspace_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_firm_workspace_join_requests_firm
  ON public.firm_workspace_join_requests(firm_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_firm_workspace_join_requests_workspace
  ON public.firm_workspace_join_requests(workspace_id, requested_at DESC);

-- Covering index for the inbox view's correlated workspace_roles EXISTS (the
-- role-holder routing path, evaluated per pending chain row). Without it, the
-- view degrades to a per-row rescan at scale (load-test hot spot, RF-5).
CREATE INDEX IF NOT EXISTS idx_workspace_roles_workspace_user_role
  ON public.workspace_roles(workspace_id, user_id, role);

-- ============================================================================
-- 4. firm_activity_log.activity_type CHECK (decision #1).
--    Phase 9 left firm_activity_log as open text. Add a CHECK so the audit
--    table is self-describing. MUST include every value any deployed writer
--    currently emits (create-firm/add-firm-member/bind/release/stripe-webhook),
--    plus the Phase 10 invitation/join-request/settings values, plus
--    firm_deleted (CP3 delete-firm). Append-only by nature; dropping a value
--    would break a live writer.
-- ============================================================================
ALTER TABLE public.firm_activity_log
  DROP CONSTRAINT IF EXISTS firm_activity_log_activity_type_check;

ALTER TABLE public.firm_activity_log
  ADD CONSTRAINT firm_activity_log_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    -- Phase 9 firm events (some already written to this table by deployed fns)
    'firm_created','firm_member_added','firm_member_removed','firm_member_role_changed',
    'workspace_joined_firm','workspace_left_firm','workspace_firm_access_restricted',
    'workspace_firm_access_unrestricted','firm_billing_subscription_started',
    'firm_billing_subscription_updated','firm_billing_subscription_canceled',
    -- Phase 10 additions
    'firm_invitation_sent','firm_invitation_accepted','firm_invitation_revoked',
    'firm_invitation_resent','firm_join_request_created','firm_join_request_approved',
    'firm_join_request_rejected','firm_join_request_cancelled','firm_join_request_expired',
    'firm_settings_updated','firm_billing_summary_mode_changed','firm_deleted'
  ]));

-- ============================================================================
-- 5. RLS — firm_invitations, firm_workspace_join_requests
-- ============================================================================
ALTER TABLE public.firm_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_workspace_join_requests ENABLE ROW LEVEL SECURITY;

-- --- firm_invitations -------------------------------------------------------
-- Read: any firm member can see their firm's invitations (the members page).
DROP POLICY IF EXISTS "firm members read invitations" ON public.firm_invitations;
CREATE POLICY "firm members read invitations"
  ON public.firm_invitations FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));

-- [D2] Manage: admins manage firm_member invitations only; owner mints all.
-- Mirrors the Phase 9 firm_members split (owner-only-mints-admins) so the
-- invitation path can't bypass it.
-- WITH CHECK also pins invited_by = auth.uid() so a privileged caller cannot
-- forge the audit attribution of who sent the invite (mirrors requested_by on
-- join requests).
DROP POLICY IF EXISTS "firm admins manage member invitations" ON public.firm_invitations;
CREATE POLICY "firm admins manage member invitations"
  ON public.firm_invitations FOR ALL
  USING (public.is_firm_admin(firm_id, auth.uid()) AND role = 'firm_member')
  WITH CHECK (public.is_firm_admin(firm_id, auth.uid()) AND role = 'firm_member' AND invited_by = auth.uid());

DROP POLICY IF EXISTS "firm owner manages all invitations" ON public.firm_invitations;
CREATE POLICY "firm owner manages all invitations"
  ON public.firm_invitations FOR ALL
  USING (EXISTS (SELECT 1 FROM public.firms f WHERE f.id = firm_id AND f.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.firms f WHERE f.id = firm_id AND f.owner_id = auth.uid()) AND invited_by = auth.uid());

-- --- firm_workspace_join_requests -------------------------------------------
-- Read: firm members (the firm side) + the workspace owner/admins (the
-- workspace side) can see requests touching their firm/workspace.
DROP POLICY IF EXISTS "firm and workspace parties read join requests" ON public.firm_workspace_join_requests;
CREATE POLICY "firm and workspace parties read join requests"
  ON public.firm_workspace_join_requests FOR SELECT
  USING (
    public.is_firm_member(firm_id, auth.uid())
    OR public.is_workspace_owner(workspace_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = firm_workspace_join_requests.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role = 'admin'
    )
  );

-- Create: the initiating side per direction. requested_by must be the caller.
DROP POLICY IF EXISTS "authorized parties create join requests" ON public.firm_workspace_join_requests;
CREATE POLICY "authorized parties create join requests"
  ON public.firm_workspace_join_requests FOR INSERT
  WITH CHECK (
    requested_by = auth.uid()
    AND status = 'pending'
    AND (
      (request_direction = 'firm_to_workspace' AND public.is_firm_admin(firm_id, auth.uid()))
      OR (request_direction = 'workspace_to_firm' AND (
        public.is_workspace_owner(workspace_id, auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.workspace_members wm
          WHERE wm.workspace_id = firm_workspace_join_requests.workspace_id
            AND wm.user_id = auth.uid()
            AND wm.role = 'admin'
        )
      ))
    )
  );

-- [D3] No client UPDATE/DELETE policy: approve/reject/cancel are service-role-
-- only via the act-on / cancel edge functions (CP3). Prevents an initiator from
-- self-approving (the spec's client UPDATE policy with requested_by=auth.uid()
-- and no WITH CHECK would have allowed status→'approved' by the initiator).
-- CP3 INVARIANTS (enforced in the edge functions, not the schema):
--   * Every transition out of 'pending' MUST set acted_by + acted_at (the
--     two-party approval record's attribution); the expiry sweep attributes to
--     the system and writes a 'firm_join_request_expired' audit row.
--   * accept-firm-invitation MUST generate a CSPRNG token (>=32 bytes base64url)
--     — the schema's UNIQUE-only token has no entropy floor.

-- ============================================================================
-- 6. v_firm_user_pending_actions — cross-workspace inbox aggregate.
--    PLAIN (owner-privileged) view — see [D1]. Scoping is enforced ENTIRELY by
--    this WHERE, with NO RLS backstop, so it must stay airtight:
--      * effective firm membership (firm_members UNION firm owners) = auth.uid()
--        → a caller only ever sees rows for firms they belong to / own
--      * w.restrict_firm_access = false → restricted children are excluded
--      * chain branch: only the caller's OWN routed actions (direct approver,
--        effective assignee, or matching functional role)
--      * unlock branch: firm_admins/owners only (effective role)
--    The auth.uid() filter is baked IN (not left to the consuming query) so a
--    forgotten app-side filter can never leak another member's actions.
-- ============================================================================
CREATE OR REPLACE VIEW public.v_firm_user_pending_actions AS
WITH effective_membership AS (
  -- Firm members by row, plus firm owners (implicitly firm_admin, no row needed
  -- — matches is_firm_admin semantics). Collapsed to ONE strongest-role row per
  -- (firm, user) so an owner who also holds a firm_members row can't produce
  -- duplicate inbox actions.
  SELECT
    firm_id,
    user_id,
    CASE WHEN bool_or(is_admin) THEN 'firm_admin' ELSE 'firm_member' END AS role
  FROM (
    SELECT firm_id, user_id, (role = 'firm_admin') AS is_admin FROM public.firm_members
    UNION ALL
    SELECT id AS firm_id, owner_id AS user_id, true AS is_admin FROM public.firms
  ) m
  GROUP BY firm_id, user_id
)
SELECT
  fm.user_id,
  w.firm_id,
  w.id AS workspace_id,
  w.name AS workspace_name,
  COALESCE(w.firm_child_label, w.name) AS display_label,
  'chain_step'::text AS action_type,
  lac.id AS action_id,
  lac.lease_id,
  COALESCE(l.request_title, l.filename, 'Unnamed lease') AS lease_title,
  lac.stage,
  lac.step_order,
  lac.parallel_group,
  lac.pending_since,
  lac.created_at AS action_created_at,
  -- These three conditions MUST stay in lockstep with the chain branch's WHERE
  -- (a row only surfaces if one of them holds), so there is no ELSE fall-through
  -- — a NULL here would signal the WHERE/CASE drifted out of sync.
  CASE
    WHEN lac.approver_user_id = fm.user_id THEN 'direct_approver'
    WHEN lac.effective_assignee_user_id = fm.user_id THEN 'effective_assignee'
    WHEN lac.approver_role IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.workspace_roles wr
      WHERE wr.workspace_id = w.id
        AND wr.user_id = fm.user_id
        AND wr.role = lac.approver_role
    ) THEN 'role_holder'
    ELSE NULL
  END AS routing_source
FROM effective_membership fm
JOIN public.workspaces w
  ON w.firm_id = fm.firm_id AND w.restrict_firm_access = false
JOIN public.lease_approval_chain lac
  ON lac.workspace_id = w.id AND lac.status = 'pending'
JOIN public.leases l ON l.id = lac.lease_id
WHERE fm.user_id = auth.uid()
  AND (
    lac.approver_user_id = fm.user_id
    OR lac.effective_assignee_user_id = fm.user_id
    OR EXISTS (
      SELECT 1 FROM public.workspace_roles wr
      WHERE wr.workspace_id = w.id
        AND wr.user_id = fm.user_id
        AND wr.role = lac.approver_role
    )
  )

UNION ALL

-- Pending unlock requests — surfaced to firm admins/owners only.
SELECT
  fm.user_id,
  w.firm_id,
  w.id AS workspace_id,
  w.name AS workspace_name,
  COALESCE(w.firm_child_label, w.name) AS display_label,
  'unlock_request'::text AS action_type,
  lur.id AS action_id,
  lur.lease_id,
  COALESCE(l.request_title, l.filename, 'Unnamed lease') AS lease_title,
  NULL::text AS stage,
  NULL::integer AS step_order,
  NULL::integer AS parallel_group,
  lur.created_at AS pending_since,
  lur.created_at AS action_created_at,
  'firm_admin'::text AS routing_source
FROM effective_membership fm
JOIN public.workspaces w
  ON w.firm_id = fm.firm_id AND w.restrict_firm_access = false
JOIN public.lease_unlock_requests lur
  ON lur.workspace_id = w.id AND lur.status = 'pending'
JOIN public.leases l ON l.id = lur.lease_id
WHERE fm.user_id = auth.uid()
  AND fm.role = 'firm_admin';

COMMENT ON VIEW public.v_firm_user_pending_actions IS
  'Phase 10 cross-workspace firm inbox. PLAIN owner-privileged view (NOT security_invoker): the underlying lease_approval_chain / lease_unlock_requests SELECT policies gate on direct workspace_members, so an invoker view returns an empty inbox for firm-derived members. Scoping is enforced airtight in the WHERE (effective firm membership incl. owner = auth.uid(), restrict_firm_access=false, own routed chain actions, firm_admin-only unlock requests). The auth.uid() filter is baked in — do not rely on the consuming query to add it.';
