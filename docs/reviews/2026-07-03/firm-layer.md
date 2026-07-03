# Firm/Organization Layer (Phase 9 + 10) — Code-Verified Review

Reviewer scope: `src/pages/app/firm/*`, `src/pages/AcceptFirmInvitation.tsx`, `src/contexts/FirmContext.tsx`, `src/lib/firmContext.ts`, `src/lib/firmAccess.ts`, `src/components/firm/`, all 17 firm edge functions, `_shared/firm_access.ts`, `_shared/firm_billing.ts`, migrations `20260615172439` / `20260616120000` / `20260616130000` / `20260616140000` / `20260618130000`, `stripe-webhook` firm branch, specs + KNOWN_ISSUES #102–#107.

Everything below is verified against the code on branch `claude/leaseio-end-to-end-review-163v6w` (HEAD `a89efcd`). Where I could not find evidence I say so.

---

## 1. Executive summary

The firm layer is **substantially more built than the docs claim** — self-serve firm creation + hosted Stripe checkout shipped in commit `6a94a8d` ("feat(firm/#105-C): self-serve firm onboarding — UI + hosted checkout (#55)") while CLAUDE.md, PHASE_10_BUILD_SPEC's as-built header, and KNOWN_ISSUES #105 all still describe it as deferred/ops-only. The security architecture is genuinely strong (service-role guards, airtight owner-privileged inbox view, owner-only-mints-admins everywhere, idempotent billing sync with self-audit + reconcile cron).

But the layer is **not operable end-to-end from the UI**. The single biggest hole: **after onboarding creates the first child workspace, there is no UI path to ever add another one** — no "Add workspace" on FirmWorkspaces, no bind-existing-workspace flow, and re-running `/app/firm/onboarding` creates a *second firm*. A product whose pricing model is "N children × $499" ships with N permanently = 1 from the UI. The second-biggest: the **entire two-party join-request feature is backend-only dead code**, and the **effective-access role mapping (firm_admin→admin, firm_member→editor) is implemented nowhere** — `resolveEffectiveAccess`/`hasWorkspaceAuthority` have zero runtime call sites, so a firm admin who opens a child workspace gets `userRole = null` (below viewer) in the UI.

Verdict: **fix, not rebuild.** The foundation (schema, RLS, guards, billing engine) is sound and well-reviewed; the gaps are unfinished wiring and stale docs.

---

## 2. What exists and works (verified)

- **Routes + provider**: 7 firm routes + `/firm/accept-invitation` mounted (`src/App.tsx:148-157`), `FirmProvider` wraps the app (`src/App.tsx:101`). Sidebar has a firm mode with all 6 nav links + workspace-mode "Firm" entry with pending-count badge (`src/components/layout/AppSidebar.tsx:299,689-707`).
- **Self-serve creation**: `Onboarding.tsx:210-217` fork → `FirmOnboarding.tsx` 3-step wizard → `create-firm` (self-serve, per-owner cap of 10, ops override; `create-firm/index.ts:31-58`) → `create-firm-workspace` (firm admin/owner, idempotent RPC `create_firm_workspace_locked`, advisory-lock serialized; `20260616130000`) → `create-firm-checkout` (owner-only, quantity = child count on the standard Business price, double-sub guard by stamping customer + scanning live subs; `create-firm-checkout/index.ts:61-98`).
- **Webhook**: `applyFirmSubscription` routes on `metadata.firm_id`, mirrors sub → `firms`, propagates `plan='business'` to all children, audits started/updated/canceled (`stripe-webhook/index.ts:668-717,749-764`).
- **Billing sync engine**: `_shared/firm_billing.ts` — recompute-from-live-count, prorated, offboarding cancel_at_period_end at 0 children, un-cancel on re-bind, self-auditing on success AND failure; swept hourly-capable by `firm-billing-reconcile` (cron-secret, fail-closed). Called from bind/release/act-on-join/create-workspace.
- **Invitations**: full loop — `send-firm-invitation` (owner-only mints admins, token refresh on duplicate, escaped HTML email), `get-firm-invitation-info` (display-safe public lookup), `accept-firm-invitation` (email-bound, idempotent), `resend`/`revoke` (role-gated), pending list + revoke/resend UI in `FirmMembers.tsx:168-191`, landing page handles need-auth / mismatch / expired / revoked / accepted states.
- **Inbox**: `v_firm_user_pending_actions` is a deliberately owner-privileged view with the `auth.uid()` filter baked into the WHERE, restricted children excluded, chain actions routed only to the caller, unlock requests to firm admins only (`20260616120000:249-345`). `FirmInbox.tsx` renders it with urgency badges + per-workspace filter and switches workspace before opening the lease.
- **restrict_firm_access**: workspace-owner-only via `set-firm-access` (server-enforced at `set-firm-access/index.ts:46-47`; UI disables the switch for non-owners at `FirmWorkspaces.tsx:82`); the flag actually cuts firm access at the RLS root (`is_workspace_member` 3rd EXISTS requires `restrict_firm_access = false`, `20260615172439:362-369`) and the inbox/usage views respect it.
- **Guards**: `prevent_firm_entitlement_edits` (owner cannot touch plan/stripe/quota/owner_id; name/type/billing_email/billing_summary_mode deliberately writable), `enforce_workspace_firm_binding_guard` (no self-binding), counter trigger with DELETE branch (#112 fixed, `20260618130000`), `firm_activity_log` ON DELETE RESTRICT.
- **Locales**: every `firm.*` key used by the 8 firm surfaces exists in both `en` and `es` (verified programmatically — ALL PRESENT).
- **#103 server guards**: re-verified — `create-checkout:129` / `customer-portal:64` / `manage-document-pack:207` class of guards exist per the KNOWN_ISSUES re-verification; not re-audited in depth here (out of focus).

---

## 3. Gaps / incomplete work (each verified in code)

### G1 — HIGH: No UI path to add a second child workspace (or bind an existing one)
- `create-firm-workspace` is invoked ONLY from `FirmOnboarding.tsx:57` (grep of `functions.invoke(` across `src/`).
- `bind-workspace-to-firm` is invoked **nowhere** in the frontend.
- `FirmWorkspaces.tsx` has no header action and no per-card "add" — only the restrict toggle and Release (`FirmWorkspaces.tsx:58-96`).
- Revisiting `/app/firm/onboarding` restarts at step "details" and `createFirm` unconditionally creates a **new firm** (`FirmOnboarding.tsx:38-52`) — the wizard cannot target an existing firm.
- PHASE_10_BUILD_SPEC explicitly requires an "Add Workspace" action with both paths (create-new + bring-existing via join request) on FirmWorkspaces (spec `:378-388`). Not built.
- Consequence: the N×$499 quantity model, the child counter, the firm dashboard grid, the billing usage table — all engineered for N children — are reachable only at N=1 self-serve. Existing customers who want to convert their standalone Business workspace into a firm child have **no path at all** (onboarding step 2 only creates a new workspace; there is no bind UI; join requests have no UI — see G2).

### G2 — HIGH: The firm⇄workspace join-request feature is backend-only dead code
- Table `firm_workspace_join_requests` + RLS + partial-unique pending index exist (`20260616120000:121-235`); `act-on-firm-workspace-join-request` and `cancel-firm-workspace-join-request` are complete, correctly counterparty-authorized edge functions.
- Zero frontend references: no INSERT of a join request anywhere in `src/`, no list, no approve/reject/cancel invocation (grep: only `types.ts` + static tests match).
- There is also **no creation edge function** — creation was designed as a client RLS INSERT (spec `:192-208`), and no UI performs it. The two deployed functions are unreachable in the product.
- CHECK values `firm_join_request_created` / `firm_join_request_expired` (`20260616120000:151-152`) are written by nothing; no expiry job exists.

### G3 — HIGH: Effective-access role mapping is implemented nowhere; firm users get a role-less UI in child workspaces
- `resolveEffectiveAccess` / `hasWorkspaceAuthority` / `isFirmAdminOrOwner` / `isFirmMemberOrOwner` (`src/lib/firmAccess.ts:22-100`, Deno mirror `_shared/firm_access.ts`) have **zero runtime call sites** — only tests and docs reference them (project-wide grep).
- `AppContext.fetchProfile` resolves `userRole` from ownership + direct `workspace_members` only (`src/contexts/AppContext.tsx:175-185`); a firm-derived user gets `userRole = null`. Every gate in `src/lib/authorization.ts` (admin/editor checks) then fails, `RequireRole` redirects, and pages like `Leases.tsx:131` hide all actions. The workspace selector hardcodes firm children as `role: "editor"` for display only (`AppContext.tsx:384`).
- Server-side is inconsistent too: `is_workspace_member` is firm-aware (`20260615172439:348-370`) so firm users can **read** everything and even **insert leases** ("Users can insert leases" gates on `is_workspace_member`, baseline `:3845`), but `has_workspace_permission` was never made firm-aware (baseline `:CREATE FUNCTION has_workspace_permission` — direct members + owner only), so `leases_update_own_or_workspace_editor` (baseline `:4214`) denies them updates. Net effective role: an undocumented "reader who can insert but not edit" for BOTH firm_member and firm_admin — matching neither the spec's firm_admin→admin nor firm_member→editor.
- CLAUDE.md's file map presents `firmAccess.ts` as the live "effective-access resolution" — it is aspirational/dead.

### G4 — HIGH: Firm children are created on the wrong plan (#113 is now LIVE, not latent)
- `create_firm_workspace_locked` inserts `INSERT INTO workspaces (name, owner_id, firm_id)` (`20260616130000:57-58`) and its comment claims "Phase 9 triggers fire here: plan→'business'" — but `workspaces_plan_firm_lock` is `BEFORE UPDATE` only (`20260615172439:219-222`); the force-to-business branch never fires on INSERT.
- `workspaces.plan` defaults to `'pro'` (baseline `:1878`), so every self-serve firm child is born plan `pro` (UI-normalized to starter entitlements: no AI assistant, starter quotas) while the firm model bills it at the Business rate.
- Self-heal only happens when a firm-sub webhook event fires (`stripe-webhook:705` blanket-propagates business). If the owner clicks "do this later" at the billing step (`FirmOnboarding.tsx:159-161`) — an explicitly offered path — children stay mis-planned indefinitely. KNOWN_ISSUES #113 said this "bites when self-serve firm-workspace creation ships"; it shipped (PR #55) and the item was never upgraded.

### G5 — HIGH: Accepting a firm invitation dead-ends on "No firm yet"
- `AcceptFirmInvitation.accept()` inserts the membership server-side, then `navigate("/app/firm")` (SPA navigation, `AcceptFirmInvitation.tsx:41-47`).
- `FirmProvider` fetches memberships once per auth-user change (`FirmContext.tsx:113-116`); nothing refetches after acceptance (the page never imports `useFirm`/`refreshFirm`).
- So the fresh member lands on `FirmDashboard` with stale `isFirmUser=false` → `FirmNotMemberState`: "you're not part of a firm" + a Back-to-workspace button (`FirmDashboard.tsx:50-52`, `FirmNotMemberState.tsx`). The sidebar "Firm" entry is also hidden (same stale flag). A hard refresh fixes it — the first-run firm-member experience is broken until then.

### G6 — MED/HIGH: Released or lapsed children keep Business entitlements free, forever
- `release-workspace-from-firm` deliberately keeps `plan='business'` ("the owner downgrades separately if desired", `release-workspace-from-firm/index.ts:21-24`) and the released workspace has no subscription; nothing ever downgrades it. The firm's quantity decrements, so **nobody pays** for a permanently-Business workspace.
- Same on firm cancellation: `applyFirmSubscription` deleted-branch comments "Children remain 'business' for a 30-day grace (P9 records; grace cleanup is P11+)" (`stripe-webhook:680-692`) — but no grace timestamp is recorded on children and no cleanup exists. "30-day grace" is currently "free forever". Not tracked as its own KNOWN_ISSUES item.

### G7 — MED: Firm owner is billed for restricted children he cannot see
- `countFirmChildren` (service role) counts every `workspaces.firm_id = firm` row including `restrict_firm_access=true` (`_shared/firm_billing.ts:17-26`).
- But a restricted child is invisible to the firm owner everywhere: `is_workspace_member` excludes it, `v_firm_child_usage` is security_invoker (`20260615172439:375-376`), FirmWorkspaces/FirmDashboard/FirmBilling therefore omit it (unless the firm owner also directly owns/joins the child). The owner pays quantity N while every firm surface shows N−k children, with no way to see, release, or even know about the k restricted ones. KNOWN_ISSUES logged the counting side as "product decision B1" — the *invisibility of a billed line item* was not assessed.

### G8 — MED: FirmBilling page is far thinner than spec and contains a placebo control
- Spec (`PHASE_10_BUILD_SPEC.md:390-404`): invoice history, update-payment-method portal link, change-plan/cancel buttons, aggregate usage, next-invoice preview. As built (`FirmBilling.tsx`): status badge, per-child usage list, and the mode toggle. No price, no quantity ("Business × N" is never shown), no invoices, no payment method, **no cancel path** — winding down a subscribed firm from the UI requires discovering that releasing every child implicitly cancels at period end (a side effect never surfaced in any copy; release toast says only "Workspace released from firm", `FirmWorkspaces.tsx:50`).
- `billing_summary_mode` toggle is a placebo: `detailed` changes only the toggle's own caption strings (`FirmBilling.tsx:90,205-208`); the usage list renders identically and nothing else in the codebase consumes the column except audit-log echoes (`stripe-webhook:714`). KNOWN_ISSUES #105 item 4 re-scoped it to "in-app breakdown emphasis wired in #105-C" — as built, it controls nothing.

### G9 — MED: Firm wind-down / delete-firm (#104) — as-decided, but with a dead-end sharper than documented
- No `delete-firm` function exists (confirmed; deferral documented in #104 with `deleted_firms` table ready). FirmSettings has **no danger zone and no "coming soon"** (`FirmSettings.tsx` — name/type/email only), so an owner who wants out finds nothing. Combined with G8 (no cancel button) the complete wind-down story is: release children one-by-one (each an unconfirmed one-click), infer that billing stopped, and live with a permanent "Firm" nav item + empty firm forever. A member (non-owner) also has no "leave firm" affordance (remove button is canManage-only, `FirmMembers.tsx:159`).

### G10 — MED: Multi-firm support is half-wired
- `switchFirm` is exposed by FirmContext (`FirmContext.tsx:118-128`) but **never called from any UI** (grep). Yet `create-firm` allows 10 firms/owner and a user can hold memberships in many firms. `resolveActiveFirm` pins the persisted/first firm permanently.
- Concrete failure: a user with firm A active runs the onboarding wizard to create firm B — `refreshFirm()` keeps A active (persisted `current_firm_id` wins, `firmContext.ts:26-36`); checkout succeeds for B; the success redirect lands on `/app/firm/billing` which polls **firm A**, never sees the sub, and after 30 s shows the "still syncing / contact support" card forever (`FirmBilling.tsx:44-118`). No UI can switch to firm B.

### G11 — MED: Firm inbox shows soft-deleted leases (RLS bypass gap)
- `v_firm_user_pending_actions` is owner-privileged (bypasses RLS by design) and was **not** updated by the lease-retention migration: it joins `leases` with no `deleted_at IS NULL` filter (view defined only in `20260616120000:249-345`; `20260625130000` touches it nowhere), and `delete-lease` does not cancel pending chain steps.
- A soft-deleted lease with a pending chain step keeps surfacing in the firm inbox for up to 14 days (title exposed), and "Open" navigates to a lease the client can't read (`leases_hide_soft_deleted` RESTRICTIVE policy) — a guaranteed dead-end. The retention work explicitly enumerated RLS-bypassing readers to patch (process_lease, workspace_quotas, ai-assistant) and missed this fourth one.

### G12 — MED: Firm-membership mutations are unevenly audited
- `FirmMembers.removeMember` is a raw client DELETE on `firm_members` (`FirmMembers.tsx:104-108`; allowed by the consolidated "firm members delete" policy) that writes **no** `firm_activity_log` row — while every other membership mutation (add, invite, accept, revoke) audits. The CHECK constraint even reserves `firm_member_removed` and `firm_member_role_changed` (`20260616120000:145`) — neither is ever written; there is also no change-role UI (spec required it).

### G13 — MED: Pure firm members render as raw UUIDs in the roster
- `FirmMembers` resolves names via `profiles` (`FirmMembers.tsx:60-64`), but no profiles SELECT policy is firm-aware (baseline `:4340-4342` requires the *target* to be a direct workspace member/owner of a workspace the viewer can reach). A firm member with no `workspace_members` row anywhere (the normal CPA-staff case at invite time) is invisible → the roster falls back to `m.user_id` (`FirmMembers.tsx:154`). Same class of issue will hit any future firm surface resolving user names.

### G14 — LOW/MED: `firm_child_label` has no writer
- Displayed in five surfaces (`FirmDashboard.tsx:119`, `FirmWorkspaces.tsx:71`, `FirmBilling.tsx:225`, inbox view, selector) and spec'd as editable ("edit child label", spec `:387`), but no UI and no edge function ever writes it, and the binding guard makes it service-role-only (`20260615172439` CRITICAL-2). It is permanently NULL in practice.

### G15 — LOW: Dead backend surfaces
- `create-firm-subscription` (the PaymentElement/3DS path) — complete, owner-gated, #61-safe — has **zero** UI invocations; superseded by `create-firm-checkout`. Deployed dead code.
- `list-pending-firm-invitations` — never invoked; `FirmMembers` reads `firm_invitations` directly via RLS.
- `v_firm_billing_period_summary` — consumed by nothing (grep: only types.ts).
- `add-firm-member` / `bind-workspace-to-firm` — documented ops paths, no UI (acceptable, but note the config.toml:180 comment "create-firm: ops-admin only" is now false).

### G16 — LOW: #102 holdout confirmed + small items
- `add-firm-member/index.ts:65` returns raw `insErr.message`; `:78` returns raw exception message in the catch — the last raw-DB-error leak of the #102 sweep (matches CLAUDE.md's note).
- `Login.tsx:66-67` navigates to unvalidated `next` (Signup validates `startsWith('/') && !startsWith('//')` at `Signup.tsx:159`); low risk with react-router but inconsistent.
- Release has no confirmation dialog despite billing + access consequences (`FirmWorkspaces.tsx:85-89`).
- No UI anywhere renders `firm_activity_log` — the firm audit trail (a core product promise) is write-only.
- `FirmNotMemberState` still doesn't link to the now-shipped `/app/firm/onboarding` (KNOWN_ISSUES line 2554 anticipated this); and since `/app/onboarding` is only reachable post-signup (`Signup.tsx:162` is the only navigator), **existing** users have no discoverable entry into firm creation at all.

---

## 4. Docs drift (code contradicts docs)

| # | Doc claim | Code reality |
|---|---|---|
| D1 | CLAUDE.md (Active Priorities + Phase-10 note, twice): "The one deferred piece is self-serve firm onboarding's Stripe checkout … a firm is ops-created via `create-firm`" | Self-serve onboarding + hosted checkout shipped (commit `6a94a8d`, PR #55): `FirmOnboarding.tsx`, `create-firm` self-serve (`index.ts:5-9`), `create-firm-checkout`, Onboarding fork (`Onboarding.tsx:210-217`) |
| D2 | KNOWN_ISSUES #105 item 5: "#105-C (remaining): FirmOnboarding fork + card-collection (SetupIntent) → create-firm-subscription 3DS flow" | #105-C is built — but via hosted Checkout (`create-firm-checkout`), not the SetupIntent/`create-firm-subscription` design; the latter is now dead code. Item never stamped |
| D3 | PHASE_10_BUILD_SPEC as-built header (`:11`): "DEFERRED: self-serve firm onboarding's Stripe checkout + create-workspace firm_id" | Both built (`create-firm-checkout`, `create-firm-workspace` + RPC). Header never updated |
| D4 | CLAUDE.md file map: "effective-access `src/lib/firmAccess.ts` (+ Deno mirror)" presented as a live layer; PHASE_9 spec `:711` mandates `hasWorkspaceAuthority` "everywhere" | Zero runtime call sites for any firmAccess export — tests only (G3) |
| D5 | `supabase/config.toml:180`: "create-firm: ops-admin only" | `create-firm` is self-serve for any authenticated user (`create-firm/index.ts:5-9,31-39`) |
| D6 | KNOWN_ISSUES #113: "Medium, latent … bites when self-serve firm-workspace creation ships" | That path shipped; the bug is live on every onboarding run (G4). `create_firm_workspace_locked`'s own comment ("triggers set plan='business'") is also wrong |
| D7 | CLAUDE.md/spec: firm "fully operable through the UI (members, child workspaces …)" | Child-workspace management is list/restrict/release only; no add/bind/label/join-request UI (G1, G2, G14) |
| D8 | `stripe-webhook:682`: children keep business "for a 30-day grace" | No grace timestamp, no cleanup — indefinite (G6) |

---

## 5. Recommendations (ordered)

1. **Ship "Add workspace" on FirmWorkspaces** (create-new via `create-firm-workspace` — the fn is ready) and a minimal "bind my existing workspace" path for the owner-owns-both case (`bind-workspace-to-firm` is ready). This single change makes the pricing model real. (G1)
2. **Fix the plan-lock trigger to `BEFORE INSERT OR UPDATE`** and force `plan='business'` on firm-bound INSERT (one-line migration; KNOWN_ISSUES #113 already contains the fix text). Backfill any mis-planned children. (G4)
3. **Call `refreshFirm()` after `accept-firm-invitation` succeeds** (AcceptFirmInvitation can consume `useFirm`), or navigate with a full reload. One-line class of fix. (G5)
4. **Wire the role mapping or delete it**: either make `has_workspace_permission` firm-aware + resolve `userRole` from firm membership in AppContext (using the already-tested `resolveEffectiveAccess`), or descope to "firm users are read-only in children" and say so in the spec/CLAUDE.md. The current half-state is the worst option. (G3)
5. **Decide the join-request feature's fate**: build the small creation+list UI the spec describes, or remove the two dead functions + table from the deployed surface and file the descope. (G2)
6. **FirmBilling honesty pass**: show quantity × price, add a cancel path (or at least document the release-last-child behavior), and either wire `billing_summary_mode` to something visible or remove the toggle. (G8, G6, G9)
7. **Add `l.deleted_at IS NULL` to both branches of `v_firm_user_pending_actions`** (or cancel chains in delete-lease). (G11)
8. **Reconcile the docs** (CLAUDE.md ×2, KNOWN_ISSUES #105/#113, PHASE_10 spec header, config.toml comment) — this violates the project's own Documentation & Completion Discipline rule and will mislead the next session exactly the way the rule predicts. (D1–D8)
9. Smaller: audit `firm_member_removed` (route removal through an edge fn or add a trigger), firm-aware profiles SELECT for roster names, release confirmation dialog, `switchFirm` UI (or cap firms at 1 until multi-firm is real), firm activity-log viewer, `add-firm-member:65/:78` structured errors, `firm_child_label` editor or column removal, link FirmNotMemberState → onboarding.
