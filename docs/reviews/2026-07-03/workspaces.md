# Multi-Workspace Lifecycle Review — Creation → Seeding → Switching → Transfer → Deletion

Reviewer lane: multi-workspace lifecycle ("how multiple workspaces work from creation to what is templated").
Repo: `/home/user/leaseio_staging`. All claims carry file:line evidence from the code as of this session. Severity per brief: critical = data loss/security/blocks core flow; high = core flow broken or badly misleading; medium = friction/confusion; low = polish.

---

## 1. Workspace creation paths — the complete map

There are **four** creation paths in the code (plus one uncontrolled fifth):

### 1a. Signup → Onboarding (first workspace, client-side insert)
- `src/pages/Signup.tsx:106-111` — `signUp()` with metadata (first/last/company/timezone), then `navigate('/app/onboarding?plan=…')` (`:162`).
- `src/pages/app/Onboarding.tsx:84-120` — client-side `INSERT INTO workspaces (name, owner_id, intended_plan)` (DB defaults apply), then `workspace_members` owner-admin row with `invited_at`/`accepted_at` (`:102-111`), then `profiles.current_workspace_id` (`:115-118`). Business signups are routed to `/app/settings/account?tab=billing&…&autoCheckout=1` (`:131-134`); Starter goes straight to `/app/leases`.
- DB trigger `handle_new_user` (`supabase/migrations/20260516120000_baseline_schema.sql:306-317`) inserts **only `id` + `email`** into `profiles`.
- RLS: `"Users can create workspaces" FOR INSERT WITH CHECK (owner_id = auth.uid())` (`baseline_schema.sql:3823`); the entitlement guard trigger pins Starter defaults on INSERT (`supabase/migrations/20260611150000_add_purchased_lease_credits.sql:196-231,296-300`).

### 1b. Settings "New workspace" (paid, $499/mo, edge function)
- UI: `src/components/workspace/NewWorkspaceDialog.tsx` (acknowledge → name → preview → confirm → 3DS → activating → activated, with resume + timeout branches). Entry points: sidebar dropdown (`src/components/layout/AppSidebar.tsx:651-659`), command palette (`WorkspaceCommandPalette.tsx:201-211`), My Workspaces panel (`src/pages/account/WorkspaceManagement.tsx:247-250`).
- Server: `supabase/functions/create-workspace/index.ts` — preview/confirm/cancel modes; atomic `create_workspace_locked()` RPC (`supabase/migrations/20260609120000_workspace_management_phase1.sql:132-219`): advisory lock per owner, idempotency, Business eligibility, 10-cap, Starter-baseline insert, **owner admin member row** (`:197-199`), dedupe row, `workspace_activity_log 'created'`.
- Stripe sub created `default_incomplete` (`create-workspace/index.ts:395-405`); the webhook is the sole entitlement promoter. Abandonment backstop: `supabase/functions/sweep-pending-workspaces/index.ts` (2h cutoff, Stripe-truth re-derivation before deletion, `:103-137`).
- This path is genuinely well-engineered: idempotency, resume-after-3DS-failure (`create-workspace/index.ts:149-201`, `AppSidebar.tsx:600-609`), fail-safe cancel that re-checks Stripe before destroying (`:258-283`), forensic `deleted_workspaces` rows on rollback (`:434-443`).

### 1c. Firm child workspace (Phase 10, edge function)
- `supabase/functions/create-firm-workspace/index.ts` (firm admin/owner only, `:40-48`) → `create_firm_workspace_locked()` (`supabase/migrations/20260616130000_create_firm_workspace_rpc.sql:18-74`): advisory lock per firm, idempotency, insert with `firm_id` (Phase 9 triggers set plan='business', counter, firm_joined_at), owner admin member row (`:62-63`), firm Stripe quantity sync (`index.ts:66-74`).

### 1d. Account-deletion-survivor / ops paths
- `create-firm` binds an *existing* workspace, doesn't create one — out of lane.

### 1e. The uncontrolled fifth path — raw PostgREST INSERT (HIGH)
The Onboarding path's RLS INSERT policy has **no count limit and no payment linkage**. Any authenticated user can replay `INSERT INTO workspaces (name, owner_id)` any number of times from the browser console; the entitlement guard only pins *values* (plan='starter', document_limit=15), not *quantity* (`20260611150000:196-231`). Consequences, all verified:
- The 10-workspace Business cap and the "$499 per additional workspace" model are client-bypassable. The migration's own claim that service-role-only EXECUTE on the RPC "forces every creation through the paying edge-function path" (`20260609120000_workspace_management_phase1.sql:128-131`) is false — the RPC isn't the only insert path; the plain INSERT policy is wide open.
- **Quota multiplication:** `process_lease` gates only `soft_deleted_at`/vault (`supabase/functions/process_lease/index.ts:1000-1033`) — it never checks `subscription_status`. A never-paid Starter workspace is fully functional (15 active leases, 15 AI extractions per rolling 30 days). Self-minted workspaces = unlimited free Opus/Haiku extraction, each fresh workspace resetting the quota. There is no subscription/trial enforcement anywhere in the frontend either (no intake surface reads `subscription_status`; grep hits are billing UI only).
- Not filed in `docs/KNOWN_ISSUES.md` (the #29 entitlement-guard item covers value tampering, not quantity; the 2026-05-17 exploitation audit at KNOWN_ISSUES.md:770-800 looked at column tampering only).

**Recommendation:** either (a) restrict the INSERT policy to users with zero owned workspaces (first-workspace-only; additional workspaces must come through `create_workspace_locked`), or (b) move first-workspace creation into an edge function/RPC too and drop the client INSERT policy. (a) is a one-migration fix that preserves Onboarding unchanged.

---

## 2. What a fresh workspace is seeded with (exact inventory)

From column defaults (`baseline_schema.sql:1874-1904`, defaults updated by `20260522000000:67-68`):

| Seeded | Value |
|---|---|
| plan / document_limit | `starter` / 15 (guard-pinned) |
| documents_used, addon_document_capacity, purchased_lease_credits | 0 |
| timezone | **`America/New_York` always** — signup timezone is never used |
| default_notification_days | 90 |
| billing_interval | monthly |
| discount_rate | 5.5 |
| approval_threshold | 0 (= everything requires approval when approvers exist) |
| covenant_threshold | NULL |
| backdoor_enabled | false |
| asset_type_config | `["Real Estate","Equipment","Vehicle","Other"]` |
| department/region/location/building_options | `[]` (empty) |
| separation_of_duties_default | true |
| counter_signature_default_due_days | 21 |
| report_* defaults | fiscal month 1, rounding 2, retention 90d |
| workspace_members | 1 owner-admin row (all three controlled paths) |
| profiles.current_workspace_id | set only by Onboarding path (`Onboarding.tsx:115-118`); create-workspace/firm paths leave it unchanged (switch is explicit — fine) |

**NOT seeded (and what happens):**
- **No approval policies** (`approval_policies` empty) → `resolve-approval-chain` falls back to the legacy path.
- **No functional roles** (`workspace_roles` empty: no manager_approver/financial_approver/signator) → on the legacy path with zero approvers, `getApprovalRequirements` requires nothing and **requests auto-approve**. This is deliberate and surfaced: the request form shows a "No approvers configured / This request will be auto-approved" warning (`src/components/workflow/LeaseRequestForm.tsx:437-449`), and the dashboard `OnboardingChecklist` tracks an "approvers" step (`src/components/dashboard/OnboardingChecklist.tsx:119-129`). So a fresh workspace is *not broken* — but it silently bypasses the product's central control (finance approval) until an admin assigns roles. Acceptable for a solo trial; risky default for the buyer's stated problem. Consider making the auto-approve state louder on the Dashboard (not only inside the form sheet).
- No risk watchlist entries (system `risk_templates` rows are global and apply automatically; custom list starts empty — fine, `src/components/workspace/RiskWatchlistManager.tsx:80-91`).
- No alert_rules, no user_preferences, no intake settings (email intake unbuilt).

**Nothing is templated.** No creation path copies configuration from an existing workspace or from any template — a Business owner's 5th workspace and a firm's 20th child each start from bare column defaults and must be hand-configured (asset types, departments, approval policies + chain steps, functional roles, thresholds, report settings, watchlist). See §8 for the templating proposal.

---

## 3. delete-account — the weakest destruction path (CRITICAL ×2, HIGH ×1)

`supabase/functions/delete-account/index.ts` predates the hardened `delete-workspace` and shares none of its safeguards:

### 3a. CRITICAL — No Stripe cancellation at all
`delete-account` deletes every owned workspace via `.delete().eq("owner_id", user.id)` (`:63-71`) **without cancelling a single Stripe subscription** — the file never imports Stripe. Compare `delete-workspace/index.ts:236-249` (`cancelWorkspaceSubscriptions` per workspace, plan subs + document packs) and `_shared/workspace_purge.ts:34-57`. A paying customer who deletes their account keeps being billed $249/$499/mo (+ packs, + every extra $499 multi-workspace sub) forever, with no in-app path back because the account is gone. KNOWN_ISSUES #120 files only the narrow firm-quantity-resync sliver of this; the total-non-cancellation is unfiled.

### 3b. CRITICAL — Account deletion destroys other tenants' lease records
Two independent mechanisms, same outcome:
- Explicit: `delete-account/index.ts:83-91` deletes `leases WHERE user_id = user.id` — `user_id` is the *uploader*, so this includes leases the user submitted into **someone else's workspace** (e.g., an employee's requests in the employer's repository: `LeaseRequestForm.tsx:275-283` stamps `user_id: user.id` + the employer's `workspace_id`).
- Schema-level: `leases_user_id_fkey → profiles(id) ON DELETE CASCADE` (`baseline_schema.sql:3579`), and `profiles_id_fkey → auth.users ON DELETE CASCADE` (`:3624`) — even without the explicit delete, removing the profile cascades away every lease the departing user ever uploaded, in any workspace, plus all CASCADE children (activity log, chains, rent schedules). Storage step `:49-61` also removes their uploaded PDFs from other tenants' repositories.
This directly violates the audit-defensible-repository promise: an employee leaving (and deleting their personal account) silently guts their employer's lease repository. Fix: re-point `leases.user_id` (and the storage purge) to `ON DELETE SET NULL` + keep attribution via the denormalized activity log; scope the explicit delete to workspaces the user owns.

### 3c. HIGH — delete-account half-fails and strands the account
`auth.admin.deleteUser` (`:140-145`) will raise FK violations for: firm owners (`firms.owner_id REFERENCES auth.users` with NO ACTION — `20260615172439_phase9_firm_layer_foundation.sql:43`), users who are `lease_owner_id` on surviving leases (`baseline_schema.sql:3554`, NO ACTION), and the file's own admitted `lease_change_sets.submitted_by` case (`delete-account/index.ts:107-110`). Because the function destroys workspaces + profile *before* attempting the auth delete, the failure mode is a **half-deleted account**: data gone, auth user alive, profile missing → every subsequent login breaks in `AppContext.fetchProfile` (`src/contexts/AppContext.tsx:93-100`). No pre-flight checks, no ordering protection, no forensic `deleted_workspaces` rows (compare `delete-workspace/index.ts:258-285`), and only 2 of 4 storage buckets purged with only the caller's own uploader prefix (`:49-61` vs `_shared/workspace_purge.ts:100-106`).

**Recommendation:** rewrite delete-account on top of the shared helpers: per owned workspace run the same forensic-row + Stripe-cancel + lease-delete + 4-bucket purge as delete-workspace; pre-flight the blocking FKs (firm ownership → refuse with instructions; lease_owner reassignments); only then delete profile/auth user.

---

## 4. Leave workspace is a silent no-op (HIGH)

`WorkspaceManagementContent.handleLeaveWorkspace` (`src/pages/account/WorkspaceManagement.tsx:183-208`) issues a client `DELETE FROM workspace_members WHERE workspace_id=? AND user_id=self`. The **only** DELETE policy on `workspace_members` is `"Owners can remove members" USING (is_workspace_owner(...))` (`baseline_schema.sql:3787`; no later migration adds a self-leave policy — verified across `supabase/migrations/`). RLS therefore filters the delete to zero rows, PostgREST returns **no error**, and the UI shows `toast.success('Left "…"')`, may switch the active workspace (`:196-199`), and refreshes — after which the workspace is still in the list. The feature has never worked; the success toast makes it badly misleading. Bonus: the "Leave" button is also rendered for firm-derived rows (`memberOnly` includes synthetic `role:'editor'` firm children, `AppContext.tsx:375-387`) which have **no membership row at all** to delete.
**Fix:** add a self-delete policy (`FOR DELETE USING (user_id = auth.uid())`) or a `leave-workspace` edge function (which could also clean `workspace_roles` + chain assignments); make the client check the deleted row count before claiming success. Same zero-row-blindness class exists in `RenameWorkspaceInline.tsx:61-68` (success toast on 0-row UPDATE) — lower risk since it's only rendered for owned workspaces.

Related known-but-worth-repeating: removing a member (`MembersPanel.tsx:114-148`) deletes only the `workspace_members` row — the member's `workspace_roles` rows (manager_approver/financial_approver/signator) survive, so legacy routing/notification (`src/lib/leaseNotifications.ts:72`, `retryRequestRouting.ts:52-53`) still counts and notifies the removed user (KNOWN_ISSUES notes the chain-orphan half at 2161; the functional-role staleness is only obliquely covered by #128).

---

## 5. Ownership transfer → prior owner's card is chargeable by the new owner (HIGH)

The transfer itself is exemplary: atomic RPC with row lock, mandatory demote-to-admin, audit row in the same transaction (`supabase/migrations/20260609180000_transfer_workspace_ownership_rpc.sql:24-126`), owner-only edge function with same-404-for-missing/not-yours (`transfer-workspace-ownership/index.ts:115-138`), and the "billing does not transfer" v1 limitation is surfaced (`:217-228`).

But billing-not-transferring interacts with `create-workspace`'s card resolution: `resolveCustomerAndCard` picks the caller's Stripe customer from **any owned Business workspace's `stripe_customer_id`** (`create-workspace/index.ts:70-78`). After a transfer, the workspace row still carries the *prior owner's* customer id under the *new owner's* `owner_id`. The new owner then passes eligibility (`create_workspace_locked` checks only "owns an active Business workspace", `20260609120000:174-182`) and the new $499 subscription is created **on the prior owner's customer with the prior owner's default card** (`create-workspace/index.ts:395-405`). The confirm modal even renders the prior owner's brand/last4 as if it were the caller's. The person consenting is not the person charged. Similar leakage applies to any surface resolving billing from `workspaces.stripe_customer_id` for the new owner (customer-portal, get-billing-summary — adjacent lanes).
**Fix:** on transfer, either NULL `stripe_customer_id`/`stripe_subscription_id` (forcing re-checkout, matching the "billing does not transfer" contract), or exclude transferred-in workspaces from `resolveCustomerAndCard` by verifying the Stripe customer's email/metadata matches the caller.

---

## 6. Signup data is silently discarded; workspace-less users dead-end (HIGH + MEDIUM)

- **Dead-end (HIGH):** the only navigation to `/app/onboarding` in the entire app is Signup's immediate `navigate` (`Signup.tsx:162`). `ProtectedRoute` doesn't check for a workspace (`src/components/auth/ProtectedRoute.tsx:23-28`), `Login` always goes to `/app/dashboard` (`Login.tsx:65-67`, ignoring `location.state.from` that ProtectedRoute sets), and no layout/page redirects a workspace-less user to onboarding (grep: zero other `/app/onboarding` references). So: (a) with email confirmation enabled, the post-signup navigate bounces off ProtectedRoute to /login; after confirming (redirect target is `/` — `AuthContext.tsx:68`) and logging in, the user lands on an empty dashboard **with no way to ever create their first workspace** — the primary signup flow dead-ends; (b) a user who deletes/loses their last workspace lands in the same stranded state (`AppContext.tsx:168-173` leaves `workspace=null` and every page renders empty). **Fix:** redirect `workspace === null && !isLoading` app routes to `/app/onboarding` (one check in ProtectedRoute or AppLayout).
- **Discarded profile fields (MEDIUM):** Signup collects first/last name, company, timezone (`Signup.tsx:106-111`) into auth metadata; `handle_new_user` copies only id+email (`baseline_schema.sql:306-317`); no migration reads `raw_user_meta_data` (verified). So profiles stay nameless — members lists show raw emails (`MembersPanel.tsx:91-94`), `AppContext` timezone falls back to `America/New_York` (`AppContext.tsx:108`), and the workspace's timezone is likewise never set from signup. The user must re-type everything in Account Settings (`AccountSettings.tsx:282-285`). Also, the `ai_processing_consent_at` write right after signup (`Signup.tsx:132-146`) is a no-op when email confirmation is on (no session yet) — the consent timestamp the checkbox promises is never recorded for the standard flow.
**Fix:** extend `handle_new_user` to copy `raw_user_meta_data` (first/last/company/timezone) + record consent server-side.

---

## 7. Switching UX & state isolation (MEDIUM findings)

The switcher stack (sidebar dropdown `AppSidebar.tsx:568-665`, Cmd+K palette `WorkspaceCommandPalette.tsx`, My Workspaces panel) is solid: firm-grouped listing, recents (localStorage, cleared on sign-out — `AuthContext.tsx:33-37,81-92`), pending-workspace "Resume" interception in the dropdown (`AppSidebar.tsx:596-609`).

- **State isolation is sound at the data layer.** `switchWorkspace` (`AppContext.tsx:416-423`) updates `profiles.current_workspace_id` and refetches; sampled React Query keys consistently include `workspace?.id` (`useNeedsAction.ts:37`, `Portfolio.tsx:296`, dashboard components) so no cross-workspace cache bleed was found; RLS backstops reads. Switching to an inaccessible id self-heals (fetch fails → falls back to earliest owned/member workspace and rewrites `current_workspace_id`, `AppContext.tsx:134-192`).
- **MEDIUM — switch doesn't navigate:** none of the switch actions navigate, so a user on `/app/leases/<id>` of workspace A stays on A's lease detail while the sidebar/context now says B (they can remain a member of both, so RLS still serves the page) — a mixed-context view that misattributes which workspace the user is "in". Recommend navigating to `/app/dashboard` on switch (Slack behavior) or at least when the current route is entity-scoped.
- **MEDIUM — palette bypasses the pending-workspace trap the sidebar fixed:** `WorkspaceCommandPalette.handleSelect` always calls `switchWorkspace` (`WorkspaceCommandPalette.tsx:121-125`), including for rows it itself badges "pending" (`:151-155`) — exactly the "switching INTO an unactivated workspace and trapping them there" the dropdown intercepts (`AppSidebar.tsx:600-603`). Same for the "Switch to" buttons in `WorkspaceManagement.tsx:321-330,431-438`. Since the palette only appears at >5 workspaces, the users most likely to have a pending workspace are the ones exposed.
- **LOW — OnboardingChecklist bleeds across workspaces:** lease count is by `user_id` with no workspace filter and notification count has no workspace filter (`OnboardingChecklist.tsx:98-105,132-139`) — uploading in workspace A marks "upload" complete in fresh workspace B.

---

## 8. Deletion (owner path) — healthy; sweep — unscheduled (MEDIUM)

`delete-workspace` is the strongest function in the lane: owner + typed-name confirm server-side (`delete-workspace/index.ts:159-181`), forensic row before destruction with abort-on-failure (`:258-285`), explicit lease delete before workspace delete (leases FK is SET NULL, `:287-309`), shared 4-bucket recursive purge + Stripe cancel (`_shared/workspace_purge.ts`), firm counter/billing resync (`:336-349`). `DeleteWorkspaceDialog.tsx` enforces typed-name client-side too. Two notes:
- **MEDIUM — sweep cron is not scheduled and its operator checklist is missing:** `docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md:540-556` says sweep scheduling was "added to docs/ops/OPERATOR_PLAYBOOK.md"; the playbook contains zero references to `sweep-pending-workspaces` or `SWEEP_PENDING_WORKSPACES_CRON_SECRET` (verified by grep across `docs/ops/`). Until scheduled, abandoned pending workspaces persist indefinitely (they count toward the 10-cap and sit in the switcher; the Resume/cancel affordances mitigate but don't collect true abandoners).
- **LOW:** `create_firm_workspace_locked` writes `workspace_creation_requests.status='confirmed'` (`20260616130000:65-66`) — a value outside the documented `pending|active|failed|canceled` vocabulary (`20260609120000:86`); harmless today (no CHECK constraint; sweep filters `pending`) but it will surprise anyone adding the #51 CHECK constraint.
- **LOW:** DeleteWorkspaceDialog copy doesn't mention that the workspace's paid subscription(s) will be cancelled — the one consequence an owner can't infer.

---

## 9. Docs drift observed (code vs CLAUDE.md/specs)

1. `CLAUDE.md:228` — "`workspace_approvers` … has no read/write path in the frontend." Stale: it has a **read** path (`src/lib/approverCandidates.ts:1-30`, `LeaseReview.tsx:899` request-approval candidates). Still no write path.
2. `CLAUDE.md:201` — points to `supabase/README.md` as where Studio-configured storage/auth settings are documented; **the file does not exist** (`ls supabase/` → config.toml, functions, migrations, tests). The auth email-confirmation setting that determines whether the §6 dead-end fires is therefore undocumented anywhere in the repo.
3. `docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md:546-556` — operator checklist claimed present in OPERATOR_PLAYBOOK.md; absent (§8).
4. Stale in-code comments claiming create-workspace owners get no member row (`WorkspaceManagement.tsx:83-84,146-147`; `20260609180000:74-76`) — the RPC has inserted one since Phase 1 (`20260609120000:197-199`). Harmless defensive code, but it misdirects readers.
5. `20260609120000:128-131` — "restricting EXECUTE to service_role forces every creation through the paying edge-function path" — contradicted by the open client INSERT policy (§1e).
6. KNOWN_ISSUES #120 understates delete-account's billing gap (files only firm-quantity resync; total Stripe non-cancellation is unfiled — §3a).

---

## 10. Templating proposal (what "new workspace from template" should include)

Today every new workspace starts at bare column defaults (§2) — for the Business multi-workspace buyer and especially the firm buyer (N subsidiaries needing identical policy), that's N× manual re-configuration with no export/import. A minimal, high-leverage template model:

1. **Template = a designated source workspace + a copy-set**, executed server-side (extend `create_workspace_locked`/`create_firm_workspace_locked` with an optional `p_template_workspace_id` the caller must own/admin).
2. **Copy (safe, structural):** `asset_type_config` + `asset_type_abbreviations`; `department/region/location/building_options`; `discount_rate`, `approval_threshold`, `covenant_threshold`; `separation_of_duties_default`, `counter_signature_default_due_days`, `default_notification_days`, timezone; `report_*` settings; custom `risk_templates` rows; `approval_policies` + `approval_chain_steps` **only for role-based steps** (steps pinned to specific user ids can't transfer — copy them as unassigned-role steps and flag the policy "needs assignees").
3. **Do NOT copy:** members, `workspace_roles` (people differ per workspace), billing/entitlement columns (guard-protected anyway), leases/data, `backdoor_enabled`.
4. **Post-create checklist:** surface the existing OnboardingChecklist pre-seeded with "assign approval roles" and "review copied policies" as the two open steps — this converts the current silent auto-approve default (§2) into an explicit task.
5. For firms specifically, default the template source to the firm's first child ("make this the firm standard") — one decision covers the whole portfolio.

---

## 11. Verified-healthy (no findings)

- `create-workspace` money-path invariants (idempotency-in-ref, secret hygiene, non-dismissable in-flight modal, Stripe-truth-before-destroy, resume) match the spec claims — verified in code, not just comments (`NewWorkspaceDialog.tsx:165-234,476-517`; `create-workspace/index.ts:258-283`).
- `sweep-pending-workspaces` fail-safe ordering (never deletes on Stripe uncertainty, `:119-124`; marks active on live sub, `:126-137`).
- Transfer RPC atomicity + audit-iff-committed (`20260609180000:36-118`).
- i18n: all `workspace.create.*` / `workspace.transfer.*` keys exist in both locales with zero EN↔ES key drift (verified programmatically: 1697/1697 keys). The hardcoded-English `WorkspaceManagement.tsx`/`DeleteWorkspaceDialog.tsx` strings are already filed (KNOWN_ISSUES ~:1400).
- Workspace RLS SELECT/UPDATE/DELETE posture matches CLAUDE.md (server-only deletes #83, owner+admin update #70, owner-immutability trigger).
