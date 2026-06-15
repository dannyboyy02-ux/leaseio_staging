# Phase 10 Kickoff Plan — Firm UX Layer

**Status:** Kickoff plan / sequencing layer. Drafted 2026-06-15. **Not started — no build authorized yet.** The 5 decisions in "Decisions to lock" are **OPEN** (recommendations noted, not adopted — resolve when Phase 10 actually starts).
**Binding source:** `docs/PHASE_10_BUILD_SPEC.md` (column-level spec). This doc is the synthesis/sequencing layer on top of it, grounded against the as-built Phase 9 reality (PR #49, merged 2026-06-15).
**Prereq state:** Phase 9 (firm foundation) merged to `main`. Migration `20260615172439_phase9_firm_layer_foundation.sql` applied to staging; 4 service-role firm edge fns deployed; minimal firm frontend shipped.

---

## What this phase is

Phase 9 built the firm data layer; it's invisible to customers (firms mint only via service-role API). **Phase 10 is the customer-facing layer that makes Business tier sellable**: self-serve firm onboarding → dashboard → cross-workspace inbox → member/workspace/billing/settings management. Per the spec it's the largest phase by UI surface (8 new pages + sidebar/onboarding/switcher refactor) — realistically a multi-week effort.

## Verified foundation (Explore pass, 2026-06-15)

**Ready as-spec (no correction work needed):**
- The inbox view `v_firm_user_pending_actions` can be built verbatim — `lease_approval_chain` (all 10 referenced columns: workspace_id, lease_id, status, stage, step_order, parallel_group, pending_since, approver_user_id, approver_role, effective_assignee_user_id — baseline:1048–1076), `leases.request_title` (baseline:1491), `lease_unlock_requests` (baseline:1419–1432), and helpers `is_workspace_owner` (baseline:407) / `is_firm_member` / `is_firm_admin` (phase9:319–340) / `workspace_roles` (baseline:2095–2102) all exist with the exact names the spec assumes.
- Reusable patterns confirmed present: the 5 workspace-invite edge fns (`accept-invite`, `get-invite-info`, `list-pending-invites`, `resend-invite`, `revoke-invite`), the member UI (`WorkspaceSettings` + `InviteMemberDialog`/`MemberRoleSelect`/`PendingInvitesList`), `src/pages/app/Onboarding.tsx`, and the AppContext firm-grouping plumbing shipped in Phase 9.

**New builds (none are blockers — standard feature work):** `profiles.current_firm_id`, `firm_invitations`, `firm_workspace_join_requests`, the inbox view, `FirmContext.tsx`, 7 firm edge fns, and extensions to `create-workspace` (accept `firm_id`) + the 3 billing fns (firm-aware, KNOWN_ISSUES #103).

---

## Decisions to lock before building (OPEN — 5)

1. **`firm_activity_log` audit routing.** Phase 9 routed firm events into `lease_activity_log`'s CHECK (those events reference a lease); but `firm_activity_log` itself is **open text, no CHECK** (phase9:90–97). Phase 10 adds 8 firm-only event types (invitations, join-requests, settings). Either (a) add a CHECK to `firm_activity_log` for the firm-only events [**rec** — keeps the audit table self-describing], or (b) keep it open text.
2. **FirmContext vs. extend AppContext.** Spec says new `FirmContext.tsx` mirroring AppContext. **Rec: separate `FirmContext`** (undefined for non-firm users, mirrors the spec) — but factor the firm-grouping query already in AppContext into `src/lib/firmContext.ts` (+ Deno mirror) to avoid drift.
3. **#103 firm-billing lockdown — fold in here?** The FirmBilling page is the natural home. **Rec: yes, fold the full #103 fix into Phase 10** (server-side firm-aware guards on create-checkout/customer-portal/manage-document-pack + the deferred UI gates). This phase makes firm-bound workspaces customer-reachable for the first time — leaving #103 open past Phase 10 ships a real double-billing hole.
4. **Inbox view: plain vs. materialized.** Spec says plain view for v1, materialize only if scale demands. **Rec: plain view v1**, but build the 50-child / 1000-action load test into Checkpoint 1 so the decision is evidence-based.
5. **stripe-webhook `billing_summary_mode` line items.** `applyFirmSubscription` (stripe-webhook:545–594) is coded but (a) **not deployed** and (b) records the mode in audit but **doesn't construct invoice line items by mode yet** (explicit TODO at :542–544). **Rec: deploy the branch in Checkpoint 3 and build the `invoice.created` line-item construction there** (the spec's "most important integration point").

---

## Sequencing — 5 checkpoints (spec cadence, with deferred Phase 9 follow-ons folded in)

**Checkpoint 1 — Migration + inbox view + types.** `<ts>_phase10_firm_ux.sql`: `profiles.current_firm_id`, `firm_invitations`, `firm_workspace_join_requests` (+ RLS exactly as spec'd — the two-party join-request approval is the subtle part), the `firm_activity_log` CHECK (decision #1), `v_firm_user_pending_actions` (security_invoker, like Phase 9's views). **Security migration → reviewers route BEFORE apply** (RLS + the inbox view's cross-tenant surface; expect 3+ rounds). Inbox load test at 50 children / 1000 actions. Regen types.

**Checkpoint 2 — Pure helpers + Deno mirror + vitest.** `src/lib/firmContext.ts` (+ `_shared/firm_context.ts`): firm-context resolution, action-urgency calc, sidebar-state computation, `isFirmAdminOrOwner()`. Parity test wired into `scripts/check-mirror-parity.mjs`. The testable core before any UI.

**Checkpoint 3 — Edge functions + Stripe + deferred Phase 9 follow-ons.** The 7 new firm edge fns (5 invitation, 2 join-request — direct adaptations of the workspace ones). **Deploy** the stripe-webhook firm branch + build `billing_summary_mode` line-item construction (decision #5). **Fold in deferred beats:** #103 firm-aware guards on create-checkout/customer-portal/manage-document-pack (decision #3); `set-firm-access` + `delete-firm` edge fns (back FirmSettings/FirmWorkspaces); extend `create-workspace` for `firm_id`; sweep #102 (firm edge-fn raw-error leak) while in these files. Smoke each (authorized / 403 / edge-cases).

**Checkpoint 4 — Frontend (split 4a/4b per spec).**
- **4a (core):** FirmContext provider + FirmDashboard + FirmInbox + FirmMembers. The inbox is the highest-risk surface.
- **4b (admin/billing):** FirmWorkspaces + FirmBilling (absorbs the #103 UI gates) + FirmSettings + FirmOnboarding, plus the **sidebar refactor** (3 nav modes + context indicator), **workspace-switcher → unified firm+workspace selector**, and **onboarding fork** ("one company or multiple?"). en+es locale parity throughout.

**Checkpoint 5 — Tests + docs + closeout.** Full regression on workspace-context flows (firm-aware `is_workspace_member` must not have regressed Plus/Pro), perf check on dashboard + inbox, the full manual smoke lifecycle (signup → firm → invite → add children → inbox → billing-mode toggle → release → cancel → delete), then docs: Phase 10 spec as-built, CLAUDE.md (close Phase 10, open Phase 11+ backlog), KNOWN_ISSUES (#102/#103 resolved), `docs/LEASEIO_TIER_OVERVIEW.md` refresh.

---

## Critical risks

- **Inbox view performance** — the one surface that can't be hand-waved; load-test early (CP1).
- **`restrict_firm_access` visibility** — must show a clear "limited firm-derived view" indicator everywhere a firm member views a restricted child; easy to miss.
- **Stripe billing-summary-mode round-trip** — detailed↔summarized must reach Stripe line-item construction correctly; the integration point most likely to silently misbehave.
- **Sidebar/switcher refactor blast radius** — touches every authenticated screen's navigation; regression risk to existing workspace flows.
- **Two-party join-request RLS** — the approve-by-the-other-party logic is the trickiest authz in the migration; adversarially test both directions (`firm_to_workspace` and `workspace_to_firm`).

## Out of scope (Phase 11+, per spec)

Firm-level reports rollup, white-label branding, multi-firm membership, per-firm policy templates, firm audit reporting, bulk cross-child ops, mobile-optimized firm UI, Business sub-tiers / "Business Elite", Pro→firm auto-upgrade prompts.

---

## Deferred Phase 9 follow-ons this phase absorbs (cross-reference)

| Item | Source | Folded into |
|---|---|---|
| Firm-billing lockdown (3 HIGH + UX) | KNOWN_ISSUES #103 | CP3 (server guards) + CP4b (FirmBilling UI gates) |
| Firm edge-fn raw-error-message leak | KNOWN_ISSUES #102 | CP3 (sweep while in firm edge fns) |
| Deploy stripe-webhook firm branch | CLAUDE.md Phase 9 follow-ons | CP3 |
| `billing_summary_mode` invoice line items | stripe-webhook:542–544 TODO | CP3 (decision #5) |
| `set-firm-access` + `delete-firm` edge fns | CLAUDE.md Phase 9 follow-ons | CP3 |
| `create-workspace` accept `firm_id` | spec lines 372–374 | CP3 |
