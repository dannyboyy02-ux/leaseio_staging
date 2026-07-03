# J1 — First-Run Journey: Cold Signup → Workspace → Dashboard → Team → First Request

Reviewer: first-run journey walkthrough (code-traced, no assumptions). Every claim carries file:line evidence from the repo at `/home/user/leaseio_staging`. Where something cannot be verified from code (hosted Supabase settings, actual deployed edge-function versions), it is explicitly labeled as unverifiable.

---

## 1. The journey, step by step (what the code actually does)

### Step 0 — Landing page (cold visitor)

- Hero renders two CTAs: primary **"Start Your Free Lease Audit"** → `/lease-audit` (`src/components/landing/HeroSection.tsx:33`, copy at `src/locales/en/common.json:298`), secondary **"Start Free Trial"** → `/signup` (`HeroSection.tsx:39`).
- **The primary CTA is auth-walled.** `/lease-audit` is wrapped in `ProtectedRoute` (`src/App.tsx:129-135`). A cold visitor — the exact audience of a lead magnet — clicks the main button and is bounced to `/login` with no explanation. Worse, even if they sign in, `Login.tsx` ignores the redirect state `ProtectedRoute` passes (`ProtectedRoute.tsx:25` sets `state={{ from: location }}`; `Login.tsx:65-67` reads only a `?next=` search param that ProtectedRoute never sets) and sends them to `/app/dashboard`. **The free-audit funnel never completes for cold traffic.** Docs call the Free Lease Audit the "GTM lead magnet" (CLAUDE.md Pricing section); as built, it's only reachable by people who already have accounts and type the URL.
- Pricing section subtitle promises "Start with a 7-day free trial. Cancel anytime." (`en/common.json:356`) — see Finding F1 on what the trial actually is.

### Step 1 — Signup (`src/pages/Signup.tsx`)

What the user sees: first/last name, work email, company name, timezone (11 options), password (min 8 chars, `Signup.tsx:80`), confirm, two required checkboxes (ToS + AI-processing consent, `Signup.tsx:88-95`). Reasonable, low-friction form. The AI-consent checkbox is a good compliance touch.

Code path after submit (`Signup.tsx:106-163`):
1. `signUp()` → `supabase.auth.signUp` with `emailRedirectTo = origin/` (`AuthContext.tsx:68-77`).
2. Best-effort write of `profiles.ai_processing_consent_at` using `getSession()` (`Signup.tsx:132-146`). **If email confirmation is enabled on the hosted project, there is no session at this point and the consent timestamp is silently never written** (console.warn only). Unverifiable from repo whether confirmation is on, but `Login.tsx:48` explicitly handles an `'Email not confirmed'` error, so the code anticipates it.
3. Toast: "account created / **check your email**" (`Signup.tsx:148-151`) — then immediately `navigate('/app/onboarding?plan=…&billing=…')` (`Signup.tsx:162`).

**The confirmation-enabled path is a dead end**: no session → `ProtectedRoute` bounces `/app/onboarding` to `/login` (`ProtectedRoute.tsx:23-26`); the intended destination (with the plan/billing params) is dropped because Login never reads `state.from` (`Login.tsx:65-67`); the email link lands on `/` — the marketing Landing page, which is **not auth-aware** (no `useAuth` anywhere in `Landing.tsx`/`LandingNav.tsx`; nav still shows "Sign in / Get started"). The user must figure out to click Sign in, and then lands on `/app/dashboard` — **skipping onboarding entirely** (see Step 3-b for what that shell looks like).

Minor: "Remember me" checkbox on Login is wired to nothing — `rememberMe` state is set (`Login.tsx:19,142-151`) and never used by `signIn()` (`Login.tsx:40`). Dead control.

Minor: password policy inconsistency — Signup accepts any 8+ chars (`Signup.tsx:80`); the invite-acceptance page requires upper+lower+number (`src/pages/AcceptInvite.tsx:28-33`). Two teammates joining the same product meet two different rules.

### Step 2 — Onboarding (`src/pages/app/Onboarding.tsx`)

Three-step wizard: name workspace → choose plan → confirm.

- Step 1: workspace name prefilled from signup's company name (`Onboarding.tsx:44-49`). Good. Below the Continue button sits a small "managing multiple companies → set up a firm" fork to `/app/firm/onboarding` (`Onboarding.tsx:210-217`) — a brand-new SMB user can wander into a $499-per-child firm-billing flow one click into onboarding. `create-firm` does allow self-serve creation (`supabase/functions/create-firm/index.ts:6,31-34`), so it's not a dead end, but it's an odd offer to a user who hasn't seen the product yet.
- Step 2: plan chooser renders `PLAN_ORDER` (exactly 2 plans, `pricing.ts:149`) inside a `sm:grid-cols-2 lg:grid-cols-4` grid (`Onboarding.tsx:236`) — half-empty row on desktop, a leftover from a 4-plan design. Dead branches: `plan.price.monthly === 0 ? 'Free'` and `maxActiveLeases === -1 ? 'Unlimited'` (`Onboarding.tsx:259-264`) can never fire for these two plans. Copy: "Start with a 7-day free trial" (`en/common.json:1664`).
- Step 3: confirm → `handleCreateWorkspace` (`Onboarding.tsx:51-145`) does three **client-side** inserts: `workspaces` (Starter defaults enforced by the entitlement trigger; `intended_plan` records the choice), `workspace_members` (owner as admin), `profiles.current_workspace_id`. KNOWN_ISSUES **#8 (duplicate workspace creation at signup/onboarding) is still open** (`docs/KNOWN_ISSUES.md:251-285`).
- Routing after creation (`Onboarding.tsx:131-135`): **Business** → `/app/settings/account?tab=billing&billing=…&autoCheckout=1`, which auto-fires Stripe checkout (`AccountSettings.tsx:446-459`) with a real 7-day trial (`create-checkout/index.ts:44-46,210`). Cancel returns to the billing tab (`create-checkout/index.ts:198`) where the abandoned-checkout recovery banner shows (`AccountSettings.tsx:1047-1065`). This path is coherent.
- **Starter** → `navigate('/app/leases')`. **No checkout. No card. No trial. Ever.** See Finding F1.

### Step 3-a — First render, Starter path (`/app/leases` then Dashboard)

- Leases page with zero leases shows `EmptyLeaseState` — a genuinely good empty state: three value-prop tiles + a prominent "Add lease" CTA opening the upload modal (`src/components/leases/EmptyLeaseState.tsx`, gated at `Leases.tsx:721-725`). Path 2 (direct add → AI extraction) is reachable on day one.
- Dashboard (`src/pages/Dashboard.tsx`): header "Welcome back, {name}", **"New Request"** button (untranslated literal, `Dashboard.tsx:67`), `OnboardingChecklist`, then widgets. Widget empty states are mostly decent: NeedsAction "No actions required" (`NeedsAction.tsx:53`), UpcomingRisks "No immediate risks detected" (`UpcomingRisks.tsx:177`), RecentActivity "No recent activity" (`RecentActivity.tsx:173`), PipelineByDepartment gives an actionable hint (`PipelineByDepartment.tsx:128`), UpcomingEvents hides itself entirely when empty (`UpcomingEvents.tsx:260`). SummaryStrip shows $0 / 0 / all-clear tiles. A fresh workspace is empty but not broken.
- **Trial-state visibility: there is nothing to see.** The sidebar trial pill and billing-tab trial banner both key on `subscriptionStatus === 'trialing'` (`AppSidebar.tsx:279-289`, `AccountSettings.tsx:995`), which only the Business/Stripe path ever sets. A Starter workspace has `subscription_status = null` forever: no pill, no banner, no "you haven't set up billing" nudge anywhere in the shell. (KNOWN_ISSUES #63 already notes the pill also ignores `past_due`; the null case is worse and unfiled.)

### Step 3-b — First render, stranded path (authenticated, no workspace)

`/app/onboarding` is reachable from exactly one place in the entire app: Signup's post-submit navigate (`grep 'app/onboarding'` → only `Signup.tsx:162` and the route decl `App.tsx:161`). Nothing else ever routes a workspace-less user there:

- `ProtectedRoute` checks only auth, not workspace (`ProtectedRoute.tsx:10-28`).
- Login always goes to `/app/dashboard` (`Login.tsx:67`).
- `AppContext.fetchProfile` resolves `workspace = null` and just stops (`AppContext.tsx:168-173`).
- Dashboard renders the full shell: checklist hidden (`OnboardingChecklist.tsx:66-69` leaves `loadingPrefs` true → `return null` at :161), SummaryStrip renders an empty grid (`SummaryStrip.tsx:44-47` → `stats=[]`), and the "New Request" drawer opens but its Submit button is **silently disabled** because `canSubmit` requires `!!workspace` (`LeaseRequestForm.tsx:199-202,760`) — no message explains why.
- The only "create workspace" affordance in the app is `NewWorkspaceDialog` (My Workspaces panel, `WorkspaceManagement.tsx:247-250`), which is the **paid Business multi-workspace flow**: non-Business callers get ack-state `"starter"` → "route to upgrade" (`NewWorkspaceDialog.tsx:63-69`), and upgrading requires a workspace's billing tab — circular.

So: any user who abandons the 3-step onboarding wizard (closes the tab at step 2, session hiccup, or the email-confirmation detour in Step 1) signs in later to a permanently workspace-less shell with no route back to workspace creation short of hand-typing `/app/onboarding`. **High-severity dead end on the front door.**

### Step 4 — Inviting 2 teammates

- The checklist's "Invite team members" step opens `InviteMemberDialog` directly from the dashboard (`OnboardingChecklist.tsx:252-261`) — good affordance. Dialog collects name/email/role with clear role descriptions (`InviteMemberDialog.tsx:27-31,165-178`), calls `send-invite`, and handles resend / already-member / existing-account-direct-add (`InviteMemberDialog.tsx:90-98`).
- **Seat limits are unenforced.** `PLANS.starter.maxUsers = 3` (`pricing.ts:56`) is referenced nowhere outside pricing config and a vault test (grep across `src/` and `supabase/functions/` — `send-invite/index.ts` has no member-count check at all). The pricing table (CLAUDE.md, landing copy `plan.feature.3_users`) advertises a 3-user Starter cap that the product will happily exceed.
- Invitee experience (`AcceptInvite.tsx`) is one of the strongest flows in the product: token check, create-password with live requirements, auto-sign-in, wrong-account and needs-login branches all handled (`AcceptInvite.tsx:55-190`). They land on `/app/dashboard` with membership resolved.

### Step 5 — Assigning roles

Settings → Workspaces → Members (`WorkspacesSection.tsx:61` → `WorkspaceSettings` `users` tab, `WorkspaceSettings.tsx:565-753`). The new admin faces **three different role systems on one screen**:

1. `MembersPanel`'s per-member workspace-role select: admin / editor / viewer (writes `workspace_members.role`, `MemberRoleSelect.tsx`).
2. "Approval Chain" card: Manager Approval / Financial Approval single-holder slots (writes `workspace_roles` rows `manager_approver` / `financial_approver`, `WorkspaceSettings.tsx:578-673`) — **only rendered when `members.length > 1`** (`WorkspaceSettings.tsx:579`).
3. "Other Roles" grid: **Submitter** and **Admin** checkboxes per member (writes `workspace_roles` `submitter`/`admin`, `WorkspaceSettings.tsx:676-732`).

Frictions here:
- Two different toggles are both labeled **"Admin"** with different backing tables and different semantics (workspace access role vs functional role). No explanation of the difference on screen.
- The owner's row shows a **"Owner — all roles"** badge (`WorkspaceSettings.tsx:706-711`), but the owner actually holds **zero** functional roles — legacy approval routing counts only `workspace_roles` rows (`approvalRouting.ts:40-58`; `resolve-approval-chain/index.ts:1103-1121`), so an "all roles" owner does not count as an approver and requests auto-approve right past them.
- A helpful warning ("No Financial Approver assigned — commitments will stall after manager approval", `WorkspaceSettings.tsx:665-672`) exists, but only for the financial slot, and only once the card is visible (≥2 members).

### Step 6 — Approval setup prompting, and the first request in a policy-less workspace

**Is approval setup ever prompted before someone submits?** Only two places, both flawed:

1. The dashboard checklist step "Set up approval roles" (`OnboardingChecklist.tsx:39-47`) — points at Members (the **legacy** role slots), never at Approval Rules (`/app/settings/approval-policies`, the canonical policy engine per `docs/APPROVAL_ROUTING_ARCHITECTURE.md` and CLAUDE.md "replacing the legacy fixed model"). Its completion check is `count(workspace_roles) > 0` (`OnboardingChecklist.tsx:120-128`) — ticking a single **Submitter** checkbox "completes" approval setup with zero approvers. And for a **solo** workspace it is uncompletable: the Approval Chain card is hidden (`members.length > 1` gate) and the owner's row has no checkboxes ("Owner — all roles"), so no `workspace_roles` row can ever be created — the step the checklist demands is literally impossible until an invite is accepted.
2. The amber banner inside the request form itself ("No approvers configured … will be auto-approved", `LeaseRequestForm.tsx:438-466`) — shown at the moment of submission, admin gets a deep link, non-admins get "ask your admin". This is the only honest prompt, and it arrives last.

**What actually happens on the first submission (fresh, policy-less, role-less workspace)** — fully code-traced:

1. Lease inserted client-side as `lifecycle_status='draft'`, `intake_source='request_workflow'`, `status='Ready'` (`LeaseRequestForm.tsx:275-308`), `created` activity row written (`:325-337`).
2. `resolve-approval-chain` invoked (`:348-351`). Server: `matchPolicy()` finds no policies → legacy branch → recomputes requirements server-side from `workspace_roles` (`resolve-approval-chain/index.ts:1096-1122`) → no manager, no financial → `getInitialStatusAfterSubmission` returns `'approved'` (`approvalRouting.ts:68-74`) → server flips draft → **approved** and logs `auto_approved: true` (`resolve-approval-chain/index.ts:1124-1140`).
3. User is navigated to the lease page, which shows "This request is approved. Upload the executed document to advance to Executed status" (`LeaseReview.tsx:2061-2063`) and the `UploadExecutedDocumentDialog` (`:2450-2456`). Not a dead-end state — but the very first thing the "lease control" product does is **approve a commitment with no human review**, guarded only by an amber note.
4. If routing fails (network / ambiguous policy), the lease stays in `draft` and a dedicated retry page renders (`LeaseReview.tsx:2068-2119`) — good half-state handling.

**Misleading preview when policies DO exist:** the form's route preview and the "no approvers" banner read **only legacy `workspace_roles`** (`LeaseRequestForm.tsx:131-144,204-223`). A workspace whose admin diligently built approval policies (chain steps, signator stage) but never touched the legacy slots will see *"No approvers configured — this request will be auto-approved"* on every request, while submission actually routes through the policy chain to `concept_submitted`. The two approval systems' UIs contradict each other on the product's core promise.

**The full Path-1 story is policy-only.** The owner's described flow (manager → quote → manager → CFO/signator → finance visibility) exists only in the chain vocabulary (`lifecycleStates.ts:44-56,184-191`; signator stage only in the policy editor, `ApprovalPolicyEditPage.tsx:93,205,287` — `FunctionalRole` has no `'signator'`, `types/lifecycle.ts:76`). A fresh workspace defaults to the legacy 2-role model, and nothing in onboarding ever points at "Approval Rules". The empty-state on the policies page ("No approval rules yet. Click New rule…", `ApprovalPoliciesListPage.tsx:263-269`) is fine, but you have to find the page (Settings → Workspaces → Approval Rules → external page).

**Notification delivery caveat (deploy-state, flagged honestly):** approver notifications write `lease_activity_log` comment rows with `recipient_ids` (`leaseNotifications.ts:63-80`); email delivery depends on the `dispatch-notifications` cron, which `docs/DEPLOY_RUNBOOK_2026-06-18.md:41-49` marks "⏳ NOT DONE (still required)", same for the `resolve-approval-chain` redeploy (the deferred #84). If the deployed function copy predates the server-side draft-flip (Cluster A, 2026-06-23 per CLAUDE.md), first submissions would strand in draft. **Cannot be verified from the repo — verify the deployed function versions before customer #1.**

---

## 2. Findings (ranked)

### F1 — CRITICAL: Starter signups never pay, can never pay, and get no trial — contradicting all pricing docs and copy
- Starter onboarding path never touches Stripe: `Onboarding.tsx:131-135` routes Starter straight to `/app/leases`. The 7-day trial exists **only** inside `create-checkout` (`create-checkout/index.ts:44-46,210`), which Starter never reaches.
- There is no UI path to *start* a Starter subscription afterward: the plan picker disables the current plan ("Current plan", `PlanPickerDialog.tsx:134-137`), and `handleAdjustPlanSelect` only handles upgrade (checkout) or downgrade (portal) (`AccountSettings.tsx:588-595`). A Starter workspace's only purchase option is Business.
- No enforcement gates a never-subscribed workspace: `process_lease` blocks only `canceled_at`/`soft_deleted_at`/vault (`process_lease/index.ts:1000-1046`); quota logic gives Starter 15 active leases + 15 Opus/Haiku extractions per rolling 30 days, indefinitely, at $0.
- Meanwhile landing + onboarding promise "Start with a 7-day free trial. Cancel anytime" (`en/common.json:356,1664`) and CLAUDE.md/PRODUCT_STRATEGY declare $249/$499 with 7-day trial and **no free tier**. As built, Starter *is* a free tier with unmetered AI cost. Docs drift + revenue-critical.

### F2 — HIGH: Workspace-less authenticated users are permanently stranded (no route back to onboarding)
Evidence chain: `Signup.tsx:162` is the sole navigator to `/app/onboarding`; `Login.tsx:65-67` ignores `ProtectedRoute`'s `state.from` (`ProtectedRoute.tsx:25`); `AppContext.tsx:168-173` accepts null workspace; `LeaseRequestForm.tsx:199-202` silently disables Submit; `NewWorkspaceDialog.tsx:63-69` gates first-workspace creation behind Business. Reachable by: abandoning the 3-step wizard, the email-confirmation detour (Step 1), or any pre-workspace re-login. Fix is one line of routing (redirect authenticated+workspace-less to `/app/onboarding`) or an in-shell "finish setting up your workspace" card.

### F3 — HIGH: Primary landing CTA (Free Lease Audit) is auth-walled and its redirect is dropped
`App.tsx:129-135` (ProtectedRoute on `/lease-audit`), `HeroSection.tsx:33`, `Login.tsx:65-67`. Cold visitor clicks the main hero button → login wall → (if they sign in) dashboard, never the audit. The lead magnet cannot convert cold traffic; combined with F2's ignored `state.from`, even warm users lose the destination.

### F4 — HIGH: First request in a fresh workspace is auto-approved; the only prompt arrives at submission time; preview lies when policies exist
Auto-approve path: `approvalRouting.ts:45-47,68-74`; `resolve-approval-chain/index.ts:1096-1140` (`auto_approved: true`). Prompting gaps: checklist step counts any `workspace_roles` row (`OnboardingChecklist.tsx:120-128`), is uncompletable solo (`WorkspaceSettings.tsx:579,706-711`), and points at the legacy system. Preview reads only legacy roles → contradicts chain routing when policies exist (`LeaseRequestForm.tsx:131-144,204-223,438-466`). For a product whose pitch is "finance knows about every lease **before** it's signed", the default-configured path is a control bypass with a whisper of a warning.

### F5 — MEDIUM: Two approval systems, three role systems, two "Admin"s — unexplained on one screen
`MemberRoleSelect` (workspace_members admin/editor/viewer) vs "Other Roles" Admin checkbox (workspace_roles) on the same Members tab (`WorkspaceSettings.tsx:676-732`); "Approval Chain" slots (legacy) vs "Approval Rules" page (policies) with no cross-link or explanation of precedence (policies win at runtime — `resolve-approval-chain/index.ts:1096`). "Owner — all roles" badge is factually wrong for routing purposes. This is exactly the over-complication the owner fears; consolidation guidance in §3.

### F6 — MEDIUM: Starter's 3-user seat cap is unenforced anywhere
`pricing.ts:56` (`maxUsers: 3`) has zero consumers (grep: only `_shared/monitoring/workspace_quotas.ts` comments and a vault test). `send-invite/index.ts` performs no member-count check. Pricing table and landing copy advertise the cap.

### F7 — MEDIUM: Trial/billing state is invisible exactly when it matters
Pill/banner only for `trialing` (`AppSidebar.tsx:279-289`, `AccountSettings.tsx:995`); a null-subscription Starter workspace shows nothing anywhere; `past_due` has no global signal (already filed as KNOWN_ISSUES #63). The answer to "am I on a trial? when do I get charged?" for the default signup path is: the product never says.

### F8 — MEDIUM: Onboarding checklist steps measure the wrong things
- "Upload your first lease" checks `leases.user_id = me` across **all** workspaces (`OnboardingChecklist.tsx:98-105`) — cross-workspace bleed.
- "Configure notifications" checks any confirmed `lease_notifications` visible to the user (`:131-139`), links to a read-only feed with nothing to configure (`Notifications.tsx`), and self-completes as a side effect of the first request (`leaseNotifications.ts:29-37` inserts `is_confirmed: true`).
- "Set up approval roles": see F4.
- Step 1 links to `/app/imports` (Import History) rather than the Leases page whose empty state is the intended first-lease surface (`OnboardingChecklist.tsx:30`).

### F9 — MEDIUM (deploy-state risk, unverifiable from repo): stale deployed `resolve-approval-chain` would strand every first request in draft
Repo code does the server-side draft→X flip (`resolve-approval-chain/index.ts:1124-1140`); the browser no longer writes lifecycle (governance trigger). `docs/DEPLOY_RUNBOOK_2026-06-18.md:41-46` marks the redeploy "NOT DONE"; CLAUDE.md still lists it as the outstanding operator step. If the deployed copy predates the flip, submission → draft + routing-failed page for every user. Verify deployed version.

### F10 — LOW: dead/incomplete odds and ends on the journey surfaces
- "Remember me" does nothing (`Login.tsx:19,142-151`).
- `canUploadExecutedDocument` / `canAccessVarianceReview` exported, never imported (grep; `authorization.ts:41-46`) — the Phase-4 role gating they encode is not wired; the executed-upload dialog shows to any non-read-only user at `approved` (`LeaseReview.tsx:2450`).
- Hardcoded English `title: 'Set up approval roles'` overrides existing ES translations (`OnboardingChecklist.tsx:42-44,209-210` vs `es/common.json:1645-1646`).
- Onboarding plan grid `lg:grid-cols-4` for 2 plans + dead Free/Unlimited branches (`Onboarding.tsx:236,259-264`).
- Untranslated "New Request" (`Dashboard.tsx:67`) and the whole LeaseRequestForm/InviteMemberDialog are hardcoded English while the app is bilingual.
- Signup AI-consent timestamp silently skipped when no session (`Signup.tsx:132-146`).
- `onboarding.step4_title` ("Explore integrations") exists in locales but no checklist step uses it (`en/common.json:1643-1644`) — leftover.
- KNOWN_ISSUES #8 (duplicate workspace creation on signup/onboarding) remains open and sits directly on this journey (`docs/KNOWN_ISSUES.md:251-285`).

---

## 3. Simplification pushback (invited by the owner)

The first-run experience currently asks a new admin to understand: workspace roles (admin/editor/viewer) + functional roles (submitter/manager_approver/financial_approver/admin) + approval policies (concept/signator stages, priorities, fallbacks, SoD toggle) + two lifecycle vocabularies. That is four mental models before the first lease. Concrete recommendations:

1. **Pick one approval system for the fresh-workspace path.** Either seed a default approval policy at workspace creation (one manager step, assignee = owner) so the canonical engine handles day one, or keep legacy as the visible default — but do not surface both. Today the checklist points to legacy, the docs say policies are canonical, and the form preview only understands legacy.
2. **Make the owner an approver by default.** "Owner — all roles" should be true: treat the owner as the implicit manager approver when no roles exist, converting "auto-approved" into "owner approves" — one line of routing semantics that restores the control story for solo/small teams.
3. **Merge the two "Admin" concepts** or at minimum rename the functional-role checkbox (e.g. "Can manage approvals").
4. **Onboarding wizard should end with the one decision that matters**: "Who approves lease requests?" (defaults to you; add someone later). That single prompt kills F4's surprise entirely and costs one wizard field.
5. **Route Starter through checkout with the trial** (card-up-front, 7-day trial) or consciously re-document Starter as freemium with hard AI caps. The current in-between is the worst of both.

---

## 4. Journey verdict

The mid-flow surfaces (invite/accept, empty states, request-form half-state handling, retry-on-routing-failure) are genuinely well built. The two ends of the journey are where it breaks: the entrance (auth-walled lead magnet, droppable onboarding handoff, no way back to workspace creation, no billing at all for Starter) and the control moment the product exists for (first request auto-approves in every default-configured workspace, prompted only by an amber note at submission time).
