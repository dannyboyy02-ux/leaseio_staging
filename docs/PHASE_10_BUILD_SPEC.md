# Phase 10 Build Spec — Firm UX Layer

**Prerequisite reading:** All prior phase build specs (1 through 9), `APPROVAL_ROUTING_ARCHITECTURE.md`, `docs/PRODUCT_STRATEGY.md`, `docs/CLAUDE.md`, `docs/LEASEIO_TIER_OVERVIEW.md`
**Phase scope:** Build the customer-facing UX layer on top of Phase 9's firm foundation. Firm dashboard, cross-workspace inbox, firm member management, child workspace administration, self-serve firm creation, and the firm-billing visibility UI.
**Out of scope for Phase 10:** Firm-level reports rolling up across child workspaces (Phase 11+), white-label branding (Phase 11+), multi-firm membership for a single user (deferred indefinitely), per-firm policy templates (Phase 11+), audit reporting at the firm level (Phase 11+), automatic firm-tier upgrades from Pro tier (Phase 11+).

After Phase 9, the firm data layer exists but is invisible to customers. Firms can only be created via service-role API calls, and firm members can access child workspace data through existing surfaces but have no firm-aware UI to navigate by. Phase 10 closes that gap. After Phase 10, a CPA firm or parent company signs up, creates a firm, adds members, brings child workspaces into the firm, sees a firm dashboard with cross-workspace insights, manages firm-level billing, and operates the way the Business tier was designed to be operated.

This is the phase that makes Business tier sellable.

> **As-built — PHASE SUBSTANTIALLY COMPLETE (2026-06-16, branch `claude/phase10-firm-ux`, PR #51, CI green).** All checkpoints CP1–CP5 done, reviewed (security/integrity/polish — no unaddressed Critical/High). Backend deployed to staging; frontend built. A firm is **ops-created via `create-firm`** and fully operable through the UI (members, child workspaces + restrict_firm_access, cross-workspace inbox, billing visibility). **DEFERRED:** self-serve firm onboarding's Stripe checkout + create-workspace firm_id + billing_summary_mode invoice line-items (KNOWN_ISSUES #105 — undecided firm pricing model + operator Stripe setup, operator-gated like Vault); `delete-firm` (Phase 11 / #104 — firm_activity_log ON DELETE RESTRICT blocks hard-delete). Polish review confirmed no UI implies self-serve checkout where none exists. CP1 detail + deviations [D1]–[D4] below.

> **As-built — Checkpoint 1 (2026-06-15, applied to staging).** Migration `supabase/migrations/20260616120000_phase10_firm_ux.sql` (profiles.current_firm_id; firm_invitations; firm_workspace_join_requests; firm_activity_log activity_type CHECK; v_firm_user_pending_actions). Routed through security + integrity + test-author review BEFORE apply (no Critical/High; all Medium/Low folded in). **Deviations from this spec, corrected during build:**
> - **[D1] The inbox view is a PLAIN owner-privileged view, NOT security_invoker.** The spec assumed security_invoker + an app-side auth.uid() filter, but `lease_approval_chain` and `lease_unlock_requests` SELECT policies gate on DIRECT `workspace_members` (not the firm-aware `is_workspace_member`), so a security_invoker view returns an EMPTY inbox for the firm-derived members it serves. Broadly opening those two tables' RLS would over-expose all child chains to every firm member; the inbox only needs a user's OWN routed actions. The view therefore bypasses RLS by owner privilege and does airtight least-privilege scoping in its WHERE (effective firm membership incl. owner = auth.uid(), restrict_firm_access=false, per-branch routing). This trips the expected `security_definer_view` advisor lint — accepted by design and documented in the view's COMMENT. **Validated by a live leak matrix on staging:** cross-firm isolation, restrict_firm_access exclusion, owner-implicit-admin, member-not-admin, own-routed-only chain, and stranger-denial all hold.
> - **[D2] firm_invitations enforces owner-only-mints-admins** (Phase 9 parity): admins manage `role='firm_member'` invitations only; only the owner mints `firm_admin`. The spec's flat "admins manage invitations FOR ALL" would let an admin invite a firm_admin and bypass the rule at acceptance. WITH CHECK also pins `invited_by = auth.uid()` (attribution).
> - **[D3] firm_workspace_join_requests has NO client UPDATE/DELETE policy** — approve/reject/cancel are service-role-only via the CP3 edge functions (prevents initiator self-approval). CP3 must set acted_by/acted_at on every transition and emit a `firm_join_request_expired` audit row on expiry.
> - **[D4] one-pending-per-pair is a PARTIAL UNIQUE INDEX `WHERE status='pending'`** (not the spec's `UNIQUE(firm_id,workspace_id,status)`, which would block legitimate rejected/cancelled history).
> - **Decision (plain vs materialized inbox view): PLAIN.** Load test = 3.8ms for 1000 pending actions across 50 children, index-driven. Added covering index `idx_workspace_roles_workspace_user_role` for the role-holder routing path.
> - **firm_activity_log gained an activity_type CHECK** (it was open text in Phase 9) — covers all deployed-writer values + the Phase 10 additions + `firm_deleted`. Static guards: `src/lib/__tests__/firmUxMigration.test.ts` (31 cases).

---

## Goals of this phase

1. Self-serve firm creation flow for end users — a new prospective Business-tier customer can sign up, create their firm, configure billing, and start adding child workspaces without engineering intervention.
2. Firm dashboard at `/app/firm` that surfaces aggregate insights across all child workspaces — total active leases, recent activity, billing status, member roster.
3. Cross-workspace inbox at `/app/firm/inbox` that aggregates pending actions for the current firm member across every child workspace they have access to. Single screen for "what needs my attention today across all my clients/subsidiaries."
4. Firm member management surface at `/app/firm/members` — invite, remove, change role.
5. Child workspace administration at `/app/firm/workspaces` — add an existing workspace to the firm, create a new workspace within the firm, release a workspace, set per-workspace overrides.
6. Firm-level billing surface at `/app/firm/billing` showing the Stripe subscription, per-child usage breakdown, billing summary mode toggle, invoice history.
7. Firm settings at `/app/firm/settings` for firm metadata, terminology mode (CPA firm vs. parent company), and other firm-level configuration.
8. Workspace switcher in the sidebar groups workspaces by firm context, allowing firm members to navigate between firm view, individual child workspaces, and any non-firm workspaces they have direct access to.
9. Onboarding flow distinguishes "create individual workspace" from "create firm with child workspaces" so a new sign-up immediately understands tier choice.

---

## Architecture and routing

### New top-level routes

```
/app/firm                          → Firm dashboard
/app/firm/inbox                    → Cross-workspace pending actions
/app/firm/members                  → Firm member management
/app/firm/workspaces               → Child workspace administration
/app/firm/billing                  → Firm-level Stripe billing + per-child usage
/app/firm/settings                 → Firm metadata and configuration
/app/firm/onboarding               → Self-serve firm creation flow
```

### "Firm context" vs. "workspace context"

The application gains a new navigation mode. A user can be in:
- **Workspace context** — viewing a specific workspace's leases, approvals, settings (existing behavior unchanged)
- **Firm context** — viewing the firm dashboard, cross-workspace data, firm administration (new in Phase 10)

The sidebar adapts: when in firm context, the sidebar shows firm-level navigation (Dashboard, Inbox, Members, Workspaces, Billing, Settings). When in workspace context, the existing per-workspace navigation persists. A header element makes the current context clear and provides one-click switching.

A new `FirmContext` React provider mirrors the existing `AppContext`. It loads:
- The user's firm memberships
- The currently active firm (persisted in `profiles.current_firm_id` — new column)
- The set of child workspaces the user has access to via the active firm

Firm context is undefined for users with no firm memberships (Plus/Pro tier customers). The application gracefully hides firm-context UI for those users.

---

## Database migrations

Create one migration file: `<timestamp>_phase10_firm_ux.sql`.

### `profiles` extension

```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS current_firm_id uuid REFERENCES public.firms(id) ON DELETE SET NULL;
```

This persists the user's currently selected firm context across sessions, mirroring `current_workspace_id`.

### `firm_invitations` table

For the invite flow — firm admins email-invite users who may not yet have an account.

```sql
CREATE TABLE public.firm_invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  email               text NOT NULL,
  role                text NOT NULL CHECK (role IN ('firm_admin', 'firm_member')),
  invited_by          uuid NOT NULL REFERENCES auth.users(id),
  invited_at          timestamptz NOT NULL DEFAULT now(),
  token               text NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at         timestamptz,
  accepted_by         uuid REFERENCES auth.users(id),
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES auth.users(id),
  CONSTRAINT firm_invitation_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT firm_invitation_one_state CHECK (
    (accepted_at IS NULL AND revoked_at IS NULL) OR
    (accepted_at IS NOT NULL AND revoked_at IS NULL) OR
    (accepted_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_firm_invitations_firm
  ON public.firm_invitations(firm_id, invited_at DESC);

CREATE INDEX idx_firm_invitations_email_pending
  ON public.firm_invitations(LOWER(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX idx_firm_invitations_token
  ON public.firm_invitations(token)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

This mirrors the existing workspace invitation pattern (`accept-invite`, `get-invite-info`, `list-pending-invites`, `resend-invite`, `revoke-invite` edge functions in the codebase).

### `firm_workspace_join_requests` table

When a user wants to bring an existing workspace into a firm (where they're not the firm owner OR the workspace owner), they create a join request that the relevant party approves.

```sql
CREATE TABLE public.firm_workspace_join_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by          uuid NOT NULL REFERENCES auth.users(id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  request_direction     text NOT NULL CHECK (request_direction IN ('firm_to_workspace', 'workspace_to_firm')),
  message               text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  acted_at              timestamptz,
  acted_by              uuid REFERENCES auth.users(id),
  decision_note         text,
  expires_at            timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  CONSTRAINT firm_workspace_join_one_pending UNIQUE (firm_id, workspace_id, status) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_firm_workspace_join_requests_firm
  ON public.firm_workspace_join_requests(firm_id, requested_at DESC);

CREATE INDEX idx_firm_workspace_join_requests_workspace
  ON public.firm_workspace_join_requests(workspace_id, requested_at DESC);
```

The `request_direction` distinguishes:
- `firm_to_workspace` — firm admin wants to bring an existing workspace in; the workspace owner approves
- `workspace_to_firm` — a workspace owner wants to join a firm; the firm admin approves

### Activity log additions

```sql
ALTER TABLE public.firm_activity_log
  -- (or extend the existing activity_type check on lease_activity_log if firm_activity_log uses an open text column)
  -- ... add: firm_invitation_sent, firm_invitation_accepted, firm_invitation_revoked,
  --          firm_join_request_created, firm_join_request_approved, firm_join_request_rejected,
  --          firm_settings_updated, firm_billing_summary_mode_changed
  -- Mirror approach used in earlier phases.
```

### RLS

```sql
ALTER TABLE public.firm_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_workspace_join_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "firm members read invitations"
  ON public.firm_invitations FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));

CREATE POLICY "firm admins manage invitations"
  ON public.firm_invitations FOR ALL
  USING (public.is_firm_admin(firm_id, auth.uid()))
  WITH CHECK (public.is_firm_admin(firm_id, auth.uid()));

CREATE POLICY "firm members read join requests"
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

CREATE POLICY "authorized parties create join requests"
  ON public.firm_workspace_join_requests FOR INSERT
  WITH CHECK (
    requested_by = auth.uid()
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

CREATE POLICY "authorized parties act on join requests"
  ON public.firm_workspace_join_requests FOR UPDATE
  USING (
    -- The party that did NOT initiate must approve/reject
    (request_direction = 'firm_to_workspace' AND (
      public.is_workspace_owner(workspace_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = firm_workspace_join_requests.workspace_id
          AND wm.user_id = auth.uid()
          AND wm.role = 'admin'
      )
    ))
    OR (request_direction = 'workspace_to_firm' AND public.is_firm_admin(firm_id, auth.uid()))
    -- Initiator can cancel their own
    OR requested_by = auth.uid()
  );
```

### Cross-workspace inbox view

The most query-heavy surface in Phase 10. A view that aggregates pending actions across all child workspaces a firm member has access to:

```sql
CREATE OR REPLACE VIEW public.v_firm_user_pending_actions AS
SELECT
  fm.user_id,
  w.firm_id,
  w.id AS workspace_id,
  w.name AS workspace_name,
  COALESCE(w.firm_child_label, w.name) AS display_label,
  -- Pending chain step approvals
  'chain_step' AS action_type,
  lac.id AS action_id,
  lac.lease_id,
  l.request_title AS lease_title,
  lac.stage,
  lac.step_order,
  lac.parallel_group,
  lac.pending_since,
  lac.created_at AS action_created_at,
  -- Source: how this action came to this user
  CASE
    WHEN lac.approver_user_id = fm.user_id THEN 'direct_approver'
    WHEN lac.approver_role IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.workspace_roles wr
      WHERE wr.workspace_id = w.id
        AND wr.user_id = fm.user_id
        AND wr.role = lac.approver_role
    ) THEN 'role_holder'
    WHEN lac.effective_assignee_user_id = fm.user_id THEN 'effective_assignee'
    ELSE 'firm_member_view'
  END AS routing_source
FROM public.firm_members fm
JOIN public.workspaces w ON w.firm_id = fm.firm_id AND w.restrict_firm_access = false
JOIN public.lease_approval_chain lac ON lac.workspace_id = w.id
JOIN public.leases l ON l.id = lac.lease_id
WHERE lac.status = 'pending'
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

-- Pending unlock requests, change set reviews, signator reviews, etc.
-- Same shape, different sources. Build out in implementation.
SELECT
  fm.user_id,
  w.firm_id,
  w.id AS workspace_id,
  w.name AS workspace_name,
  COALESCE(w.firm_child_label, w.name) AS display_label,
  'unlock_request' AS action_type,
  lur.id AS action_id,
  lur.lease_id,
  l.request_title AS lease_title,
  NULL AS stage,
  NULL AS step_order,
  NULL AS parallel_group,
  lur.created_at AS pending_since,
  lur.created_at AS action_created_at,
  'admin' AS routing_source
FROM public.firm_members fm
JOIN public.workspaces w ON w.firm_id = fm.firm_id AND w.restrict_firm_access = false
JOIN public.lease_unlock_requests lur ON lur.workspace_id = w.id
JOIN public.leases l ON l.id = lur.lease_id
WHERE lur.status = 'pending'
  AND fm.role = 'firm_admin';
-- ... extend with other action types
```

The view filters by current user via `WHERE fm.user_id = auth.uid()` in queries that consume it. It's not parameterized; the application includes the auth.uid() filter.

For performance, consider materializing this view if scale demands it. For Phase 10 v1, a regular view is sufficient; observe query times during smoke testing.

---

## Code changes

### New file: `src/contexts/FirmContext.tsx`

The firm-aware app state provider. Mirrors `AppContext.tsx` but for firm context.

```typescript
type FirmContextValue = {
  firmMemberships: Array<{ firm_id: string; role: 'firm_admin' | 'firm_member' }>;
  currentFirm: Firm | null;
  currentFirmRole: 'firm_admin' | 'firm_member' | 'owner' | null;
  childWorkspaces: Workspace[];
  pendingActionsCount: number;
  switchFirm: (firmId: string | null) => Promise<void>;
  refreshFirm: () => Promise<void>;
};
```

The provider is mounted high in the React tree alongside `AppContext`. It loads firm memberships when the user authenticates, persists `current_firm_id` to `profiles`, and provides accessors for downstream components.

When a user has no firm memberships, all values are null/empty and Phase 10 UI components don't render. Plus and Pro tier customers see no change.

### New page: `src/pages/firm/FirmDashboard.tsx`

The landing page for firm context. Shows:
- Firm summary header (name, type, member count, child workspace count)
- Aggregate metrics across child workspaces — total active leases, total documents, leases in negotiation, leases pending counter-signature, recent reports generated
- Recent activity feed (cross-workspace, last 30 events)
- Child workspaces grid — each workspace as a card showing usage stats, link to enter that workspace's context
- Member roster summary — count of firm_admins, count of firm_members, link to full roster
- Billing snapshot — current plan status, current month's usage, link to billing detail

Performance budget: page must load in under 2 seconds for a firm with 50 child workspaces. Use the views (`v_firm_child_usage`, `v_firm_billing_period_summary`) introduced in Phase 9. Don't query individual workspace tables directly.

### New page: `src/pages/firm/FirmInbox.tsx`

The cross-workspace pending actions surface. Renders a unified inbox.

UI sections:
- Filter strip — by workspace, by action type, by urgency, by routing source
- Sort selector — by date, by urgency, by workspace
- List of pending actions with workspace label clearly visible on each row
- Click an action → opens a modal or navigates to the relevant workspace context with that action surfaced

Each row shows:
- Workspace label (firm_child_label or workspace_name)
- Lease title
- Action type ("Chain step approval - concept", "Unlock request", "Signator review")
- Time pending
- Urgency indicator (computed from pending_since duration)
- Action buttons inline where possible (Approve, Reject, Send Back) for chain steps

For actions that require deeper context (signator reviews, complex governance), the row links to the full workspace context for resolution rather than acting in-place.

### New page: `src/pages/firm/FirmMembers.tsx`

Member management. Mirrors `WorkspaceSettings.tsx` member tab structure:
- List of current firm members with role badges
- Pending invitations section
- "Invite Member" button → opens email + role modal
- Per-member actions (admin only): change role, remove

Reuses the existing invitation patterns from workspace invitations — the edge functions for firm invitations are new but the UI conventions are identical.

### New page: `src/pages/firm/FirmWorkspaces.tsx`

Child workspace administration:
- List of current child workspaces with usage summary, child label, restrict_firm_access status, member count
- "Add Workspace" action with two paths:
  - Create new workspace within firm — calls the existing workspace creation flow with firm_id pre-set
  - Bring existing workspace into firm — opens a search/selector for workspaces the user owns or admins, then creates a `firm_workspace_join_request` of type `firm_to_workspace`
- Per-workspace actions: edit child label, toggle restrict_firm_access (with prominent warning about implications), release workspace from firm
- Pending join requests section showing requests awaiting workspace-side approval

### New page: `src/pages/firm/FirmBilling.tsx`

The firm-level billing surface that customers actually look at to understand what they're paying.

Sections:
- Current subscription status (active, past due, canceled with grace, etc.)
- Current month's usage summary — aggregate metrics
- Per-child usage breakdown table — uses `v_firm_child_usage` to show, per child workspace: lease count, document storage, reports generated this month, member count
- Billing summary mode toggle (detailed vs. summarized, persists to `firms.billing_summary_mode`)
- Invoice history — past 12 months of invoices with download links (Stripe-hosted)
- "Update Payment Method" link to Stripe customer portal
- "Change Plan" / "Cancel Subscription" buttons (cancel triggers the existing 30-day grace flow)

The detailed-vs-summarized toggle is the most important interaction here. When toggled to summarized, the next invoice will show one line item; when detailed, line items per child. Show a preview: "Your next invoice will be issued on {date}. Current selection: {detailed | summarized}."

### New page: `src/pages/firm/FirmSettings.tsx`

Firm-level configuration:
- Firm name (admin only)
- Firm type (cpa_firm | parent_company | other) — drives terminology elsewhere in firm UI
- Billing email
- Default child workspace settings (default `restrict_firm_access` for new workspaces, etc.)
- Danger zone: delete firm (with multi-step confirmation, blocks if any child workspaces still bound)

### New page: `src/pages/firm/FirmOnboarding.tsx`

The self-serve firm creation flow. New top-level user landing for prospective Business-tier customers.

Step 1 — Confirm intent: "Are you setting up LeaseIO for one company or for multiple companies you serve or operate?"
- If "one company" → redirect to existing workspace creation flow
- If "multiple" → continue firm onboarding

Step 2 — Firm details: name, type (CPA firm or parent company or other), billing email

Step 3 — Stripe checkout: Business tier subscription, with clear pricing summary

Step 4 — Initial setup: invite first members, create first child workspace OR bring an existing workspace into the firm

Step 5 — Confirmation and dashboard redirect

### Sidebar refactor: `src/components/AppSidebar.tsx`

Three navigation modes:
- **Workspace mode** (default for non-firm-member users) — existing sidebar
- **Firm mode** — firm-specific navigation links (Dashboard, Inbox, Members, Workspaces, Billing, Settings)
- **Firm-with-workspace-drilldown** — when a firm member is viewing a specific child workspace, the sidebar shows the workspace navigation with a "Back to firm" link at top

A header context indicator above the sidebar shows the current active firm/workspace and provides one-click switching.

For users with both firm and direct workspace memberships, the sidebar's top section groups workspaces under headers: "Firm: {firm_name}" listing child workspaces, then "My workspaces" listing direct memberships.

### Onboarding refactor: `src/pages/app/Onboarding.tsx`

The existing onboarding creates a workspace. Phase 10 adds the firm path:
- A new initial question: "Are you setting up for one company or for multiple?"
- "Multiple" routes to `/app/firm/onboarding`
- "One" routes to existing workspace flow

Existing customers and Pro/Plus signups see no change.

### Edge functions

New edge functions to back the UX:

- `accept-firm-invitation` — mirrors workspace invitation acceptance
- `get-firm-invitation-info` — for the invitation acceptance landing page
- `list-pending-firm-invitations` — for the firm members page
- `revoke-firm-invitation`
- `resend-firm-invitation`
- `act-on-firm-workspace-join-request` — approve/reject join requests
- `cancel-firm-workspace-join-request` — initiator cancels their own pending request

Most of these are direct adaptations of existing workspace invitation edge functions; reuse patterns aggressively.

### Workspace switcher refactor

The existing workspace selector becomes a unified context selector that handles both firms and workspaces. When clicked, it shows:
- Firms section — each firm with a chevron to expand and see child workspaces
- Direct workspaces section — workspaces where the user is a direct member
- "Create new" option at bottom — opens onboarding choice

Clicking a firm enters firm context (lands on dashboard). Clicking a child workspace enters workspace context (lands on the child workspace's normal landing page).

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- `firm_invitations` and `firm_workspace_join_requests` tables created with correct constraints.
- `current_firm_id` added to profiles.
- RLS prevents non-admins from acting on invitations they shouldn't see.
- The cross-workspace inbox view returns correct rows for various firm membership configurations.
- Activity log additions work.

### Pure logic (vitest)

- Firm context resolution — given a user's firm memberships, returns the correct active firm and accessible child workspaces.
- Action urgency calculation — given pending action timestamps, returns correct urgency category.
- Sidebar state computation — given a user's firm + workspace memberships and current context, returns correct navigation tree.

### Edge functions

For each of the new edge functions:
- Authorized actor can perform the action.
- Unauthorized actor gets 403.
- Edge cases (already accepted invitation, expired token, revoked invitation, duplicate join request) handled correctly.
- Activity log entries written with correct details.

### Frontend (vitest + integration)

- Firm dashboard renders for firm members, not for non-firm users.
- Firm inbox shows pending actions across multiple child workspaces.
- Filter and sort interactions work.
- Acting on an inbox action correctly resolves it.
- Firm member invitation flow end-to-end.
- Child workspace administration (add new, bring existing, release) works.
- Billing summary mode toggle persists and Stripe webhook respects it on next invoice.
- Sidebar correctly switches between firm and workspace contexts.
- Workspace switcher groups firm workspaces correctly.

### Manual smoke

- Sign up as a new prospective Business-tier customer; complete the full firm onboarding flow.
- Invite two firm members (one firm_admin, one firm_member); verify they accept and gain expected access.
- Create one new child workspace via firm UI; bring one existing workspace into the firm via join request flow.
- As a firm member, view the firm dashboard; verify aggregate metrics correct.
- As a firm member, view the firm inbox; verify pending actions from multiple child workspaces appear together.
- Approve a chain step from the firm inbox; verify the underlying lease advances.
- Set restrict_firm_access on one child workspace; verify firm members lose access via existing surfaces.
- Toggle billing summary mode; trigger a Stripe invoice; verify line item construction matches the mode.
- Release a child workspace from the firm; verify it can be operated standalone afterward.
- Cancel firm subscription; verify grace period banner appears.
- Delete firm (after releasing all children); verify firm and related data cleanly removed.

---

## Out of scope for Phase 10 — explicit list

Do NOT build any of these in Phase 10.

- Firm-level reports rolling up data across multiple children. Phase 11+.
- White-label branding per firm. Phase 11+.
- Multi-firm membership for a single user. Defer indefinitely.
- Per-firm policy templates that propagate to children. Phase 11+.
- Firm-level audit reporting (all firm member activity across all children). Phase 11+.
- Bulk operations across child workspaces (e.g., "generate ASC 842 reports for all children at once"). Phase 11+.
- Firm dashboard customization (custom widgets, layouts). Defer.
- Firm-level notification preferences (e.g., "notify firm admins of all child workspace approvals"). Phase 11+.
- Mobile-optimized firm UI. Phase 10 ships desktop-first.
- API access for external systems to query firm data. Defer.
- Firm-tier sub-tiers (e.g., Business vs. Business Pro). Defer.
- Automatic firm-tier upgrade prompts when a Pro customer behaves like they need a firm. Defer.
- Migration tools to bulk-import existing customers as a CPA's clients. Defer.
- Firm-level approval policies that apply across child workspaces. Phase 11+.

---

## Definition of done for Phase 10

1. Migration applied cleanly. All schema, RLS, and view tests pass. Mirror committed.
2. Pure logic helpers in `src/lib/firmContext.ts` and Deno mirror with full unit tests passing.
3. New edge functions deployed and source-verified.
4. All eight new pages built (firm dashboard, inbox, members, workspaces, billing, settings, onboarding) and accessible from the firm-context sidebar.
5. Sidebar refactored to support firm context with one-click switching.
6. Workspace switcher refactored to unified firm + workspace selector.
7. Onboarding refactored to offer firm vs. individual paths.
8. Cross-workspace inbox view returns correct data with acceptable performance for firms up to 50 child workspaces.
9. Stripe webhook respects `billing_summary_mode` on invoice construction.
10. Manual smoke covering the full lifecycle: sign up → create firm → invite members → add child workspaces → use firm inbox → toggle billing modes → release workspace → cancel subscription.
11. Existing Plus/Pro tier behavior unaffected — full regression run on workspace-context flows confirms no breakage.
12. Performance check on firm dashboard and firm inbox under realistic data loads.
13. As-built notes appendix on this spec captures any deltas discovered during implementation.
14. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
15. KNOWN_ISSUES.md updated.
16. CLAUDE.md updated to mark Phase 10 closed and Phase 11+ deferred work backlog.
17. `docs/LEASEIO_TIER_OVERVIEW.md` reviewed and refreshed if any tier capability differs from what's described in the customer-facing doc.

---

## Notes for Claude Code

- This is the largest phase by UI surface area. Eight new pages plus significant refactor of sidebar, onboarding, and workspace switcher. Plan accordingly — this is likely a 2-3 week phase even at Phase 4-9 cadence.
- The cross-workspace inbox view is the highest-risk performance surface. Test with realistic data (50+ child workspaces, 1000+ pending actions across them) before declaring it done. Consider materialized view if needed.
- The `restrict_firm_access` flag's behavior must be visible in the UI everywhere relevant. When viewing a workspace as a firm member, if the workspace has restrict_firm_access enabled, the user should see a clear indicator that they're seeing limited (firm-derived) view, not full firm access.
- The Stripe webhook firm-tier branch is the single most important integration point. Test thoroughly. The detailed-vs-summarized billing toggle in the UI must round-trip correctly to Stripe line item construction.
- Reuse the existing invitation, workspace-creation, and member-management patterns aggressively. Phase 10 should not invent new UX for actions that already have established patterns at the workspace level.
- Apply the Permissions Gating Convention rigorously. Firm admin access checks should use `isFirmAdminOrOwner(firmId)` helper consistently (define it in firmAccess.ts) — never raw `firm_role === 'firm_admin'`.
- Apply the Schema Change Rule.
- Reference `docs/PRODUCT_STRATEGY.md` for any decision that touches tier boundaries. Phase 10 implements the customer-facing layer of the Business tier vision; deviations should update the strategy doc.
- Reference `docs/LEASEIO_TIER_OVERVIEW.md` and update it after Phase 10 closes if the implemented capabilities differ from what's described to customers.
- Do not introduce new dependencies.
- Reuse the same five-checkpoint cadence:
  - Checkpoint 1: Migration + types regen + audit + cross-workspace view
  - Checkpoint 2: Pure helpers (firmContext, action resolution, sidebar state) + Deno mirror + vitest
  - Checkpoint 3: Edge functions (invitations, join requests) + Stripe webhook update + smoke
  - Checkpoint 4: Frontend (eight pages + sidebar + switcher + onboarding) — this checkpoint may need to be split into 4a (core surfaces: dashboard, inbox, members) and 4b (workspaces, billing, settings, onboarding)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke + LEASEIO_TIER_OVERVIEW.md refresh
- Phase 10 is the launch-readiness phase for Business tier. Once it closes, Plus, Pro, and Business are all functionally complete and the product is ready for full-market launch.
