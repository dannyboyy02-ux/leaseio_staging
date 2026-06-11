# LeaseIO Product Strategy — Tiers, Firm Layer, and Architecture Decisions

**Status:** Strategic decision document. Ratified 2026-05-04 (last updated 2026-06-11).
**Owner:** Daniel
**Audience:** Claude Code, future contributors, anyone making decisions that span phases.

This document captures the product strategy decisions that frame the entire build plan. Specs and phase work reference this document for context. Decisions here override default assumptions in earlier phase specs where they conflict — and the As-built notes appendices on phase specs should explicitly call out any decision here that changed how implementation went.

---

## The product, in one sentence

LeaseIO is a multi-tenant lease management platform that produces verified ASC 842 reports for businesses managing their own leases or for organizations managing multiple subsidiaries' or clients' leases.

The verified-data-layer-not-financial-statement positioning (compliance liability stays with the customer, LeaseIO produces structured inputs only) holds across all tiers.

---

## Tiers

Three tiers, single product surface, gated by plan.

| Tier | Buyer | Price model | Workspace model | Members | Document limits | Key features |
|------|-------|-------------|-----------------|---------|-----------------|--------------|
| **Plus** | Small business, single company | Per-workspace subscription | Single workspace | Up to 5 members | Low (e.g., 25 active leases) | Basic intake, AI extraction, verification layer, ASC 842 report generation, single approval flow |
| **Pro** | Mid-market, single company | Per-workspace subscription | Single workspace | Up to 25 members | Mid (e.g., 250 active leases) | All Plus + configurable approval policies (Phase 1+), full chain workflow (Phase 2+), negotiation document tracking (Phase 4), signator stage (Phase 5), rerouting (Phase 6), delegation (Phase 7) |
| **Business** | CPA firm, accounting practice, parent company with subsidiaries | Per-firm subscription, billed at the firm level, covers all child workspaces | Firm entity owns multiple workspaces | Firm members get access to all child workspaces; per-workspace member roles still apply | Aggregate across all child workspaces | All Pro features per workspace + firm-level layer: cross-workspace inbox, firm member management, firm-wide billing, firm-tagged reporting |

The Plus → Pro distinction is feature depth and document volume.
The Pro → Business distinction is structural — Business is the only tier with the firm/organization layer. That's the line where the architecture changes meaningfully.

---

## Why Business tier exists for two distinct buyer types

This is the strategic insight that makes Business tier a major TAM expansion rather than a niche feature.

**Buyer type 1 — Professional services firms.** CPA offices, accounting practices, law firms, real estate brokers, lease consultants. They serve many client companies. Each client's leases must be confidentially separated from other clients' data. The firm itself needs aggregate visibility for staff productivity, but no client should ever see another client's data.

**Buyer type 2 — Parent companies with subsidiaries.** A holding company with 12 operating subsidiaries. Each subsidiary has its own lease portfolio, its own approval workflows (which may differ — operating subsidiary A is a retail chain, operating subsidiary B is a manufacturing concern), its own financial reporting requirements. The parent needs roll-up visibility for treasury and compliance, but operational independence for each subsidiary.

These two buyer types have **structurally identical software requirements**:
- A parent entity (firm or holding company) that owns multiple workspaces
- Strong data isolation between child workspaces
- Parent-level user roster with access scoped to assigned children
- Cross-workspace inbox for parent users
- Centralized billing
- Aggregate visibility for parent users only

This means one architectural layer — call it the **firm layer** — serves both markets. The terminology in the UI may need to flex (a firm has "clients," a parent company has "subsidiaries"), but the data model and code are the same.

---

## Decision 1 — Workspace model for Business tier: Option B (separate workspaces)

**Decided:** Each client (or subsidiary) gets its own workspace. The firm/parent owns a separate firm entity that aggregates them.

Rationale:
- Data isolation between clients/subsidiaries is enforced at the database level via existing RLS, not via application-level filters that could be bypassed by bugs or misconfiguration.
- A CPA firm can credibly tell their client "your data is physically separated from our other clients" because it is.
- A parent company can credibly satisfy auditors and regulators that subsidiary data isolation is preserved.
- If a firm churns or a subsidiary is divested, transferring or removing one workspace is a clean, contained operation.
- Per-workspace approval policies, members, and configuration remain independent — which matches reality (subsidiary A's CFO has authority subsidiary A; they have no authority at subsidiary B).

The alternative (single workspace with a "client" field on each lease) was rejected. It would have shipped faster but sacrificed isolation, made permission boundaries fragile, and limited per-client configuration.

---

## Decision 2 — Billing direction: parent/firm pays

**Decided:** At the Business tier, the parent or firm pays for everything in a single subscription. Child workspaces inherit the parent's plan; they do not have independent subscriptions.

Rationale:
- Simpler billing — one Stripe subscription covers the firm and all child workspaces.
- CPAs prefer to control the bill and pass costs through to clients as part of their service fee, rather than have clients see a third-party SaaS line item they didn't authorize.
- Parent companies expect centralized procurement; subsidiaries don't usually have authority to sign software contracts.
- Volume pricing is naturally enabled — firms with more children get tier-up pricing.
- When a firm churns, billing termination is one operation, not 20.

Plus and Pro tiers are unchanged: each workspace has its own subscription tied to the workspace owner.

---

## Decision 3 — Build cadence: progressive, not all-at-once

**Decided:** Build out the firm layer **after** Phases 4-8 close, not in parallel with them.

This is a refinement of the original instinct ("build it all in one sweep before launch"). The reasoning:

The Phases 4-8 work — negotiation documents, signator stage, rerouting, delegation, ASC 842 report — is foundational to all three tiers. Plus, Pro, and Business all need that core to be sellable. Stopping mid-Phase-4 to build the firm layer would leave both tracks half-finished and the product unsellable to anyone.

Building the firm layer **after** Phases 4-8 means:
- Plus and Pro tiers become sellable as soon as Phase 8 closes (or even earlier, with reduced feature gating).
- The firm layer (call it Phase 9 + 10) has a complete, stable feature set to layer on top of.
- The cross-workspace inbox and firm reporting work against a known data shape rather than a moving target.
- "Build it all before launch" is preserved as a goal — just with a sequence that doesn't strand work in progress.

The strategic intent is unchanged — both markets get served, Business tier ships before launch — but the execution order matters.

The build order is:
1. Phases 4-8 (current chain workflow build): negotiation documents, signator stage, pending counter-signature, rerouting, delegation, ASC 842 report
2. Phase 9: Firm layer foundation (firm entity, firm members, firm-level Stripe billing, firm-aware RLS)
3. Phase 10: Firm UX (cross-workspace inbox, firm dashboard, child workspace management)
4. Phase 11+ (post-launch): firm-level reporting, white-labeling, advanced firm roles, client onboarding flows

---

## Decision 4 — Document capacity packs (recurring monthly add-on)  *(2026-06-11)*

**Decided:** A workspace at or near its monthly abstraction limit can buy a recurring **document pack** that raises both its monthly-abstraction allowance and its active-lease cap. Available on **both tiers**.

**Pricing:** 10 leases/$90 ($9/ea) · 20/$160 ($8/ea) · 50/$350 ($7/ea).

**Rationale (market-researched + pressure-tested):**
- **Cheaper than overage, always.** Overage is $12/doc (Starter) / $10/doc (Business). The smallest pack ($9/ea) beats both, so packs are the rational relief valve and overage is the expensive convenience. ($100/10-pack would have tied Business overage — hence $90.)
- **Margin floor holds.** Two-pass extraction costs ≈ $0.50–0.60/doc; doubled per the 75%-margin rule = $1.20, so the floor sits at ≈ $4.80/lease. Worst-case pack price ($7) clears it with ~45% headroom.
- **Doesn't cannibalize the upgrade path.** Starter + 20-pack ($409, 35 docs) still loses to Business ($499, 50 docs + all Business features) on value; at high volume the ladder pushes toward Business, as intended.
- **Undercuts the market.** Competitor per-doc AI abstraction runs ~$20–25 (Prophia/LeaseLens/Lextract); $7–9/lease undercuts by 2–3× while staying well above cost.

**Architecture:** Each pack is its **own Stripe subscription** (not a line item on the plan subscription), tagged `metadata.addon_type='document_pack'` + `pack_size`. Full price charged on purchase, **no proration**, **cancel-at-period-end** (capacity persists until the period ends; leases are never touched). Capacity is **additive** — `workspaces.addon_document_capacity` is the sum of the workspace's active/trialing pack sizes, written **only** by the Stripe webhook and guarded by the #29 entitlement trigger. Separate-subscription (vs. shared-subscription line items) was chosen because it (a) charges full price immediately with a clean cycle, (b) yields clean per-pack invoice streams that directly feed the future itemized-billing surface (KNOWN_ISSUES #60), and (c) cancels independently of the plan.

**A pack raises BOTH caps** (monthly abstractions AND active-lease storage) by its size — "a pack of N leases" as a user reads it. The two base caps are equal (15/15, 50/50), so adding to both keeps them coherent.

**Quota window stays rolling-30-day** (NOT billing-period-aligned). The alignment rewrite was scoped then **descoped (2026-06-11)**: the proven rolling window self-resets and is the same window the usage meter shows; the only motivation for alignment (copy contradicting a rolling window) was already solved with honest copy. Rewriting the margin-protecting enforcement path was judged not worth the risk.

**At-cap behavior** (limit wall, shipped 2026-06-11): hard-block stays the default. The wall (`LimitReachedDialog`) gates the Leases "Add Lease" and Dashboard "New Request" entry points (plus a server backstop in the upload modal) and offers plan-aware doors: upgrade (Starter only), a capacity pack, or a **one-time single lease at the overage rate** ($12/$10 → one `purchased_lease_credits` credit, granted via an idempotent payment ledger and consumed atomically by `process_lease` when over cap). There is NO auto-charged overage — every over-cap dollar is an explicit, consented purchase. Non-admins are told to contact their admin.

---

## Firm layer architecture sketch

This is a sketch, not a build spec. The actual spec gets written when Phase 9 opens. The purpose here is to make sure Phases 4-8 don't accidentally foreclose any of these decisions.

### New tables

**`firms`**
- `id` (uuid)
- `name` (text)
- `firm_type` (text — `'cpa_firm'`, `'parent_company'`, `'other'` — drives terminology in the UI)
- `owner_id` (fk auth.users — the user who created the firm)
- `plan` (text — currently always `'business'` since firms are Business-tier-only)
- `stripe_customer_id` / `stripe_subscription_id` (text — Stripe identifiers at the firm level)
- `child_workspace_limit` (int — how many child workspaces the firm's plan allows)
- `child_workspaces_used` (int — running count, maintained by trigger)
- `created_at`, `updated_at`

**`firm_members`**
- `id` (uuid)
- `firm_id` (fk firms)
- `user_id` (fk auth.users)
- `role` (text — `'firm_admin'`, `'firm_member'`)
- `created_at`

**`firm_workspace_membership`**
- `id` (uuid)
- `firm_id` (fk firms)
- `workspace_id` (fk workspaces)
- `child_label` (text — display label, e.g., "Acme Corp" or "Subsidiary 4 — Manufacturing")
- `created_at`
- One row per child workspace; UNIQUE(workspace_id) means a workspace belongs to at most one firm.

**Workspace table additions**
- `firm_id` (fk firms — nullable; non-null means this is a Business-tier child workspace)
- `child_label` denormalized from firm_workspace_membership for performance

### Permission model

A firm member's effective access to data:
1. Their direct workspace memberships (Plus/Pro semantics — unchanged from today).
2. Plus implicit membership in all workspaces where `workspaces.firm_id` matches a firm they're a member of, with role determined by their firm role mapped to a workspace role:
 - `firm_admin` → effective `admin` in every child workspace
 - `firm_member` → effective `editor` in every child workspace (configurable per firm in the future, but `editor` is the v1 default)

Workspace-level membership in a child workspace can override firm-level access — e.g., a firm member who is explicitly added to a child workspace as `viewer` is `viewer` in that workspace despite having `firm_member` role granting them editor access elsewhere. This handles the case where a firm wants to restrict a junior associate from a sensitive client.

### RLS adjustments

The existing RLS pattern uses `is_workspace_member(workspace_id, user_id)`. That helper extends to also return true if the user is a firm member of the firm that owns the workspace. The change is one helper function, not a sweep of every policy.

```sql
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id UUID, _user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
 SELECT EXISTS (
 SELECT 1 FROM public.workspace_members
 WHERE workspace_id = _workspace_id AND user_id = _user_id
 ) OR EXISTS (
 SELECT 1
 FROM public.workspaces w
 JOIN public.firm_members fm ON fm.firm_id = w.firm_id
 WHERE w.id = _workspace_id AND fm.user_id = _user_id
 );
$$;
```

This is the cleanest possible architectural change. Every RLS policy in the codebase that uses `is_workspace_member` automatically picks up firm-membership-based access without any other code change. That's the payoff of the existing helper-function pattern.

### Cross-workspace inbox

A new view `v_firm_user_pending_actions` aggregates pending actions for a firm user across all child workspaces:
- Pending chain step approvals from `lease_approval_chain` where `approver_user_id = me OR approver_role IN (my_roles_in_workspaces_owned_by_my_firm)`
- Pending unlock requests, change set reviews, and other governance items
- Each row tagged with the child workspace's `child_label` for the firm UI

The firm dashboard at `/app/firm/inbox` queries this view. The existing per-workspace approvals page at `/app/approvals` continues to work for users in the active workspace context — the firm inbox is a parallel surface, not a replacement.

### Firm-level Stripe billing

The Stripe webhook handler gets a new branch: when the subscribed customer is a firm, route the subscription to `firms.stripe_subscription_id` and propagate the `business` plan to all child workspaces via `workspaces.plan`. Plus and Pro flows remain unchanged.

A child workspace's `plan` is read-only at the database level (a trigger prevents independent plan changes on Business-tier workspaces) — the firm's plan is the source of truth.

---

## Risks and how we'll mitigate them

**Risk: A firm member abuses implicit access.** A firm member with broad access could exfiltrate data from many client workspaces at once.

Mitigation: Firm-level audit logging. Every firm member's read of a child workspace's data gets logged (or at minimum, all writes, exports, and report generations are logged). The firm admin sees an activity feed of what their team has accessed. Optional: per-client opt-in where the client must explicitly consent to a firm member having access (added in Phase 11+).

**Risk: A child workspace's data leaks into another child's report.** A bug in cross-workspace queries could mix data.

Mitigation: All cross-workspace queries are read-only and routed through views like `v_firm_user_pending_actions` that explicitly join with the firm relationship. Writes are always workspace-scoped, never firm-scoped. Tests cover the data isolation boundary explicitly.

**Risk: A firm adds 100 child workspaces and creates a performance issue on the inbox.** The aggregate inbox could become slow as a firm scales.

Mitigation: Indexes on `workspaces.firm_id` and on the `lease_approval_chain.approver_user_id` already exist or are added. The inbox view paginates and date-bounds. A firm with 100 children is well within Postgres's wheelhouse if indexes are right.

**Risk: A firm churns and child workspaces become orphaned.** If the firm cancels their subscription, what happens to the 20 client workspaces?

Mitigation: Defined offboarding path. Each child workspace gets a 30-day window during which the firm relationship is suspended (read-only) but data is preserved. After 30 days, child workspaces either need to upgrade to their own Pro subscription independently, or get archived per data retention policy. The product surface for this lives in `/app/firm/billing` and email reminders to all child workspaces' owners.

**Risk: A parent company's subsidiary objects to the parent having full read access.** Subsidiaries may want to keep some lease information confidential from the parent (e.g., M&A leases, sensitive legal exposure).

Mitigation: Per-workspace override of firm access. A child workspace can have a setting `restrict_firm_access` that, when enabled, requires firm members to be explicitly added as workspace members rather than gaining access via firm membership. v1 default is firm members get full access; per-workspace restriction is opt-in.

---

## Implementation guidance for Phases 4-8 (interim period)

While the firm layer doesn't ship until Phase 9, there are decisions in Phases 4-8 that should be made with the firm layer in mind. The principles:

1. **Everything stays workspace-scoped at the data level.** Don't introduce user-level globals (e.g., user preferences that affect all workspaces) without careful thought. User-level state that survives across workspaces is a separate decision.

2. **Audit trails should not assume single-workspace context.** When writing audit log entries, always include `workspace_id`. Phase 8's ASC 842 report should be workspace-scoped (one report per workspace per period), but the report engine should accept multiple workspace IDs as input for a future firm-rolled-up report.

3. **Notifications and approvals are workspace-scoped.** A user with chain steps pending in three different workspaces should see them all listed in the firm inbox in Phase 10, but each step is rooted in its workspace. Don't merge them into a global queue.

4. **Don't pre-build the firm layer.** Phase 4 should not introduce `firm_id` columns prophylactically. When Phase 9 opens, those columns get added then. Premature scaffolding for unimplemented features is technical debt.

5. **When a phase spec calls for a UI surface, design it as workspace-contextual.** The active workspace context drives what the user sees. The firm layer in Phase 10 introduces a "firm context" mode that's distinct from "workspace context" mode — but every existing screen lives in workspace context.

---

## Open questions deferred to phase spec time

These get answered when Phase 9 / Phase 10 specs are written, not now:

- Exact pricing for Business tier (per-firm base + per-child workspace? flat fee with included children + overage? to be decided based on competitive analysis closer to launch)
- Onboarding flow for Business tier — does the firm admin invite child workspaces, or do clients invite the firm in? Probably both, but UX needs design
- White-labeling — can a CPA firm rebrand the LeaseIO interface for their clients? Defer to Phase 11+; not v1
- Multi-firm membership — can one user be a member of multiple firms? Probably yes (independent CPAs working with multiple firms), but not v1
- Reporting roll-ups — what does a firm-level dashboard actually show? Defer to Phase 11+

---

## Tracking

This document is the source of truth for the tier strategy and firm layer architecture. Any phase spec or implementation that diverges from these decisions must:
1. Update this document with the new decision and rationale.
2. Bump the date in the header.
3. Reference this document in the spec's As-built notes appendix.

---

## Closeout

Ratified 2026-05-04. Strategic direction. Architectural decisions around the firm layer locked in for Phase 9+ scoping. Phases 4-8 proceed unchanged with the implementation guidance above as the binding interpretation when ambiguity arises.
