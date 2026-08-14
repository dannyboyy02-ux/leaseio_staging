# Known Issues — Open Backlog

Tracked here so they survive across sessions. When fixing, remove from this
list and reference it in the commit message.

---

## Customer-facing live audit 2026-08-11 (prod `main @ 8ed16aa`, walkthrough persona) — #187–#195

Full live walkthrough on theleaseio.com as an admin customer: requestor chain end-to-end,
direct-add + Opus extraction, archive/delete/restore, Leo, every displayed number
cross-checked vs the staging DB, core surfaces re-walked in Spanish. **Core workflows and
financial math verified sound** (chain completes; dashboard/portfolio/CSV figures recompute
exactly; extraction 99% accurate). Findings artifact: `docs/reviews/2026-08-11` (published).
Assess-only — nothing fixed (except #187, fixed same day). New items below. (#194 filed by the
#187-fix integrity review; #195 by the multi-workspace pass.)

**Multi-workspace verified 2026-08-11 (owner account `daniel.c.priest@gmail.com`, test-mode
Stripe `pk_test_`):** the $499 add-workspace purchase works end-to-end on the prod domain
(eligibility → honest consent modal → `default_incomplete` sub → client confirm → webhook
promotes to `active`) — this closes the #186-owed prod-domain purchase smoke. Cross-workspace
isolation solid: a freshly-created workspace shows $0/0 leases in the UI AND Leo reports 0 active
scoped to it (Hard Rule #8 holds). Switcher lists all workspaces and reloads per-workspace data
correctly. `delete-workspace` cancels the Stripe sub (`stripeSubscriptionsCanceled:1`) + writes
the `deleted_workspaces` forensic row. **Coverage limit:** tier-gating from the Starter side is
NOT testable via add-workspace — that flow always creates a **Business** workspace
(`create-workspace` uses `BUSINESS_MONTHLY_PRICE_ID`); a Starter workspace only comes from the
first-workspace onboarding/checkout path. Test workspace "Audit WS3" was created then deleted.

### #195 (MEDIUM, UX dead-end) A member who owns no workspace is offered "New workspace" but can never satisfy the "Add a card" gate
`create-workspace/index.ts:73-87` resolves the caller's Stripe customer only from (a) a Business
workspace the caller **owns** (`.eq("owner_id", userId)`) or (b) a Stripe customer matching the
caller's **email**. A user who is only a *member* of someone else's workspace (owns none) and has
no personal Stripe history has neither → `no_customer` → the client shows "Add a card or Stripe
Link… Settings → Billing, then try again." But Settings → Billing for that user manages a
workspace they don't own (a different customer), so following the instruction can NEVER satisfy
the flow — an unsatisfiable loop. Repro: walkthrough persona (member/admin of Labs Analytix, owns
nothing) 2026-08-11 — clicking "New workspace" always returned to the "Add a card" gate even
after a card was added to the workspace subscription. Deeper issue: a zero-owned-workspace user's
"Create your first workspace" should route through the trial/checkout onboarding
(`create_first_workspace` RPC), not the $499 add-a-2nd-workspace charge path. **Fix options:**
(a) route zero-owned users to onboarding checkout; (b) let the flow create/attach a personal
Stripe customer + collect a payment method inline (PaymentElement) instead of pointing at the
wrong Billing page; (c) at minimum, fix the error copy so it doesn't send members to a Billing
page that can't help them. Verified via function source + live repro 2026-08-11.

## Wave 5 "honest walls" residuals (filed 2026-08-14 by the Wave-5 review gauntlet — all pre-existing or deliberate-deferral; the wave itself is merged as PRs #94 + the wave5b fold)

### #196 (MEDIUM, governance, pre-existing) Viewer "read-only" has residual DB-layer write arms the Wave-5 enforcement deliberately did not close
Wave 5 closed lease INSERT (policy `leases_insert_own_editor_plus`) + both paid-AI entry points
(`_shared/role_gate.ts`), and the UI treats viewers as fully read-only. Remaining RLS arms a
demoted-to-viewer user can still exercise via direct PostgREST: (a) `leases` UPDATE/DELETE
own-lease arms (`user_id = auth.uid()` — DELETE bypasses 14-day retention entirely); (b) UPDATE
arm 3 grants any `workspace_roles` functional-role holder (a viewer holding financial_approver);
(c) member-wide INSERT policies on `field_corrections`, `lease_state_transitions`,
`lease_activity_log`. None burn paid AI. **Fix shape:** a follow-up security migration tightening
the own-lease arms with a role check (mirror the Wave-5 pattern) + sweep the sibling tables;
decide whether own-lease editing by demoted creators is a feature or a hole first. Surfaced by
the Wave-5 integrity + security reviews. *#197 addendum (2026-08-14):* the direct-viewer
override in the new INSERT firm arm is one-directional — a firm staffer later demoted to a
direct viewer row loses intake (override works) but keeps edit rights on their own
previously-created leases via arm (a) above; #197 makes "viewer with own leases" reachable for
the first time. Same fix shape as (a).

### #197 (MEDIUM, product decision) Firm-derived staff lost client-side lease-request creation — RESOLVED 2026-08-14 (owner decision: YES, firm staff get intake)
`has_workspace_permission` has no firm branch, so the Wave-5 INSERT policy (deliberately matching
the existing UPDATE stance) excluded firm staff with no direct `workspace_members` row; the old
policy's firm-aware `is_workspace_member` admitted them, so `LeaseRequestForm`'s client INSERT
regressed for that persona (the paid upload path was already closed to them pre-Wave-5). Zero
production impact while open (no firms exist in prod). **Owner decision 2026-08-14: firm staff
CAN create leases in child workspaces.** All three lockstep gates moved together (branch
`firm-staff-intake-197`): (1) migration `20260814190000_leases_insert_firm_staff` re-creates
`leases_insert_own_editor_plus` with the Phase-9 firm arm (`firm_id` set, `restrict_firm_access`
false, `is_firm_member`) **plus a direct-viewer override** — a direct `workspace_members` viewer
row out-ranks the firm allowance, so RLS and the role gate agree; (2) `_shared/role_gate.ts`
`callerCanProcessLeases` gained the matching firm branch (workspace owner → direct admin/editor
→ direct viewer BLOCKS → firm check), delegating to the new membership-shaped
`isFirmStaffOfWorkspace()` helper (same file) — which carries the **firm-OWNER arm** (SQL
`is_firm_member` counts `firms.owner_id`; the pre-fold `firm_members`-only lookup would have
dead-ended the CPA-principal persona behind CTAs the client showed them — polish + integrity
HIGH, folded). The pre-apply security review also found two further owner-or-direct-member
chokepoints the capability dead-ended behind, both now consulting the same helper:
`process_lease`'s `resolveAuthorizedWorkspaceId` (direct-upload path 403'd before the role gate
could run) and `resolve-approval-chain`'s submission auth (a firm staffer's draft was
permanently stuck). Redeploy set: `process_lease`, `retry_lease`, `resolve-approval-chain` (all
bundle the frozen `role_gate.ts` snapshot);
(3) the client intake predicates (Dashboard/Leases/ImportHistory) allow
firm-derived sessions via the new `useFirmIntakeAccess()` hook (`!userRole` + workspace.firmId ∈
firmMemberships). LeaseReview: the own-lease UPDATE arm already lets firm staff confirm their
OWN leases; the polish fold added a per-lease read-only guard for COLLEAGUES' leases
(`!userRole && lease.user_id !== user.id` → read-only + `readonly.firm_lease_note`) so the
workbench never renders editable fields whose saves the RLS would bounce. UPDATE policy
deliberately NOT widened (firm staff edit only their OWN leases; colleagues' require direct
membership). All gates pinned by `firmStaffIntake197.test.ts`. Follow-ons filed: #201 (firm
child monetization gate — decision), #202 (audit display names), #203 (firm-blind SELECT
policies cluster), #204 (quota banner/limit-wall firm doors).

### #201 (HIGH, product decision + honesty) A never-subscribed firm-bound child was blocked from processing and sold a trial it couldn't start — RESOLVED 2026-08-14 (owner decision: firm children INHERIT from the firm subscription)
`applyFirmSubscription` propagates `plan='business'` to children but never stamps their own
subscription columns, and the monetization gate had no firm awareness — so any post-2026-07-16
child bound without its own past subscription hit `no_subscription` on every upload, and the
modal sold a trial whose checkout 403s `firm_managed`. **Owner decision 2026-08-14: firm-bound
children inherit processing entitlement from the firm's subscription.** As built (branch
`firm-staff-intake-197`, with #197): `_shared/monetization.ts` gains the async
`resolveProcessingSubscriptionGate(admin, ws)` — the workspace-local pure gate (grandfather,
plan exemptions, own past sub) runs first; only when it would block AND the workspace is
firm-bound is `firms.stripe_subscription_id` consulted (the webhook's entitlement pointer:
written only for active/trialing, kept through dunning, cleared on deletion). Live firm sub →
unblocked; no firm sub (or lookup error — fail closed) → blocked with the NEW
`firm_subscription_required` reason so the client never shows the trial CTA. Both paid-AI
entry points route through it (`process_lease` 200+ok:false contract, `retry_lease` 403;
selects gained `firm_id`). LeaseUploadModal renders a firm panel for the new reason
(`leases.upload.firm_subscription_*` en+es): honest "billing is handled at the firm level"
copy, Close, and a "Go to firm billing" door for firm users only. Pinned by
`firmMonetization201.test.ts` (behavioral gate tests — monetization.ts is dependency-free, so
the Deno-shared file is unit-tested directly — plus entry-point wiring pins).

### #202 (MEDIUM, audit display) Pure firm staff render as '—' in every audit surface — the profiles SELECT coworker arm requires a workspace_members row
Attribution STORAGE is intact (`user_id` UUIDs on created/status_change/document rows), but
`profiles_select_own_or_coworker` only exposes a profile whose owner has a `workspace_members`
row — pure firm staff have none, so AuditLog (`row.profiles?.email || '—'`), RecentActivity,
and ApprovalQueue requestor names can't resolve them for anyone, including direct members.
"Every change is attributable" degrades to "attributable only by raw UUID". **Fix shape:** new
security migration re-creating the profiles SELECT policy with a firm-coworker arm (profile
owner is firm staff of a non-restricted firm-bound workspace the caller can access), scoped so
a DIFFERENT firm's staff never become visible; route through pre-apply security review.
Pre-existing shape, newly reachable via #197. Surfaced by the #197 integrity review.

### #203 (MEDIUM, firm UX degradation) Direct-membership-shaped SELECT policies silently degrade the firm-staff request flow (notifications, banner truth, chain visibility, doc attachment)
Four related non-firm-aware gates, all fail-closed but felt: (a) `workspace_roles` SELECT —
`notifyRoleHolders` reads zero rows for firm staff → legacy-routing submissions notify NOBODY
(the lifecycle flip itself is correct, server-side); (b) same blindness makes LeaseRequestForm's
`hasApprovers`/`hasActivePolicies` read empty → the "no approvers — auto-approved" banner can
lie to a firm staffer; (c) `lease_approval_chain` SELECT gates on direct members (Phase-10 D1) →
the firm-staff requestor can't see their own lease's chain progress in LeaseReview; (d)
`lease_documents` table INSERT + storage bucket INSERT have no firm arm → firm staff can't
attach negotiation docs to their OWN lease (the process_lease upload path is unaffected — it
never touches storage client-side). **Fix shape:** rewrite (a)/(c) onto `is_workspace_member()`;
(b) falls out of (a); (d) is an owner scope question ("does #197 intake include negotiation-doc
attachment?"). Route through pre-apply security review as one cluster. Surfaced by the #197
integrity + security reviews.

### #204 (MEDIUM, lying door) QuotaWarningBanner's "Upgrade now / View plans" CTA renders on firm-bound children and leads to a locked billing page; LimitReachedDialog's firm wall has no door for firm admins
At 80%/95% quota the banner promises an action the destination immediately retracts ("Managed
by your firm") — the same class the limit wall already fixed with its `firmBound` branch. And
the limit wall's firm-managed note ("Ask your firm owner to add capacity") offers only Close —
even to firm_admins who could act one nav away at `/app/firm/billing`. **Fix shape:** when
`workspace.firmId` is set, point the banner CTA at `/app/firm/billing` for firm users (or drop
the button + extend the guidance copy); add a secondary "Go to firm billing" button to both
firm branches of LimitReachedDialog. Pre-existing, untouched by the #197 diff; firm staff are
the users who will drive a child toward quota. Surfaced by the #197 polish review. *#201
addendum (2026-08-14):* third member of the cluster — `AccountSettings.tsx:~1220`'s
"never-subscribed recovery" trial callout has no `firmBound` guard, so the exact #201 input
class (firm-bound never-subscribed child) is still sold a trial in the Billing tab directly
under the "managed by your firm" banner (its `proceedWithCheckout` 403s `firm_managed`). Fix
alongside: `!firmBound &&` on the callout, matching the surrounding banners.

### #205 (MEDIUM, monetization, pre-existing) Workspace-less "personal" leases bypass the P0-h gate entirely — no subscription check, no quota, no cap
`checkProcessingQuota` returns `{ kind: 'ok' }` when the workspace id resolves null
(`process_lease/index.ts:~1012`), and `retry_lease` wraps its whole liveness+monetization block
in `if (lease.workspace_id)` — so a JWT-holder with zero owned workspaces and zero memberships
who omits `workspaceId` processes leases with NO monetization gate, NO quota, and NO cap: free
Opus burn via the legacy workspace-less path. Pre-existing (predates #201; the #201 review
surfaced it, not caused it). **Fix shape:** reject null-workspace processing outright — the
`create_first_workspace` RPC guarantees every user a workspace now, so the legacy path has no
remaining legitimate persona. Root cause: the personal-lease path predates workspaces and was
grandfathered through each gate addition. Surfaced by the #201 security review. *Same
fail-open family (integrity review):* both entry points' `workspaces` SELECT ignores the query
error (`const { data: ws }`), so a transient fetch error yields a null row → the pure gate
returns false → ungated (though still quota-checked) processing with a valid `workspaceId`.
Fix with the same beat: treat a workspace-fetch error like the #36 quota-count error — 503,
never a pass.

### #200 (LOW, dead code + latent gate drift) `AppContext.hasPermission` has zero consumers and its `!userRole → false` arm encodes the pre-#197 stance
`src/contexts/AppContext.tsx:443-454` exports a `hasPermission` helper nobody calls. Beyond the
dead weight, its `!userRole → false` arm would deny firm-derived sessions the `'leases'`
permission — if anyone wires it up later it silently reintroduces the #197 regression through a
fourth, undocumented gate (the three real gates are the INSERT policy, `role_gate.ts`, and
`useFirmIntakeAccess`). **Fix shape:** delete it, or add the firm-derived arm + a lockstep
comment pointing at #197. Root cause: helper predates the firm layer and survived the
hasPermission-consolidation deferral. Surfaced by the #197 code audit (pre-existing — filed, not
bundled).

### #198 (LOW, denial UX) `retry_lease`'s 403 `read_only_role` is swallowed into generic "retry failed"; `role_gate` conflates lookup errors with denial
`supabase.functions.invoke` turns non-2xx into `FunctionsHttpError`, so `FailedLeaseBanner` and
ImportHistory's retry toast a generic failure instead of the actionable (now access-worded) denial
— the wave5b fold added the localized `read_only_role` branch to `LeaseUploadModal` (process_lease
200+ok:false contract), but the retry 403 path still loses the reason. Also
`_shared/role_gate.ts` returns `false` on transient lookup errors, so an owner mid-DB-hiccup gets
the access-denied message. **Fix:** parse `error.context`/body reason in the retry catch paths;
return a discriminated `blocked | check_failed` from the gate and map `check_failed` to a
retryable error. Surfaced by the Wave-5 security + integrity + auditor reviews. *#201 addendum
(2026-08-14):* the retry 403 now also carries `firm_subscription_required` — when this is
fixed, that reason must surface the FIRM panel copy (`leases.upload.firm_subscription_*`) and
the firm-billing door, NEVER the trial CTA (mapping only `no_subscription` to the trial would
reintroduce on the retry surface the exact lie #201 removed from the upload modal).

### #199 (MEDIUM, integrity, pre-existing) LeaseReview approve's `lease_activity_log` mirror insert is best-effort — approve-without-audit-row remains possible
The Wave-5 backstops guarantee the approve UPDATE itself can't silently no-op, and wave5b moved
every activity insert behind a verified write — but the approval's audit mirror still only
`console.error`s on failure (`user_id: user?.id ?? null` is the #90-NULL family). A lost insert =
an approved lease with no `approval` activity row. **Fix shape:** make the mirror mandatory
(fail the approve, or queue a retry), part of the #90-NULL attribution tightening. Re-surfaced by
the Wave-5 integrity review.

### #194 (MEDIUM, accuracy, pre-existing) Leo's lease fetch caps at `.limit(60)` with no ORDER BY — totals silently diverge from the dashboard above 60 leases
`supabase/functions/ai-assistant/index.ts` fetches leases with `.limit(60)` and no `.order()`,
then computes counts + obligation totals over that capped set. The dashboard (`SummaryStrip.tsx`)
fetches ALL `archived=false` leases with no cap. So for any workspace with >60 non-cancelled,
non-archived, non-deleted leases, Leo's count and total silently UNDERCOUNT vs. the dashboard, and
*which* 60 rows survive is nondeterministic (no ORDER BY) — the exact "reconciles with no UI
surface" trust break #187 documents, just at higher lease counts. Pre-existing (the cap predates
the #187 fix), so filed separately per the pre-existing-issues rule rather than bundled into that
change. **Fix:** compute counts/totals server-side over the FULL result set (a lightweight
aggregate query for the numbers), keep the row cap only for the per-lease detail blocks, add a
deterministic `.order()`, and note in the prompt that detail is truncated while totals are
complete. Surfaced by the #187 integrity review 2026-08-11.

### #187 (HIGH, accuracy) Leo reports a portfolio total ~29% too high and fabricates the lease count — **RESOLVED 2026-08-11 (deployed + verified live)**
`supabase/functions/ai-assistant`. Asked "total annual rent commitment", Leo answered
$293,957/mo · $3,527,481/yr across "12 active leases". Actual (dashboard + Portfolio): 5 active
leases, $228,275/mo · $2.74M/yr. Leo's $293,957 exactly equalled `sum(current_monthly_rent)` over
the **7** rows with `lifecycle_status='active'` **including 2 archived leases**; the "12" was the
`buildLeaseContext` filter `['active','executed','draft']` count (7 active-status + 5 draft) — the
edge function literally put "TOTAL ACTIVE LEASES: 12" in the prompt.
**FIX (2026-08-11):** the fetch now mirrors the UI scope exactly — added `.eq('archived', false)`
and a `rent_schedules` embed; `buildLeaseContext` now uses the new pure `partitionPortfolio`
helper (`_shared/ai_portfolio.ts`) which splits the live portfolio (`active`/`executed`/
`fully_executed`) from in-progress pipeline (never counted as active) and sums **schedule-aware**
rent via `currentMonthlyRent` (ported from `leaseCalculations.getCurrentMonthlyRent`), so the
total equals the dashboard tile. System prompt gained a rule separating active-portfolio totals
from in-progress leases. Integrity review then caught a regression the first cut introduced —
terminal leases (`rejected`/`expired`/`chain_violation`) were bucketed as "pipeline"; folded in a
`classifyLease` split (portfolio / pipeline / closed, via `_shared/lifecycle.ts` `groupOf`) so
closed leases are labeled closed, not "in progress". Pinned by
`src/lib/__tests__/aiPortfolioScope.test.ts` (18 tests). Security review clean; integrity review
clean on the money path (the pre-existing `.limit(60)` gap is filed separately as #194).
Deployed via linked CLI; **verified live** — Leo now answers "5 active leases · $228,275/mo ·
$2,739,306/yr" with a note that the 6 pipeline leases are excluded. Security review clean.

### #188 (MEDIUM, i18n/UX) No in-app language switch — EN/ES toggle exists only on auth pages
The language toggle is on login/signup only; Settings → Appearance offers theme only, and no
other in-app control writes `leaseio.language`. A signed-in Spanish user (e.g. arrived via invite
link) is stranded in English. Spanish itself renders cleanly once selected. **Fix:** add a
language selector to Settings → Appearance (or profile menu) writing the existing
`leaseio.language` key. Verified live 2026-08-11.

### #189 (MEDIUM, polish/trust) Internal issue-tracker reference printed in Report settings
Reports → Report settings → "Artifact retention (days)" help text reads verbatim: "Reports older
than this become eligible for cleanup (cron not yet implemented; tracked in KNOWN_ISSUES #12)." A
customer sees the internal ticket ref + an admission the feature is unbuilt, and the control is
functionally inert. **Fix:** customer-facing copy + either wire the retention cron (#12) or
remove the control. Verified live 2026-08-11.

### #190 (LOW, convention) Same lease shown under two different names across pages
"Northwind Estates" (`request_title`, on Leases list/dashboard/Leo) appears as "1200 Market
Street, Suite 800, San Francisco" (`property_address`) on Portfolio + watchlist. One lease looks
like two properties. **Fix:** unify the name field or show both. Verified live 2026-08-11.

### #191 (LOW, copy) Reports "Monthly Rent Overview" chart actually plots total commitment
Chart titled "Monthly Rent Overview" is subtitled "Total commitment by lifecycle status", axis to
~$32M — it charts multi-year total commitment, not monthly rent. Bars are correct; title lies.
**Fix:** retitle to match content. Verified live 2026-08-11.

### #192 (LOW, extraction) Direct-upload extraction leaves `asset_type` null
An office lease added via Upload Document extracted every field at 99% but `asset_type` came back
null → blank "Type" on the Leases list + CSV, while the request-flow twin shows "Real estate".
Type was inferable from the document. **Fix:** infer/persist asset_type in the direct-upload
`process_lease` path. Verified live 2026-08-11.

### #193 (DOC DRIFT) Self-serve firm onboarding is BUILT but docs say "not built"
CLAUDE.md (Phase-10 deferred list) + #105 describe self-serve firm onboarding / firm Stripe
checkout as deferred and firms as "operator-created only". Git shows PR #55/#56 (June 2026)
shipped self-serve `create-firm` + hosted checkout, and the deployed `create-firm` is self-serve
for any authenticated user (per-owner cap of 10). **Action:** reconcile CLAUDE.md + #105 to
reflect shipped capability; re-scope whatever genuinely remains. Confirmed via git + function
source 2026-08-11.

---

## ▶ PHASE 0 REMEDIATION — CODE COMPLETE 2026-07-16, **DEPLOYED TO STAGING SAME DAY**

**Deploy executed 2026-07-16** (owner present) per `docs/ops/END_TO_END_DEPLOY_2026-07-16.md`:
all 6 migrations applied + verified, 64 edge functions redeployed via the linked
CLI, types regenerated, frontend merged to `main`. Nothing below is inert anymore.
`AUTO_NUDGE_CRON_SECRET` was set 2026-07-17 (owner-requested) and the cron gate
verified live (401 wrong secret / 200 real sweep) — **no deploy items remain.**

### Live end-to-end chain simulation 2026-07-16 — the full journey PASSED on deployed code

A real lease ("SIM Suite 210", Labs Analytix test workspace) was driven through
the ENTIRE chain in the rendered UI against the freshly deployed functions:
submit (P1-7 preview resolved the Darren policy truthfully) → concept step 1
approve → step 2 released by the intra-stage frontier ONLY after step 1 (P1-3) →
`in_negotiation` (P1-1 workbench; `final_negotiated` upload accepted AT
in_negotiation — the catch-22 fix) → advance (plain-language signator
notification to the chain-step cohort) → SignatorReview (3 confirmations +
≥30-char attestation gated Approve; P1-2) → `pending_counter_signature`
(execution owner auto-assigned; due date auto-set) → counter-signed upload +
Confirm → `fully_executed` → **Finalize & activate (P1-5): real Opus abstraction
extracted every term correctly** (landlord/tenant/rent $8,400/36-mo term/3%
escalation; calc_total_commitment $311,562.72 — escalation math exact) →
**`active` + model-locked**. All 7 lifecycle transitions logged with
`routing_path: 'chain'` + truthful triggers; every notification row carried
`recipient_ids` (P1-4); the finalize IS counted by the rolling quota (P0-g).
Nudge (P1-6): three send-nudge calls traversed auth→liveness→cooldown→resolution
correctly; recipient set went empty only because the sim's requestor == sole
approver and the function correctly never self-nudges — a nudge landing on a
DIFFERENT user remains unverified (needs two accounts; minor).

| Item | What landed | Commit |
|---|---|---|
| P0-a #164 | lease-removal liveness gates + Vault-preserve retention cron | 9530428 |
| P0-b #165 | deleted-lease public-link revoke + deleted_at filters on token/report readers | 9530428 |
| P0-g | process_lease: undefined jsonResponse, fail-CLOSED quota (#36), dead OpenAI removed | dc920eb |
| P0-e | transfer-ownership blocked while a subscription bills the prior owner (**policy choice, confirm**) | ebd8bda |
| P0-c | free-workspace hole: client INSERT `WITH CHECK(false)` + advisory-locked `create_first_workspace` RPC | fda2a1c |
| P0-d | delete-account rebuilt (no cross-tenant destruction, Stripe cancel, zombie-proof); leases.user_id + 51 actor FKs → SET NULL | fda2a1c |
| P0-f | #18 storage-RLS captured into a repo migration (objects.name qualified) | fda2a1c |
| P0-h | Starter monetization: onboarding→checkout+trial (both plans); **process_lease AND retry_lease** gate never-subscribed workspaces via shared `_shared/monetization.ts`; `created_at` made immutable (grandfather-bypass HIGH-1); upload-modal start-trial dead-end fixed | (this commit) |

Filed-not-fixed during Phase 0 (own beats): #166 (metering counts leases not events — usage-ledger); existing-free-workspace migration for the P0-h gate (grandfathered by cutoff for now); ASC/portfolio/amendment Business-only server gates (Phase 6/3).

---

## Fresh-eyes walkthrough fixes 2026-07-18 (branch `fresh-eyes-fixes`) — ~30 fixes shipped; **the deferred Tier-4 set (#172–#178) is now FULLY RESOLVED** (branch `deferred-fixes`, waves `2c640d1` + `a10d6c3`, 2026-07-18)

The fresh-eyes pass (full-product skeptic sweep synthesized in the 2026-07-18 session) shipped Tier 1–3 + most of Tier 4 on `fresh-eyes-fixes` (security-deposit fabrication, expiring-tile mismatch, cross-workspace onboarding counts, Portfolio KPI clip, dashboard annual-$ divergence, dead Needs-Review banner, ASC 842 classification cross-check, escalation-panel coherence, chain-aware approval tabs, dead Reports export buttons, Login deep-link, free-audit paywall, **AI assistant Claude→Leo**, Notifications dedup + humanized badges, `manage-workspace-member` service fn, + Tier-4 nits). Reviewer sweep clean apart from 2 in-branch HIGHs (escalation raw-column overwrite; sibling asset_type token) both folded. The following Tier-4 items were **deliberately deferred** (lower value / higher risk / architectural):

- **#172 (MEDIUM, i18n) date/currency leaks on core surfaces — RESOLVED 2026-07-18** (wave-1 commit `2c640d1`): queue/signator dates route through `formatLocalizedDate` (the "threading" concern evaporated — each sub-component already calls `useAppTranslation()`, so it was a destructure widening; `localizedQueueDates.test.ts`); `LeaseReportDetail` status/discount-method tokens + dates localized (`leaseReportDetailLocalization.test.ts`); Portfolio's hand-rolled `compactCurrency` deleted in favor of `formatLocalizedCurrency` compact (+ the blended-cost tile, `portfolioCurrencyLocalization.test.ts`); CSV export headers+display values localized with raw ISO dates/numbers preserved for Excel (`leasesCsvExportI18n.test.ts`).
- **#173 (MEDIUM, polish) raw Postgres/RLS errors piped into user toasts — RESOLVED 2026-07-18** (wave-1 commit `2c640d1` + reviewer fold): shared `src/lib/userFacingError.ts` `mapSupabaseError()` (lock-trigger → `errors.lease_locked`, 42501/RLS → `errors.no_permission`, network → `errors.network`, else caller fallback; raw always console.error'd) routed through 13 sites — 11 in the original four files (VendorCard 1, LockedLeaseDetail 4, DisclosureReportLibrary 3, LeaseReportDetail 3) + 2 folded from the integrity review (LeaseReviewSections risk-dismiss, AddRiskDialog); `font-mono` dropped from the now-localized inline errors (`userFacingError.test.ts`). The DB-stored `report.error_message` render is deliberately out of scope. **Known holdouts (filed below, #179):** ApprovalPolicyEditPage's 2 save-path toasts + LeaseReview's 3 `err?.message` interpolation sites.
- **#174 (LOW, architectural) SPA-nav dirty guards — RESOLVED 2026-07-18** (with #169): data-router migration (`createBrowserRouter` + pathless `RootLayout` with ErrorBoundary+Suspense parity in `App.tsx`) + shared `useUnsavedChangesGuard` hook (`useBlocker` + native confirm + beforeunload twin, `common.unsaved_nav_confirm`). Single-blocker constraint handled by lifting Asc842InputsTab's dirty flag to LeaseReview via `onDirtyChange`/`onAscDirtyChange` (one guard per page); ApprovalPolicyEditPage gained snapshot-based dirty tracking (`serializePolicy`, uiId-stripped) it never had, with a `bypass()` one-shot for the post-save navigate. Pinned by `unsavedNavGuard.test.ts`.
- **#175 (LOW, polish) divergent password policy — RESOLVED 2026-07-18** (wave-1 commit `2c640d1`): shared `src/lib/passwordPolicy.ts` (AcceptInvite's 4 rules canonical) + extracted `PasswordRequirementsChecklist` component wired into Signup, ResetPassword, and AcceptInvite; the dead `auth.min_password` key removed; a static pin keeps the client rules byte-equivalent to accept-invite's server `isStrongPassword` (`passwordPolicy.test.ts`). **Operator follow-up (config-not-code, not blocking):** tighten the Supabase Auth dashboard password requirements to match the 4-rule gate so signUp/updateUser enforce it server-side too.
- **#176 (LOW, marketing) Landing hero "demo coming" placeholder — RESOLVED 2026-07-18** (wave-1 commit `2c640d1`): replaced with `HeroMockup.tsx`, an aria-hidden pure-Tailwind miniature of the review workbench (skeleton chrome, 3 extracted-field rows with real ConfidenceBadge chip classes — 2 green + 1 amber for the human-in-the-loop story, span-not-button approve affordance; 13 `landing.hero.mockup.*` keys en+es; `heroMockup.test.ts`). Swap for a real product screenshot remains a nice-to-have when one exists.
- **#177 (LOW) misc single-surface polish** — **#177a RESOLVED 2026-07-18:** confidence tiers/border/flag now one banding (confidenceTier medium boundary 0.70→0.80 == the flag cutoff; `getFieldBorderClass` derives from the tier — red field == flagged field), and the status-strip jump now tab-switches + rAF-polls the new `data-field-id` anchor, scrolls+focuses the control, and marks it interacted so repeated clicks drain the flagged count to reveal Approve (pinned by `reviewConfidenceAlignment.test.ts` + the updated `extractedFieldHelpers.test.ts`). **#177b RESOLVED 2026-07-18:** policy-list "Archive" button + its native `window.confirm` removed (the row Switch owns activation); policy editor "Try sample" is disabled while the draft is unsaved/dirty (`testerStale` off the same uiId-stripped snapshot as the #174 guard) with an inline save-first note (`policy_editor.tester_save_first`; pinned by `approvalPolicyTester177b.test.ts`). **#177c–e RESOLVED 2026-07-18** (wave-1 commit `2c640d1`, stamped here retroactively): reset-password expired-link state machine + request-a-new-link path (#177c); copy-honesty pass — cost-per-sqft retitled per-lease, forecast jargon plain-languaged, FirmBilling invoice-mode preference copy, billed-vs-visible firm children count + note (#177d); RentScheduleTable direction-aware next-change label + expiring-tile dismiss undo toast with honest device/tile scope copy (#177e; `deferredPolish177e.test.ts`, `portfolioFirmHonesty177d.test.ts`). **The full #177 bundle is now closed.**
- **#178 (LOW, integrity) escalation review of a finalized/locked lease — RESOLVED 2026-07-18** (wave-1 commit `2c640d1`): the panel now selects `model_locked` and renders a "View Lease" action (→ `/app/leases/:id`, where the unlock-request governance flow lives) for locked leases instead of the doomed Edit button; the `/lock/i` toast mapping stays as the stale-data backstop (`escalationReviewLockRouting.test.ts`).
- **NOTE (intentional decision, not a bug): admin peer-management.** `manage-workspace-member` lets any admin re-role/remove/promote-to-admin another admin (owner's own row always protected). RLS was owner-only before (the bug being fixed); the expansion matches the advertised "Admin = full member management" and was **confirmed keep** by the owner 2026-07-18.

### #186 (HIGH, money) In-app purchases were structurally impossible on the production DOMAIN — RESOLVED (code) 2026-07-18, **operator env vars owed**

Owner live repro (2026-07-18, theleaseio.com): "Multi-workspace is temporarily unavailable — Payment configuration is missing." Root cause: `src/lib/stripe.ts` asserted the publishable-key prefix against BUILD mode (production build ⇒ `pk_live_` only), but the whole backend runs test-mode Stripe pre-launch — so the prod domain had no acceptable key and every in-app confirm surface (add-workspace $499, document packs, single-lease credit) failed closed. NOT a regression: shipped this way in June; all money-path verifications (incl. the 7/16 live Link charge) ran on localhost dev where `pk_test_` is accepted — environment-scoped verification that never covered the prod domain. Fix: `VITE_STRIPE_KEY_MODE` (`'test'|'live'`) explicitly declares the deploy's Stripe mode and wins over the build-mode inference; fail-closed default unchanged; truth table pinned by `stripeKeyMode.test.ts`. **Operator (Vercel → Settings → Environment Variables → redeploy): set `VITE_STRIPE_PUBLISHABLE_KEY` = the `pk_test_…` key + `VITE_STRIPE_KEY_MODE=test`; at live cutover swap BOTH together.** Side effects of the repro: workspace "Acme, Inc." was left `incomplete` — the sweep cron cancels+deletes it within ~2h; no charge was made. Follow-on lesson: prod-domain smoke of one in-app purchase joins the deploy checklist once the env vars land.

### Filed by the deferred-fixes reviewer sweep 2026-07-18 (pre-existing — NOT introduced by the branch)

- **#179 (LOW, polish) remaining raw-error toast sites (#173 class):** `ApprovalPolicyEditPage` save-path toasts (2, `err?.message ??`), `LeaseReview` `err?.message` interpolations (3, ~807/1221/2015). Route through `mapSupabaseError` in a follow-up; their `unknown_error` fallback keys still have live callers and stay.
- **#180 (MEDIUM, polish) SummaryStrip expiring-tile dismiss affordance is a 12px 40%-opacity check icon** with hover-only tooltip — fails discoverability + the 44px touch minimum. The new undo toast fixed what happens *after* the click; the click target itself predates the branch.
- **#181 (LOW, polish) Signup validation toasts all titled "Missing fields"** — the title lies for weak-password/mismatch/terms cases; reuse the specific titles per case.
- **#182 (LOW, polish) report library/detail load-error states have no Retry** — recovery is a full page refresh; add a retry action to the (now-localized) error cards.
- **#183 (LOW) VendorCard mid-edit draft sits outside the #174 unsaved-changes guard** (page guard covers the form + ASC tab only); navigating away mid-vendor-edit silently discards. Small surface, deliberate v1 scope.
- **#184 (LOW, layout) auth-shell drift:** `AcceptInvite` lacks the top-right LanguageToggle the other four auth pages have (ResetPassword's gap was fixed in the fold); five auth pages hand-roll the same gradient/logo/card scaffold — extract an `AuthPageShell` (with the toggle built in) next time an auth surface is touched.
- **#185 (MEDIUM, integrity, pre-existing) EscalationReviewPanel audit insert omits `workspace_id`** and is best-effort (console-only on failure) — a financial-data edit can commit while its attribution row is silently lost, and the row lacks the strategy-doc-required workspace_id. Predates the branch; fix alongside a broader "audit inserts are required, not best-effort" beat.
- **(nit) `archive.deleted_badge` key name says "deleted" but the value is "Archived"** — pre-existing naming mismatch, now consumed by the CSV export too; rename the key in a quiet locale-hygiene pass.

## UI-polish reviewer sweep 2026-07-17 — pre-existing findings filed (NOT introduced by the polish commit)

Surfaced while reviewing the 7-cluster polish change (`polish/ui-walkthrough-fixes`); all predate it. The commit's own HIGH (ASC 842 saved-snapshot race) and the `beforeunload` half of the dirty-nav guard were fixed in-branch.

- **#167 (MEDIUM, security) `lease_asc842_inputs` INSERT doesn't bind lease_id to the caller's workspace.** RLS validates `workspace_id` membership but nothing ties `lease_id` to that workspace (no composite FK / consistency trigger). An editor in workspace A holding a workspace-B lease UUID can pre-seed B's ASC inputs (only while B has no row), and `generate-lease-report` loads by `lease_id` alone under service role. Mitigated by unguessable UUIDs. Fix: workspace-consistency trigger on `lease_asc842_inputs` + `.eq('workspace_id', …)` defense-in-depth in the report fn.
- **#168 (MEDIUM, integrity) `asc842_inputs_updated` audit row has WHO/WHEN but no WHAT** — `details` carries only `{saved_at}`, no field-level from→to diff; and an audit-insert failure is swallowed (`console.warn`) while the save still reports success. Fix: diff payload vs loaded row into `details`; surface (or retry) the audit failure.
- **#169 (LOW) ASC 842 dirty state has no in-app navigation guard — RESOLVED 2026-07-18** (with #174): the data-router migration landed and Asc842InputsTab now lifts its dirty flag (`onDirtyChange`) into LeaseReview's single `useUnsavedChangesGuard` instance, which blocks SPA navigation AND owns the beforeunload twin (the tab's hand-rolled listener was removed — one blocker per page).
- **#170 (LOW) asc842 RLS write policies lack the owner_id branch** (`canEdit` includes owner; a member-row-less owner fails at RLS — fails closed; align policies with the owner-OR-member pattern or document that owners always get a member row).
- **#171 (LOW) `generate-lease-report` has no Vault/read-only check server-side** — a Vault owner can generate reports by direct API (UI hides the button). Phase 8 spec says single-lease reports are all-tier, so likely intentional; either add the `isReadOnlyRetention` check or document the export entitlement in VAULT_TIER_SPEC.
- **(LOW, pre-existing) `LeaseRequestForm` `created` activity insert is fire-and-forget** (error unchecked).

---

## #166: AI metering counts LEASES, not abstraction EVENTS — executed-mode re-extractions are unmetered (MEDIUM, money; deferred to a usage-ledger beat)

**Filed 2026-07-16** during the P0-g pass. The monthly-abstraction quota in `process_lease` counts DISTINCT leases with `extracted_json IS NOT NULL AND uploaded_at >= now()-30d`. Executed-mode extractions write `executed_extracted_json` / `executed_uploaded_at` (separate columns), so they never increment that count → a workspace at its monthly cap can run **unlimited executed re-extractions** (each = paid Haiku+Opus). Even the primary path under-counts: re-running extraction on the same lease is 1 counted lease but N abstraction events. The **#36 fail-open was fixed in P0-g** (a count error now fails closed with a retryable 503 instead of granting unmetered processing) — that was the acute hole. This item is the deeper model flaw: the correct fix is a per-event **usage ledger** (count abstraction events, debit on each run) rather than a lease-COUNT meter — a bolt-on OR-count would still miss same-lease re-runs and give false confidence, so it's deferred to a dedicated metering beat, NOT half-fixed here. Retry-path unmetered (#67) folds into the same ledger.

---

## Full-product assessment sweep 2026-07-16 — 7 more subsystems verified on this branch (billing, direct-add, AI pipeline, dashboard, firm, reports, governance)

Orchestrated walkthrough (7 parallel verification agents) after the workspaces + approvals walks, at the owner's direction to complete the full-product assessment before any remediation. Each subsystem's documented findings re-checked against **current-branch code**; cross-checked with live staging DB. **Owner's call: no fixes yet — this is the assessment.** Full per-finding detail (file:line) is in the 2026-07-03 evidence reports (`docs/reviews/2026-07-03/*.md`), now confirmed current. Headline counts of still-open findings: Billing 6 open / 3 money-path items **FIXED since review** (double-billing, serial-trials, Basil period-end — verified line-by-line); Direct-add 10 PRESENT + 1 CHANGED; AI pipeline 6 PRESENT; Dashboard 6 PRESENT; Firm layer 5 PRESENT (all HIGH); Reports 10 PRESENT; Governance 5 PRESENT.

**The two most serious NEW / under-tracked items (file distinctly — not clearly in any existing item):**

### #164: `delete-lease` / `restore-lease` / `process-lease-retention` skip the `checkWorkspaceLive` gate — a Vault/grace admin can permanently destroy leases (HIGH, data destruction) — **✅ FIX LANDED (code) 2026-07-16 (9530428), deploy owed**
Verified 2026-07-16. `supabase/functions/{delete-lease,restore-lease,process-lease-retention}/index.ts` never import or call `checkWorkspaceLive` (grep: ZERO hits in all three) — the invariant `_shared/workspace_live.ts` declares "every user-invokable mutator must check this explicitly" and ~34 other functions honor. Both removal fns were added 2026-06-25, AFTER the 2026-06-12 vault-v1 liveness sweep, and never got the gate. A workspace admin can POST directly to the deployed function (the UI only hides the kebab — the exact "UI-only authorization" class the project flags) and soft-delete/purge any lease in a Vault (read-only offramp) or grace/soft-deleted workspace — destroying the very records the Vault tier promises to preserve. Pairs with the workspaces cross-tenant delete-account (#Workspaces-1) as the "destructive lease-removal safety" cluster. → **Phase 0.**

### #165: "Delete permanently" leaves a "deleted" lease's public no-login financial summary link LIVE for the full 14-day retention window (HIGH, data exposure) — **✅ FIX LANDED (code) 2026-07-16 (9530428), deploy owed**
Verified 2026-07-16. `delete-lease/index.ts:135-142` updates only `deleted_at`/`purge_after`/`deleted_by`/`deletion_reason` — it never nulls `summary_share_token` and deliberately leaves `lifecycle_status` unchanged. `get-summary-by-token/index.ts` runs as **service role** (bypasses the `leases_hide_soft_deleted` restrictive RLS), has no `deleted_at` filter, and its lifecycle state-gate still passes. So a lease an admin "deletes permanently" keeps serving its PV-liability / classification / rent financial summary at the public `/share/:token` URL for 14 days. The plan's Phase-0 bullet ("revoke public summary tokens on lease deletion") names this — filing it distinctly with the verified mechanism. Same pass: soft-deleted leases also flow into all THREE report generators (`generate-{lease,portfolio,workspace-asc842}-report`, all service-role, no `deleted_at` filter) → a soft-deleted lease lands in a CPA-facing consolidated ASC-842 PDF. **CLAUDE.md's "4 service-role deleted_at sites" claim is materially incomplete** (missed these 4 read sites). → **Phase 0 (token) + Phase 6 (report generators).**

**Other still-present highlights (already tracked in the plan/reports; confirmed current):** direct-add lands `executed` unreviewed with no approval concept + `retry_lease` divergent degraded pipeline that strands recovered leases (Phase 4); AI metering bypasses — executed-mode uncounted + retry unmetered + #36 fail-open count (money, partly unassigned); `jsonResponse` undefined in `process_lease:2126` (latent 500 + blocks `deno check`); firm layer entirely unwired end-to-end AND **0 firms exist on staging** (never exercised live) with children born on `starter` not `business` (#113 — corrected: `starter`, not `pro`); dashboard `final_review` invisible + persona-blind "Needs Your Action"; governance change-set verbatim-string apply → 22P02 deadlock (G2) + `calc_*` never recomputed (#A7) + the whole unlock loop notifies nobody; #18 storage RLS **fixed LIVE but drifted in the repo migration** (needs `db pull`); Starter free-forever on the default signup path (Phase 0). Escalation-panel financial edits still write no activity-log row (attributability violation, Phase 6/0).

---

## Approvals-management walkthrough 2026-07-16 — 11 defects re-verified on this branch; live stuck-lease proof; #5 is only HALF fixed

Owner-directed walkthrough (second flagged area). Re-verified each documented approvals defect against **current-branch code** (not the old reports — the branch has had approval churn) + **live staging DB**. Owner's call: **fix in the combined workspaces+approvals pass, not now.** All items map cleanly to the ratified plan's Phase 1 (the "seven wires"), Phase 3 (setup templates/guardrails), and Phase 5 (roles) — the plan IS appropriately scoped; the risk is piecemeal half-fixes (see #5).

**Live smoking gun:** a real lease has sat in `lifecycle_status='in_negotiation'` since **2026-06-09 (37 days)**, its concept stage fully approved, with a **pending `signator` step resolved to a role that ZERO users hold** (live: `signator_role_holders = 0`) and `effective_assignee_user_id IS NULL`. It entered the flagship workflow and cannot come out — the same permanent-strand shape as the 60-day-stuck extractions. (Also live: 4 policies / 1 active, so the Phase-3 setup traps are reachable, not hypothetical.)

**Current-branch status of the 11 defects** (→ plan phase):
1. **[FIXED — P1-1, this branch]** ~~Negotiation panel unreachable~~ — `isIntakeStage` now excludes `in_negotiation` (`LeaseReview.tsx`), so it reaches the main workbench + Documents tab (`DocumentsPanel`). Also fixed in the same pass: the `final_negotiated` upload catch-22 (`leaseDocuments.ts` + Deno mirror — advance-to-final-review needs that doc but the dropdown only offered it at the unreachable `final_review`); and the workbench was adapted for chain post-concept states (`isPostConceptChain` = in_negotiation/final_review/pending_counter_signature/chain_violation) — suppressed the intake approve ceremony (stray "Approve" header action, the section-progress status strip, the per-tab "Reviewed" footers) and the empty source-PDF split, and default the tab to Documents where the negotiation actions live. Reviewers: integrity + auditor clean; polish's 2 HIGH + 2 MEDIUM addressed. (Remaining: `DocumentsTimeline.tsx:127` hardcoded date-fns format is one instance of the documented #160 date-fns-locale remainder, now more prominent.) Rendered persona walkthrough is owner-owed (needs login).
2. **[FIXED — P1-6, this branch]** ~~Nudge dead~~ — `isPendingApproval` is now a real waiting-for-approver predicate (concept approval / concept review / signator `final_review`), not `false`, so `NudgeApproverButton` renders. Mounted where the requestor actually sees the stalled request: the **intake view header** (concept stages) + the workbench (final_review), both gated to the nudger (requestor/admin, not read-only). `send-nudge` (already complete) resolves the live approver + cooldown. Plus the **day-2/5/10 automatic escalation cron** (`auto-nudge-approvers`) the schema always anticipated (`lease_nudges.automatic_dayN`) but was never built: a daily secret-authed sweep nudges the current pending approver of any frontier step past a 2/5/10-day milestone, deduped per step-cycle, skipping non-live/soft-deleted. **Owner-owed:** set `AUTO_NUDGE_CRON_SECRET` (edge-fn secret) + insert the `private.cron_secrets` row `id='auto_nudge'` (fail-closed until both). **Redeploy owed: deploy `auto-nudge-approvers` + apply the schedule migration `20260716170000`.** → Phase 1.
3. **[FIXED — P1-2, this branch]** ~~Signator gate broken~~ — the queue's `ChainStepCard` now routes a `stage==='signator'` step to a "Review & Sign" button → `/app/leases/{id}/signator-review` (the attestation page, previously orphaned) instead of the bare approve that 400'd; the `signator_review_required` email deep-links there too (`notify_dispatch.ts`). Added a server lifecycle guard in `act-on-chain-step` (no action on a terminal lease; no signator action while the lease is still in the concept/negotiation phase — the signator row is inserted pending at submission, so the CFO saw an actionable card from day 1) + a matching client stage-frontier filter that hides premature signator cards. Also cleared the stale reject/send-back `comment` on dialog close (j4-approver §40 audit-pollution). NOTE: the **intra-stage sequential frontier** (a step-2 concept approver seeing their card before step-1 acts) is still open → P1-3. **Redeploy owed: `act-on-chain-step`, `dispatch-notifications` + `send-nudge` (bundle `notify_dispatch.ts`).** → Phase 1.
4. **[FIXED — P1-3, this branch]** ~~Send-back strands~~ — `advance-to-final-review` now REACTIVATES the dormant signator stage on re-advance: when no `pending` signator rows exist (a prior send-back marked them `sent_back`/`superseded`), it flips those rows back to `pending` in place (clearing `action_at`/`action_by`/`comment`, resetting `pending_since`) and sets `pending_since` on the lowest required step_order — so re-advance always yields a fresh actionable signator stage instead of stranding at final_review with zero steps. Recorded via `reactivated_signator` in the `final_review_stage_entered` audit row. Also in P1-3: the queue's **intra-stage sequential frontier** (a step-2 approver no longer sees an actionable card while step-1 is pending) + signator card allowlist (final_review only) + SignatorReview honoring delegation auth. **Redeploy owed: `advance-to-final-review`, `act-on-chain-step`.** → Phase 1.
5. **[FIXED — P1-4, this branch]** ~~requestor-outcome writers omit recipient_ids~~ — **F-3:** the four legacy requestor-outcome writers (`FinancialReview` approve/return/reject + `ApprovalQueue` reject) now include `recipient_ids: [requestor_id]`, so the requestor is told their request's outcome on both channels. **F-2 (the owner's headline complaint — "is the requestor told after concept approval that they may proceed? No, on no channel"):** `act-on-chain-step` now writes a server-side requestor notification on every chain outcome — concept approval → in_negotiation ("you may proceed"), reject, and send-back (concept or signator) — via a new `notify()` helper. **F-4:** the next sequential concept approver is now notified when a level is crossed (`resolveAssigneeUserIds(nextAssignees)` → `notify_chain_step_users`), instead of `nextAssignees` being computed and thrown away. Email copy for all these `notification_type`s already existed in `notify_dispatch.ts` (`copyForType`). **Redeploy owed: `act-on-chain-step`.** (Still open, own beats: **F-9** legacy client-side notification writes remain fragile — a closed tab between the edge call and the client insert loses them; the review's suggested move into `legacy-lease-action` server-side is a separate reliability item. Plus notification-cron soft-delete filtering (report §soft-delete) and the shared-`read_at` notifications RLS.) → Phase 1.
6. **[FIXED — P1-5, this branch]** ~~`fully_executed → active` missing + chain lease never abstracted~~ — the CRITICAL executed dead-end (j3-requestor §1.9). A counter-signed chain lease stranded at `fully_executed`: no route to `active` (invisible to the active-lease cap / amendment matching / unlock / ASC-842) AND never AI-abstracted at all (chain request leases are created `status:'Ready'`, never processed). New **`process_lease` `finalize` mode** (keyed by leaseId, precondition `fully_executed`, idempotent): reads the stored `fully_executed_counterparty_returned` doc from the lease-documents bucket, runs the AI abstraction into the **PRIMARY** term columns + `extracted_json` + recomputed `calc_*`, then activates + model-locks the lease (`fully_executed → active`, a legal `VALID_TRANSITIONS` edge, convention `status_change` row `routing_path:'chain'`). Gated: authz (requestor/uploader/execution-owner or workspace owner/admin) + liveness + rate-limit + monthly-cap quota. UI: a `fully_executed` lease's header now shows **"Finalize & activate"** (`handleFinalize`), replacing the dead `handleRunAbstraction` hook (which minted a new lease and was rendered nowhere). This is the chain path finally delivering Path 1's "AI abstracts → repository". **Redeploy owed: `process_lease`.** → Phase 1.
7. **[FIXED — P1-7, this branch]** ~~Request-form route preview reads only `workspace_roles`~~ — the preview now calls the **real resolver** `preview_policy_resolution` (the same RPC the policy tester + `resolve-approval-chain` use) whenever the workspace has an active `approval_policies` row, so the preview matches actual routing: it shows the matched policy's Concept-approval / Signature stages (or a truthful "no matching policy — could be blocked at submission" warning for the no-match trap), and only falls back to the legacy manager/financial role badges when NO policies exist (where that flow is the truth). The RPC is `authenticated`-granted and called with the user's OWN `workspace.id`. Also fixed the **false AI-extract labels**: the optional term fields claimed "AI will extract them from the uploaded document," but there is no document at request time and AI abstraction runs only later (at finalize, P1-5) — relabeled honest "(optional estimate — sharpens routing & preview)". → Phase 1.
8. **[PRESENT, improved]** Narrow-rule-no-fallback → `no_match_no_fallback` 409 blocks every other submission; priority ties (editor default `priority:100`, `ApprovalPolicyEditPage.tsx:66`) → `ambiguous` 409. **`2ffd5d1` (canonical asset-type) cut the spurious vocabulary-mismatch 409s** but left both structural traps. → Phase 3.
9. **[PRESENT]** "AND at the same time" stored sequentially — `ChainDiagram.tsx:147-153` `addParallelApprover` bumps `step_order`; engine keys co-activeness on EQUAL `step_order` (`approvalChainLogic.ts:122/146/441`). Needs the fix + a one-time repair migration. → Phase 3.
10. **[PRESENT]** `signator` offered in the chain editor (`ChainDiagram.tsx:66`) but unassignable — absent from `FunctionalRole` (`types/lifecycle.ts:76`); no UI writes `workspace_roles.role='signator'` (live: 0 holders). Role-based signator steps never resolve to a user (user-pinned steps still work). → Phase 5 (assignable "Signs leases") + Phase 3.
11. **[CHANGED — aligned, still two impls]** Tester (`preview_policy_resolution` RPC) vs live TS `matchPolicy` — `2ffd5d1` deliberately mirrored them + added `canonicalAssetTypeDrift.test.ts`; the known asset-type divergence is closed in-repo, but two implementations still exist (structural drift risk). → Phase 3.

**Notification rail is otherwise healthy (live):** `notification_deliveries` shows sent rows; 9/10 activity notification rows carry recipients. The gap is specifically the requestor-outcome writers (#5).

**Deploy caveat:** CLAUDE.md says the *deployed* `resolve-approval-chain` (v37/v38) may lag the repo's canonical matcher — a deploy-lag, not a code gap; verify on the next redeploy.

## End-to-end journey walk (2026-07-16) — 16 confirmed cross-stage gaps; 5 fixed, rest filed

A whole-surface walk of the full flagship journey (6 persona walkers, each adversarially verified) surfaced gaps a per-change diff review structurally can't see. **Fixed this session:** upload-paywall CTA 404 (`LeaseUploadModal` `/app/settings`→`/account`); annual→monthly silent mischarge (`AccountSettings` autoCheckout now reads the interval from the URL); execution-owner (viewer) can now upload the counter-signed doc (`upload-lease-document`); signator "your turn" notification now targets the assigned chain-step signator, not just the role cohort (`advance-to-final-review`); `fully_executed` chrome stripped while keeping the Finalize button (`LeaseReview` `isPostConceptChrome`). **Filed (own beats, NOT rushed at session end):**

- **[HIGH] Concept send-back strands the lease + lying banner (`act-on-chain-step:~640`, `LeaseReview:~2102`).** P1-3 fixed the *signator* backward arrow but not the *concept* one: a concept send-back marks the acted step `sent_back`, supersedes siblings, and flips to `concept_submitted` with ZERO pending steps and no rebuild path — and the P1-4 email now sends the requestor to that dead-end (the requestor then sees a "pending manager review" banner + Nudge with no resubmit affordance). This is the "chain resubmit" P1-3 named but only half-delivered. **Fix (needs design + full review):** a chain-aware resubmit — the requestor edits + resubmits, re-running concept-stage resolution (mirror `forceConceptReactivation`, which escalate-to-concept-approver uses but gates on `in_negotiation`); ensure exactly one pending frontier exists after send-back; distinguish "has a live pending frontier" from raw lifecycle before showing the "pending review"/Nudge banner.
- **[MEDIUM] `retry_lease` skips the monthly extraction cap (`retry_lease:~651`).** It enforces never-subscribed + liveness but not `checkProcessingQuota`, so a subscribed workspace over its metered allowance can re-extract via retry and burn unmetered Opus. **Fix:** extract `checkProcessingQuota` from `process_lease` into `_shared` and call it in `retry_lease` (`{isNewLease:false}`) — do it as a careful shared-helper extraction, not a replicated copy (quota math errors are themselves money bugs).
- **[MEDIUM] No "My Requests" surface (`Leases.tsx:120`).** `PORTFOLIO_STATUSES` excludes every in-flight chain state and ApprovalQueue is approver-scoped, so a requestor loses their submitted lease until it's `active`. **Fix:** a requestor-scoped "My Requests" list (or include `requestor_id==me` in-flight leases in Leases / a dashboard card).
- **[MEDIUM] Chain approvals absent from the "Reviewed" tab (`ApprovalQueue:~684`).** The reviewed query matches only legacy columns + `rejection`/`send_back` activity. **Fix:** include `chain_step_approved` (and/or `lease_approval_chain.action_by==me`).
- **[MEDIUM] `final_review` lease-detail has no sign CTA (`LeaseReview:~2837`).** A signator who opens the lease (not via the queue card) sees no path to sign. **Fix:** render a "Review & Sign" CTA on the `final_review` workbench for an authorized signator.
- **[LOW×3]** upload modal collapses 403 read-only reasons (`subscription_canceled`/`inactive`) into a generic error panel (`LeaseUploadModal:~185`); the first concept-approver notification is written client-side (`LeaseRequestForm:~459`, unlike the server-side act-on-chain-step ones); a soft-deleted PARENT lease with amendment children can never purge (`process-lease-retention:~225`, FK `ON DELETE NO ACTION`).
- **[LOW, uncertain] `advance-to-final-review:~399`** advances to `final_review` even if zero signator rows exist — assert ≥1 signator row before flipping.

**Filed (surfaced by the P1-7 review — own beats, NOT bundled):**
- **No-match submit dead-end (MEDIUM):** when the P1-7 preview truthfully warns "no matching policy," Submit stays enabled; submitting surfaces the raw resolver string ("No matching policy and no default fallback configured.") as a non-i18n toast, and each retry writes another orphaned `draft` lease (`LeaseRequestForm.tsx:~417`, `leaseSubmissionDecision.ts:~112`). Fix: i18n the leave-draft message in the requestor's voice + de-dupe / clean up the draft on a no-route submission (integrity/auditor lane). The truthful warning makes this pre-existing dead-end more reachable.
- **Route-preview abstraction (LOW):** the matched preview shows stage badges (Concept approval / Signature) but not the approver count/role; "Concept approval" is internal vocabulary a non-admin requestor may not recognize. The RPC already returns `approver_role`/`approver_user_id` per chain step. Enhancement: surface the first-stage approver, or plainer stage copy.

**Filed (pre-existing, surfaced by the P1-5 review — own beats, NOT bundled):**
- **LeaseReview stale-parent-UI no-op (LOW):** `DocumentsPanel.onLifecycleChanged` (`LeaseReview.tsx:~3679`), `CounterSignaturePanel.onChanged` (`~3706`), and `ChainViolationBanner.onResolved` (`~3716`) all refresh via `queryClient.invalidateQueries({ queryKey: ['lease', leaseId] })`, but this component loads the lease with `useEffect`+`setLease` — there is NO `useQuery` keyed `['lease', leaseId]` — so the invalidation is a no-op and the parent workbench stays stale after those child actions until a manual reload. Root cause identical to the P1-5 `handleFinalize` case (fixed there with `refetchLease()`). Fix: route all three through `refetchLease()`. (P1-5 handleFinalize already fixed; these three predate P1-5.)
- **Finalize active-lease-cap (owner decision, not a bug):** finalize meters against the monthly abstraction cap only (`isNewLease:false`), not the active-lease cap — consistent with executed mode, and chain request leases never had the active-lease cap enforced (created outside `process_lease`). Preferable to stranding a fully-executed lease, but flag for an owner monetization decision.

---

## Workspaces-management walkthrough 2026-07-16 — every fragility LIVE-VERIFIED still open on this branch; two plan recommendations

Owner directed a fresh walkthrough of workspaces management ("may not have been planned appropriately"). Verified against the **live staging DB/RLS/schema/trigger** + the running app (not the docs), on branch `claude/leaseio-end-to-end-review-163v6w`. Owner's call: **do NOT fix now — filed for a combined workspaces+approvals fix pass.** Every item the 2026-07-03 review flagged is confirmed unchanged (the 2026-07-12 autosave rewrite touched only the config-section surfaces, none of these). The individual items already live in the ratified plan / prior review reports; this entry is the dated live-confirmation + the delta.

**Live-verified still-open (evidence):**
1. **[CRITICAL] `delete-account` cross-tenant lease destruction.** `delete-account/index.ts` deletes `leases WHERE user_id = me` under service role AND `leases.user_id → profiles(id) ON DELETE CASCADE` (live schema: `confdeltype='c'`) — a departing employee's account deletion erases every lease they uploaded into their EMPLOYER's workspace, audit trail included. → Plan Phase 0.
2. **[CRITICAL/revenue] Unlimited free workspaces.** Live `workspaces` INSERT policy = `WITH CHECK (owner_id = auth.uid())`, no count/payment gate — the $499 paid path (`create_workspace_locked`) is bypassable by a direct browser insert. → Plan Phase 0.
3. **[HIGH] "Leave workspace" silent no-op.** Live `workspace_members` policies: only `"Owners can remove members" USING is_workspace_owner(...)` for DELETE; NO self-delete policy. A member's browser `.delete().eq('user_id', me)` (`WorkspaceManagement.tsx:186`) matches 0 rows, no error → success toast, membership persists. → Plan Phase 5.
4. **[HIGH] Admin member-management no-op + phantom audit.** Same owner-only UPDATE/DELETE policies, but the UI offers role-change/remove to *admins* (`canManageWorkspaceMembers = isAdmin`); their `MemberRoleSelect` UPDATE / `handleRemoveMember` DELETE match 0 rows, toast success, and write an audit row for a change that never happened. → Plan Phase 5.
5. **[HIGH] `handle_new_user` silently discards signup data.** Live trigger body inserts ONLY `(id, email)` — first/last name, company, and the timezone the signup form collects are dropped; workspace timezone hardcodes `America/New_York`. → **RECOMMENDATION: scope explicitly (currently only loosely under Phase 3 seeding); it's a ~1-line trigger fix + passing metadata through.**
6. **[HIGH/money] Ownership transfer keeps billing the prior owner.** `transfer_workspace_ownership_locked` swaps `owner_id` + member roles but never touches `stripe_customer_id`; the new owner's next `create-workspace` charges the EX-owner's card. → **RECOMMENDATION: promote from "v1 limitation" to Phase 0 — same silently-charges-the-wrong-party class as the #82 double-billing bug.**
7. **[HIGH] `delete-account` cancels zero Stripe subscriptions** (no Stripe import) — departed customer billed forever. → Plan Phase 0.
8. **[MEDIUM] Nothing seeded at creation** — `create_workspace_locked` seeds the workspace + owner member row + one activity row, but NO approval policy → fresh workspace silently auto-approves every request until an admin builds one. → Plan Phase 3.
9. **[MEDIUM] Lead-magnet funnel auth-walled** (live: landing "Start Your Free Lease Audit" → `/login`). → Plan Phase 6.

**Method note:** the destructive authenticated flows (leave/transfer/delete) were verified at the DB/RLS/schema layer (definitive for no-op behavior) rather than by clicking, because account-creation/authentication is outside what this session performs and executing them would destroy real staging data. A left-over Vite dev server on :8080 and NO created accounts.

---

## #161: Link/non-card customers cannot buy packs OR add workspaces — expansion revenue blocked on the mainstream payment path (HIGH) — **FIX LANDED 2026-07-16, pending live Link-funded verification**

> **Status 2026-07-16:** code-complete on the branch — both resolvers accept any method type via `describePaymentMethod`; all THREE purchase dialogs (packs, single-lease credit via `LimitReachedDialog` — a third blocked surface found during the fix — and $499 add-workspace) confirm through the new method-agnostic `confirmSavedMethodPayment()` (`src/lib/stripeConfirm.ts`, `stripe.confirmPayment` + `redirect:'if_required'`); consent copy renders the real method label; the no-method banners and the trial "card on file" banner are truthful; static pin `paymentMethodAgnosticPurchases.test.ts`; 1443/1443 green. Per the DoD this stays OPEN until each surface is driven live with a **Link**-funded sandbox transaction (requires `manage-document-pack` + `create-workspace` redeploys; pack purchases additionally still 503 until the operator creates the pack Prices — runbook Step 4). Then stamp RESOLVED.
>
> **Reviewer sweep (security + code-auditor + integrity + polish, all four, 2026-07-16) — every Critical/High actioned:** no Criticals. The convergent HIGH/MEDIUM — the broadened resolver admitted **ACH/bank-debit** methods that settle to PI `processing`, which these instant flows have no UX for (charge-while-told-failed) — was closed by a **deferred-settlement denylist** (`isDeferredSettlementMethod` in `_shared/payment_method.ts` + Node mirror): both resolvers reject `us_bank_account`/`sepa_debit`/`acss_debit`/`bacs_debit`/etc. at resolve time (before any PI is created), returning `deferred_method_unsupported`, wired to honest copy + an "Open billing" door in all three dialogs. Also fixed from the sweep: every remaining "card on file" consent/awareness string across the pack/single/add-workspace consent panels + acknowledge gate + 3DS/decline narration made method-neutral (en+es); the es `method_on_file_fallback` "a el" → "su" grammar; the pack no-method banner given a billing-door button (was a 6-click scavenger hunt); the single-credit retry-loop replaced with a billing door for no-method reasons; dead `methodType`/`cardLast4`/`cardBrand` wire+client plumbing removed; stale card-only comments/headers reconciled; the two `payment_method.ts` mirrors kept byte-identical. Behavioral regression tests: `DocumentPackDialog.test.tsx` (Link customer gets the catalog + both no-method reasons offer the door). **KNOWN_ISSUES #97 (Node≥22 localStorage) resolved as a side effect** (vitest shim `src/test/setupStorage.ts`) so the touched workspace tests actually run.

---

## #162: `create-firm-subscription` still filters `type:"card"` — Link firm owners will hit the #161 lockout when self-serve firm checkout (#105-C) ships (HIGH, latent)

**Filed 2026-07-16** (surfaced by the #161 code-audit as a pre-existing third occurrence; NOT bundled per the pre-existing-issues discipline). `supabase/functions/create-firm-subscription/index.ts:~83` resolves the payment method with `stripe.paymentMethods.list({ customer, type: "card", limit: 1 })` — the exact pattern #161 banned on the other charge flows. It's currently **dormant**: `create-firm-subscription` is the deprecated SetupIntent path superseded by `create-firm-checkout` (hosted), and has no live frontend caller. But the deferred **#105-C self-serve firm onboarding** (FirmOnboarding fork + in-app SetupIntent card collection) would revive it, and a Stripe-Link-paying firm owner would then be rejected `no_card_on_file` exactly as #161's customers were — while the CI pin built to catch this (`paymentMethodAgnosticPurchases.test.ts` `CHARGE_FLOW_FUNCTIONS`) stays silent because this function isn't in its list.

**Fix (when #105-C is picked up):** either retire `create-firm-subscription` in favor of `create-firm-checkout`, or broaden its resolver to `describePaymentMethod` + `confirmSavedMethodPayment` + the deferred denylist like #161, and add the file to `CHARGE_FLOW_FUNCTIONS` in the static pin. Do NOT add it to the pin before fixing the filter — the pin would fail on the still-present `type:"card"`.

---

## #163: `DocumentPackDialog` is dismissible mid-payment → reopen mints a fresh idempotency key → double pack subscription (MEDIUM, pre-existing)

**Filed 2026-07-16** (surfaced by the #161 polish review; pre-existing, not bundled). Unlike its two sibling money dialogs — `LimitReachedDialog` blocks close during `processing` (`:123`) and `NewWorkspaceDialog` guards the in-flight window (`isInFlight`) — `DocumentPackDialog`'s `onOpenChange` is not guarded during `processing`/`finalizing`, so an Esc/overlay-click mid-confirm closes the dialog with no outcome signal; reopening runs `handleBuy` which mints a NEW `crypto.randomUUID()` idempotency key (`:141`), so the same pack can be purchased twice → two active pack subscriptions → double capacity + double monthly charge. (Financial integrity otherwise holds: the webhook is the sole entitlement writer and each sub is legit; this is a UX-induced duplicate-purchase, not a ledger bug.)

**Fix:** mirror the siblings — ignore `onOpenChange(false)` while `step === "processing" || step === "finalizing"`, and/or persist the idempotency key across a reopen within the same intended purchase (as `LimitReachedDialog` does with `idempotencyRef`).

**Filed 2026-07-16 from the owner's live repro** (Business trial account "Labs Analytix", payment method = Stripe Link — the method Stripe Checkout *defaults to*). Screenshots show both purchase surfaces refusing a paying customer.

**Symptoms (owner-observed live):**
1. Usage → "Add capacity" dialog preemptively shows *"Add a payment method in the billing portal before buying a pack"* (`packs.no_card_banner`, `DocumentPackDialog.tsx:297`) — for an account whose Billing tab correctly displays "Stripe Link (…)" as the saved method.
2. Workspaces → "New workspace" → *"We couldn't find a saved card — Add a payment method to continue."* Same account.
3. Billing trial banner says *"the card on file will be charged"* (`account.trial_banner_desc`, en/es) — the method on file is Link, not a card. Copy lies for every wallet/ACH customer.

**Root cause (verified):** both charge surfaces resolve the payment method with `stripe.paymentMethods.list({ type: "card" })` and fail `no_card_on_file` for any non-card type — `manage-document-pack/index.ts:104-107` and `create-workspace/index.ts:107-110` — because their client confirmation is `confirmCardPayment`-only. This is the *deliberate* "card-specific charge flows reject non-card early" rule (CLAUDE.md, PR #81 scoping correction), which was correct as an anti-orphan guard but wrong as a product endpoint: **since Checkout defaults new subscribers to Link, the typical customer's only saved method is non-card, so both expansion-revenue purchases (packs + $499 add-workspace) are unavailable to the mainstream path.** The prior filing ("Enhancement (open) — non-card methods in the $499 add-workspace charge", Low-ish framing) is SUPERSEDED by this item: it under-classed the impact (it treated Link as an edge case, it is the default) and covered only one of the two blocked surfaces.

**Also misleading copy (fix in the same beat):** both dialogs say "add a payment method" when one exists — the truthful message is "this purchase currently needs a card" (or better, the fix below makes the message moot); the trial banner should describe the actual method (reuse `describePaymentMethod()`'s label) or say "your payment method on file".

**Fix direction (decide mechanism before building):** either (a) in-app **Payment Element** — replace `confirmCardPayment` with `stripe.confirmPayment` and let the saved Link/card/ACH method (or a fresh one) fund the PaymentIntent/subscription, preserving the current in-dialog consent UX; or (b) route packs + add-workspace through **hosted Stripe Checkout** like plan subs (webhook already routes pack subs by `metadata.addon_type` and credits by `payment_intent.succeeded`), simpler + method-agnostic but changes the felt flow to a redirect. Either way: DoD = drive each surface live with a **Link**-funded test transaction (the exact gap that let this class ship twice).

---

## Settings/Workspaces LIVE walkthrough (2nd pass) 2026-07-12 — layout fixed, felt items filed

Owner: "the walkthrough didn't do a good job on UI polish through Settings/Workspace; sections under My Workspaces don't stay stationary when subsections scroll." Reproduced + verified fixes in a REAL browser (local Vite against a mock Supabase, owner-shaped data). Layout reviewer + polish reviewer swept the full surface.

**Fixed + live-verified (this pass):**
- **Section rail scrolled off-screen on tall sections** (the reported bug) — rail is now `md:sticky md:top-20` on both `WorkspacesSection` and `AccountSettings`; mobile rail is a horizontal scroll strip, not a wrapped pile. (commit `cb30b65`)
- **Content width jumped between sections** (My Workspaces `max-w-5xl` vs uncapped config sections) — one shared `max-w-4xl`; `min-h` trimmed to cut short-section dead space; header now shows the active section ("Workspaces · Members"). (`cb30b65`)
- **Deleting your only workspace stranded the account** — informed-consent gate added (amber warning + required acknowledgement). (commit `76f1694`)

**Felt-experience items — RESOLVED 2026-07-12 (unified-autosave pass, live-verified against a mock backend):**
- **[HIGH] Silent data-loss + inconsistent persistence model — RESOLVED.** The whole surface now runs ONE model: every control persists on change (selects/checkboxes) or on blur (text/number inputs), a per-card "Saving…/Saved ✓" chip confirms, failures toast AND revert the field to the last persisted value. All seven Save buttons removed; list add/remove commits immediately (verified live: PATCH on add; optimistic revert on a failed write; `set_workspace_roles` RPC on a role toggle). No-op writes are skipped via last-persisted refs, so the old "saved!" toast on unchanged data is gone too. Splitting the name/timezone write also retired the #87 bundling workaround.
- **[MEDIUM] Editor phantom sections — RESOLVED.** General + Notifications show a compact "View-only — only workspace admins can change these settings" notice instead of disabled dead Save buttons.
- **[MEDIUM] "Company Profile" label over-promise — RESOLVED.** Rail item renamed "General" (en+es), matching the Workspace Details card it opens.
- **[MEDIUM] Workflow-roles "Admin" collision — RESOLVED, and the prior copy was WRONG.** Investigation showed the functional `admin` (workspace_roles) is a distinct, load-bearing grant — `canUploadExecutedDocument`/`canAccessVarianceReview` check it and AppContext never merges the access-level Admin in — so PR #84's "the same Admin as the access level" helper text was factually incorrect. Column renamed "Workflow admin" with honest copy naming its real capabilities; the column stays (removing it would orphan those grants).
- **[MEDIUM] Risk Watchlist load failure rendered genuine-empty — RESOLVED.** Distinct error state + "Try again" panel ("Your entries are safe — this is a loading problem, not a data problem").
- **[MEDIUM] Leave-workspace raw `err.message` — RESOLVED** (human message; raw error logged to console).
- **[MEDIUM] Card-header inconsistency — RESOLVED** via a shared `SectionCardHeader` (icon + title + right-aligned autosave chip) used by every section card.
- **[LOW] Timezone list — RESOLVED** (AZ/HI/AK/UTC + London/Paris/India/Singapore/Tokyo/Sydney/São Paulo). Owned-empty state gained a "Create your first workspace" CTA; member-of "Switch to" icon corrected (ArrowRightLeft, not ExternalLink). Default-approver assignee no longer displayed twice (Select trigger is static "Change"/"Assign").

**Reviewer round on the autosave pass (security+integrity+auditor+polish, 2026-07-12) — fixed in the follow-up commit:** the roles/config loader-honesty class (a swallowed load error rendered false-empty/default state that one autosave click would then persist over real data — full-replace roles wipe being the worst case; now every loader tracks its error, shows a "Try again" panel, and its card's writers stay BLOCKED until a load succeeds); thresholds NaN/Infinity→silent-NULL clear (validated + display normalized to stored); asset-type revert baseline mismatch (`persistedRef` now mirrors the state defaults); backdoor toggle routed through `persistWorkspace` (chip + no-rows check, optimistic); validation failures now show the error chip, not just a toast; in-flight disables on list controls; undo toasts on remove; Enter commits text fields; empty-name revert explains itself; mobile role label says "Workflow admin"; a11y labels on the approver controls; watchlist save/delete errors humanized; Switch-to/Transfer icon collision resolved.

**Still filed:**
- **[HIGH] Hardcoded-English settings body — RESOLVED 2026-07-12 (full en/es sweep, walked in Spanish).** ~170 new keys under `workspace.*` (autosave chips/notes, config/roles error panels, Default approvers + Workflow roles, all Lease Configuration cards, Approval Rules, Review Thresholds, Counter-Signature, Onboarding, My Workspaces panel incl. counts with i18next plurals, leave/delete dialogs incl. the last-workspace guard, Risk Watchlist, MembersPanel toasts + role labels). Verified by walking the live app in Spanish (Members, Lease Config, My Workspaces, delete dialog — correct plurals and formal-usted throughout). **Guardrail added:** `src/lib/__tests__/localeParity.test.ts` fails CI on en/es key drift, empty values, or `{{placeholder}}` mismatches, and CLAUDE.md's locale rule is now ENFORCED wording (all user-facing copy ships via i18n in both files in the same commit). Also fixed in the sweep: the watchlist list-item variable shadowing (`t` → `tpl`); the three orphaned `workspace.save_changes/saving/read_only` keys removed (#71c partially cleared). NOT in scope: the timezone display names (proper-noun-ish, left English) and surfaces outside Settings/Workspaces.
- **[LOW] persistRoles residual lost-update window** — two role writes in flight together (same-batch events / out-of-order completion) could last-writer-wins-drop the earlier one; success doesn't re-sync from the DB. Mitigated by disable-while-saving; fix = per-key write queue or sequence token. (security+integrity)
- **[LOW] Rapid role toggles are swallowed by the whole-card in-flight disable** — safe but frictional for "check, check, check" configuration; fix = queue/merge changes or disable only the toggled row. (polish)
- **[LOW] Members screen speaks two feedback languages** — `MembersPanel`/`MemberRoleSelect` still toast while the sibling cards chip; give MembersPanel the SectionCardHeader+chip treatment (component is reused in the My Workspaces sheet). (polish)
- **[LOW] Autosave chip is out of view on tall cards** (roles grid, long option lists) — success has no signal at the point of interaction; consider the bottom microcopy doubling as live status. (polish)
- **[LOW] Blur-persist doesn't flush on unmount-without-blur** (browser Back mid-edit discards a typed-but-unblurred field edit) — debounce-on-change or a cleanup-effect flush. (polish)
- **[LOW] `default_notification_days` has no server CHECK** (client validates 1..365; countersig twin has one) — add an idempotent CHECK migration; same for `covenant_threshold`/`approval_threshold` (≥ 0). (security)
- **[LOW] Workspace config writes are unattributed in the activity log** (pre-existing; name/timezone/thresholds/countersig/asset types/option lists — only roles log via the RPC). Two of these shape approval routing; stub: a `workspace_config_changed` activity row (column, old→new, actor). (integrity)
- **[LOW] Risk Watchlist card keeps its old plain header** while siblings use SectionCardHeader. (polish/layout)

---

## Workspace-settings walkthrough 2026-07-12 (Members / approval chains / roles / lease config) — fixed + filed

Same live-browser method as the billing walkthrough (owner: "none of this seems easy to navigate or is self-explanatory"). Walked: My Workspaces inventory, Company Profile, Members, Notifications, Lease Configuration, Risk Watchlist, Approval Rules (+ standalone rules list/editor), Onboarding.

**Root confusion confirmed on screen: three permission systems stacked on the Members page with no explanation** — Team Members access roles (Owner/Admin/Editor/Viewer), the legacy fixed "Approval Chain" editor (manager→financial), and an "Other Roles" grid with a SECOND Admin toggle — while the real routing engine (Approval Rules) sat behind a bounce button on a section page whose visible content was two unrelated settings (Review Thresholds, Counter-Signature Window). An admin configuring the Members-page chain would reasonably believe they'd set up approvals.

**Fixed 2026-07-12 (verified rendered):**
1. Members page: "Approval Chain" → **"Default approvers"**, described as the FALLBACK ("routes a lease request only when no Approval Rule matches"), with an inline callout + link "Set up Approval Rules →" naming the precedence.
2. "Other Roles" → **"Workflow roles"** with explicit definitions (Submitter = can create/submit requests; Admin = same Admin as the Team Members access level).
3. Approval Rules section card: leads with what rules DO + the precedence over the default chain; button "Open Approval Rules"→"Manage rules" + a line saying what's inside (rule builder + sample-request tester).
4. Rule-builder sentence leaked raw snake_case (`real_estate`) for asset types outside its hardcoded option list — now humanized via `prettyAssetType` fallback.

**Filed (deeper, own beat):**
- **[MEDIUM] Rule-builder asset-type options are hardcoded — RESOLVED 2026-07-12 (this was the deeper pass's headline).** Root cause was bigger than "hardcoded options": `leases.asset_type` is written with three spellings for the same real-estate class (`property` from the Path-1 request form, `real_estate` from the AI classifier, config label `"Real Estate"` from LeaseReview), and the approval-rule matcher compared them with an EXACT string match in BOTH matcher copies — so a rule authored as one spelling silently failed to route a lease stored as another. Fix (commit `2ffd5d1` + polish follow-up): a canonical asset-type token (`canonicalAssetType` in `src/lib/assetTypes.ts` + Deno mirror in `resolve-approval-chain` + SQL `public.canonical_asset_type` in migration `20260712140000`, folds property/real_estate/"Real Estate" → `realestate`) used on both sides of the compare; `buildAssetTypeOptions()` merges built-ins with the workspace's `asset_type_config` so custom Asset Types are selectable, threaded into the rule builder AND both "Try it on a sample request" testers (edit page + rules-list page). Reviewed clean by security + integrity + code-auditor; static drift test guards the SQL⇄Deno⇄TS lockstep. **Migrations `…140000` + `…150000` APPLIED to staging + verified live; the `resolve-approval-chain` edge-fn redeploy (the one step making the LIVE matcher canonical — the tester/RPC is already live) is pending an owner CLI deploy — verified-safe single change, see `docs/CANONICAL_ASSET_TYPE_DEPLOY_2026-07-12.md`.** Also fixed in the same pass: legacy `real_estate` values now show the matching built-in checkbox checked (canonical `checked`/toggle); rules-list summary chips humanized; first-run "requests **a** any lease type" grammar; tester Selects gained an explicit "Any"; pill popover scrolls.
- **[MEDIUM] "Try it on a sample request" tester (`preview_policy_resolution` RPC) has no top-priority tie detection that the live matcher enforces.** The live `resolve-approval-chain` matcher hard-errors on two policies tied at the top priority (`ambiguous_match`, 409, no chain built); the RPC just `ORDER BY priority DESC ... LIMIT 1` and confidently returns one winner. Pre-existing, but the 2026-07-12 canonical fold WIDENS its reachability: two rules authored as `['property']` and `['real_estate']` at equal priority used to stay distinct (exact compare) and now both fold to `realestate`, so they can tie. Result: the tester vouches "Policy X matches" while a real submission of that lease fails with "Multiple rules tied." It **fails closed** (no misroute/data loss) — the harm is to the admin's trust in the tester during setup. FIX: give the RPC the same tie detection (detect ≥2 policies at the max matched priority → return a `matched:false`/`ambiguous` shape mirroring the live outcome). Surfaced by lease-repository-integrity-reviewer.
- **[MEDIUM] The rule-builder "lease type" pill conflates two different match axes** — `match_asset_types` (how the lease is classified) and `match_lease_types` (the document category) are ANDed by the matcher but rendered as one `joinWithOr` pill, so selecting the same concept in both groups renders a misleading duplicate ("Equipment or Equipment", "Property (Real Estate) or Real Estate") and the "or" mis-describes the AND. The popover stacks two unexplained checkbox groups whose members overlap. Needs an IA decision, not a lossy label-dedupe: either add one-line helper text distinguishing the two axes, or collapse them into one labeled axis if the match semantics allow. Surfaced by lease-product-polish.
- **[LOW] Rule editor's sticky action bar** (Try it / Cancel / Save) overlaps form content at some scroll positions, and its `flex-1` spacer strands wrapped buttons at narrow widths — give the page bottom padding equal to the bar height and prefer `justify-between` over the spacer.
- **[LOW] Rule-editor / tester asset-type list flashes** built-ins → built-ins+custom once the workspace row resolves (~200ms). Only visible on a workspace with custom Asset Types; gate the pill/tester on the workspace query's success if a seamless first paint is wanted.
- **[LOW] Lease Configuration has five separate Save buttons** (asset types/departments/regions/locations/buildings) — consider one sticky save or per-list autosave; also the two Members-page saves (role dropdowns save instantly, Workflow roles need "Save Roles") are inconsistent persistence models on one page.
- **[LOW] Default-approvers rows show the assignee twice** (avatar+name AND the same name in the select) — collapse to the select-only once a row is assigned.
- **[INFO] The legacy default chain remains the only pre-Rules routing surface** — long-term, consider representing it AS the default Approval Rule (single mental model; the DB already has `is_default_fallback`).

---

## Live billing-UX walkthrough 2026-07-12 (Playwright-driven, stubbed backend) — fixed + findings

The owner reported (a) a blank page from the invoice "View" link and (b) inconsistent cancel notices between the in-app flow and the portal path. Rather than diff-reading, the actual app was driven in a real browser (local Vite against a network-stubbed backend mirroring live staging data shapes), walking the full Billing tab state machine: trialing → cancel dialog → scheduled-cancel → resume → portal round-trip → plan picker → usage.

**Invoice "View" blank page — NOT a setup problem (verified server-side).** The hosted invoice URL returns HTTP 200 with a valid "Stripe Invoice" page — but the body is a ~745-byte JS shell rendered entirely by `js.stripe.com`. Under a content blocker (or while the script loads) the page is a dark blank frame — which is what the owner's extension-heavy Safari showed. Nothing to configure. Mitigation shipped: invoice rows now show **View** (hosted page) + **PDF** (direct download, no JS required).

**Cancel-notice inconsistency — root cause: the portal offered its own duplicate Cancel.** Canceling inside the Stripe portal returned to a neutral "Billing information refreshed" toast instead of the scheduled-cancel notice. RESOLVED: `customer-portal` now pins a **card-management-only portal configuration** (payment-method update + invoice history; subscription cancel/update disabled; tagged `metadata.leaseio_config=card_management_v1`, created on first use, cached; falls back to the account default on failure). The in-app flow is now the single cancel door, with its full notice. As a knock-on, the **downgrade** dialog (which handed off to the portal — a dead-end once the portal lost plan controls) now routes through **checkout, same as upgrades**; the hardened webhook cancels the displaced sub automatically.

**Also fixed from the state walk (each verified live before/after):**
- Trial banner contradiction: with a cancel scheduled, the banner said "the card on file will be charged on {date}" directly above "Scheduled to cancel on {date}". Now a scheduled-cancel trial shows the honest variant ("…scheduled to cancel — you won't be charged. Resume anytime…").
- `capitalize` CSS on the payment line mangled the Stripe Link email ("Lat36foods@Gmail.Com") — now applied to the card-brand line only.
- Duplicate portal doors on the trial state (banner button + Payment "Update") with different labels — the banner button was removed; the Payment section is the single door. Dead `account.add_payment_method` key removed from both locales.
- Casing consistency: "Cancel subscription" / "Keep subscription" / "Update payment method" (en+es).

Ops note: a seeded walkthrough login exists in staging auth (`claude-ui-walkthrough@leaseio.test`, accepted admin member of Labs Analytix) for future UI walkthroughs; remove it if undesired. The temporary `debug-invoice-check` edge fn was tombstoned (410) — deletable from the dashboard.

---

## Money-path audit 2026-07-11 (second pass, adversarial lens) — fixed + deferred

Three parallel adversarial reviews (webhook state machine/races · financial math/ledgers · Stripe Basil API semantics) + live staging verification. The ledgers (credits, packs, entitlement guard) came back genuinely solid — atomic, idempotent, fail-closed, price-verified. The defects were at the subscription-orchestration layer and in Basil API field moves.

### RESOLVED 2026-07-11 (same-day fix batch; deployed to the project)

1. **[CRITICAL] Basil removed top-level `subscription.current_period_end`** (moved to subscription items) — the old read returned `undefined` on every event, so `workspaces.subscription_period_end` was **NULL for every subscription** (verified live), killing trial-end/renewal/pack/scheduled-cancel dates and leaving **`vault-renewal-reminder` permanently matching zero rows**. Fixed with the items-aware resolver `_shared/stripe_subscription.ts` (top-level → `items.data[0]` → `trial_end`), used by stripe-webhook (incl. the grace-anchor fallback), cancel-subscription, get-billing-summary, manage-document-pack. **Rule: never read `current_period_end` off a subscription directly.** Heal: the existing NULL row self-heals on the sub's next event (trial end 7/18) or by resending its `customer.subscription.updated` from the Stripe dashboard.
2. **[CRITICAL] Basil removed `invoice.payment_intent`** — all three `default_incomplete` surfaces (`manage-document-pack` confirm, `create-workspace` $499, `create-firm-subscription`) expanded `latest_invoice.payment_intent`, which fails under the pinned API version; none of these had ever been driven live (staging: zero pack/add-workspace/firm-sub successes ever). Fixed: expand `latest_invoice.confirmation_secret`, return its `client_secret` (same secret; `confirmCardPayment` unchanged client-side); `paymentIntentStatus` degrades to `"requires_confirmation"`. **Must be driven with a real test transaction per surface (DoD gate) — never exercised before.**
3. **[CRITICAL] Firm sub recorded on unpaid `incomplete` event** — `applyFirmSubscription` wrote `firms.stripe_subscription_id` on ANY non-deleted event; `create-firm-subscription` uses `default_incomplete`, so the pointer landed pre-3DS → abandoned payment left the firm "subscribed" (free `business` children, retry blocked by the already-subscribed short-circuit) with no self-heal. Fixed: entitlement gate (active/trialing only) + stale-deleted guard (only the current sub's `deleted` clears the pointer) + billing-critical firm writes now throw on DB `{ error }` so Stripe retries.
4. **[HIGH] Plan-switch double-billing** (ratified review billing §2) — checkout upgrades created a NEW sub and never canceled the displaced one ($299+$499/mo forever; Vault reactivation kept the $249/yr sub renewing). Fixed in the webhook checkout branch: after the entitlement write, the displaced sub is retrieved, verified to be THIS workspace's own non-terminal plan sub (never a pack/firm sub), canceled at Stripe, and audited (`displaced_subscription_canceled`). Failure is loud ("OLD SUB MAY STILL BE BILLING") — residual: a failed cancel isn't retried (event replay re-reads the new pointer); ops follow the log.
5. **[HIGH] Unlimited re-trials + trial-on-upgrade** — `trial_period_days: 7` was unconditional (the comment claiming Stripe dedupes trials natively was wrong): cancel→re-subscribe minted a fresh free week every time, and paying customers' upgrades started free-trialing subs (compounding #4). Fixed: trial only when the workspace has NO stored `stripe_customer_id`/`stripe_subscription_id` (first-ever subscription). Also: checkout now prefers the workspace's stored customer id over the email match (#61-class), keeping all subs on one customer.
6. **[HIGH] Purge-vs-renewal race** — the purge loop trusted the DB mirror (webhook-lagged), so a customer who renewed seconds before the cron could have their new sub canceled and data destroyed. Fixed: a **Stripe-truth re-check** (live entitled sub tagged to the workspace → heal, not purge; fail-closed on Stripe errors) before any destruction, plus zero-row detection on the conditional workspace delete (a concurrent heal now skips the storage purge and logs CRITICAL instead of orphaning documents).
7. **[HIGH] Firm-bound workspaces: standalone-sub webhook events** — any lingering standalone plan sub's event resolving to `plan='starter'` hit the firm plan-lock trigger (no service_role carve-out) → UPDATE rejected → webhook 500 → ~72h Stripe retry storm, monthly, forever; a `deleted` event would have stamped the cancellation lifecycle on a firm-paid child. Fixed: `applySubscription` early-exits for firm-bound workspaces (loud warn).
8. **[HIGH] QuotaWarningBanner false alarms for pack buyers** — the quota poller snapshot used hardcoded `TIER_LIMITS`, ignoring `document_limit` + `addon_document_capacity`: a Starter + 20-pack workspace at 20/35 (57%) rendered a non-dismissible "133% used — critical" banner pushing them to buy MORE capacity. Fixed: effective caps = `document_limit + addon_document_capacity` for the active-lease and monthly-extraction metrics.
9. **[HIGH → hardening] Same-sub stale-event resurrection** — C1/C2 compare sub IDs only; a retried entitled `updated` landing after the same sub's `deleted` would null the grace lifecycle and restore the plan forever (free service; no later event corrects it). Fixed: the subscription-event branch now **retrieves the sub fresh from Stripe** and applies current truth (payload fallback on retrieve failure) — the pattern the checkout branch already used.

Regression pins: `src/lib/__tests__/moneyPathHardening.test.ts` (18) + `stripeSubscriptionPeriod.test.ts` (unit + no-direct-read guard). Full suite 1407 green.

### Filed OPEN by the same audit (decisions/complex — own beat)

- **[HIGH] Monthly-extraction counters diverge on soft-deleted leases → silent credit burn.** The server gate (`process_lease` monthly count, service-role, no `deleted_at` filter) counts soft-deleted leases; the client meter (AppContext, `authenticated`) can't see them under the `leases_hide_soft_deleted` RLS. At the cap, a user who soft-deletes N leases sees N free slots in the UI, but the server still counts them — the next upload is decided `needs_credit` and **silently consumes a purchased $12/$10 credit with no consent dialog** (or blocks a user who was told they have room). Counting regardless of deletion is the financially-correct semantics (the AI spend happened) — the fix is making the client/poller surface the server's number (e.g. serve `documentsUsed` from the service-role quota snapshot), NOT relaxing the server (soft-delete→restore would otherwise mint quota). Needs an owner call on where the meter reads from. Broken by the 2026-06-25 Phase-3 RLS; contradicts #31 Finding A's "meter and gate can never disagree" invariant.
- **[HIGH] `bind-workspace-to-firm` doesn't retire the child's standalone plan sub** — the firm pays N×$499 while the child's own $299/$499 sub keeps billing (in-app cancel paths are firm_managed-blocked). The webhook early-exit (fix #7) stops the retry storm/lifecycle damage, but the redundant sub keeps charging. Needs a policy decision: cancel-at-period-end (house pattern, no refund) vs immediate cancel at bind. Recommend: `cancel_at_period_end` on the child's plan sub inside `bind-workspace-to-firm` + audit row. (Supersedes the passive #129 hygiene note.)
- **[MEDIUM] Plan checkout prices are never amount-verified against config** — `manage-document-pack` verifies its Stripe Price amount before charging; `create-checkout`/`create-workspace`/`create-firm-checkout` don't. After the 2026-07-04 $249→$299 reprice, a stale operator env Price (e.g. `STRIPE_PRICE_STARTER_ANNUAL` minted under the old tariff) would silently charge ≠ display. Fix: replicate the pack-style `prices.retrieve` amount check; interim operator step: verify the two annual env prices charge $2,870/$4,790.
- **[MEDIUM] C1/C2 check-then-act** — no optimistic-concurrency guard on the workspaces entitlement UPDATE (~1-2s overlap window between concurrent deliveries could re-point to the old sub with no self-heal). Largely mitigated by the fresh-retrieve fix; full close = conditional UPDATE (`WHERE stripe_subscription_id = storedSubId`).
- **[MEDIUM] `sweep-pending-workspaces` + `create-workspace` resume use eventually-consistent `subscriptions.search`** for destroy/resume decisions — a just-confirmed sub can be invisible to the stale index at the 2h boundary. Fix: `subscriptions.list({customer})` (the webhook's own documented choice) before cancel/delete.
- **[LOW] Pack-capacity recompute race** (two concurrent pack events, last-writer-wins with older total; self-heals ≤1 month) — pairs with the filed #138 reconcile-sweep gap.
- **[LOW] Plan-sub money with no `workspace_id` metadata is warn-and-dropped** — the #65 dead-letter net only covers pack/single-lease sources (a new source value needs a migration to the CHECK).
- **[LOW] No refund/dispute handling on the credit ledger** (refunded PI leaves the credit spendable; disputed pack invoice keeps capacity until Stripe cancels) — pairs with #138.
- **[LOW] `retry_lease` has no quota gate** — un-metered re-extraction for over-cap workspaces (customer-favorable, bounded to Failed leases).
- **[LOW] Firm `updated` redeliveries duplicate `firm_activity_log` rows** (audit noise only; entitlement writes now fail loud per fix #3).
- **[MEDIUM — policy] Annual-sub displacement forfeits the prepaid remainder with no credit.** The displaced-sub cancel (fix #4) is immediate + no-refund — right for monthly (≤1 month forfeited), but an annual Starter ($2,870) upgrading mid-year forfeits up to ~11 prepaid months. The audit row now records `old_status` + `old_period_end` so the forfeiture is defensible; whether to issue a proration credit on annual switches is an owner pricing decision (options: `subscriptions.cancel(id, { prorate: true })`, or block in-app annual→X switches behind support).
- **[LOW] `DocumentPackDialog` lacks the retrieve-PI-before-fail recovery `NewWorkspaceDialog` has** — a network flake after a successful confirm shows "payment failed" while the webhook grants capacity anyway. Copy the NewWorkspaceDialog pattern.
- **[LOW] Unpaginated `subscriptions.list(limit:100)`** in the purge heal-check + `cancelWorkspaceSubscriptions` — a customer with >100 historical subs could hide one beyond page 1 (newest-first mitigates). Paginate like the webhook's pack loops.
- **[OPERATOR] Live-mode launch additions:** pin the live webhook endpoint's API version to `2025-08-27.basil` when creating it (STOP 3 — event shape follows the ENDPOINT's version, not the SDK pin); save a default **Billing Portal configuration in live mode** (one-time dashboard step; without it every portal open 500s); after deploying the period-end fix, optionally resend the live sub's `customer.subscription.updated` event to heal the NULL `subscription_period_end` immediately.

---

## Billing tab + create-workspace dropped non-card payment methods (Stripe Link) — RESOLVED 2026-07-11

**Severity:** High (functional, not just cosmetic). **Found:** live operator test, not the audit.

**Symptom:** After a successful Stripe Checkout paid via **Stripe Link** (Checkout's default wallet), the in-app Billing tab showed "No payment method on file yet" for a paying customer, and `create-workspace` would have rejected a Link-paying owner with `no_card_on_file` — blocking $499 additional-workspace creation.

**Root cause:** both `get-billing-summary` and `create-workspace/resolveCustomerAndCard` resolved the saved method with `stripe.paymentMethods.list({ type: "card" })` and read `pm.card`. A Link (or Apple/Google Pay / ACH) method has a **non-`card`** PaymentMethod type, so the filter silently dropped it. The customer's `invoice_settings.default_payment_method` is also empty because Checkout sets the method on the *subscription*, not the customer default — so both lookup paths missed it.

**Fix:** shared type-exhaustive mapper `describePaymentMethod()` (`src/lib/paymentMethodDisplay.ts` + Deno mirror `supabase/functions/_shared/payment_method.ts`) handles card / link / us_bank_account / any future type, and NEVER returns null for a present method. `get-billing-summary` (the DISPLAY surface, the actual symptom) drops the `type:"card"` filter and maps through it; the Billing tab renders card ("Visa •••• 4242") or a labeled wallet ("Stripe Link (email)"). Regression tests: `paymentMethodDisplay.test.ts` (8) + updated `billingSummaryGating.test.ts`. Operator step: redeploy `get-billing-summary`; the frontend label ships with the next Vercel build.

**Scoping correction (PR #81 review, Codex):** `create-workspace`'s `resolveCustomerAndCard` was initially broadened too, but that flow's $499 charge is confirmed client-side with Stripe.js `confirmCardPayment` (card-only). Accepting a non-card method there let the caller past eligibility and then fail after a pending workspace + PaymentIntent were created and rolled back. So `create-workspace` **stays card-only** (filters `type:"card"`, rejects non-card early with `no_card_on_file` — no orphan) — only `get-billing-summary` is broadened. **⚠ SUPERSEDED 2026-07-16 by #161: `create-workspace` is NO LONGER card-only.** The client now confirms method-agnostically (`confirmSavedMethodPayment` / `stripe.confirmPayment` with `redirect:'if_required'`), which removes the anti-orphan rationale, so the resolver was broadened to any synchronous method type (bank debits declined honestly). See #161.

### Enhancement — non-card methods in the $499 add-workspace charge — **RESOLVED 2026-07-16 by #161**

> **RESOLVED 2026-07-16 (#161).** Implemented more simply than this note predicted: instead of type-branching the client confirmation, all three purchase dialogs adopted the single method-agnostic `confirmSavedMethodPayment()` helper (`stripe.confirmPayment`, `redirect:'if_required'`), which completes card / Link / wallet in-page. A Business owner whose saved method is Stripe Link can now create additional workspaces. Deferred-settlement bank debits (ACH/SEPA) are declined early with honest copy (no `processing` UX). Pending live Link-funded verification per #161's DoD.

**Why the audit missed it (process note):** the review read the billing code but never drove a live payment, so the `type:"card"` assumption wasn't exercised. This is exactly what the plan's Definition-of-Done "rendered persona walkthrough" gate exists to catch — reinforced: **any billing/payment surface must be exercised with a real Stripe test transaction, including a Link/wallet method, before it's called done.**

---

## Subscription cancel: double-cancel + silent return + false "auto-renews" — RESOLVED 2026-07-11

**Severity:** High (felt-experience + a factual-lie in the UI). **Found:** owner report ("they land where they still have to click cancel… no notice informing them they canceled") → full billing/payment surface audit (self + lease-product-polish).

**Symptoms (one broken journey, several defects):**
1. **Double-cancel.** The in-app "Cancel subscription?" confirm dialog didn't cancel — its CTA called `handleManagePayment()` (opened the Stripe billing portal), where the user had to find and confirm "Cancel plan" a *second* time + answer Stripe's survey.
2. **Silent return.** The portal `return_url` carried no marker; the only return handler keyed off `checkout=` (set solely by `create-checkout`), so every portal round-trip (cancel / downgrade / update-card) ended with no toast, no refresh — an updated card even kept showing the old brand/last4.
3. **False "Auto-renews on {date}".** Stripe leaves `subscription.status='active'` for up to a month after a cancel is *scheduled* (`cancel_at_period_end=true`). The workspace never tracked that flag, so the plan header kept saying "Auto renews" — a lie — with no way to undo in-app.
4. **Swallowed server errors.** `supabase.functions.invoke` collapses any non-2xx into a generic `Error` ("Edge Function returned a non-2xx status code") and nulls `data`, so `no_customer` / `firm_managed` / `annual_not_configured` never reached the user (e.g. "Add payment method" on a no-customer workspace → 409 → generic toast).

**Fix (reuses the in-app pattern packs + firm billing already ship; NO schema/webhook change):**
- **NEW `supabase/functions/cancel-subscription/index.ts`** — owner/admin-gated, workspace-scoped, firm-bound rejected (`firm_managed` 403) before any Stripe call, no-sub → 409. Flips `cancel_at_period_end` (`resume:false`→true schedule / `resume:true`→false undo — never an immediate cancel; access kept to period end). Audits `subscription_cancel_scheduled` / `subscription_cancel_reverted` to `workspace_activity_log` (free-text `event_type`, no migration). Auth boundary is an exact peer of `customer-portal`.
- **`get-billing-summary`** now selects `stripe_subscription_id` and returns a `subscription {status, cancelAtPeriodEnd, currentPeriodEnd}` block (one extra Stripe GET, wrapped non-fatal). Sourced live rather than mirrored to a workspace column — keeps the scheduled-cancel signal on the one surface that needs it (the Billing tab) with no webhook/entitlement-guard change.
- **AccountSettings Billing tab** — the confirm dialog's CTA now cancels in-app (`handleSetCancellation(false)`, `preventDefault` keeps it open during the request); the plan header shows **"Scheduled to cancel on {date}" + a Resume button** (`handleSetCancellation(true)`) instead of the false renew line; the cancel section hides once scheduled (never Cancel + Resume at once). `?portal=return` on the portal URL now triggers refresh + billing-summary re-fetch + a neutral toast. `extractFnReason()` + `mapCheckoutError/mapPortalError/mapSubError` surface the real server reason. Bare "Cancel" button relabeled "Cancel subscription".
- **Tests:** new `cancelSubscription.test.ts` (auth/gating/cancel-vs-resume/audit), extended `billingSummaryGating.test.ts` (subscription block) + `subscriptionSettingsPolish.test.ts` (in-app cancel + scheduled-cancel-wins). Full suite green (1379).
- **Operator deploy:** deploy `cancel-subscription`; redeploy `get-billing-summary` + `customer-portal`; frontend ships with the next Vercel build.

### Deferred (own beat — cosmetic/consistency, filed not fixed)
- ~~**[MEDIUM] Downgrade still uses the Stripe portal**~~ **RESOLVED 2026-07-12** (live-walkthrough batch): downgrades now route through checkout like upgrades; the webhook cancels the displaced sub. The portal is card-management-only.
- ~~**[MEDIUM] Payment-CTA label drift**~~ **RESOLVED 2026-07-12**: trial-banner button removed (Payment section is the single portal door); past-due label sentence-cased; dead `add_payment_method` key removed.
- **[LOW] Scheduled-cancel visibility for non-admins** — non-admins don't fetch `get-billing-summary`, so they can't see the `cancelAtPeriodEnd` flag. Rather than assert a possibly-false "Auto-renews", the plan header now **suppresses the renewal line entirely when the flag is unknown** (integrity review 2026-07-11 — the "Auto-renews" line is gated on `billingSummary?.subscription` being present, so only an admin whose summary loaded ever sees it; the honest-silence fix). Residual edge (accepted): a *second* admin who opened the Billing tab before the cancel was scheduled keeps a cached summary (the per-workspace `billingSummaryFetchedFor` guard) and sees "Auto-renews" until a manual refresh — the admin who performed the cancel force-refetches and sees the truth immediately. A persisted `cancel_at_period_end` column (webhook-mirrored) would close the residual app-wide if ever needed.
- **[LOW] Cancellation reason (WHY) not captured** on the `subscription_cancel_scheduled` audit row (integrity review) — a subscription cancel is a self-attributed owner/admin decision (WHO/WHEN/WHAT are recorded), so not an integrity requirement; a future churn-analytics pass could accept a free-text reason in the request body.

---

## Cluster A — core request-workflow transitions blocked by the governance trigger (filed + partly resolved 2026-06-23)

Surfaced by a live health audit (the core Path-1 submission was silently failing in production). Root cause: the `prevent_unauthorized_lease_workflow_edits` BEFORE-UPDATE trigger on `leases` `RAISE EXCEPTION`s on any `authenticated`/browser UPDATE that changes `lifecycle_status` (or approval/lock columns), but several client paths still did exactly that direct write — silently rejected, leaving leases stranded and, worse, writing `status_change` audit rows asserting transitions that never happened.

- **#A1 + #A4 — RESOLVED 2026-06-23 (code; PENDING LIVE EDGE DEPLOY).** Primary Lease Request submission (`LeaseRequestForm.tsx:369`) and the retry path (`retryRequestRouting.ts`) flipped `lifecycle_status` in the browser → rejected → lease stranded in `draft` with a misleading "submitted" audit row. Fixed by moving the flip + `status_change` log SERVER-SIDE into `resolve-approval-chain` (fresh-chain / legacy / idempotent-recovery branches); legacy target computed server-side via the new `_shared/approval_routing.ts` mirror so a submitter cannot self-approve. Client now only notifies. Reviewer-clean (security/integrity/auditor/test-author); `retryRequestRouting.test.ts` rewritten to assert the ABSENCE of any client lifecycle write. **`resolve-approval-chain` must be redeployed to the live project for this to take effect** (owner/operator step).
- **#A2 — RESOLVED 2026-06-23.** (1) The governance-bypass buttons "Move to Under Review/Approved" + "Mark Executed" were REMOVED. (2) "Cancel Request" and "Edit & Resubmit" now route through `legacy-lease-action` server actions — `cancel_request` (requester/admin, → `cancelled`) and `resubmit_request` (resets the trigger-guarded approval columns + recomputes status SERVER-SIDE via `_shared/approval_routing.ts` + flips). Both convention-compliant + attributable. Reviewer-clean (security/integrity/auditor). Frontend saves only non-guarded fields in the browser. **Deploy:** `legacy-lease-action` edge function + frontend.
- **#A3 — RESOLVED 2026-06-23 (removed).** The "Post Lease" sticky footer was REMOVED. It activated an `under_review`/`concept_under_review` lease straight to `active` — an INVALID lifecycle transition (skips approved → executed; see `VALID_TRANSITIONS`) and a governance bypass (silently trigger-rejected anyway). The valid paths remain: under_review requests advance via the **Approval Queue** (linked in the LeaseReview header), and a reviewed **executed** lease activates via **Lock & Activate** (`canShowLock` → `model_lock`). Removed `handlePostLease` + the now-orphaned `posting`/`isReviewRequired`/`allLowConfFieldsInteracted`.
- **#A11 — RESOLVED 2026-06-23.** Terminal-state dead-end surfaced by the #A3 polish review (and made reachable by the now-working Cancel flow): `cancelled`/`rejected` request leases fell through `isIntakeStage` into the **editable main workbench**, which showed a "Ready to Approve" primary action and no terminal messaging (the intake view's cancelled banner was unreachable). Fixed: a dedicated terminal view (status badge + rejection reason + "Back to Leases") now renders for `terminal_negative` leases before the workbench, with no approve/edit affordances. Also: cancel-confirm copy corrected (the request is preserved, not destroyed).
- **#A10 — OPEN (Low, hardening).** `resubmit_request` (and the legacy threshold routing generally) computes the post-revision status from the lease's cached `calc_total_commitment` (client-written) — a submitter could understate cost / uncheck the covenant flag to lower the required approval. This is the **pre-existing** trust model (whoever enters the financials drives routing; identical to the old client code), not introduced here. Hardening: recompute `calc_total_commitment` server-side from raw lease fields before routing. Related to #A7 (apply path also doesn't recompute calc_*).
- **#A5 — RESOLVED 2026-06-23 (route + page).** `/app/leases/new` now redirects to `/app/leases` (App.tsx) and the orphaned `NewLease.tsx` was deleted. **Remaining (dead-code cleanup):** `useLifecycleWorkflow`'s now-unused mutating methods (`submitForApproval`/`takeApprovalAction`/`submitForExecutionApproval`) — see the related item later in this file; safe to delete in a code-auditor pass.

### Deferred LOWs from the #A1/#A4 review (2026-06-23)
- **[LOW] flip+log non-atomicity** in `resolve-approval-chain` — `updateLifecycle` + `logStatusChange` are separate awaits; a log-insert failure after a successful flip leaves an unattributed transition. Pre-existing pattern (matches `act-on-chain-step`). A hard guarantee would need a SECURITY DEFINER RPC (or a DB trigger writing the `status_change` from the lifecycle UPDATE itself).
- **[LOW] legacy notification target** is chosen from client-recomputed approval requirements while the flip status is server-authoritative — a divergence window if the two computations ever drift (notifications only; not an audit/security boundary). Accepted tradeoff (the form also needs the requirements for its financial preview).
- **[COVERAGE GAP] no Deno-level test** for `resolve-approval-chain`'s server-side flip/log/`recovered` branches (vitest doesn't cover edge functions). Suggested: `scripts/smoke-resolve-approval-chain.mjs` — seed a draft lease → invoke → assert it advanced + a server-written `status_change` row exists.

---

## Unlock → edit → re-approve loop (filed + partly resolved 2026-06-23)

Surfaced by the product owner + a live audit: after a locked/active lease was unlocked and edited, there was NO button to submit/approve/re-lock the staged changes — the user was stranded, edits staged forever, the lease sat `model_locked=false`. The full backend (`request-lease-unlock` / `lease-governance-action` `submit_change_set` / `cancel_change_set` + re-lock + attribution) and the finalize dialog were already built and correct; the dialog was simply **unreachable** from the `isUnlockedDraft` state (its only trigger lived in `primaryAction`, which returns `null` for that state). Live DB confirmed it had never run: 3 locked leases, 0 unlock requests ever.

- **#A6 — RESOLVED 2026-06-23 (frontend-only).** Wired a primary "Lock & submit N changes" / "Re-lock" button into the `isUnlockedDraft` action bar (`LeaseReview.tsx`) that opens the existing finalize dialog. Reviewer-clean (auditor/security/integrity/polish) + a narrowed static regression guard (`src/lib/__tests__/unlockedDraftActionBar.test.ts`). Same change also: (a) closed an edit-not-yet-staged **data-loss window** — the button now `flushStagedEdits()` (stages dirty fields) before opening the dialog, so a just-typed value can't be discarded by the empty-draft `cancel_change_set` path; (b) fixed a **header-overflow** that re-hid the exit at narrow widths — Discard/Archive moved into a `⋯` menu; (c) added cross-tab legibility — an "Editing — N staged" chip by the status badge; (d) **removed the unlocked-bar "Save changes"** button (it wrote directly to `leases`, bypassing the change-set audit chain). Deploy: frontend only — no edge/DB change.
- **#A7 — OPEN (Medium).** The change-set apply path (`lease-governance-action` `submit_change_set` + approver-approve) writes staged field values literally via `FIELD_TO_COLUMN` but does **not** recompute `calc_*` (`calc_total_commitment` / `calc_pv_liability` / `calc_straight_line_exp` / `calc_cash_pl_delta`). `FIELD_TO_COLUMN` includes calc inputs (`current_monthly_rent`, `term_months`, `base_rent_amount`, `lease_start/end`, `rent_escalation_type`), so an unlocked rent/term correction leaves portfolio analytics **stale after re-lock**. Pre-existing latent gap, now reachable (the apply path was never usable before #A6; the now-removed direct-write "Save changes"/`handleSync` was the only thing that recomputed `calc_*`, via an unattributable write). Fix: recompute `calc_*` server-side in the apply path (needs the `leaseCalculations` logic available to the Deno edge function / a mirror).
- **#19 reachability note (2026-06-23):** `cancel_change_set`'s two-UPDATE non-atomicity (#19) is now the standard empty-draft exit (the "Re-lock" path), making it more reachable — strengthens the case to fix #19 in its own beat.
- **#A8 — OPEN (Low, defense-in-depth).** Server-side `cancel_change_set` (`lease-governance-action`) re-locks unconditionally without counting `lease_change_set_items`, so the client `stagedItemCount` gate is the SOLE defense against discarding a draft that actually has staged edits. #A6's flush makes that gate reliable, but a server-side item-count check (reject / redirect to submit when items exist) would make the audit chain self-protecting rather than client-trusting.
- **#A9 — OPEN (Low, polish).** The lock/finalize dialog's confirm buttons (Apply / Submit for approval / Re-lock) use `bg-success` (emerald) while the header "Lock & submit" trigger and other primaries use `bg-green-600` — a green-token seam between the trigger and the dialog it opens. Pre-existing (dialog untouched by #A6). Fix: standardize the green token app-wide.

---

## Cluster B — AI extraction robustness (filed + resolved 2026-06-23)

Surfaced by the same core-workflow verification pass as Cluster A (`lease-explorer` mapped three distinct extraction failure modes). `process_lease` and `retry_lease` run extraction SYNCHRONOUSLY inside the request; nothing recovered a run that died mid-flight, and the AI/storage call paths had thin input guards. Live DB showed leases sitting `status='Processing'` for **60 days** — a permanent spinner with no retry affordance.

- **#B1 — RESOLVED 2026-06-23 (code; PENDING LIVE EDGE DEPLOY).** Hardened the two synchronous extraction entry points.
  - `process_lease/index.ts` — `callAnthropicAPIWithPDF` (~:345) gained an empty-payload backstop (`if (!pdfBase64 || pdfBase64.length === 0) throw`) and a **bounded** retry loop (`maxAttempts=2`) that retries ONLY on transient status (`429/500/502/503/504/529`), honors `Retry-After` (capped 15s), and is terminal on `400/401/403`; timeouts are NOT retried. The single-lease credit is consumed once BEFORE the Opus call and OUTSIDE this loop, so retries never double-debit (re-verified by integrity/security — clean).
  - `retry_lease/index.ts` — added a storage-download guard after the file fetch (~:762): a 0-byte object downloads "successfully" (no error, truthy data) and would flow into the AI call as an empty payload; now `if (fileBytes.byteLength === 0 || !isPdfFile(fileBytes))` flips the lease to `Failed` with clear copy and throws. (`isPdfFile` magic-byte check at :65.)
  - **Deploy:** redeploy `process_lease` + `retry_lease`. **STILL OWED (2026-06-23):** these two are large core files; redeploy via `supabase functions deploy process_lease retry_lease` (CLI bundles the committed source — not done via MCP to avoid hand-transcribing 115KB of core extraction code). Until redeployed, new leases don't stamp `processing_started_at` (the reclaim sweep safely falls back to `uploaded_at`; the retry-race fix is inert for new retries until then).
- **#B2 — RESOLVED 2026-06-23 (code + migration APPLIED + function DEPLOYED; PENDING ONLY THE CRON SECRET).** New `reclaim-stuck-extractions` edge function (cron-only, `x-cron-secret` = `RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET`, `verify_jwt=false`, service role) sweeps every 15 min and flips leases stuck in `status='Processing'` past 30 min to `Failed` (`error_message` + `processed_at` set) so the user sees a retryable `FailedLeaseBanner` instead of a permanent spinner. It touches ONLY the extraction-status columns (never lifecycle/approval/lock), so it never trips the workflow governance triggers; writes an `extraction_timed_out` audit row per reclaim with `user_id=null` (system attribution, #90 convention) recording `clock_used` + `stuck_since`. Migration `20260623000000_reclaim_stuck_extractions.sql`: (1) adds `leases.processing_started_at timestamptz`, (2) appends `'extraction_timed_out'` to the `lease_activity_log` activity_type CHECK (full verbatim superset + append), (3) schedules the cron. `config.toml` + `.env.example` updated.
  - **Race fix (integrity-flagged, resolved same change):** the sweep originally keyed "is this extraction stuck?" off `uploaded_at`, but `retry_lease` re-enters `Processing` WITHOUT changing `uploaded_at` — so a lease retried >30 min after its original upload could be re-failed mid-retry. Fixed by introducing `processing_started_at` (stamped by `process_lease` on create + `retry_lease` on retry) and keying the sweep off it via a PostgREST `.or(processing_started_at.lt.<cutoff>, and(processing_started_at.is.null, uploaded_at.lt.<cutoff>))` — fresh uploads + retries measure from when extraction actually began, while pre-existing zombies (NULL `processing_started_at`) still fall back to `uploaded_at`. No backfill needed (the fallback covers legacy rows; `uploaded_at` is `NOT NULL`). Reviewer-clean (integrity confirmed the race closes for all four cases; auditor clean; security clean).
  - **Deploy status (2026-06-23):** ✅ migration `20260623000000` APPLIED to staging (version reconciled in `schema_migrations` to match the file); ✅ `reclaim-stuck-extractions` function DEPLOYED (v1, ACTIVE, verify_jwt=false); ✅ cron job `reclaim-stuck-extractions` scheduled (every 15 min). ⏳ **STILL OWED — the cron secret (both places, same value):** `supabase secrets set RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET=$(openssl rand -hex 32)` AND `INSERT INTO private.cron_secrets (id, value) VALUES ('reclaim_stuck_extractions', '<same value>')`. Until set, the deployed function fail-closes 500 on each cron hit (harmless log noise; no data effect) and no zombie leases are reclaimed. (Regenerate `src/integrations/supabase/types.ts` for `processing_started_at` — non-blocking; service-role-only, unreferenced from `src/`.)

---

**Status reconciliation (Phase 3 close, 2026-05-05):**
- Items 1-7 (pre-Phase-3 backlog) all still open. Phase 3 did not touch them.
- Three new items added (8, 9, 10) from the Phase 3 smoke run.
- One item resolved DURING Phase 3 closeout and NOT filed here: the P0
  cross-workspace data leak (UI was missing workspace_id filtering on the
  leases list — RLS allowed multi-membership reads to surface mixed data).
  Fixed in commit `9b46dca`. Permanent regression test belongs in the future
  Owner Workspace Management spec rather than as a sticky issue here.

**Status reconciliation (Owner Workspace Management close, 2026-05-05):**
- Item #8 (duplicate workspace creation): orphan `440d279f-a781-450a-863a-73b51780becd`
  was successfully deleted via the new feature during Checkpoint 3 smoke,
  which validated the delete-workspace edge function's cascade end-to-end.
  The underlying duplicate-creation bug at signup/onboarding remains open
  — a separate ticket fixes that surface; OWM only provided the cleanup tool.
- Item #9 (creator-membership timestamps) NOT addressed by OWM. Still open.
- No new items surfaced during OWM smoke.

**Status reconciliation (Phase 4 close, 2026-05-05):**
- Items 1-9 (pre-Phase-4 backlog) all still open. Phase 4 did not touch them.
- One new item added (#11) for the lease-documents storage cleanup
  in delete-workspace — small follow-up; no security implication.

**Status reconciliation (proactive sweep, 2026-05-07):**
- Item #1 (profiles 400) — RESOLVED. Root cause was missing
  `notify_abstraction_complete` column on `public.profiles` referenced
  by `AccountSettings.tsx`. Added in migration
  `20260507100000_profiles_notify_abstraction_complete.sql`.
- Item #2 (CSP missing wss + WASM blockers) — RESOLVED. Updated CSP
  in `vercel.json` (commit `c2f6276`): added `wss://*.supabase.co` for
  Realtime; added `'wasm-unsafe-eval'` for `@react-pdf/renderer`'s
  yoga-layout WASM; added `data:` and `blob:` to connect-src; added
  `worker-src 'self' blob:` and `frame-src 'self' blob:`.
- Item #5 (WorkspaceSettings owner gating) — RESOLVED. Replaced
  literal `userRole === 'admin'` with `canEditWorkspaceSettings(userRole)`
  on line 164 (previously line 161 per the original report).

**Status reconciliation (Tier 2 build close, 2026-05-08):**
- Item #4 (CSS MIME type error on `theleaseio.com`) — RESOLVED.
  Verified live with curl: `https://theleaseio.com/assets/index-*.css`
  returns `Content-Type: text/css; charset=utf-8`; the JS bundle
  returns `application/javascript; charset=utf-8`; root HTML returns
  `text/html`. All asset MIME types are correct in the current
  deployment. The original failure mode (catch-all serving `text/html`
  for asset paths) is no longer present — likely fixed by a Vercel
  domain config change since 2026-05-03 when the issue was filed.
  Browser-side `strict MIME checking` error described in the issue
  is not reproducible.

**Status reconciliation (P2 batch, 2026-05-07):**
- Item #3 (password DOM warnings) — RESOLVED. Wrapped the password
  card in `<form>` with hidden `autocomplete="username"` shadow input
  and added `autocomplete="current-password"` / `autocomplete="new-password"`
  to the three password Inputs in `src/pages/settings/AccountSettings.tsx`.
  Form's onSubmit calls `handleChangePassword`. Chrome heuristic now
  satisfied; password managers can autofill.
- Item #6 (`ai-assistant` dead filter values) — RESOLVED. Dropped the
  stale `'needs_review'` from the `buildLeaseContext` includes() filter
  and dropped `'failed'` from the `.not('lifecycle_status', 'in', ...)`
  query in `supabase/functions/ai-assistant/index.ts`. Behavior
  unchanged (both values were dead — the constraints never accepted
  them). Redeployed as ai-assistant v3
  (ezbr e74d4c34a441fa2eb0b74ba26ae5529463778d513a7e05648fc54ea2f858dcba).
- Item #9 (creator-membership `invited_at`/`accepted_at` NULL) —
  RESOLVED. `src/pages/app/Onboarding.tsx` now sets both timestamps
  to `now()` when inserting the owner's own `workspace_members` row.
  Behavior unchanged for invitees; just the owner's audit-trail trail
  is now consistent with everyone else's. Existing rows with NULL
  timestamps remain NULL — a one-shot backfill UPDATE could be filed
  if forensics need them, but the live-data effect is cosmetic only.
- Items 4, 7, 8, 10, 11, 12, 13 — still open / deferred / pattern
  notes per their original entries below.

---

## 3. Password field DOM warnings on `/app/settings/account`

**Symptom (browser console):**
```
[DOM] Password field is not contained in a form: ...
[DOM] Input elements should have autocomplete attributes (suggested: "current-password")
```

**Hypothesis:** Chrome heuristic for password manager / autofill. The password
inputs on the account-settings page aren't wrapped in a `<form>` and/or lack
`autocomplete="current-password"` / `autocomplete="new-password"` attributes.

**Where to look:** `src/pages/settings/AccountSettings.tsx`. Wrap password
fields in a `<form>` and add the appropriate `autocomplete` attribute per
input.

**Severity:** Cosmetic — Chrome warning only. Password manager UX may be
slightly degraded.

---

## 4. CSS MIME type error on `theleaseio.com` custom domain

**Symptom (browser console on prod custom domain):**
```
Refused to apply style from '...' because its MIME type ('text/html') is
not a supported stylesheet MIME type, and strict MIME checking is enabled.
```

**Hypothesis:** the request for a CSS asset is returning HTML — typically
because the asset path is wrong and the host's catch-all returns the SPA
`index.html`. Likely an asset-path / base-URL config mismatch between the
`theleaseio.com` apex and the Vercel/Lovable subdomain that the build was
configured for.

**Where to look:** `vite.config.ts` (`base` setting), Vercel project domain
settings, and any environment-specific asset path config. Compare
`https://theleaseio.com` → asset request paths vs the Vercel subdomain.

**Severity:** Medium-High on `theleaseio.com` (style breakage); zero impact on
the Lovable / Vercel subdomain where the smoke is being run.

---

## 6. `ai-assistant/index.ts` filters reference impossible `lifecycle_status` values

**Symptom (audit-time investigation, 2026-05-03):** During the Phase 3
audit, two filters in `supabase/functions/ai-assistant/index.ts` were found
to reference `lifecycle_status` values that have never been part of the live
CHECK constraint:

- **Line 27** (inside `buildLeaseContext`):
  ```ts
  const activeLeases = leases.filter(l =>
    ['active', 'executed', 'needs_review', 'draft'].includes(l.lifecycle_status)
  );
  ```
  `'needs_review'` is not a valid `lifecycle_status`. The `.includes()` for
  it always returns false; harmless dead value.
- **Line 217** (lease query):
  ```ts
  .not('lifecycle_status', 'in', '("failed","cancelled")')
  ```
  `'failed'` is not a valid `lifecycle_status`. The NOT IN clause excludes
  only `'cancelled'` in practice; harmless dead value.

**Root cause:** Likely artifacts from an earlier draft of the schema where
`'needs_review'` and `'failed'` may have been considered for what is now
the separate `status` column (which carries the AI-processing state, not
the lifecycle state). Both columns coexist on `leases`; the dead values
look plausible at first glance.

**Severity:** Cosmetic — no functional bug today. The filters do exactly
what the surrounding code intends; they just carry useless predicates.
Worth cleaning up to prevent future confusion.

**Where to look:** `supabase/functions/ai-assistant/index.ts` lines 27 and
217. Recommended fix:
- Line 27: `['active', 'executed', 'draft'].includes(l.lifecycle_status)` (drop `'needs_review'`).
- Line 217: `.not('lifecycle_status', 'in', '("cancelled")')` (drop `'failed'`); or — better — add the new Phase 3 chain-vocabulary `'cancelled'`-equivalent if/when one exists, and consider whether the AI assistant should also exclude `'rejected'`.

**Decision:** Filed as KNOWN_ISSUES rather than fixed in Phase 3 per user
direction. Phase 3 touches `ai-assistant/index.ts` only at line 64
(`displayLabel()` migration), not the filters.

---

## 7. State-helper consolidation refactor (post-Phase-3)

**Symptom:** Six local constants across the codebase encode the same
semantic groupings as the `STATE_GROUPS` map in `src/lib/lifecycleStates.ts`
(introduced in Phase 3 Checkpoint 2):

- `IN_PROGRESS_STATUSES` in `src/components/dashboard/PipelineByDepartment.tsx`
- `IN_FLIGHT_STATUSES` in `src/pages/Leases.tsx`
- `SHAREABLE_STATUSES` in `src/components/summary/SummaryShareControls.tsx`
- `APPROVED_STATUSES` in `src/components/summary/FinancialImpactSummary.tsx`
- `LIFECYCLE_LABELS` in `src/components/dashboard/RecentActivity.tsx`
- `expiringStatuses` in `src/components/dashboard/SummaryStrip.tsx`

Phase 3's "extend in place" approach (per user direction) keeps each of
these local but extends their lists to include chain-vocabulary
equivalents. This is correct for Phase 3's risk profile but leaves the
lists duplicated across files.

**Recommended fix (dedicated future phase):** consolidate each constant
into a `STATE_GROUPS`-derived helper. For example:

```ts
// Replaces SHAREABLE_STATUSES.has(status):
isInGroups(status, ['post_concept_pre_signator', 'executed_pre_active', 'active'])
```

Surface area: 6 files, six constants, all read-only consumers. Behavior
must remain identical. Add vitest cases that pin each consolidated
predicate's truth table against the previous local-constant behavior.

**Decision:** Filed as KNOWN_ISSUES rather than mixed into Phase 3.
Vocabulary expansion (Phase 3) and constant consolidation are separate
concerns and conflating them would inflate Phase 3's blast radius and
make rollback harder. Re-evaluate after Phase 3 closes.

---

## 8. Duplicate workspace creation on signup / onboarding

**Symptom (database forensics, 2026-05-05):** During the Phase 3 closeout
investigation of "where did Labs Analytix's workspaces come from?", the
`workspaces` table revealed two rows named `"My Workspace"` owned by the
same user, created **13 seconds apart** (2026-01-14 03:35:04 and 03:35:17).
One of the two has zero members and zero leases (orphaned).

```
| id            | name         | created_at                  | members | leases |
|---------------|--------------|----------------------------:|--------:|-------:|
| 440d279f...   | My Workspace | 2026-01-14 03:35:04         |       0 |      0 |
| b0f3c7a0...   | My Workspace | 2026-01-14 03:35:17 (+13s)  |       2 |      2 |
```

**Hypothesis:** A double-fire in the signup → onboarding workspace-creation
flow. Possibly a React StrictMode double-effect, a race between Signup.tsx
and Onboarding.tsx both calling create-workspace, or a retry on a slow
first response that succeeded after the user clicked again.

**Where to look:** `src/pages/Signup.tsx`, `src/pages/app/Onboarding.tsx`,
and any edge function that auto-creates a workspace on first sign-in. Add
an idempotency guard (e.g., "if user already owns a workspace, no-op")
before any new workspace insert.

**Severity:** Medium-Low — orphaned workspaces are invisible due to
empty member/lease state, but they pollute the workspace switcher and
inflate any "active workspaces" count.

**Update 2026-05-05:** The orphan `440d279f-a781-450a-863a-73b51780becd`
was deleted via the new Owner Workspace Management feature during its
Checkpoint 3 smoke (post-delete DB verification: zero orphan rows across
every dependent table; audit row populated correctly). The
duplicate-creation bug itself is still open — preventing future
duplicates is a separate Signup/Onboarding ticket and is NOT addressed
by Owner Workspace Management.

---

## 9. Creator-membership row missing `invited_at` / `accepted_at`

**Symptom (database forensics, 2026-05-05):** Workspace owners' own
`workspace_members` rows have NULL `invited_at` and NULL `accepted_at`.
Members added via the legitimate invite flow have both populated. The
asymmetry breaks audit-trail clarity:

```sql
-- Owner's own admin row (created by the workspace-creation handler):
{ workspace_id: c9dad4c7..., user_id: c2dbf842..., role: 'admin',
  invited_at: NULL, accepted_at: NULL, created_at: 2026-01-07 ... }

-- Invitee row (created by accept-invite edge function):
{ workspace_id: c9dad4c7..., user_id: 3d5d40ec..., role: 'admin',
  invited_at: 2026-04-22 21:22:22.801+00,
  accepted_at: 2026-04-22 21:22:22.801+00, created_at: 2026-04-22 ... }
```

**Where to look:** the workspace-creation handler that auto-inserts the
creator into `workspace_members`. Set `invited_at = accepted_at = now()`
for the creator's own row so every membership has a populated timestamp
trail.

**Severity:** Low — purely a forensics-clarity issue. No user-visible
behavior. Worth tightening before Phase 9 (firm layer) when audit trails
become more important for cross-workspace member visibility.

---

## 10. Phase 3 audit miss: `LeaseStatusBadge.tsx`

**Symptom (Phase 3 smoke, 2026-05-05):** The Phase 3 audit
(`docs/PHASE_3_AUDIT.md`, committed as `49e1ab7`) traced
`LifecycleStatusBadge.tsx` (the canonical chain-aware badge in
`src/components/lifecycle/`) but **missed `LeaseStatusBadge.tsx`** — a
separate badge in `src/components/leases/` used by `Leases.tsx` and
`ImportHistory.tsx`. The two filenames differ by only the substring
"cycle" and the audit grep didn't catch the second.

The smoke surfaced this when a chain lease at `concept_submitted` rendered
its raw enum text in the leases queue view while the lease detail page
(which uses the canonical badge) correctly showed "Submitted".

**Status:** Fixed in commit `aaa5ab3` (`LeaseStatusBadge.tsx` now routes
every label through `displayLabel()`). Filed here NOT as an open issue
but as a pattern note for future audits:

**Pattern for Phase 4+ audits:** when grepping for badge / display
components, do not rely on substring matching. Walk the imports of every
status-rendering site and trace each transitive component, even if the
filename is a near-twin of an already-audited component. The Phase 3
audit doc template at the top of `docs/PHASE_3_AUDIT.md` should be
updated to call this out — done as part of the Phase 3 closeout.

---

## 11. `delete-workspace` edge function does not purge `lease-documents` bucket

**Symptom (Phase 4 close-out audit, 2026-05-05):** The
`delete-workspace` edge function from Owner Workspace Management
explicitly purges storage objects from the `leases` and
`executed-leases` buckets when a workspace is deleted (per its
`storageTargets` set + bucket loop). Phase 4 added a third bucket,
`lease-documents`, but the edge function was not updated to include
it. When a workspace is deleted:

- The `lease_documents` rows cascade away via `lease_id` and
  `workspace_id` ON DELETE CASCADE FKs (correct).
- The storage objects under `lease-documents/{workspace_id}/...`
  remain in storage (orphaned).

**Severity:** Low. The orphan storage is invisible to all users —
the path-prefix RLS rejects reads since the `workspace_id` no longer
exists in `workspace_members` or `workspaces`. Pure billing /
storage hygiene; no security implication.

**Where to look:** `supabase/functions/delete-workspace/index.ts`,
specifically the `for (const bucket of ["leases", "executed-leases"])`
loop. Add `"lease-documents"` to the array. The path-prefix
convention `{workspace_id}/{lease_id}/{uuid}_{filename}` means the
existing list-then-remove pattern works without modification.

**Decision:** Filed as KNOWN_ISSUES rather than fixed inline during
Phase 4 because (a) it's a one-line edit in a different feature's
edge function and (b) the orphan storage is invisible to all users.
Tracked here for the next time `delete-workspace` is touched.

---

## Phase 8 C1 additions (2026-05-06)

### Item #12: lease_reports artifact cleanup job — RESOLVED 2026-05-07

Shipped `supabase/functions/cleanup-expired-reports/index.ts` and
production cron wiring at
`supabase/migrations/20260507210000_cleanup_expired_reports_cron.sql`.

Daily 08:30 UTC schedule via `pg_cron` + `pg_net`, mirroring the
audit-remediated `send-lease-notifications-daily` pattern (migration
`20260426000003`). Edge function uses `verify_jwt = false` and
authenticates via an `x-cron-secret` header read from
`CLEANUP_EXPIRED_REPORTS_CRON_SECRET`; pg_cron forwards the same value
sourced from `current_setting('app.cleanup_expired_reports_cron_secret', true)`.
The Bearer-JWT pattern was abandoned mid-implementation when the
existing wired-cron precedent was found — kept the existing audit-
remediated pattern for consistency.

Behavior: selects `lease_reports` where `expires_at <= now() AND
status != 'expired'`, batches storage removes against the
`lease-reports` bucket in chunks of 100 across both `pdf_storage_path`
and `json_storage_path`, marks each row `status = 'expired'` (row
preserved as audit anchor), and writes a `report_expired` activity
row for single-lease reports. Portfolio reports skip the activity log
per Phase 8 As-built A6 (lease_id is NULL; lease_activity_log.lease_id
is NOT NULL).

**Operator deployment steps** (one-time, both must use the same value):
  1. `supabase secrets set CLEANUP_EXPIRED_REPORTS_CRON_SECRET='<value>'`
  2. `ALTER DATABASE postgres SET app.cleanup_expired_reports_cron_secret = '<value>';`

If either step is missed the function fails closed (401); pg_cron
still fires and the rejection shows up in `net._http_response`. No
data loss either way.

### Item #13: Synchronous PDF generation soft cap — RESOLVED 2026-05-07

`generate-portfolio-report` now enforces a `PORTFOLIO_LEASE_CAP = 500`
guardrail. Workspaces whose eligible-lease count for the requested
period exceeds the cap get a 422 with
`reason: 'portfolio_too_large'`, the row is marked `status='failed'`
with a descriptive `error_message`, and the frontend hook
(`useGeneratePortfolioReport`) surfaces the message directly to the
user. Cap is a single constant; raising it requires moving to
background-queue generation (still deferred until real-world usage
demands it).

The architecture remains forward-compatible: `lease_reports.status`
already supports `pending | generating | ready | failed | expired`
and the frontend polls — switching to a background queue requires no
schema change. The "punted heavy fix" stays punted; this is the
minimal guardrail the original entry recommended.

---

## Cron-wiring follow-ups (2026-05-07)

### Item #14: reroute-audit-sweep + process-pending-reroute-evaluations are not yet on cron

When wiring the rest of the scheduled functions in
`20260507220000_phase567_crons.sql`, three leaf crons shipped
(`send-counter-signature-reminder`, `process-delegate-timers`,
`detect-stuck-chains`). The two reroute-related crons were NOT wired
in the same pass because both forward the inbound `Authorization`
header to `resolve-approval-chain` (1054-line sibling function in
`supabase/functions/resolve-approval-chain/index.ts`).

`resolve-approval-chain` uses `user.id` in five places (lines 169,
205, 272, 277-279, 723) — workspace-membership authorization gates
plus `triggered_by` attribution on the audit log. Switching the two
reroute crons to the `x-cron-secret` pattern leaves no JWT to
forward, which means safely wiring them requires a service-context
invocation path in `resolve-approval-chain`.

**Severity:** Medium-deferred. The two crons run fine on manual
invocation today; the auto-detection of attribute changes that should
trigger rerouting is currently caught by the BEFORE UPDATE trigger
on `leases` (see Phase 6 spec) — the `process-pending-reroute-evaluations`
poller is a backstop. The daily `reroute-audit-sweep` is a
defense-in-depth scan that detects but does not act, so leaving it
manual reduces only the catch-rate of stale-policy drift.

**Where to look:**
  1. `supabase/functions/resolve-approval-chain/index.ts` — extend the
     auth block to recognize an `x-internal-cron` header (or similar),
     and skip user-membership checks + null out `triggered_by` when
     called via that path.
  2. `supabase/functions/reroute-audit-sweep/index.ts` and
     `supabase/functions/process-pending-reroute-evaluations/index.ts`
     — swap Bearer JWT for `x-cron-secret` (per
     `cleanup-expired-reports`), forward the new internal header to
     `resolve-approval-chain` instead of `Authorization`.
  3. `supabase/migrations/<new>_reroute_crons.sql` — add the two
     schedules.

Both crons need to keep their existing manual-invocation paths usable
during testing (real users may want to dry-run a reroute audit sweep).

---

## P2-01 cron / secret hygiene (2026-05-15)

### Item #15: `process-alerts-daily` cron orphan — RESOLVED 2026-05-15

Surfaced during P2-01 audit follow-up: the `process-alerts-daily` cron had no `x-cron-secret` header, the target function had no source in the repo, and the function did no auth check of its own.

**Triage executed 2026-05-15:**
1. Downloaded the deployed function source via `supabase functions download process-alerts` and committed it to `supabase/functions/process-alerts/index.ts`. The function is real and functional — it evaluates `alert_rules` (8 active rules across 2 workspaces) and inserts `notifications` rows for triggered conditions. Not dead code.
2. Rewrote the function to add the canonical `x-cron-secret` check (matching `cleanup-expired-reports`, `send-counter-signature-reminder`, etc.). Reads `PROCESS_ALERTS_CRON_SECRET` from edge env.
3. Added `[functions.process-alerts] verify_jwt = false` to `supabase/config.toml` so deployments pin the auth mode.
4. Migration `20260515040000_process_alerts_cron_secret.sql` unschedules + reschedules `process-alerts-daily` with `x-cron-secret` forwarded from `private.cron_secrets`. Applied to live.
5. Generated a 46-char secret, set as edge env via `supabase secrets set PROCESS_ALERTS_CRON_SECRET=...`, and inserted into `private.cron_secrets` under id `process_alerts`.
6. Redeployed the function. Smoke tested live:
   - No header → 401 ✅
   - Wrong secret → 401 ✅
   - Correct secret → 200 `{"processed":0,"timestamp":"..."}` ✅
7. Updated `docs/ops/OPERATOR_PLAYBOOK.md` cron-verification table to remove the orphan flag.

`{"processed":0,...}` indicates no leases currently trip the configured alert rules. That's a separate question — investigate alert_rules thresholds vs. actual lease data if alerts are expected to be firing — but the cron + auth chain is healthy end-to-end.

---

## P1-10 baseline-exposed hardening regressions (2026-05-16)

The P1-10 baseline squash (`supabase/migrations/20260516120000_baseline_schema.sql`)
captured live production state verbatim. Three hardening guards that were
supposed to be installed by archived migrations are missing from the live
schema — confirmed via direct `pg_policies` query on prod, not just dump
inspection. The baseline is faithful; production is the drift. Filed here
rather than fixed inline because each deserves its own scoped migration with
full reviewer routing.

Common root-cause hypothesis (unverified): either the relevant hardening
migration was never applied on prod despite being committed to repo, or it
was applied and silently reverted via Studio/MCP at some later point. The
`schema_migrations.created_by` audit trail was wiped during P1-10 reconcile,
so attribution is no longer queryable from the live DB — use
`docs/ops/schema_migrations_pre_baseline_2026-05-16.json` for historical
attribution lookups.

### Item #16: Governance audit INSERT policy reverted to pre-hardening state

**Symptom:** Hardening migration `_archive/20260426000003_audit_remediation.sql`
swaps `"workspace members can insert governance audit"` (any member can
INSERT) for `"governance audit is service role append only" WITH CHECK
(false)`. Live `pg_policies` shows the old permissive policy still active
and the hardened one missing. Any workspace member can fabricate
`lease_governance_audit` rows via direct PostgREST INSERT.

**Severity:** Critical. `lease_governance_audit` is the system of record
for unlock / change-set / relock events. Any tampering invalidates
audit-defensible attribution.

**Where to look:**
- Live state: `SELECT polname, with_check FROM pg_policies WHERE tablename = 'lease_governance_audit';`
- Hardened policy SQL: `supabase/migrations/_archive/20260426000003_audit_remediation.sql`
- `audit_rls_smoke_check()` checks for the hardened policy name and would
  return FALSE for the `governance_audit_append_only` key today — built-in
  detection has been silently failing because nothing calls the smoke check
  on a schedule. Consider wiring it as a cron with alerting.

**Stub follow-up migration (`<ts>_restore_governance_audit_hardening.sql`):**

```sql
DROP POLICY IF EXISTS "workspace members can insert governance audit" ON public.lease_governance_audit;
DROP POLICY IF EXISTS "governance audit is service role append only" ON public.lease_governance_audit;
CREATE POLICY "governance audit is service role append only"
  ON public.lease_governance_audit FOR INSERT TO authenticated
  WITH CHECK (false);
```

**Pre-apply checklist:**
- Verify all current writers to `lease_governance_audit` use service_role
  (edge functions, not browser code). If any browser path inserts directly,
  the hardening breaks it.
- Route through `lease-repository-integrity-reviewer` and `lease-test-author`
  (regression test asserting the hardened policy exists in production).
- Post-apply: confirm via `audit_rls_smoke_check()`.

**Decision:** Filed not fixed. P1-10 scope is migration-chain hygiene;
surfacing a Critical governance regression mid-squash conflates two
distinct workstreams.

### Item #17: Change-set UPDATE policy missing draft-only status guard

**Symptom:** Hardening migration `_archive/20260426000004_governance_rls_tighten.sql`
was supposed to restrict `lease_change_sets` UPDATE to drafts only — once
status flips to `pending_approval`, submitters should not be able to edit
proposed values. Live `pg_policies` shows the unrestricted policy
`"submitters and approvers can update change sets"` (no status check in
USING clause). A submitter can modify a change set after submitting it for
approval, altering values the approver may have already reviewed.

**Severity:** Critical. Defeats the staged-approval premise — what the
approver reads at decision time may not be what they were notified about.

**Where to look:**
- Live state: `SELECT polname, qual FROM pg_policies WHERE tablename = 'lease_change_sets' AND cmd = 'UPDATE';`
- Original hardened policy: `supabase/migrations/_archive/20260426000004_governance_rls_tighten.sql`

**Stub follow-up migration:** Add `AND status = 'draft'` to the USING
clause; mirror in WITH CHECK. Bundle with #16 into a single
`restore_governance_hardening` migration if scoped together. Same
root-cause investigation as #16.

**Decision:** Same as #16.

### Item #18: `lease-reports` storage RLS policies use `foldername(w.name)` instead of `foldername(objects.name)`

**Symptom:** The `"report owners insert lease-reports"` and
`"report owners update lease-reports"` RLS policies on `storage.objects`
reference `storage.foldername(w.name)` where `w` aliases `public.workspaces`.
`w.name` is the workspace's human-readable display name (e.g., "Labs
Analytix"), NOT the storage path. `storage.foldername("Labs Analytix")`
returns `['Labs Analytix']` (one element); `[2]` is NULL; comparison
always fails. The policies effectively `WITH CHECK (false)` for
client-side uploads.

**Severity:** High — with an unresolved practical-impact question.
Client-side PDF report uploads (`src/hooks/useGenerateLeaseReport.tsx:110-115`,
`src/hooks/useGeneratePortfolioReport.tsx:102-107`) call
`supabase.storage.from('lease-reports').upload(...)` which goes through
user-session RLS. **If RLS is being enforced as expected, every
authenticated user trying to generate a report should be hitting
"permission denied" today.** Two scenarios are possible:

1. **The feature is silently failing for everyone.** Would explain
   the absence of complaints if reports are rarely generated.
2. **Supabase storage has an additional access path bypassing Postgres
   RLS for some bucket configurations.** Possible if the storage
   container does its own auth check that short-circuits before falling
   through to Postgres RLS.

**Operational verification needed BEFORE writing the fix:** test report
generation as a non-admin authenticated user via the live app. If uploads
succeed, the broken policy is masked by an external bypass and the fix
is policy-correctness hygiene. If uploads fail, this is a P0 user-facing
bug.

**Where to look:**
- Live state: `SELECT policyname, qual FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname LIKE '%lease-reports%';`
- Companion file mirroring the bug:
  `supabase/migrations/20260516120001_storage_policies.sql` (this commit) —
  preserves prod state faithfully; not a regression introduced by P1-10.
- Original migration: `supabase/migrations/_archive/20260507000000_lease_reports_storage_insert.sql`
  — uses unqualified `name`, which in policy context
  (`FROM lease_reports lr LEFT JOIN workspaces w …`) is ambiguous between
  `objects.name` and `w.name`. `pg_dump` resolved it to `w.name`,
  suggesting Postgres resolves it the same way at policy-execution time.

**Stub follow-up migration:**

```sql
DROP POLICY IF EXISTS "report owners insert lease-reports" ON storage.objects;
CREATE POLICY "report owners insert lease-reports" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'lease-reports' AND EXISTS (
      SELECT 1 FROM lease_reports lr
      LEFT JOIN workspaces w ON w.id = lr.workspace_id
      LEFT JOIN workspace_members wm ON wm.workspace_id = lr.workspace_id AND wm.user_id = auth.uid()
      WHERE lr.id::text = (storage.foldername(objects.name))[2]
        AND lr.workspace_id::text = (storage.foldername(objects.name))[1]
        AND lr.pdf_storage_path IS NULL
        AND (lr.generated_by = auth.uid() OR w.owner_id = auth.uid() OR wm.role = 'admin')
    )
  );
-- mirror for UPDATE policy
```

**Decision:** Same as #16/#17 — filed not fixed. Fix needs operational
verification of the silent-failure-vs-bypass question first.

---

## Governance hardening follow-up review (2026-05-16, items #19-23)

Surfaced during reviewer pass on the second iteration of the governance
hardening migration (`20260517000000_governance_hardening_followup.sql`).
The current beat closes #16 + #17; these five are scope-adjacent findings
that surfaced during review but were deliberately not bundled. Each gets
its own scoped beat with its own reviewer routing.

### Item #19: `cancel_change_set` two-UPDATE sequence is non-atomic

**Symptom:** `supabase/functions/lease-governance-action/index.ts:748-758` (cancel_change_set action) performs two sequential UPDATEs: one on `lease_change_sets` (status → 'canceled'), then one on `leases` (re-lock). If the second UPDATE fails (network partition, transient DB error), the change set is canceled but the lease stays unlocked indefinitely. No compensating audit event is written. Pre-existing pattern not introduced by P1-10 or its follow-ups.

**Severity:** Medium. Customer-visible (lease stays in unlocked-but-canceled limbo) but rare (requires Supabase JS client second-update failure between two same-session calls). No data corruption, just orphan state.

**Where to look:**
- `supabase/functions/lease-governance-action/index.ts:748-758` — the unprotected two-UPDATE block.
- Same pattern likely exists in other state-transition actions in the same file (`submit_change_set`, `approve_change_set`, `reject_change_set`); audit for consistency.

**Stub follow-up migration / fix:** Either wrap both UPDATEs in a single Postgres RPC SECURITY DEFINER function called via `supabase.rpc()`, OR add explicit error-checking on the second UPDATE that emits a compensating audit event and 500-response on failure. Cleaner choice is RPC; rolls both into one transaction.

**Decision:** Filed not fixed. Pre-existing pattern, not in the named scope of #16/#17.

### Item #20: `audit_rls_smoke_check()` doesn't assert `relrowsecurity = true` on governance tables

**Symptom:** The smoke check function asserts policies EXIST but not that RLS is ENFORCED. If a Studio operator (or future ALTER TABLE) sets `relrowsecurity = false` on `lease_governance_audit`, `lease_change_sets`, or `lease_change_set_items`, all RLS policies become irrelevant and the smoke check would still return all keys = true.

**Severity:** Medium. Low probability (disabling RLS is an obvious destructive action) but completely defeats the hardening if it happens.

**Where to look:**
- `audit_rls_smoke_check()` function body in `supabase/migrations/20260517000000_governance_hardening_followup.sql`. Add assertions like:
```sql
'lease_governance_audit_rls_enabled', (
  SELECT relrowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'lease_governance_audit'
),
```
- Same for `lease_change_sets`, `lease_change_set_items`. Three keys total to add.

**Decision:** Filed not fixed. Additive defense-in-depth; not blocking the current beat's named scope.

### Item #21: `lease_unlock_requests` UPDATE policy is not asserted by smoke check; potential same-class gap as #17

**Symptom:** The smoke check asserts SELECT policy `'workspace access can view unlock requests'` exists on `lease_unlock_requests`, but does NOT assert that UPDATE is restricted to service_role or admin only. If an authenticated user can PATCH their own request's `status='approved'` via PostgREST, they bypass the admin-review approval gate.

**Severity:** Medium (pending live verification — may be High). Same attack class as #17 but on a different governance table.

**Where to look:**
- Live: `SELECT polname, cmd FROM pg_policies WHERE tablename = 'lease_unlock_requests';` — confirm whether an UPDATE policy exists and whether it gates writes to service_role/admin.
- If no UPDATE policy exists: implicit deny for non-service-role is the current posture — same condition as `lease_governance_audit` UPDATE. Worth documenting explicitly. If a permissive UPDATE policy exists: that's an active vulnerability — escalate to High.

**Stub follow-up:** Audit the table's policy surface first; if a gap is found, write a `restore_unlock_request_hardening` migration that adds the appropriate UPDATE policy AND extends `audit_rls_smoke_check()` with name-based + content-based assertions (same pattern as #16/#17).

**Decision:** Filed not fixed pending verification. Out of the current beat's named scope.

### Item #22: `audit_rls_smoke_check()` `GRANT EXECUTE TO authenticated` leaks security posture

**Symptom:** Function is granted to `authenticated`, meaning any workspace member can call `SELECT public.audit_rls_smoke_check()` and learn which RLS policies and security triggers are present or absent in production. The function returns boolean values only (not policy text), so the leak is structural ("these checks are in place" / "these are not") — useful reconnaissance for someone probing the security surface, not direct data exfiltration.

**Severity:** Low. Information-disclosure rather than authorization bypass. Originally flagged by security scanner as M2 during the first P1-10 review round; explicitly deferred in the follow-up scope per session decisions to avoid scope creep. Tracked here so the decision isn't held in conversational memory.

**Where to look:**
- `supabase/migrations/20260517000000_governance_hardening_followup.sql` line 470: `GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated`.
- Caller analysis: `scripts/smoke-audit-hardening.mjs` runs as service_role (uses SERVICE_ROLE_KEY) and does not need the `authenticated` grant. No frontend code calls this function. Tightening to `service_role`-only would not break any current consumer.

**Stub follow-up migration:** `REVOKE EXECUTE ON FUNCTION public.audit_rls_smoke_check() FROM authenticated;` (the `TO service_role` grant from the follow-up migration remains).

**Decision:** Filed not fixed. Information-disclosure level; not blocking the current beat.

### Item #29: `enforce_workspace_entitlement_guard` trigger missing from prod — **RESOLVED 2026-05-23** (billing-bypass vector, severity High)

**RESOLVED 2026-05-23** — `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` was applied to the live production project (`wwkwoxxcprnjjufkbzac`) via `supabase db push` on 2026-05-23, closing the bypass.

The change was verified local-first before prod was touched. A clean `supabase start` replayed the full migration chain from scratch with no baseline errors; the four static verification queries passed 4/4 (trigger present, the UPDATE policy carries `WITH CHECK (owner_id = auth.uid())`, defaults corrected to `'starter'/15`, and the `workspace_entitlement_guard` smoke key true); and all five behavioral scenarios in `supabase/tests/workspace_entitlement.test.sql` passed 5/5 — billing UPDATE escalation blocked across all 9 guarded columns, a non-billing settings UPDATE allowed through, the INSERT baseline pin enforced, the service_role promotion path working, and ownership reassignment blocked.

Live pre-apply introspection (read-only) confirmed both that the target matched expectations and that the bug was real: all 9 guarded columns were present on `public.workspaces` with the expected types/nullability, the UPDATE policy `"Owners can update their workspaces"` was present by that exact name with a NULL `with_check` clause (the literal #29 gap), and `audit_rls_smoke_check()` returned `workspace_entitlement_guard: false`. `supabase db push --dry-run` then listed exactly one pending migration (`20260522000000`) — no drift to reconcile as a separate beat. The real `supabase db push` completed cleanly, emitting only the expected `NOTICE` on `DROP TRIGGER IF EXISTS` (the idempotency guard firing because the trigger did not pre-exist on prod).

Live post-apply verification confirmed the fix landed: the trigger `enforce_workspace_entitlement_guard` is now present alongside `update_workspaces_updated_at`, the UPDATE policy now carries `WITH CHECK (owner_id = auth.uid())`, the column defaults are now `'starter'/15`, and the `workspace_entitlement_guard` smoke key flipped false → true. As cross-validation, the unrelated governance keys (`governance_unlock_policy`, `governance_change_set_policy`) remained false on both local and live — confirming the migration was correctly scoped to `public.workspaces` and changed nothing outside it.

The bypass that was verified exploitable on 2026-05-17 is no longer exploitable as of 2026-05-23. PR #34.

**FIX READY 2026-05-22** — migration `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` written and reviewer-cleared (security / repository-integrity / test-author). NOT yet applied: the bypass remains live in prod until the migration runs and the smoke check confirms `workspace_entitlement_guard: true`. Promote to RESOLVED after prod apply.
- **Meta-question answered first (per the agenda below):** the archived migration was *committed but never applied* — not applied-then-reverted. Version `20260426000003` is absent from `docs/ops/schema_migrations_pre_baseline_2026-05-16.json`; the trigger is absent from the `20260516120000` baseline dump; the file was moved into `_archive/` (CLI-skipped) during the squash. Same class as #16/#17/#25, all remediated with new active-dir migrations. Conclusion: a standard new restoration migration suffices; no constraint/CI-tripwire required.
- **As-built (hardened scope, decisions ratified 2026-05-22):** (1) column defaults aligned `'pro'/3 → 'starter'/15` (pricing reconciliation + the Onboarding contract; required so the INSERT guard and the defaults agree, else onboarding INSERTs would be rejected); (2) `prevent_workspace_entitlement_edits()` BEFORE INSERT/UPDATE trigger restored with the canonical `COALESCE(auth.role(),'') = 'service_role'` carve-out, guarding **9** columns: plan, document_limit, documents_used, billing_interval, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_period_end, **max_archived_leases** (added in-beat per security-review finding M1 — a tier entitlement read DB-first in `AppContext.tsx:184`; verified no authenticated writer); (3) UPDATE policy re-created with `WITH CHECK (owner_id = auth.uid())`, closing the literal gap and blocking ownership reassignment. `intended_plan` intentionally left writable (abandoned-checkout recovery).
- **Tests:** static `src/lib/__tests__/workspaceEntitlementGuard.test.ts` (narrowed-window assertions) + behavioral `supabase/tests/workspace_entitlement.test.sql` (5 scenarios, staging-only). Full vitest suite 443/443. Stale `Onboarding.tsx` comment updated to reference 20260522000000.
- **Pre-push review:** routed through stand-in general-purpose agents in the security / repository-integrity / test-author charters (the named `lease-*` subagents referenced in CLAUDE.md are absent from the repo — flagged separately). Converged clean over two rounds; the one Medium (M1) was folded in; no Critical/High.
- **Smoke check:** no `audit_rls_smoke_check()` change — the `workspace_entitlement_guard` key (defined in 20260517000000) flips false→true on apply, which is the success signal.
- **Apply checklist (remaining):** staging apply → `audit_rls_smoke_check()` shows the key true (no other key regressed) → exploit re-test (authenticated PATCH plan='business' rejected) → onboarding + service-role-webhook regression → prod apply → re-run smoke on prod → then stamp RESOLVED.

**Symptom:** First post-apply run of `audit_rls_smoke_check()` after the governance hardening follow-up landed (commit `896f4ed`, 2026-05-16) returned `workspace_entitlement_guard: false`. The Category A key asserts a BEFORE-UPDATE trigger named `enforce_workspace_entitlement_guard` exists on `public.workspaces`. Live `pg_trigger` query (2026-05-17) confirms the trigger does not exist on prod. The trigger was defined in archived migration `_archive/20260426000003_audit_remediation.sql` which never applied to live — same silent-non-application pattern as #16, #17, and #25.

**Severity: High (verified exploitable 2026-05-17).** Initially filed as "Medium pending live verification — may be High." Live verification confirmed the exploit path is open: the only UPDATE policy on `public.workspaces` is `"Owners can update their workspaces"` with `USING (owner_id = auth.uid())` and **no WITH CHECK clause** — any authenticated workspace owner can PATCH any column on their own workspace row via PostgREST, including billing columns. Exploitable today by anyone with a workspace.

**Exploit chain:**
1. Workspace owner sends `PATCH /rest/v1/workspaces?id=eq.<their_id>` with body `{"plan": "business", "document_limit": 9999, "subscription_status": "active", "subscription_period_end": "2030-01-01"}`.
2. PostgREST RLS USING check passes (owner_id matches). No WITH CHECK gate. UPDATE succeeds.
3. Application now reads `plan='business'`. Business-tier features (per CLAUDE.md Strategic Rule 7: embedded AI assistant, portfolio intelligence, amendment comparison, custom approval playbook, audit package generator) all become accessible.
4. `document_limit` becomes effectively unlimited. Every lease upload triggers Claude Opus extraction (~$1-3 per document per CLAUDE.md cost model) at LeaseIO's cost.
5. Stripe webhook never sees the change — billing infrastructure is bypassed entirely.

**Billing columns currently exposed on `public.workspaces`** (no column-level grant restriction, no trigger guard):
- `plan` (text, NOT NULL, default 'pro')
- `document_limit` (integer, NOT NULL, default 3)
- `stripe_customer_id` (text, nullable)
- `stripe_subscription_id` (text, nullable)
- `subscription_status` (text, nullable)
- `subscription_period_end` (timestamptz, nullable)
- `intended_plan` (text, nullable)

**Where to look:**
- Live trigger absence: `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.workspaces'::regclass AND NOT tgisinternal;` returns only `update_workspaces_updated_at`.
- Live policy: `SELECT polname, qual::text, with_check::text FROM pg_policies WHERE tablename = 'workspaces' AND cmd IN ('UPDATE', 'ALL');` confirms permissive single policy.
- Archived intent: `_archive/20260426000003_audit_remediation.sql` for the original trigger + function definitions.

**Stub follow-up:** Restore the trigger + function from the archived definition under pre-push reviewer routing per the rule added to CLAUDE.md this session. Verify the archived version's column list matches the current schema (billing columns may have evolved). Optionally: add column-level REVOKE on the billing columns as defense-in-depth.

**Decision:** Filed not fixed in the originating beat (governance hardening completion), but **escalated immediately on live verification.** This is the next P0 beat — NOT bundled with #25 as previously suggested. The trigger-restoration scope is bigger and more urgent than the SELECT policy rename (#25), and warrants its own focused reviewer routing without being conflated with cosmetic cleanup.

**Surfaced by the smoke check at the exact moment the migration intended** — this is the design working as advertised. The fact that the smoke check was rebuilt to its full key set in commit `896f4ed` (after weeks of being shrunk to 4 keys by 20260516130000) is what made this visible. Concrete validation of the "Restoring a previously-shrunk drift-detection function will surface drift on its first run" lesson added to CLAUDE.md the same session.

---

#### Post-verification work done 2026-05-17 (so tomorrow's session inherits without re-investigation)

**Audit 1 — exploitation detection on live `public.workspaces`:** zero suspicious external rows. Three sub-queries run (status='active' AND no Stripe sub; paid plan AND no Stripe customer; high document_limit AND no Stripe). Two rows flagged, **both owned by `daniel.c.priest@gmail.com`** (auth.users id `c2dbf842-1021-4b1d-a59f-df2ecc575d8e`):
- **"Labs Analytix"** (`c9dad4c7-...`): plan=`business`, document_limit=50, no Stripe. Known-legitimate dev/test workspace — Daniel manually set business tier for access to business-tier code paths (embedded AI assistant, etc.) without paying his own Stripe account. Common project-owner-dev pattern; not exploitation.
- **"My Workspace"** (`b0f3c7a0-...`): plan=`pro`, document_limit=3. **False positive in the query** — `'pro'` is the column default (`column_default: 'pro'::text`) and `normalizePlanId` coerces to `'starter'` on read. Default-state workspace, not tampered.

**Verdict: exposure, not incident.** The bypass has been live since ~April 2026; zero customer exploitation observed. No emergency mitigation warranted.

**Audit 2 — legitimate authenticated writers on the 7 billing columns:** one only.
- `src/pages/app/Onboarding.tsx:83-91` writes `intended_plan: selectedPlan` on **INSERT** (not UPDATE). The code's own comment at lines 75-79: *"Always create the workspace at Starter defaults. The entitlement-guard trigger in migration 20260426000003 rejects any authenticated insert that diverges from those defaults, so we omit plan / document_limit and let the DB defaults apply. Stripe checkout + the signed webhook (service role, which bypasses the trigger) own the promotion to Business. intended_plan persists the user's declared choice so AccountSettings can recover an abandoned Business checkout."* The frontend was written **assuming the trigger exists** — i.e., the frontend already operates as if the missing protection were in place.
- No authenticated UPDATE writers on any of the 7 billing columns (`plan`, `document_limit`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_period_end`, `intended_plan`). All other `.from('workspaces').update(...)` call sites touch only `name`, `timezone`, `report_*`, `default_notification_days`, `counter_signature_default_due_days`, `separation_of_duties_default` — non-billing.

**Audit 3 — full inventory of `public.workspaces`:** clean except for the missing trigger. 4 policies + 1 trigger total:
- POLICY `Owners can delete their workspaces` — DELETE, `owner_id = auth.uid()`
- POLICY `Owners can update their workspaces` — UPDATE, `owner_id = auth.uid()`, **no WITH CHECK**
- POLICY `Users can create workspaces` — INSERT, `owner_id = auth.uid()`
- POLICY `Users can view workspaces they own or are members of` — SELECT
- TRIGGER `update_workspaces_updated_at` — BEFORE UPDATE, just the timestamp updater

No other drift. Mitigation scope is narrow: restore the one missing trigger.

#### Design points for the next-beat migration (carry into the entitlement-guard beat)

- **Trigger must be BEFORE INSERT OR UPDATE, not just UPDATE.** The archived version (`_archive/20260426000003_audit_remediation.sql`) was designed to cover both. Confirm by reading the archived definition.
- **`intended_plan` must remain authenticated-writable on INSERT** (Onboarding.tsx's legitimate path) while the entitlement-state columns (`plan`, `document_limit`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_period_end`) must reject authenticated divergence from defaults on INSERT and any change on UPDATE. Same service-role-carve-out pattern as the trigger shipped in 20260517000000 (`COALESCE(auth.role(), '') <> 'service_role'`).
- **Frontend changes likely unnecessary.** Onboarding.tsx is already written for the trigger's presence (omits plan/document_limit on INSERT, expects DB defaults). Stripe webhook (`supabase/functions/stripe-webhook/index.ts:109-111`) uses service_role and bypasses the trigger. No browser writers to break.
- **Smoke check key already exists** (`workspace_entitlement_guard` in `audit_rls_smoke_check()`), so no smoke check changes needed — the existing key flips from FALSE to TRUE post-apply, which is the success signal.
- **Pre-apply checklist (per the rule added to CLAUDE.md this session):** pull `pg_attribute` for live `workspaces` columns; categorize every column into universal-immutable / service-role-only / authenticated-mutable; surface ambiguities; derive trigger code from categorization. Workspaces table has more columns than `lease_change_sets` (report settings, discount rate, region/department options, etc.) — the categorization will be longer.

#### Meta-question — first agenda item for the next-beat session, BEFORE writing any SQL

`_archive/20260426000003_audit_remediation.sql` has now produced four distinct vulnerabilities (#16, #17, #25, #29) because it "never applied to prod." We don't actually know why. Possibilities:
- Migration was applied then Studio-reverted (someone clicked "drop policy" in Studio after)
- Migration was added to the repo but never run via `db push` (the apply step was skipped)
- Migration ran but failed mid-execution and rolled back without reaching the trigger/policy creates
- Migration ran on a different branch / staging env but not prod

Before restoring more pieces of this archived migration, the next session should investigate the mechanism. If the same thing that prevented original apply is still active, restoration migrations may face the same fate. Possible investigation paths:
- `git log --follow --diff-filter=A` on the archived file to see when it was first committed
- Check `docs/ops/schema_migrations_pre_baseline_2026-05-16.json` (the captured pre-reconcile state) — was the migration's version timestamp present? If yes, it was applied at some point. If no, it was committed but never applied.
- Studio audit log if accessible (may not be retained that long)
- Cross-reference with Daniel's calendar / Linear / Slack around the original commit date

**Do this investigation FIRST. If the migration was applied-then-reverted, the restoration needs an additional defense (e.g., constraint instead of trigger, or a CI check that detects re-removal). If it was simply never applied, the standard restoration is sufficient.**

---

### Item #28: `lease_change_sets` INSERT policy is permissive — submitters can craft `change_summary` at INSERT time

**Symptom:** Round 5 integrity reviewer surfaced that `prevent_change_set_field_tampering` is BEFORE UPDATE only — does not fire on INSERT. Live `pg_policies` confirms the INSERT policy `"workspace members can create change sets"` permits any workspace member to INSERT a `lease_change_sets` row directly via PostgREST with arbitrary column values, including a fabricated `change_summary`. The approver then sees a misleading summary on the pending_approval queue. Live grep of `src/` confirms zero browser-side `.insert()` calls to this table — every legitimate INSERT goes through `lease-governance-action/index.ts:192-200` using service_role, which bypasses RLS regardless.

**Severity:** Medium.

**Where to look:**
- Live: `SELECT polname, qual::text, with_check::text FROM pg_policies WHERE tablename = 'lease_change_sets' AND cmd = 'INSERT';` confirms the permissive policy.
- Edge function: `supabase/functions/lease-governance-action/index.ts:192-200` is the sole legitimate INSERT writer (service_role).
- Frontend grep: no `.from('lease_change_sets').insert(` calls in `src/` confirms no browser-side writer.

**Attribution asymmetry vs the UPDATE vector that #16/#17/the trigger closed:** the `prevent_change_set_field_tampering` trigger added in this beat makes `submitted_by` immutable post-INSERT. Even if an attacker exploits this INSERT vector to craft a misleading row, `submitted_by` is reliably the actual attacker's identity — they cannot hide behind a legitimate submitter's attribution. The UPDATE vector that #16/#17 closed was strictly more dangerous: it let attackers tamper with rows authored by other users, masking which user took which action. The INSERT vector here is "attacker can submit a misleading row under their own name" — still wrong, but the attacker's identity is captured truthfully in the audit chain. State this asymmetry explicitly so a future reader understands why #28 was filed-not-fixed despite being structurally similar to #21.

**Stub follow-up:** Audit the INSERT policy across all governance tables; if `lease_change_sets` and `lease_unlock_requests` (#21) both permit authenticated INSERTs where service_role is the only legitimate writer, write a `restore_governance_table_writers` migration that (a) drops the permissive INSERT/UPDATE policies, (b) optionally adds explicit service_role-only policies for clarity, and (c) extends `audit_rls_smoke_check()` with assertions per the parent's `change_set_only_one_update_policy` pattern.

**Decision:** Filed not fixed. Symmetric structural choice to #21 — pre-existing baseline permissiveness on a different write op (INSERT here, UPDATE on #21), same fix shape, same scope discipline. The "scope discipline" rule has to hold when bundling would be convenient, otherwise it's not a rule.

**Suggested next-beat bundling:** #21 and #28 are mechanically identical fixes — tighten policy to service_role-only writers, verify no browser path, add smoke check assertion. Both deserve to be bundled into a single "governance-table writers tightening" beat rather than fragmented across two beats. The next-beat planner should treat them as one workstream.

---

### Item #27: Static migration-file tests may have naive-`toContain` false-positive pattern

**Symptom:** Round 5 test-author surfaced that the Round 3 trigger-function test used `expect(migration).toContain('SECURITY DEFINER')` on the full migration file — which passed not because the trigger function had `SECURITY DEFINER` (it didn't, and shouldn't) but because `audit_rls_smoke_check()` (a separate function later in the same file) does. The test was providing false assurance that the trigger ran with elevated privileges; if SECURITY DEFINER had been added to the trigger by accident, the test would still have passed. Fixed in Round 5 by narrowing the assertion window to the function's declaration block.

**Severity:** Medium. This is a TEST-BUG class — tests pass for the wrong reason. The same pattern may exist elsewhere in `src/lib/__tests__/auditRemediation.test.ts`, `src/lib/__tests__/lockedLeaseLayout.test.ts`, or any other static-migration-file test that uses `toContain` on a full file with multiple functions/policies/triggers. Any assertion about a specific named function/policy/trigger is suspect if the search isn't narrowed to that named object's declaration block.

**Where to look:**
- All test files matching `src/**/__tests__/*.test.ts` that read migration files via `readFileSync` and assert via `toContain`.
- Particularly: anywhere a property is asserted of a specific named function/policy/trigger (e.g., "function X has SECURITY DEFINER", "policy Y uses WITH CHECK false", "trigger Z fires BEFORE UPDATE"). If the search isn't narrowed to that object's declaration via regex or substring extraction, the assertion may pass on an unrelated object with the same property.

**Stub fix pattern (already applied in Round 5 to one test):**

```typescript
// Narrow to the named function's declaration window before asserting.
const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.target_function_name()');
const fnEnd = migration.indexOf('AS $$', fnStart);
const declarationBlock = migration.slice(fnStart, fnEnd);
expect(declarationBlock).not.toContain('SECURITY DEFINER');
```

**Decision:** Filed not fixed. Auditing every static-migration-file test for this pattern is its own beat — needs systematic walkthrough of every `toContain` against multi-object migration files. The Round 5 fix to the specific finding is in place; broader sweep deferred to a focused test-hygiene beat. Bundling here would expand scope from "governance hardening complete" to "audit all static tests for assertion-narrowing."

---

### Item #26: `scripts/smoke-audit-hardening.mjs` fails CI on any false return, including documented Category A drift candidates

**Symptom:** The smoke script iterates every key returned by `audit_rls_smoke_check()` and exits 1 on any key that isn't true. Migration `20260517000000_governance_hardening_followup.sql` documents that `governance_unlock_policy` and `governance_change_set_policy` (Category A drift candidates) will return FALSE on first smoke run post-apply — the named SELECT policies were never applied to prod under those names (see #25). The script has no concept of "expected drift" — once the 4 SUPABASE_* GitHub Actions secrets are configured, the CI smoke step will fail-close immediately on every push until #25 is resolved.

**Severity:** Medium. Not blocking today because the secrets aren't configured (the smoke step is silently skipped at `.github/workflows/ci.yml`). Becomes blocking the moment secrets are wired AND #25 hasn't been resolved AND no expected-false allowlist has been added.

**Where to look:**
- `scripts/smoke-audit-hardening.mjs:52` — `const failedChecks = Object.entries(result).filter(([, passed]) => passed !== true);`. The filter has no notion of categories.
- `.github/workflows/ci.yml` lines 70-82 — the conditional skip on missing secrets.

**Two stub remediation options:**

(a) **Script-level allowlist (recommended, more durable):** add an `SMOKE_EXPECTED_FALSE` env var (comma-separated key names) that the script reads and excludes from the fail filter, logging them as "expected drift" rather than failures. Configured per-environment via CI secrets / dotenv.

(b) **CI workflow conditional (simpler, more coupling):** keep the smoke step skipped until #25 lands, add a comment in `ci.yml` referencing #25. Then unblock manually after the rename migration applies.

Pre-apply order matters: secrets wiring depends on knowing #25 + #26 are both green. If secrets get wired before either is resolved, the smoke step blocks all pushes to main.

**Decision:** Filed not fixed. The smoke script + CI wiring is its own workstream (the smoke-test-secrets configuration decision is also still open from the prior pre-launch checklist). Bundling here would expand this beat from "governance hardening complete" into the broader CI-integration territory.

**RESOLVED 2026-06-14** — closed differently than the two stub options. Live inspection found SIX false keys, not the two predicted — and they were **stale assertions, not "expected drift" to allowlist**: 4 because the Vault V1 read-only RESTRICTIVE policies tripped the `*_only_one_*_policy` duplicate-grant tripwires, 2 from the #25 name divergence. So the correct fix was the function, not an allowlist (option a) or a CI skip (option b). Migration `20260614000000_smoke_check_vault_restrictive_and_name_alignment.sql` adds `AND permissive = 'PERMISSIVE'` to the 5 `*_only_one_*_policy` checks (a RESTRICTIVE policy can only narrow access, never grant it, so it can't be a grant-bypass; an unexpected PERMISSIVE grant incl. FOR ALL still trips) and aligns the 2 governance_*_policy assertions to the live names (#25). Applied + verified live: **26/26 keys true**. All 4 `SUPABASE_*` Actions secrets wired (2 URLs + 2 service-role keys, repo Actions scope). **Green CI run confirmed end-to-end** (run 27520431813): "Verify smoke-test secrets on main" + "Security hardening smoke test" both pass — the governance net now actively guards every main push (previously silently skipped). Reviewers: security + integrity APPLY (no Critical/High/Medium). Test: `src/lib/__tests__/smokeCheckVaultRestrictive.test.ts`. PR #43.

---

### Item #25: SELECT policy rename on `lease_unlock_requests` + `lease_change_sets` was never applied to prod

**Symptom:** The archived migration `_archive/20260426000003_audit_remediation.sql` (lines ~200-220) intended to rename two SELECT policies from `"workspace members can view ..."` to `"workspace access can view ..."` — the latter name being more semantically accurate for the hardened workspace-membership-via-`is_workspace_member`-helper pattern. That archived migration never applied to prod (same silent-non-application class as #16 and #17). Live DB has the old `"workspace members can view"` names. Functionally equivalent — both grant SELECT to workspace members via the same predicate logic — but the smoke check function `audit_rls_smoke_check()` asserts the NEW names (`governance_unlock_policy` and `governance_change_set_policy` keys), so both return FALSE on every smoke run.

**Severity:** Low. The SELECT policies under the old names provide equivalent access control (workspace members can read). This is a name-divergence issue, not a vulnerability. The smoke check's two false returns are documented in the migration header (Category A — drift) so they don't trigger the "stop immediately" Category B procedure.

**Where to look:**
- Archive: `supabase/migrations/_archive/20260426000003_audit_remediation.sql` lines ~200-225 for the intended CREATE POLICY statements.
- Live state: `SELECT polname FROM pg_policies WHERE tablename IN ('lease_unlock_requests', 'lease_change_sets') AND cmd = 'SELECT';` shows the old names.
- Smoke check assertions in `supabase/migrations/20260517000000_governance_hardening_followup.sql` reference the new names; these are the FALSE keys.

**Stub follow-up migration (`<ts>_rename_governance_select_policies.sql`):**

```sql
-- Drop old names, recreate under hardened names. Predicates should match
-- the archived hardening intent (workspace_member via is_workspace_member
-- helper, NOT the older workspace_id IN (SELECT ...) pattern).
DROP POLICY IF EXISTS "workspace members can view unlock requests" ON public.lease_unlock_requests;
DROP POLICY IF EXISTS "workspace members can view change sets" ON public.lease_change_sets;

CREATE POLICY "workspace access can view unlock requests"
  ON public.lease_unlock_requests FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace access can view change sets"
  ON public.lease_change_sets FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));
```

**Pre-apply checklist:** verify the archived predicate against the live ones — if they actually differ (not just by name), this isn't a pure rename and the substance of the difference needs reviewer routing. After apply, move `governance_unlock_policy` and `governance_change_set_policy` from Category A → Category B in the smoke check function header to restore the "MUST return true" posture for those keys.

**Decision:** Filed not fixed. Rename is its own scoped beat. Bundling here would have required: (a) verifying the archived predicate matches the live one byte-for-byte (or surfacing the substance of any difference), (b) routing through reviewers for the substantive change, and (c) accepting that 2 of the 3 fixes in this beat are scope-adjacent rather than direct closures of #16/#17. Cleaner to file and address.

**RESOLVED 2026-06-14** — resolved by **aligning the smoke assertion to the live state rather than renaming the live policies** (lower risk; the never-applied `"workspace access can view ..."` rename is abandoned). The live `"workspace members can view ..."` SELECT policies grant identical workspace-member access via `is_workspace_member` — a name divergence, not a vulnerability — so migration `20260614000000` points `governance_unlock_policy` / `governance_change_set_policy` at the live names. Verified live: both policies present, both keys now true (part of the 26/26 in #26). Folded into the #26 fix + PR #43.

---

### Item #24: Governance hardening lacks behavioral SQL test (`supabase/tests/governance_hardening.test.sql`)

**Symptom:** The vitest static tests in `src/lib/__tests__/auditRemediation.test.ts` defend against in-repo migration-file drift (someone editing the file to remove a guard) — useful but not behavioral. The live-DB layer is covered by `scripts/smoke-audit-hardening.mjs` (`npm run smoke:security`) which calls `audit_rls_smoke_check()` and verifies all 23 assertion keys return true. **Neither layer actually exercises the trigger's RAISE EXCEPTION behavior** (insert row, attempt PATCH `workspace_id`, assert exception with expected ERRCODE) or the items policy's WITH CHECK rejection.

**Severity:** Medium. The trigger and items policies are correctly written and applied in production; behavioral verification is a defense-in-depth gap rather than a current vulnerability. The smoke check confirms the trigger EXISTS; it doesn't confirm Postgres ACTUALLY rejects the violating UPDATE.

**Where to look:**
- Add `supabase/tests/governance_hardening.test.sql` matching the pattern of `supabase/tests/phase8_disclosure_reports.test.sql` (typically 200-600 lines: setup → assertions → teardown). Cover:
  - Setup: workspace + lease + change set with non-NULL `submitted_by` and `workspace_id`.
  - Trigger test 1: `UPDATE lease_change_sets SET workspace_id = $other` → assert `RAISE EXCEPTION` with the documented message about workspace_id immutability.
  - Trigger test 2: `UPDATE lease_change_sets SET submitted_by = $other` (where OLD.submitted_by is non-NULL) → assert exception.
  - Trigger test 3: `UPDATE lease_change_sets SET change_summary = 'x'` (non-tampering field) → assert success (trigger doesn't fire on irrelevant columns).
  - Policy test 4: simulated authenticated submitter PATCH `status='pending_approval'` on own draft via `set_config('request.jwt.claims', ...)` → assert 0 rows updated (WITH CHECK rejects).
  - Items test 5: with parent set to `status='pending_approval'`, attempt `INSERT INTO lease_change_set_items (change_set_id, ...)` → assert WITH CHECK violation.
- Add to `supabase/tests/README.md` test matrix (alongside the existing 9 phase test files).

**Stub:** Pattern from `supabase/tests/phase8_disclosure_reports.test.sql:1-40` (header), `:50-150` (setup), `:200+` (DO blocks with `RAISE NOTICE 'PASS'`/`'FAIL <reason>'`). Run manually via `psql "$TEST_DATABASE_URL" -f supabase/tests/governance_hardening.test.sql` against a non-production database (local Supabase stack or staging branch).

**Decision:** Filed not fixed. The scope is genuinely separate: writing the full SQL test file requires 200-600 lines of new test infrastructure (setup/teardown/JWT-simulation fixtures matching the `supabase/tests/phaseN_*.test.sql` pattern) AND CI integration work that is itself blocked on resolving the "no non-prod environment available" status noted in `supabase/tests/README.md:7-27` (filed 2026-05-03 — pending a Pro plan upgrade or local Docker stack in CI). That's two distinct workstreams (test file authorship + test infrastructure wiring) on top of this beat's named security scope. Bundling would put migration review and test-infrastructure review on the same critical path — different review surfaces, different reviewer routing. Behavioral verification is the right call long-term and should land in a focused testing-infrastructure beat that owns both pieces.

---

### Item #23: Edge function audit-write helpers (`insertAudit`, `logActivity`) swallow errors silently

**Symptom:** `supabase/functions/lease-governance-action/index.ts:136-148` (`logActivity`) and `:150-157` (`insertAudit`) use `.then(({ error }) => { if (error) console.error(...) })` without propagating the error. If the audit INSERT fails (constraint violation, transient DB error, schema drift), the governance action still returns HTTP 200 to the caller. The state-change side of the operation (status flip, lease re-lock) succeeds; the audit row is silently missing. Pre-existing pattern.

**Severity:** Medium. The hardening migration tightens write policies on `lease_governance_audit` but does not close this application-layer fire-and-forget gap. An auditor asking "where's the approval record for change set X" can find nothing.

**Where to look:**
- `supabase/functions/lease-governance-action/index.ts:136-157` for the helper definitions.
- All callers of `insertAudit` and `logActivity` in the same file (search for the function names).
- Similar pattern likely exists in `request-lease-unlock/index.ts:138-146` per prior reviews; audit for consistency.

**Stub fix:** Promote audit-write failures to hard failures: `await` the insert and let the error propagate to the outer try/catch which returns 500 to the caller. OR (cleaner) wrap state-change and audit-write in a Postgres transaction via RPC so they succeed or fail atomically (same fix shape as #19).

**Decision:** Filed not fixed. Pre-existing pattern, not in the named scope of #16/#17. Worth bundling with #19 in a "edge function atomicity + error handling" beat.

---

### Item #30: `check-subscription/index.ts` referenced in CLAUDE.md file map but absent from repo

**Symptom:** CLAUDE.md's File-to-Feature Map ("Pricing & Billing") references `supabase/functions/{create-checkout,check-subscription,customer-portal}/index.ts`, and the #29 post-merge regression audit's Step 4 named `check-subscription` as the edge function that reads `plan`/`document_limit`. The file does not exist: `ls supabase/functions/check-subscription/index.ts` → No such file or directory; there is no `[functions.check-subscription]` stanza in `config.toml`; and `npm run check:edge-function-config` passes with 50 functions, none named `check-subscription`. Documentation/file-map drift, not a runtime bug — no code path imports or invokes it.

**Severity:** Low (documentation drift, not a runtime bug). No runtime impact: nothing depends on the missing function. Subscription state is written by `stripe-webhook` (service_role) and read client-side from the `workspaces` row.

**Where to look:**
- CLAUDE.md File-to-Feature Map, the "Pricing & Billing" line referencing `{create-checkout,check-subscription,customer-portal}`.
- `supabase/functions/` — `create-checkout` and `customer-portal` exist; `check-subscription` does not.
- `config.toml` — no `[functions.check-subscription]` stanza.

**Stub remediation:** Confirm whether `check-subscription` was removed intentionally. If so, update CLAUDE.md's file map to drop the reference (and sweep for any other stale mention). If it should exist (e.g., a planned subscription-status refresh endpoint), restore it under the Project Configuration Source-of-Truth rule.

**Decision:** Filed not fixed. Surfaced during the 2026-05-23 post-merge regression audit on the #29 fix (commits `66ac634` and `07eb2f7`) — pre-existing drift, NOT caused by either commit.

---

### Item #31: `documents_used` (workspaces quota counter) is a dead column; enforcement runs off live lease counts instead

**Symptom:** A full sweep (`grep -rni documents_used`, excluding `_archive`) finds zero code that increments or resets `workspaces.documents_used`. The only references are the column definition (`integer DEFAULT 0 NOT NULL` in the baseline), the #29 entitlement-guard's checks, and **reads** — `AppContext.tsx:215` exposes it as `documentsUsed`, surfaced in the UI (see Finding A). It is always `0`.

**Investigation (2026-05-24): the original "enforcement has no data source" premise was wrong.** Quota *enforcement* is wired — it just never used `documents_used`. Both the hard gate and the customer banner compute from **live `COUNT(leases)`**:
- Hard gate: `process_lease/index.ts:1051` `assertProcessingQuota()` (P1-03) blocks on `monthly_extractions` (leases with `uploaded_at` in trailing 30d + non-null `extracted_json`) and, for new leases, `active_leases` (`lifecycle_status='active' AND archived=false`). Rolling 30-day window ⇒ no calendar "monthly reset" needed either.
- Soft poller: `_shared/monitoring/workspace_quotas.ts:55` `pollWorkspaceQuotas()` computes the same counts → writes `workspace_quota_snapshots`.
- Banner: `QuotaWarningBanner.tsx:65` reads `workspace_quota_snapshots`, not the column.

So caps ARE enforced. The audit nonetheless surfaced two real, narrower residuals:

**Finding A — dead column drove a broken, always-zero usage meter (customer-facing, Medium). RESOLVED 2026-06-11.** `AppContext.tsx` read `documents_used` → `documentsUsed`; `AccountSettings.tsx` rendered it as a usage meter (`{documentsUsed} / {documentLimit}` + progress bar + 0.75/0.9 color thresholds). Because nothing writes the column, the meter always showed `0 / <limit>` — a customer at 14/15 abstractions saw "0 / 15". **As-built fix (deviation from the originally-suggested approach):** rather than repointing at `workspace_quota_snapshots`, `AppContext` now computes `documentsUsed` as a **live trailing-30-day count** (leases with `uploaded_at >= now-30d AND extracted_json NOT NULL`), exactly mirroring `process_lease`'s `assertProcessingQuota` window — so the customer meter and the server's hard gate can never disagree (no snapshot-staleness window). The dead `documents_used` was also removed from the AppContext select string + `WorkspaceRow` type (the DB column still exists, guarded by the #29 entitlement trigger; only the unused frontend fetch was dropped). Meter relabeled "AI Abstractions" with a rolling-window note. Reviewer-cleared (auditor/security/polish/test-author), 570 tests. The dead-column note above and Finding B below remain open.

**Finding B — overage *billing* is unimplemented (product/revenue gap, needs a product call).** `overagePerDoc` ($12/$10) exists only as display config in `pricing.ts:40,67`. No code reports metered usage to Stripe; the gate **hard-blocks at the included cap** with `reason: 'quota_exceeded'` → upgrade prompt, rather than metering-and-charging per-doc above the cap. Possibly intentional — block-at-cap protects the 75% margin floor — so this is a revenue-opportunity decision, not a bug. Scope as its own downstream beat if meter-and-charge is desired.

**Severity:** Low for the column itself (dead, harmless — quota enforcement does not depend on it). Medium for Finding A (misleading customer-facing meter, no money lost / usage blocked). Finding B is a product decision, not a defect.

**Note for any future real counter:** the #29 guard now actively *blocks* non-`service_role` writes to `documents_used`, so any increment/reset must run as `service_role` (or under `DISABLE TRIGGER`). But given enforcement already works off live counts, a dedicated counter column may be unnecessary — prefer fixing the meter (Finding A) over reviving the column.

**Decision:** Filed not fixed. Surfaced during the 2026-05-23 post-merge regression audit on the #29 fix (commits `66ac634`/`07eb2f7`); investigation completed 2026-05-24. Pre-existing, NOT caused by either commit. Findings A and B are independent follow-ups, neither blocking.

---

### Item #32: `LeaseReview.tsx` post/approve actions bypass the canonical audit trail — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — `handlePostLease` now sets `status_changed_at` in the same UPDATE and emits a `status_change` row to `lease_activity_log` with top-level `from_status`/`to_status`, mirrored shape inside `details`, and `routing_path: 'legacy'`. `handleApproveLease` now writes a first-class `approval` activity row alongside the existing `extracted_json._approval` write (so attribution is no longer overwritable by re-extraction). Verified via vitest (443 tests passing) and TypeScript typecheck.

**Symptom:** Two legacy direct-write actions on the lease-review workbench violate the Lifecycle Transition Convention. `handlePostLease` (`src/pages/app/LeaseReview.tsx:1373`) is the terminal "post to repository" action: it sets `lifecycle_status: 'active'` in the UPDATE but omits `status_changed_at`, and writes no `lease_activity_log` `status_change` row (only an inline `audit_log` JSON column on the lease). `handleApproveLease` (`src/pages/app/LeaseReview.tsx:1396`) persists approval only by spreading `_approval` into `extracted_json` — no activity-log row, and the sub-key is overwritable by the next extraction write.

**Severity:** High. The most audit-critical transition (lease going live) is invisible to the canonical audit log (the `AuditLog` page, stuck-lease detection, and dashboards key off `lease_activity_log` + `status_changed_at`), and `status_changed_at` goes stale. Directly undermines the "every change is attributable" promise. (Audit pass rated `handlePostLease` Critical; calibrated to High here — integrity/attribution gap, not data loss or security.) Verified 2026-05-24.

**Where to look:**
- `src/pages/app/LeaseReview.tsx:1373` (`handlePostLease`) and `:1396` (`handleApproveLease`).
- Convention reference: CLAUDE.md "Lifecycle Transition Convention"; compliant exemplars are the form-path writer (`LeaseRequestForm.tsx`) and the edge writer (`act-on-chain-step/index.ts` → `updateLifecycle()` + `logStatusChange()`).

**Stub remediation:** Add `status_changed_at: now()` to the post UPDATE and insert a `status_change` `lease_activity_log` row (top-level `from_status`/`to_status` + nested `details` + `routing_path: 'legacy'`). For approve, write a first-class `approval` activity row (user_id + timestamp) instead of burying it in `extracted_json`.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass). Pre-existing; not tied to a recent commit.

---

### Item #33: `process_lease` extraction flips `lifecycle_status → executed` without `status_changed_at` / status_change log — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — The post-extraction UPDATE at `supabase/functions/process_lease/index.ts` now (1) reads the prior `lifecycle_status` from the lease via a single targeted select before the UPDATE, (2) sets `status_changed_at` on the same UPDATE (reused for `processed_at` so both reflect the same transition instant), and (3) emits a `status_change` row to `lease_activity_log` with top-level `from_status`/`to_status`, mirrored shape inside `details`, and `routing_path: 'extraction'`. Verified via mirror-parity + edge-function-config drift checks + vitest.

**Symptom:** The new-upload completion UPDATE in `supabase/functions/process_lease/index.ts:2444` sets `lifecycle_status: 'executed'` but never bumps `status_changed_at` and never emits a `status_change` `lease_activity_log` row (it logs domain events like `executed_terms_extracted`, but not the lifecycle transition per convention).

**Severity:** High. Same class as #32 on the extraction path — lease enters `executed` with no attributable status_change record and a stale `status_changed_at`, breaking downstream consumers keyed on those fields.

**Where to look:**
- `supabase/functions/process_lease/index.ts:2444` (and audit any sibling lifecycle write in `retry_lease`).
- Use the `updateLifecycle()` + `logStatusChange()` helper pattern from `act-on-chain-step` if a Deno-side equivalent exists; otherwise inline both shapes per convention with `routing_path` (e.g. `'extraction'`).

**Stub remediation:** Add `status_changed_at` to the UPDATE and emit a `status_change` row (prior status → `executed`).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass). Pre-existing.

---

### Item #34: `useLifecycleWorkflow.ts` unused transition paths violate the convention (latent)

**Symptom:** `submitForApproval` (`src/hooks/useLifecycleWorkflow.ts:200`), `takeApprovalAction` (`:293-314`), and `submitForExecutionApproval` (`:467`) UPDATE `lifecycle_status` without `status_changed_at`; the `status_change` rows they write (`:221`, `:486`) omit `from_status` and `routing_path` (`:221` also omits the nested `details.from/to`). Per the audit, only `createDraftLease` from this hook is actually wired (via `NewLease.tsx`); the three offending functions appear to be dead code.

**Severity:** Latent (dead code today). Would be High if any path becomes live without remediation.

**Where to look:** `src/hooks/useLifecycleWorkflow.ts:200,221,293-314,467,486`; confirm wiring via grep before acting.

**Stub remediation:** Either delete the unused functions (preferred if confirmed dead) or bring them to convention before any caller is added.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #35: `process_lease`/`retry_lease` rent-schedule rebuild is non-atomic (can wipe a confirmed schedule)

**Symptom:** The rent-schedule rebuild does `rent_schedules.delete().eq(lease_id)` then re-inserts from fresh extraction (`supabase/functions/process_lease/index.ts:2540`, mirrored in `retry_lease`). The insert error is logged, not thrown (`:2557` `console.error`), so a partial failure leaves the prior schedule deleted with no rollback. Re-running extraction/retry on an already-reviewed lease silently replaces user-facing rent rows. Note `model_locked` only guards the executed-upload path, not retry.

**Severity:** Medium. Possible loss of confirmed rent-schedule rows on partial failure; overwrite-on-re-extract is partly by-design but unguarded on the retry path.

**Where to look:** `supabase/functions/process_lease/index.ts:2540-2557`; the equivalent block in `retry_lease/index.ts`.

**Stub remediation:** Insert-then-swap, or wrap delete+insert in a transactional RPC; treat insert error as fatal; consider extending the `model_locked` guard to the retry path.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #36: `process_lease` quota gate is a TOCTOU-racy `COUNT` (cap bypass under concurrency)

**Symptom:** `assertProcessingQuota` (`supabase/functions/process_lease/index.ts:1069`) enforces the monthly-extraction and active-lease caps via read-only `COUNT(leases) >= limit` then proceeds. Concurrent uploads each observe the pre-increment count and all pass; the count-error path fails open (`:1080`), compounding it.

**Severity:** Medium (low real-world frequency). Caps can be exceeded under concurrency → unbilled Opus spend. Distinct from #31 (that is the dead `documents_used` column; this is a race on the live count).

**Where to look:** `supabase/functions/process_lease/index.ts:1069-1083` (monthly) and `:1104` (active-lease).

**Stub remediation:** Atomic reserve (advisory lock, or `INSERT ... RETURNING` against a usage-reservation row) instead of count-then-go. Coordinate with any future #31 counter work — must run service_role per the #29 guard.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #37: `profiles_insert_self` RLS policy uses `WITH CHECK (true)`, defeating the correct same-table policy — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — `supabase/migrations/20260524000000_drop_profiles_insert_self_policy.sql` (a single idempotent `DROP POLICY IF EXISTS "profiles_insert_self" ON public.profiles;`) was applied to the live LeaseIO project (`wwkwoxxcprnjjufkbzac`) via the Supabase MCP `apply_migration` tool on 2026-06-02. Server-side `schema_migrations` recorded the apply as version `20260602141557` — a cosmetic drift from the in-repo filename timestamp, harmless because the SQL is `IF EXISTS`-idempotent on any replay (re-running the file via `supabase db push` from a fresh checkout will no-op the DROP and insert a second `schema_migrations` row at the filename version; the live policy state remains correct).

Verified via `pg_policy` query immediately post-apply: the only INSERT policy on `public.profiles` is now `profiles_insert_own (WITH CHECK (id = auth.uid()))`. The bypass vector is closed.

**Symptom:** `public.profiles` has two permissive INSERT policies. The correct one, `profiles_insert_own` (`WITH CHECK (id = auth.uid())`, `supabase/migrations/20260516120000_baseline_schema.sql:4330`), is nullified because `profiles_insert_self` (`WITH CHECK (true)`, `:4334`) is OR'd in. An authenticated user could INSERT a profile row keyed to another real, not-yet-onboarded `auth.users` id, setting attacker-controlled `email`/`current_workspace_id`. Verified 2026-05-24: both policies present, not dropped by any later migration.

**Severity:** Medium. Real RLS gap, but exploitability is limited — the PK blocks overwriting an existing profile, and the target UUID must be a real, profile-less `auth.users` id (profiles are normally auto-created at signup).

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql:4330,4334`.

**Stub remediation:** New migration: `DROP POLICY "profiles_insert_self" ON public.profiles;` (keep only `profiles_insert_own`). Per the Schema Change Rule, write the `.sql` file first; confirm no legitimate writer relies on the permissive policy.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (backend-security pass).

---

### Item #38: `send-invite` accepts `role` from the request body without a whitelist

**Symptom:** `supabase/functions/send-invite/index.ts:133` writes the invited `role` verbatim to `invite_tokens.role` / `workspace_members.role`. The DB enum/FK is the only guard.

**Severity:** Low. The caller is already an authorized admin/owner and the DB enum likely rejects garbage, so blast radius is small.

**Where to look:** `supabase/functions/send-invite/index.ts:133`.

**Stub remediation:** Whitelist `role` against allowed values before insert.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (backend-security pass).

---

### Item #39: Member-management UI exposes controls broader than the owner-only RLS

**Symptom:** `MemberRoleSelect.tsx` (`:34`) and `MembersPanel.tsx` (`:116`) show role-change/remove controls to any admin (`canManageWorkspaceMembers`), but the `workspace_members` UPDATE/DELETE RLS policies require `is_workspace_owner(...)` (`baseline_schema.sql:3787,3791`). A non-owner admin sees the controls but the write is rejected by RLS.

**Severity:** Low. Broken-feature / confusing-error, NOT a privilege escalation (server is stricter than the UI).

**Where to look:** `src/components/workspace/MemberRoleSelect.tsx:34`, `MembersPanel.tsx:116`; RLS at `baseline_schema.sql:3787,3791`.

**Stub remediation:** Pick one model and align: hide the controls for non-owners, or relax the RLS to admins if admin-managed membership is intended.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (frontend-security pass).

---

### Item #40: `OperationsPage` renders DB-sourced URLs as `href` without scheme validation

**Symptom:** `src/pages/app/OperationsPage.tsx:308,349` renders `account_url` / `upgrade_url` (from `vendor_renewal_calendar` / `vendor_alert_log`) directly as anchor `href`. A `javascript:` URL would execute on click. Both tables are operator/cron-populated and ops-admin-only (`rel="noreferrer" target="_blank"` already present).

**Severity:** Low. Near-zero practical exposure (trusted, operator-only data path).

**Where to look:** `src/pages/app/OperationsPage.tsx:308,349`.

**Stub remediation:** Validate the scheme is `https:` before rendering the anchor.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (frontend-security pass).

---

### Item #41: `check-mirror-parity.mjs` strips all `//` lines, weakening Node↔Deno drift detection

**Symptom:** `scripts/check-mirror-parity.mjs:88` `normalize()` filters every line matching `/^\s*\/\//`, broader than its stated "header docstring only" contract. A behavioral divergence expressed as a commented/uncommented line in one mirror could be masked. The two target pairs are currently byte-identical in body, so no live drift today.

**Severity:** Low. Reduced confidence in the CI parity gate, not an active bug.

**Where to look:** `scripts/check-mirror-parity.mjs:88` (`normalize`) vs `stripLeadingComment`.

**Stub remediation:** Strip only the leading block comment (via `stripLeadingComment`); drop the per-line `//` filter in `normalize`.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #42: Orphaned/unwired components ship in no bundle but clutter the tree

**Symptom:** Four components have zero references anywhere: `src/components/workflow/AdminOverrideModal.tsx` (admin-override goes through `ChainViolationBanner` + `admin-override-step` instead), `src/components/dashboard/PendingApprovalsSection.tsx`, `src/components/dashboard/FinancialSummary.tsx`, and `src/components/dashboard/CommitmentHistory.tsx` (Dashboard.tsx imports a different set).

**Severity:** Low/Medium. Dead files — harmless to runtime, misleading to readers and to the CLAUDE.md File-Map (see #43).

**Where to look:** the four files above; confirm zero importers via grep before deleting.

**Stub remediation:** Delete after confirming truly unused (or wire them if intended).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #43: CLAUDE.md File-to-Feature Map has drifted from the tree — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — Reconciled CLAUDE.md against the live tree: (a) **Lease Review** group now drops the deleted `ModelLockConfirmation.tsx`; (b) **Approval Queue** group now drops the orphaned `PendingApprovalsSection.tsx` (still flagged by #42); (c) **Dashboard** group now lists the 11 components Dashboard.tsx actually imports (`OnboardingChecklist, SummaryStrip, NeedsAction, LeasePipeline, UpcomingRisks, RecentActivity, PipelineByDepartment, IntakeTrend, UpcomingEvents, EscalationReviewPanel, PendingCounterSignatureCard`) instead of the prior 6 entries (3 of which were orphaned); (d) **Portfolio** group now reflects reality (the page is built — `Portfolio.tsx` + `src/lib/portfolioAnalytics.ts`, PV liability + asset/escalation mix + lease register + index-lease disclosure) with a forward-pointer to KNOWN_ISSUES #46 for the tier-gating gap that surfaced during this reconciliation; (e) **Active Priorities** drops the "Portfolio intelligence dashboard — replace `Portfolio.tsx` stub with real analytics" line (priority functionally satisfied; the tier-gating residual is filed as #46). Related-but-out-of-scope-for-this-pass: line 138 still lists "Amendment comparison intelligence in `process_lease`" as open even though `process_lease/index.ts:2416` already writes `_amendment_changes` — flagged for a future audit beat, not bundled here.

**Symptom:** Multiple stale entries in CLAUDE.md's File-to-Feature Map: `Portfolio.tsx` is labeled "STUB — placeholder, needs build" (Active Priorities + File-Map) but is actually built (~332 lines, real `useQuery` + `computePortfolioMetrics`); `ModelLockConfirmation.tsx` is listed (Lease Review group) but has been deleted; the Dashboard group lists `FinancialSummary, PendingApprovalsSection, CommitmentHistory` (all orphaned per #42) while omitting the 8 components Dashboard.tsx actually imports (`SummaryStrip, NeedsAction, LeasePipeline, UpcomingRisks, RecentActivity, PipelineByDepartment, IntakeTrend, PendingCounterSignatureCard`). Related to already-filed #30 (`check-subscription`).

**Severity:** Medium (documentation integrity). Misleads file-scoping and the completion picture (Portfolio appears already built).

**Where to look:** CLAUDE.md File-to-Feature Map (Dashboard, Lease Review, Portfolio groups) and Active Priorities (Portfolio intelligence line).

**Stub remediation:** Reconcile the File-Map against the tree: drop deleted/orphaned entries, add the real Dashboard components, and re-classify `Portfolio.tsx` (and confirm whether the "portfolio intelligence dashboard" priority is now closed). Sweep for other stale references in the same pass.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #44: `Reports.tsx` renders user-reachable "Coming soon" report cards — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — Added a `if (!r.href) return false;` predicate to the existing report-card filter chain in `src/pages/Reports.tsx`, so the four unbuilt cards (`portfolio`, `renewals`, `escalations`, `projections`) are no longer rendered. The legacy `report.href ? <Link/> : <span>Coming soon</span>` fallback is left in place as defense-in-depth (and as a clear signal to any future addition). When those reports ship and get an `href`, the filter will let them through automatically.

**Symptom:** On the routed `/app/reports` page, 4 of 7 report cards (`portfolio`, `renewals`, `escalations`, `projections`) lack an `href` and render a visible "Coming soon" (`src/pages/Reports.tsx:198`). The three with hrefs route to real pages.

**Severity:** Low/Medium. Real user-reachable dead-end UI; matters for launch polish.

**Where to look:** `src/pages/Reports.tsx:198` (the card definitions / "Coming soon" branch).

**Stub remediation:** Either wire the four reports, or hide the unbuilt cards until shipped (avoid surfacing "Coming soon" to paying users).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #45: ~18 of 97 `src/lib` exports are unused — **i18n.ts portion RESOLVED 2026-06-21**

**Symptom:** A grep sweep found ~19% of `src/lib` exports with no importer. Original worst offenders: ~~8 unused formatters in `src/lib/i18n.ts`~~ (now deleted — see resolution), 4 in `src/lib/dateFormatters.ts`, 5 `canAccess*` helpers in `src/lib/authorization.ts`, and `severityColor` in `reportGeneration.ts`.

**Severity:** Low. Clutter. The unused `canAccess*` authorization helpers are a mild correctness smell (intended guards never called) — worth confirming nothing should be calling them.

**RESOLVED 2026-06-21 (i18n.ts portion only):** `src/lib/i18n.ts` was entirely dead (0 importers; the i18next init at `src/i18n.ts` is a different file) and was **deleted** in the formatting-consistency sweep (commit `5b5853f`). Its 8 unused formatters are gone. The canonical money/date/number module is now `src/lib/dateFormatters.ts`. Remaining open: the `dateFormatters.ts` exports (the sweep's later parts add callers — e.g. `formatLocalizedPercent`), the `canAccess*` helpers, and `severityColor`.

**Where to look (remaining):** `src/lib/dateFormatters.ts`, `src/lib/authorization.ts`, `src/lib/reportGeneration.ts`. Verify each via grep (some may be reached by dynamic/string paths — none found, but confirm before deleting).

**Stub remediation:** Delete confirmed-dead exports; for the `canAccess*` helpers, first confirm no surface *should* be calling them.

**Decision:** Filed not fixed (i18n.ts portion now resolved). Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #46: `Portfolio.tsx` is not Business-tier gated despite Portfolio Intelligence being a Business-tier feature — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — Decision: **gate the page** (keep Portfolio Intelligence Business-tier per the existing pricing model, consistent with the AI Assistant and Reports gating). Two changes: (1) `src/components/layout/AppSidebar.tsx` Portfolio nav item now carries `requiresBusiness: true`, so Starter workspaces see the lock icon + disabled link via the existing `renderNavItem` mechanism (Business workspaces see the "Business" badge); (2) `src/pages/app/Portfolio.tsx` now reads `canAccessFeature('business')`, disables the data `useQuery` (`enabled: !!workspace?.id && hasBusinessAccess`) so no leases are fetched for Starter, and early-returns an upgrade card (Lock icon + Business badge + CTA to `/app/upgrade?feature=portfolio`) mirroring the `Reports.tsx` gate. The gate is UI-side by necessity — `leases` RLS is workspace-scoped, not tier-scoped, so there is no backend tier enforcement to rely on (same as the AI Assistant, which additionally re-checks tier in its edge function; Portfolio has no dedicated edge function, it reads `leases` directly, so the client gate is the enforcement point). Verified via typecheck + 443 passing tests.

**Residual (not blocking):** `Portfolio.tsx` is not internationalized — the whole page (including the new gate copy) uses hardcoded English, unlike the i18n'd `Reports.tsx` gate. This is pre-existing page-level i18n debt, not introduced by this fix; the gate was written in the page's existing hardcoded-English style for internal consistency rather than half-i18n-ing the file. Folding Portfolio into i18n is a separate cleanup beat.

**Symptom:** The pricing model (CLAUDE.md Pricing table) classes "Portfolio Intelligence" as Business-tier only ("No" on Starter, "Yes" on Business). The implementation has no tier gate: the `/app/portfolio` route in `src/App.tsx` is wrapped only in `<ProtectedRoute>` (auth-only), the `AppSidebar.tsx` nav entry at line 60 omits `requiresBusiness: true` (so the lock icon at `:152` is never shown), and `Portfolio.tsx` itself does not call `canAccessFeature('business')`. Starter-tier workspaces can use the full Portfolio dashboard for free, undercutting the Business-tier positioning. Surfaced during the 2026-06-02 #43 File-Map reconciliation (the audit missed this because it focused on the "is the page built?" question, not the tier surface).

**Severity:** Medium. Revenue-positioning gap, not a security or correctness bug. Concretely: a Starter customer on $249/mo gets one of the headline Business-tier features ($499/mo) at no extra charge. Whether the right fix is to gate the page or to relax the pricing table is a product decision.

**Where to look:**
- `src/App.tsx` line 269-274 (Portfolio route — no tier guard).
- `src/components/layout/AppSidebar.tsx` line 60 (nav item missing `requiresBusiness: true`; line 152 is where the lock icon would render).
- `src/pages/app/Portfolio.tsx` line 24+ (no `canAccessFeature('business')` check).
- Reference exemplar: `src/components/ai/AiAssistant.tsx:33` and `src/pages/Reports.tsx:65` both correctly gate with `canAccessFeature('business')`.

**Stub remediation:** Pick the model. If Portfolio remains Business-tier per CLAUDE.md: add `requiresBusiness: true` to the AppSidebar nav item (gets the lock icon for Starter), wrap the route in a tier-check (or render an upgrade prompt inside `Portfolio.tsx` when `canAccessFeature('business')` is false — matches the AI Assistant pattern), and confirm there's no backend RLS that already enforces it (there isn't — `leases` reads are workspace-scoped, not tier-scoped, so the gate must be UI-side). If Portfolio should be available to all tiers: drop "Portfolio Intelligence" from the Business-only row in CLAUDE.md pricing and update marketing copy accordingly.

**Decision:** Filed not fixed — needs a product call (gate vs. relax). Surfaced during the 2026-06-02 CLAUDE.md File-Map reconciliation (closing of #43).

---

### Item #47: Shape helpers duplicated between `generate-lease-report` and `generate-workspace-asc842-report`

**Symptom:** The new `supabase/functions/generate-workspace-asc842-report/index.ts` duplicates ~150 lines of "shape" helpers (`asNumber`, `asString`, `pickClassification`, `shapeRentSchedule`, `shapeCitations`, `shapeEscalation`, `shapeRenewals`, `shapeTermination`, `shapeAuditEntries`, `shapeAsc842Inputs`) from `supabase/functions/generate-lease-report/index.ts`. Two callers, same code.

**Severity:** Low. Maintenance burden — any shape change must be applied in both files. Was kept duplicated in 2026-06-03 because refactoring the working per-lease function in the same pass would have risked the disclosure flow.

**Where to look:** `supabase/functions/_shared/` is the proper home. Extract to `_shared/lease_report_shapes.ts` and update both functions to import.

**Stub remediation:** Move the helpers to `_shared/lease_report_shapes.ts`. Replace local definitions in both edge functions with imports. Verify both functions still produce identical output (snapshot the JSON sections before/after).

**Decision:** Filed not fixed. Surfaced during the 2026-06-03 workspace ASC 842 report build.

---

### Item #48: Lease detail page no longer surfaces activity timeline inline

**Symptom:** Per the 2026-06-03 lease-detail cleanup, the `ActivityTimeline` component is no longer rendered inside `LeaseReview.tsx` (it was rendered twice — main view + Documents tab — both removed). The audit log lives at `/app/reports/audit-log` now, with a deep link from the locked-lease header ("Audit trail" button).

**Severity:** Note, not a bug. Filed so a future contributor doesn't add it back assuming it was a regression. The activity timeline is the same data, just centralized.

**Where to look:** `src/components/leases/locked/LockedHeader.tsx` for the deep link; `src/pages/app/AuditLog.tsx` for the destination page; `src/components/lifecycle/ActivityTimeline.tsx` is still imported in non-lease contexts (admin operations / Phase 7 exceptions surfaces) — verify those callers remain valid.

**Decision:** Filed for context. No action needed.

---

### Item #50: Executed-vs-pipeline reconciliation UI removed; underlying data still computed

**Symptom:** The two UI surfaces that consumed the executed-stage reconciliation data — `ExecutedTermsReview` (editable 7-row comparison + per-field confidence + audit-logged corrections) and `VarianceReport` (5-row Match/Variance summary) — were deleted from the lease workbench 2026-06-04. The underlying columns and writer code are still load-bearing for other surfaces:

- `executed_*` columns on `leases` (executed_tenant_name, executed_landlord_name, executed_commencement_date, executed_expiry_date, executed_monthly_payment, executed_rent_review_clause, executed_break_clause, executed_extraction_confidence) — still populated by `supabase/functions/process_lease/index.ts` (lines 1977, 2018) when an executed PDF is processed. `executed_monthly_payment` in particular is consumed by `ai-assistant`, `process-alerts`, `generate-lease-report`, and `generate-workspace-asc842-report` as a fallback for the monthly amount.
- `variance_*` columns (variance_monthly_payment, variance_commencement_days, variance_expiry_days, variance_tenant_name_match, variance_landlord_name_match) — still populated by `process_lease` and still consumed by `src/pages/Reports.tsx:85` as the "Variance Outliers" panel data source.
- Activity-log types `'executed_terms_extracted'` and `'executed_terms_edited'` remain in the `lifecycle.ts` enum. The "extracted" entry is still emitted by process_lease; the "edited" entry no longer has a writer (the only call site was inside `ExecutedTermsReview.tsx`, deleted).

**Severity:** Low. Nothing breaks. The columns continue to fill correctly. Future contributors might be confused by columns that have writers but no per-lease UI consumer — this note exists so they understand the columns power Reports and edge functions, not the deleted panels.

**Where to look:** `supabase/functions/process_lease/index.ts:1977,2018`; `src/pages/Reports.tsx:85`; `src/types/lifecycle.ts`; the removed components live at `git log -- src/components/leases/ExecutedTermsReview.tsx src/components/leases/VarianceReport.tsx`.

**Stub remediation:** None required. If we ever decide the variance signal is purely vestigial:
1. Confirm Reports.tsx Variance Outliers panel is actually used (it's currently hidden behind `varianceLeases.length > 0` so already self-suppresses).
2. Drop the writer + columns in a coordinated migration.
3. Remove `executed_terms_edited` from the activity-type enum.

For now, leave alone.

**Decision:** Filed for context. No action needed.

---

### Item #49: `generate-lease-insights` deployed as a 410-Gone stub with no repo source

**Symptom:** The `generate-lease-insights` slug still appears in the Supabase Edge Functions list, but the repo no longer contains a `supabase/functions/generate-lease-insights/` directory or a `[functions.generate-lease-insights]` config.toml stanza.

**Severity:** Low — purely cosmetic. The Supabase MCP doesn't expose a delete tool, so on 2026-06-03 the function was redeployed (version 18) with a stub body that returns HTTP 410 + `{"ok": false, "reason": "function_retired"}` for every request. No Anthropic API calls, no Sonnet code, no surfaces with stale behavior. The repo-side CI guard (`check:edge-function-config`) only checks `supabase/functions/*` ↔ `config.toml` parity and is intentionally unaware of live deployments, so the repo stays green.

**Where to look:** Supabase dashboard → Edge Functions → `generate-lease-insights`. Click delete when convenient.

**Stub remediation:** Delete the function from the Supabase dashboard. No code change required.

**Decision:** Filed for visibility. The stub is the durable safe state; deletion is a one-click cleanup whenever an operator is in the dashboard.

---

### Item #51: `deleted_workspaces` has no `deletion_reason` discriminator

**Symptom:** Workspace deletions now arrive from three semantically different sources — an owner deleting a populated workspace (`delete-workspace`), a user cancelling a still-pending multi-workspace creation (`create-workspace` cancel mode), a Stripe-error rollback of a never-activated workspace (`create-workspace` confirm), and the abandonment cron (`sweep-pending-workspaces`). All write the same `deleted_workspaces` shape. A query for "workspaces customers lost" cannot, without joining to `workspace_creation_requests`, tell a real populated-workspace deletion from a never-live rollback/abandonment.

**Severity:** Medium — forensic clarity, not correctness or security. Surfaced by the repository-integrity reviewer during the Workspace Management Phase 1 fix pass (2026-06-09). Filed (not bundled) per the reviewer's recommendation.

**Root-cause hypothesis:** `deleted_workspaces` was designed (baseline schema) for the single owner-delete path; Phase 1 added three more deletion sources without a discriminator column, so the table conflates "lost real data" with "cleaned up an unpaid shell."

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql:931` (table); insert sites at `supabase/functions/delete-workspace/index.ts:303`, `supabase/functions/create-workspace/index.ts` (cancel + rollback), `supabase/functions/sweep-pending-workspaces/index.ts`.

**Stub remediation:** New migration adding `deletion_reason text` (e.g. `'owner_delete' | 'pending_cancel' | 'stripe_rollback' | 'abandonment_sweep'`) to `deleted_workspaces`; stamp it at each of the four insert sites. Backfill existing rows to `'owner_delete'` (the only pre-Phase-1 source).

**Decision:** Filed for a follow-up. The current rows are still recoverable (distinguishable by joining `workspace_creation_requests.status`), so this is a clarity improvement, not a data-loss fix.

---

### Item #52: Member role-change and removal queries are not workspace-scoped client-side

**Symptom:** The `workspace_members` UPDATE (role change) and DELETE (remove member) queries filter only by row PK (`.eq('id', memberId)`), with no `.eq('workspace_id', workspaceId)` constraint. RLS (`is_workspace_owner`) is the sole enforcement layer — the DB correctly blocks cross-workspace writes, but the client query expresses no scope intent of its own.

**Severity:** High (defense-in-depth, not an active vulnerability). Surfaced by lease-security-scanner during the Workspace Management Phase 4 review (2026-06-09). Pre-existing code (predates Phase 4) — filed, not bundled, per the pre-existing-issues rule.

**Root-cause hypothesis:** The original WorkspaceSettings member controls were written when the panel could only ever render the active workspace, so PK-only filtering was implicitly scoped. The MembersPanel extraction made the component workspace-agnostic without revisiting the query predicates.

**Where to look:** `src/components/workspace/MemberRoleSelect.tsx` (the `workspace_members` UPDATE), `src/components/workspace/MembersPanel.tsx` `handleRemoveMember` (the DELETE).

**Stub remediation:** Add `.eq('workspace_id', workspaceId)` to both queries (MemberRoleSelect already receives `workspaceId` as a prop; MembersPanel has it in scope). Pure belt-and-braces — no behavior change when RLS is intact.

**RESOLVED 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). `MembersPanel.handleRemoveMember` DELETE now chains `.eq('workspace_id', workspaceId)` (required prop); `MemberRoleSelect.handleRoleChange` UPDATE conditionally adds it when `workspaceId` is present (optional prop — byte-identical when absent, which only happens in tests; the sole production call site at `MembersPanel.tsx:248` always passes it). Strictly row-narrowing — the `id` predicate is preserved, so it can only narrow to zero in the cross-workspace abuse case RLS already blocks; happy-path targeting is unchanged because `workspace_members.id` is the global PK and the member list is read under workspace scope. Reviewed: security + integrity clean (no findings); auditor clean on the production code but caught that the second `.eq()` broke `MemberRoleSelect.test.tsx`'s single-chain mock — fixed in the same change (the update builder is now a chainable thenable) plus new assertions pinning the `('workspace_id','ws-1')` predicate when known and its absence when `workspaceId` is omitted. typecheck clean; 1084 tests pass.

---

### Item #53: `workspace_activity_log.event_type` has no CHECK constraint

**Symptom:** Any authenticated workspace member permitted by the insert policy can write rows with arbitrary `event_type` strings — including service-role-reserved values like `'owner_transferred'` — poisoning the workspace audit trail. Integrity currently depends entirely on client discipline.

**Severity:** High (audit-trail integrity). Surfaced by lease-security-scanner during the Workspace Management Phase 4 review (2026-06-09). Pre-existing schema (Phase 1 migration, already applied) — filed, not bundled.

**Root-cause hypothesis:** The Phase 1 migration documented the event-type vocabulary in a comment (`created | activated | renamed | owner_transferred | member_added | member_removed`) but never enforced it as a constraint; client-side writers were trusted to stay within it.

**Where to look:** `supabase/migrations/20260609120000_workspace_management_phase1.sql:32` (column definition + comment); client writers in `RenameWorkspaceInline.tsx`, `MemberRoleSelect.tsx`, `MembersPanel.tsx`.

**Stub remediation:** New migration adding a CHECK constraint enumerating allowed values — must include `'member_role_changed'` (added by the Phase 4 fix pass as the correct event for role changes; the Phase 1 comment predates it). Consider going further: restrict the client INSERT policy to the client-writable subset (`renamed`, `member_added`, `member_removed`, `member_role_changed`) so `created`/`activated`/`owner_transferred` are service-role-only.

---

### Item #54: `workspace_activity_log` INSERT policy permits forgeable rows by any member

**Symptom:** The authenticated INSERT policy requires membership and `user_id = auth.uid()`, but nothing restricts WHICH `event_type` a member may write — a plain member can insert a legitimate-valued but false `owner_transferred` / `renamed` / `member_removed` row. Combined with #53 (no CHECK constraint), the workspace audit trail is forgeable by its own subjects. The omission side is equally real: members mutating via direct REST skip logging entirely, since client-side audit writes are voluntary.

**Severity:** Medium (audit-trail integrity, defense-in-depth — RLS still prevents cross-workspace writes and edits/deletes). Surfaced by lease-security-scanner during the Phase 3 review (2026-06-09). Pre-existing schema (Phase 1 migration) — filed, not bundled.

**Root-cause hypothesis:** The Phase 1 policy mirrored `lease_activity_log`'s INSERT policy shape without considering that workspace-lifecycle events include service-role-reserved vocabulary.

**Where to look:** `supabase/migrations/20260609120000_workspace_management_phase1.sql:58-65` (policy); client writers in `RenameWorkspaceInline.tsx`, `MemberRoleSelect.tsx`, `MembersPanel.tsx`.

**Stub remediation:** Remediate together with #53 and #55 as one audit-hardening migration: restrict client-insertable event_types to the genuinely client-written subset, keep `created`/`activated`/`owner_transferred` service-role-only.

---

### Item #55: Member-event audit writes should move server-side (trigger), not live in client discipline

**Symptom:** `member_role_changed` / `member_removed` / `renamed` audit rows are written client-side, fire-and-forget (deliberate, so an audit failure can't masquerade as an operation failure — 2026-06-09 fix pass). The integrity reviewer's assessment: for permission changes, the structural answer is atomicity, not silent drop — a tab close right after the success toast can drop the row, and direct-REST mutations log nothing. Related gaps: `member_added` is documented vocabulary (migration comment, spec §2) but has NO writer anywhere (`accept-invite` logs nothing); `workspace_activity_log` is absent from the generated `src/integrations/supabase/types.ts`, forcing `(supabase as any)` casts on every client writer.

**Severity:** High (audit-trail completeness for permission changes). Surfaced by lease-repository-integrity-reviewer during the Phase 3 review (2026-06-09). Filed by owner decision: fix `user_id` stamping now (done), build the structural fix as its own beat.

**Root-cause hypothesis:** Spec §6.5 chose client-side writes via the constrained INSERT policy to resolve a writer-model contradiction; that resolved WHO may write but left WHETHER a write happens to client discipline.

**Where to look:** `src/components/workspace/{MemberRoleSelect,MembersPanel,RenameWorkspaceInline}.tsx`; `supabase/functions/accept-invite/index.ts` (missing `member_added` writer); `supabase/migrations/20260609120000_workspace_management_phase1.sql`.

**Stub remediation:** One audit-hardening migration (bundle with #53 + #54): AFTER UPDATE OF role / AFTER DELETE triggers on `workspace_members` and AFTER UPDATE OF name ON `workspaces` writing `workspace_activity_log` in the same transaction (actor from `auth.uid()`, before/after from OLD/NEW); remove the client-side writes; wire `member_added` from `accept-invite` (or a member-insert trigger); regenerate types and drop the `(supabase as any)` casts. Security-class migration — reviewer routing before push. Note the trigger-ordering gotcha in CLAUDE.md (alphabetical firing; inventory existing triggers from the live DB first).

Two LOWs from the 2026-06-09 remediation re-review fold in here:
- `previous_role` in the client's `member_removed` write comes from the page-load member snapshot, not the deleted row — a role changed in another session is recorded stale. The AFTER DELETE trigger MUST source it from `OLD.role` (this is the motivation; don't drop it during the bundle).
- Residual post-commit race in the transfer RPC: a member-removal of the target that blocks on the RPC's FOR UPDATE proceeds after commit and deletes the NEW OWNER's freshly-promoted member row (not data loss — `workspaces.owner_id` holds and `is_workspace_member` covers owners — but it recreates the owner-with-no-member-row state). The AFTER DELETE trigger can detect `OLD.user_id = workspaces.owner_id` and log it distinctly (or re-insert per the owner-self-row convention).

---

### Item #56: Lease-meter "approaching limit" CTA on Usage sends Business users to a page selling them Business — RESOLVED 2026-06-12

**Symptom:** `UsageContent.tsx`'s approaching-limit banner fires for lease/archive saturation on any plan; for Business users the CTA routed to `/app/upgrade`, which unconditionally pitches the Business plan with an `autoCheckout=1` handoff. The 2026-06-09 fix retargeted the banner CTA to subscription management when `plan === 'business'`, but `Upgrade.tsx` itself remains plan-unaware: any Business user who reaches `/app/upgrade` by other paths (sidebar, deep link) is still sold their current plan.

**Severity:** Medium (misleading dead-end; potential duplicate-checkout confusion — `create-checkout` server-side behavior for an already-subscribed customer unverified). Surfaced by lease-product-polish during the Phase 3 review (2026-06-09). The banner half is fixed; the `Upgrade.tsx` half is pre-existing — filed, not bundled.

**Where to look:** `src/pages/app/Upgrade.tsx` (plan-unaware pitch + autoCheckout link); `src/pages/settings/AccountSettings.tsx:414` (autoCheckout reader); `supabase/functions/create-checkout/index.ts` (verify behavior for an already-Business customer).

**Stub remediation:** Make `Upgrade.tsx` plan-aware: for Business users render "You're on Business" + a Manage subscription link instead of the checkout CTA; verify `create-checkout` rejects/no-ops for an already-active Business subscription.

**RESOLVED 2026-06-12:** `Upgrade.tsx` was deleted in the settings Claude-alignment pass; `/app/upgrade` now redirects to `/app/settings/account?tab=billing`, which is plan-aware (upgrade card renders only for Starter admins).

---

### Item #57: Owner Workspace Management surface is hardcoded English

**Symptom:** `WorkspaceManagement.tsx` (section headers, card actions, leave/delete confirmations) and `DeleteWorkspaceDialog.tsx` are entirely hardcoded English, predating the workstream's i18n standard (Phase 2 shipped `workspace.create.*`, Phase 3 shipped `workspace.transfer.*` in both locales). A Spanish-locale user gets a mixed-language management page, including the delete confirmation.

**Severity:** Low-Medium (locale consistency; comprehension on a destructive dialog). Surfaced by lease-product-polish (2026-06-09). Pre-existing — filed, not bundled.

**Where to look:** `src/pages/account/WorkspaceManagement.tsx`, `src/components/workspace/DeleteWorkspaceDialog.tsx`, `src/components/workspace/MembersPanel.tsx` (toasts + a few inline strings).

**Stub remediation:** Extract to `workspace.manage.*` / `workspace.delete.*` keys in en + es in one pass; update the jsdom tests that assert literal strings.

---

### Item #58: Leaving your only workspace strands the session in a zero-workspace state

**Symptom:** `handleLeaveWorkspace` in `WorkspaceManagement.tsx` looks for a fallback workspace to switch to; when the departed workspace was the user's ONLY one, no fallback exists and the flow proceeds anyway, refreshing into an app state with no active workspace and no recovery surface.

**Severity:** Medium (user stranded; recoverable only by re-invite). Surfaced by lease-product-polish (2026-06-09). Pre-existing (Owner Workspace Management Checkpoint 3) — filed, not bundled.

**Where to look:** `src/pages/account/WorkspaceManagement.tsx:171-196`; whatever AppContext renders when `availableWorkspaces` is empty.

**Stub remediation:** Either block Leave when it's the last workspace (with copy explaining why), or build an explicit "no workspaces" recovery screen (create-new or accept-invite paths) and route into it.

---

### Item #59: `enforceWorkspaceRateLimit` read-then-upsert is not atomic

**Symptom:** The shared helper (`supabase/functions/_shared/audit.ts:226-261`) reads `request_count`, then upserts `count + 1` — concurrent requests in the same window can each read the same count and both pass, overshooting the cap. For owner-gated functions (delete-workspace, transfer-workspace-ownership, ceiling 5/hr) abuse value is minimal since only the verified owner can reach the limiter; the broader exposure is the AI/processing functions sharing the helper.

**Severity:** Low. Surfaced by lease-security-scanner during the transfer-RPC pre-push review (2026-06-09). Pre-existing shared-helper behavior — filed, not bundled.

**Where to look:** `supabase/functions/_shared/audit.ts:226-261`; all `enforceWorkspaceRateLimit` call sites (grep).

**Stub remediation:** Atomic increment — single UPSERT with `request_count = processing_rate_limits.request_count + 1` ON CONFLICT (or an RPC doing INSERT ... ON CONFLICT DO UPDATE ... RETURNING) and compare the returned count to the limit. Fix once in the helper; all callers inherit. (A cousin of this helper's "document processing request" copy being wrong for non-processing callers — add an optional label param in the same pass.)

---

### Item #60: Itemized per-workspace billing — forward-looking invariant (NOT a defect)

**Context:** Daniel flagged (2026-06-10) that owners of multiple workspaces will want an itemized bill showing the cost of each workspace, not just a summarized total. This item exists to pin the architectural invariant that makes that surface buildable later, so it isn't accidentally optimized away.

**The invariant to preserve:** Each workspace is its own independent Stripe subscription, created in `create-workspace/index.ts` with `metadata: { workspace_id, plan_id, billing_interval }` stamped on the subscription (`index.ts:403`). Because each workspace = one subscription = its own invoice stream, Stripe already itemizes billing per workspace. The future itemized-billing page is therefore **pure frontend work** — list the customer's subscriptions, join each subscription's `workspace_id` metadata back to `workspaces.name`, and offer a summary ↔ itemized toggle + per-workspace billing history. **If we ever stop stamping `workspace_id` onto the subscription metadata, the itemized view becomes impossible to build cleanly** — that one line is the load-bearing dependency.

**Related design fact (decided 2026-06-10):** There is no proration. A new workspace's subscription anchors its billing cycle to creation time and charges the full $499 that day (`create-workspace/index.ts:392-393`, "no billing_cycle_anchor (keeps '$499 today' honest)"). The price-awareness gate in `NewWorkspaceDialog.tsx` states this honestly ("$499 today, then $499/month on this date"). Switching to shared-subscription + proration would re-introduce proration math AND make the itemized view harder (one invoice with many lines vs. clean per-subscription invoices) — explicitly NOT the chosen direction.

**Severity:** N/A — forward-looking note. No action required until the itemized-billing surface is scheduled.

**Phase 9 update (2026-06-15):** The per-workspace-subscription invariant is **preserved for standalone Plus/Business workspaces** (still one sub each, `metadata.workspace_id` stamped). Firm children are the documented **exception**: a firm bills via ONE firm-level Stripe subscription covering all its children, tagged `metadata.firm_id` (NOT `workspace_id`), mirrored onto `firms.stripe_customer_id`/`stripe_subscription_id` by the stripe-webhook firm branch (`applyFirmSubscription`), which propagates `plan='business'` to the children. So itemized billing splits into two regimes once firm billing is live: standalone = per-subscription invoices (unchanged); firm = the firm billing page (Phase 10) consuming `v_firm_billing_period_summary` (which respects `firms.billing_summary_mode` detailed|summarized). The load-bearing `workspace_id` metadata line for standalone subs is untouched.

**Where to look:** `supabase/functions/create-workspace/index.ts:392-403`; the future page would live alongside `src/pages/app/UsageContent.tsx` / the account subscription tab. Firm side: `supabase/functions/stripe-webhook/index.ts` (`applyFirmSubscription`).

---

### Item #61: `create-checkout` resolves the Stripe customer by caller email (the P2-07 class, re-surfacing)

**Severity:** Medium. **Pre-existing** — surfaced 2026-06-11 by the security scanner during the subscription-tab polish pass; NOT introduced by that change.

**Symptom:** `create-checkout/index.ts:137-141` resolves/creates the Stripe customer with `stripe.customers.list({ email })` — the exact pattern P2-07 already fixed in `customer-portal` (which resolves from `workspaces.stripe_customer_id`). An account holder who is admin of two workspaces shares one email-keyed Stripe customer across both. Combined with the per-workspace-subscription architecture (#60) and the recovery-checkout button on the subscription tab (`proceedWithCheckout('business')`), a checkout can bind to a customer record already carrying another workspace's billing state.

**Fix (its own beat, not bundled):** mirror P2-07 — prefer `workspaces.stripe_customer_id` when present, fall back to email lookup only for a workspace's first-ever checkout, and stamp the resolved customer id back onto the workspace. Two adjacent pre-existing LOWs in the same function to sweep in the same pass: (a) `workspaceId` is presence-checked but not type-checked (`customer-portal:41` does `typeof === "string"`) → a non-string body produces a raw 500; (b) `Invalid plan: ${planId}` reflects raw user input into the JSON error body (`index.ts:69,178`) — return a static message + `reason: 'invalid_plan'` instead.

**Phase 9 note (2026-06-15) — NOT resolved by the firm layer.** The plan briefly hypothesized the firm work would "resolve #61's firm-customer gap"; in practice Phase 9 did NOT touch `create-checkout`, so this bug **remains open for standalone workspaces**. What Phase 9 *did* establish is the correct customer-resolution pattern on the firm path: the stripe-webhook firm branch resolves via `resolveCustomerId(subscription)` and persists onto `firms.stripe_customer_id` — the same prefer-stored-id discipline #61 asks `create-checkout` to adopt. When the #61 fix is scheduled, the firm path is the reference; the standalone `create-checkout` email lookup still needs the P2-07 mirror.

**Where to look:** `supabase/functions/create-checkout/index.ts:69,71-73,137-141,178`; reference fix in `supabase/functions/customer-portal/index.ts`.

---

### Item #62: "Your subscription renews on {{date}}" still shows after a cancel-at-period-end (no Stripe flag mirror)

**Severity:** Low/Medium (copy correctness). **Surfaced 2026-06-11** (polish pass); deferred because the proper fix needs webhook work.

**Symptom:** When a user cancels via the billing portal, Stripe keeps `status='active'` with `cancel_at_period_end=true`. Nothing in the repo mirrors that flag (grep: zero hits for `cancel_at_period_end`). The subscription tab's Current Plan card therefore shows "Your subscription renews on {{date}}" for a subscription that is actually ending on that date — copy that contradicts the user's own cancel action; they may think the cancel failed and try again or email support.

**Fix:** mirror `cancel_at_period_end` (and ideally `cancel_at`) onto `workspaces` via `stripe-webhook` (`customer.subscription.updated`), then branch the Current Plan copy: "Ends on {{date}} (canceled)" vs "Renews on {{date}}". Frontend half is trivial once the column exists; the webhook half is the work. Repository-integrity lane (touches the Stripe→DB mirror).

**Where to look:** `supabase/functions/stripe-webhook/index.ts` (subscription.updated handler); `src/pages/settings/AccountSettings.tsx` (Current Plan `renews_on` block); `src/contexts/AppContext.tsx` (`WorkspaceRow` + mapping).

---

### Item #63: No sidebar billing signal for `past_due` (only `trialing` gets a pill)

**Severity:** Low (UX gap). **Surfaced 2026-06-11** (polish pass).

**Symptom:** The new sidebar trial pill (`AppSidebar.tsx`) shows for `subscriptionStatus === 'trialing'`, but `past_due` — a strictly more urgent billing state (a payment has already failed) — has no global signal. The user only sees it if they navigate to the subscription tab, where the past-due banner lives.

**Fix:** add a red "Payment failed" pill in the same sidebar slot for `['past_due','unpaid','incomplete'].includes(subscriptionStatus)`, deep-linking to `?tab=subscription`. Reuses the trial-pill pattern exactly. Small, self-contained follow-up.

**Where to look:** `src/components/layout/AppSidebar.tsx` (trial pill block, just above the user menu).

---

### Item #64: Document-pack purchase idempotency key is per-attempt, not per-intent

**Severity:** Low. **Surfaced 2026-06-11** (Workstream B integrity review). Pre-existing-by-design.

**Symptom:** `DocumentPackDialog.handleBuy` generates a fresh `crypto.randomUUID()` per call; the server namespaces it `pack_<workspaceId>_<key>`. Stripe idempotency therefore only dedupes a literal retry of one call — it does NOT stop a user from buying the same pack twice (close dialog → reopen → buy again). Because capacity is intentionally additive (stacking is a feature), an accidental duplicate is silently honored as 2× capacity AND 2× recurring charge.

**Why deferred not fixed:** intentional stacking and accidental duplicate are indistinguishable without a product rule. Today the consent→processing transition unmounts the buy button, so a fast double-click is already unlikely; the residual risk is a deliberate-looking re-purchase.

**Fix (when scoped):** derive the idempotency key from a stable intent (e.g. `pack_<workspaceId>_<packId>_<preview-nonce>`) so a same-session re-confirm of the same pack collapses while genuine stacking (new dialog session) still creates a new sub; or add a soft "you already have an active N-pack — add another?" confirm. Defer to product.

**Where to look:** `src/components/workspace/DocumentPackDialog.tsx` (`handleBuy`); `supabase/functions/manage-document-pack/index.ts` (confirm idempotencyKey).

---

### Item #65: Document-pack webhook silently drops a paid grant if `workspace_id` metadata is missing

**Severity:** Low. **Surfaced 2026-06-11** (Workstream B integrity review).

**Symptom:** `stripe-webhook`'s `applyDocumentPack` returns early with only a `console.warn` if a pack subscription event lacks `metadata.workspace_id` (or customer). In normal flow this never happens — `manage-document-pack` always stamps `workspace_id` — but a pack sub created out-of-band in the Stripe dashboard, or a future code path that forgets the tag, would leave the customer's paid capacity un-mirrored with no durable trail. Unlike a mis-attributed plan sub (loud — no Business features), a dropped pack grant is quiet (the customer just never sees the slots they paid for). Brushes the "no silent vendor failures" hard rule.

**Fix (when scoped):** on the missing-`workspace_id` branch, write an append-only audit / dead-letter row (or emit a monitored alert per OPERATIONAL_MONITORING_SPEC) so a dropped paid grant is attributable and recoverable, not just logged.

**Extension (2026-06-11, Workstream C):** the same silent-drop shape now exists on `applySingleLeaseCredit` (missing `workspace_id` on a `payment_intent.succeeded` event → `console.warn` + 200 ack, paid one-time charge never granted). And one broader gap in the same lane: there is no reconciliation sweep comparing succeeded single-lease PaymentIntents against the `lease_credit_purchases` ledger, so a missed/undelivered webhook event (see the five-event subscription requirement in `OPERATOR_PLAYBOOK.md`) is permanently silent. Scoped remediation should cover both functions' drop branches plus a periodic reconcile (e.g. in `manage-document-pack` preview or the nightly health check).

**Where to look:** `supabase/functions/stripe-webhook/index.ts` (`applyDocumentPack` + `applySingleLeaseCredit` early-return guards).

**RESOLVED (drop-branch dead-lettering) 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). New forensic sink `billing_dead_letters` (migration `20260622000000`, applied to staging — append-only/immutable: FORCE RLS, ops-admin SELECT, no client write policy) + writer RPC `record_billing_dead_letter` (migration `20260622010000`, applied — SECURITY INVOKER, EXECUTE service_role-only, atomic upsert that freezes first capture and bumps `last_seen_at`/`attempt_count` on retry). `stripe-webhook` now records all SIX paid-but-not-honored exits via a best-effort `recordBillingDeadLetter` helper (logs + acks 200, never re-raises — an un-honorable event must not loop the webhook): `applyDocumentPack` (missing_workspace_id / missing_customer) and `applySingleLeaseCredit` (missing_workspace_id / unknown_workspace / underpaid / customer_mismatch), each attributing customer + claimed workspace + amount + purchased_by (uuid-validated) + raw metadata; the event id is threaded through both functions for the reconcile pivot. Reviewed: pre-apply security + integrity on BOTH migrations (clean), code-auditor + security + integrity on the webhook wiring (clean — no false-positive, forensically faithful, happy path behavior-identical). Static-source contract test `src/lib/__tests__/billingDeadLetters.test.ts` (9) + the existing webhook routing tests updated for the new arity. typecheck clean; 1099 tests pass. **Requires `supabase functions deploy stripe-webhook` to take effect** (the webhook is a deployed function; the migrations are already live, so the RPC exists but isn't called until the new webhook is deployed). **DEFERRED → #138:** the reconciliation sweep (the Workstream-C extension) — comparing succeeded single-lease PaymentIntents / pack subs against the `lease_credit_purchases` ledger + `workspaces.addon_document_capacity` to catch a missed/undelivered webhook event (which no dead-letter can capture, since the branch never ran) — is a separate periodic job, not part of the drop-branch fix.

### Item #138: Stripe paid-event reconciliation sweep (the half of #65 a dead-letter can't cover)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). The #65 dead-letter sink captures paid events the webhook RECEIVED but couldn't honor. It cannot capture an event Stripe never successfully delivered (a missed/undelivered webhook — see the five-event subscription requirement in `OPERATOR_PLAYBOOK.md`): that branch never runs, so there's nothing to dead-letter. That gap is permanently silent without an out-of-band reconcile.

- **(MED — silent revenue/grant gap) No periodic reconciliation** compares Stripe's succeeded single-lease PaymentIntents against the `lease_credit_purchases` ledger, nor active document-pack subscriptions against `workspaces.addon_document_capacity`. A dropped/undelivered webhook leaves a customer who paid without their credit/capacity, undetectably. **Fix (when scoped):** a service-role sweep (e.g. in the nightly health check, or a manage-document-pack preview path) that lists recent succeeded Stripe PIs/pack subs and flags any with no matching ledger row / capacity — writing a `billing_dead_letters` row (`reason` would need a new value like `reconcile_missing`, so extend the CHECK + the composite matrix) or an ops alert. Bound the Stripe API cost (paginate a recent window, not all-time). Pairs with the #65 sink as the "events we never saw" complement.

---

### Item #66: `src/integrations/supabase/types.ts` not regenerated for `addon_document_capacity`

**Severity:** Low (cosmetic / type-safety). **Surfaced 2026-06-11** (Workstream B audit).

**Symptom:** The new `workspaces.addon_document_capacity` column is read in `AppContext.tsx` via an `as any` cast because the auto-generated `types.ts` predates the column. Consistent with the file's established cast pattern, but the column should be reflected in the generated types after the migration applies.

**Fix:** run the Supabase type generation (`supabase gen types` / MCP `generate_typescript_types`) after the migration is applied to staging, commit the regenerated `types.ts`, and drop the `as any` at the `addon_document_capacity` read site.

**Where to look:** `src/integrations/supabase/types.ts`; `src/contexts/AppContext.tsx` (mapping).

**Extension (2026-06-11, Workstream C):** the regen must also pick up `workspaces.purchased_lease_credits`, the `lease_credit_purchases` table, and the `consume_lease_credit` RPC (currently bridged with `as any` casts in `AppContext.tsx` and a manual row cast in `LimitReachedDialog.tsx`).

---

### Item #67: `retry_lease` has no processing-quota gate

**Severity:** Low/Medium (cost exposure, not tenant isolation). **Pre-existing** — surfaced 2026-06-11 by the Workstream C security review; NOT introduced by that change.

**Symptom:** `supabase/functions/retry_lease/index.ts` enforces AI consent and rate limiting but never calls `assertProcessingQuota`. An over-cap workspace can keep triggering paid Opus extractions by retrying failed leases. The window is bounded (retries only apply to existing failed leases + the per-workspace rate limit), and the same bypass is what makes the single-lease credit's "Opus failure after consume" loss path recoverable for free — so any fix must preserve free retries of an *already-quota-passed* upload while blocking retry-as-quota-evasion. Needs a deliberate design, not a blanket gate.

**Where to look:** `supabase/functions/retry_lease/index.ts`; `assertProcessingQuota` in `process_lease/index.ts`.

---

### Item #68: Intake entry buttons and LeaseUploadModal are hardcoded English — **RESOLVED 2026-07-12**

> **RESOLVED 2026-07-12** by the full-repo i18n sweep (see #160): Dashboard/Leases intake buttons, `AddLeaseDialog`, and the entire `LeaseUploadModal` now render through `t()` with en+es keys; `localeParity.test.ts` guards the key sets.

**Severity:** Medium (i18n completeness). **Pre-existing** — surfaced 2026-06-11 by the Workstream C polish review; NOT introduced by that change.

**Symptom:** The gated entry points — Dashboard "New Request" (`Dashboard.tsx`), Leases "Add Lease" (`Leases.tsx`), the `AddLeaseDialog` chooser, and the entire `LeaseUploadModal` (titles, steps, errors) — are raw English strings. A Spanish-language user clicks an English button and lands on the fully-translated, usted-toned limit wall: mixed-language whiplash at the billing moment. Same class as the resolved Owner Workspace Management item (#57).

**Fix (when scoped):** move all four surfaces' copy into `common.json` (en + es) in one sweep; polish-review the Spanish for usted consistency with the billing surfaces.

**Where to look:** `src/pages/Dashboard.tsx`, `src/pages/Leases.tsx`, `src/components/leases/{AddLeaseDialog,LeaseUploadModal}.tsx`.

---

## Tracking

Surfaced 2026-05-03 during Phase 2 Path A smoke (items 1-4), Phase 2 Path A
follow-up (item 5), Phase 3 audit (items 6-7), Phase 3 close-out
forensics + smoke (items 8-10), Phase 4 close-out audit (item 11),
Phase 8 C1 (items 12-13), audit P2-01 (item 15), P1-10 baseline review
(items 16-18), governance hardening follow-up review (items 19-28), post-apply smoke check (item 29),
the #29 post-merge regression audit (items 30-31),
the 2026-05-24 full-codebase audit — security / dead-ends / data-integrity passes (items 32-45),
the 2026-06-02 CLAUDE.md File-Map reconciliation pass (item 46),
the 2026-06-03 lease-detail cosmetics pass (items 47-48),
the 2026-06-03 zombie-edge-function neutralization (item 49),
the 2026-06-04 executed-vs-pipeline UI removal (item 50),
the 2026-06-09 Workspace Management Phase 1 fix pass (item 51),
the 2026-06-09 Workspace Management Phase 4 review pass (items 52-53),
the 2026-06-09 Workspace Management Phase 3 five-reviewer pass (items 54-58),
and the 2026-06-09 transfer-RPC pre-push security review (item 59).
Filed by Claude per user direction. Each item should get its own commit
when fixed; reference this file in the message and remove the entry once
green.

### Item #69: Profile tab Phone field is never loaded or saved

**Symptom:** `AccountSettings.tsx` Profile tab renders a Phone input, but the user-hydration effect never calls `setPhone` from stored data and `handleSaveProfile` omits `phone` from the `profiles` update — the user types a number, gets "Profile updated successfully!", and the value evaporates on reload.

**Severity:** High (lying control on the primary settings tab). Pre-existing; surfaced by lease-product-polish during the 2026-06-12 settings-alignment sweep.

**Where to look:** `src/pages/settings/AccountSettings.tsx` (phone state, hydration effect, `handleSaveProfile`); confirm whether `profiles` has a phone column at all.

**Stub remediation:** Either persist phone end-to-end (add/verify column, load + save) or remove the field. Root-cause hypothesis: field added with the form scaffold, persistence never wired.

---

### Item #70: Workspace-settings saves silently no-op for non-owner admins (owner-only RLS vs admin UI gates)

**Symptom:** The only UPDATE policy on `workspaces` is owner-only, but settings UIs gate on `canEditWorkspaceSettings` (admin ∥ owner). A non-owner admin's save (thresholds, discount rate, lease config, backdoor toggle, report settings) matches 0 rows, PostgREST returns no error, and a success toast fires. Worst case is the discount-rate card: the lease-financials recompute then runs with the UNSAVED rate (the `leases` UPDATE policy does allow admins/editors), rewriting every lease's `calc_*` figures from a rate the workspace row does not hold.

**Severity:** High (silent data inconsistency + figures untraceable to stored rate). Pre-existing class — same family as the `workspace_members` owner-vs-admin mismatch already filed; surfaced by lease-security-scanner + lease-repository-integrity-reviewer on 2026-06-12.

**Where to look:** `src/components/workspace/DiscountRateCard.tsx` (update → recompute without verifying the write landed); `src/pages/settings/WorkspaceSettings.tsx` save handlers; `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` (owner-only policy).

**Stub remediation:** Class-shape fix, one pass: (a) decide owner-only vs admin-writable for the non-entitlement settings columns and align RLS accordingly; (b) until then, chain `.select('id')` on these updates and treat 0 rows as failure before any follow-on work (especially before the recompute) or success toast. Related: the recompute and threshold saves write no audit/activity rows, and the recompute's `Promise.all` ignores per-lease errors (partial recompute still toasts success).

---


**RESOLVED 2026-06-13** — migration `20260613060000_workspaces_admin_update.sql` (applied + verified live): widened the workspaces UPDATE policy to owners + accepted admins (product decision: admins manage settings), with a new `enforce_workspace_owner_immutable` trigger blocking non-service-role owner_id reassignment (escalation). Safety verified by pre-apply security + integrity (both APPLY): #29 guard still blocks billing for all non-service-role; read-only guard still blocks config on non-live; service-role ownership-transfer path unaffected; only `intended_plan` newly admin-writable (UI-only hint, accepted LOW). FOLLOW-UP (defense-in-depth, non-blocking): the WorkspaceSettings/DiscountRateCard save handlers still don't check affected-row count — add `.select('id')` 0-row detection (esp. before DiscountRateCard's lease recompute).
### Item #71: Three WorkspaceSettings handlers missing the canEdit guard; dead upgrade-confirm dialog; unused imports

**Symptom:** (a) `handleSaveBackdoor`, `handleSaveAssetTypes`, and `makeOptionListHandlers.handleSave` lack the `if (!canEdit) return` guard their sibling handlers all have (unreachable via UI for non-admins; RLS blocks non-owners — consistency/defense-in-depth only). (b) `AccountSettings.tsx`'s confirm-upgrade AlertDialog + `confirmUpgradePlan` state is unreachable (with the two-plan type, `currentPlan !== 'starter' && isUpgrade(...)` can never be true). (c) `WorkspaceSettings.tsx` carries unused `cn`, `useQuery`, `WorkspaceRole` imports and an unused `getRoleLabel`.

**Severity:** Low (hygiene). All pre-existing; surfaced by lease-security-scanner + lease-code-auditor on 2026-06-12.

> **Amended 2026-07-12 (unified-autosave rewrite):** (a) is SUPERSEDED — `handleSaveAssetTypes`/`makeOptionListHandlers.handleSave` were deleted and every workspaces write now funnels through `persistWorkspace`, which carries the centralized `canEdit` gate + `.select('id')` no-rows check (including the backdoor toggle). (c) narrowed: `WorkspaceRole` import removed; still unused → `cn`, `useQuery`, `getRoleLabel`. Also orphaned by the rewrite: locale keys `workspace.save_changes` / `workspace.saving` / `workspace.read_only` in BOTH en/es (WorkspaceSettings was the sole consumer; `account.*` twins are still live — keep those). (b) unchanged.

**Stub remediation:** One hygiene pass: delete the dead dialog + state + branch (b), drop `cn`/`useQuery`/`getRoleLabel` + the three orphaned `workspace.*` locale keys (both locales).

---

### Item #72: discount_rate has no DB CHECK constraint

**Symptom:** The 0 < rate ≤ 50 validation is client-only; a workspace owner can PATCH `workspaces.discount_rate` to a negative/absurd value via PostgREST, producing nonsense PV figures (own workspace only). Sibling columns (`counter_signature_default_due_days`, `report_*`) have CHECK constraints.

**Severity:** Low. Pre-existing; surfaced by lease-security-scanner 2026-06-12.

**Stub remediation:** Migration adding `CHECK (discount_rate > 0 AND discount_rate <= 50)` (security-adjacent: route through reviewers BEFORE db push per CLAUDE.md).

---

### Item #73: Out of Office has no UI entry point (intentional) — restore a revoke path before any reactivation

**Symptom:** The 2026-06-12 settings pass removed the Out of Office tab by product decision (delegation covers absence). The Phase 7 backend (table, `declare-out-of-office`/`revoke-out-of-office` functions, cron reroutes, ExceptionsDashboard read-only card) remains dormant. Verified `user_out_of_office` had ZERO rows at removal time, so nobody is stranded. However: there is no expiry cron and `act-on-chain-step` doesn't check windows — only the revoke function reverts delegated steps. If OOO is ever reactivated (or a row is created out-of-band), a user could hold an active window with no way to end it.

**Severity:** Low while dormant. Filed by lease-repository-integrity-reviewer 2026-06-12.

**Stub remediation:** If reactivating OOO: restore the settings tab AND add an admin revoke control to the ExceptionsDashboard OOO card. Until then, treat any `user_out_of_office` row as an anomaly.

---

### Item #74: delete-workspace (owner-initiated) doesn't cancel Stripe subscriptions or purge lease-documents/lease-reports buckets

**Symptom:** The owner-initiated `delete-workspace` edge function purges only the `leases` + `executed-leases` buckets (uploader-prefix convention) and never cancels the workspace's Stripe subscriptions — pack subscriptions keep billing after deletion, and `lease-documents`/`lease-reports` objects (`{workspace_id}/...` convention) survive (KNOWN_ISSUES #11 family). The cancellation-lifecycle cron fixed both for system purges (2026-06-12); the owner path still has the gaps.

**Severity:** High (recurring charges post-deletion; "deleted" documents persisting). Pre-existing; surfaced by lease-security-scanner + lease-repository-integrity-reviewer reviewing cda30d1.

**Stub remediation:** Extract the cron's Stripe-cleanup + four-bucket purge into a shared helper and use it from `delete-workspace` — one implementation so the two paths can't drift.

**RESOLVED 2026-06-13** — `_shared/workspace_purge.ts` (`cancelWorkspaceSubscriptions` + recursive 4-bucket `purgeWorkspaceStorage`) now used by BOTH `delete-workspace` (v22) and `process-cancellation-lifecycle` (v3). delete-workspace now cancels Stripe subs (incl. packs) + purges lease-documents/lease-reports (was leaking both); cron behavior preserved verbatim (order, race guards, defer-on-Stripe-failure). Security + integrity reviews: DEPLOY (no Critical/High/Medium). Both functions redeployed. Residual filed as #93 (forensic-row ordering on the owner path).

---

### Item #75: Grace "read-only" is enforced only for document processing; soft-delete access wall is UI-only

**Symptom:** During the 30-day grace window, server-side enforcement covers `process_lease`, `retry_lease`, and pack purchases. Other mutating surfaces (lease edits via PostgREST under RLS, approval-chain functions, `upload-lease-document`, invites, report generation) remain open to members of canceled — and even soft-deleted — workspaces. Workspace-scoped only (no cross-tenant risk); a policy-vs-enforcement gap, not a breach path.

**Severity:** Medium. Filed by lease-security-scanner reviewing cda30d1; remediation deliberately scoped out of the lifecycle commit.

**Stub remediation:** An `is_workspace_live()` SQL helper folded into write-side RLS policies (security migration — reviewer routing BEFORE push), or `canceled_at`/`soft_deleted_at` gates in the remaining mutating edge functions. Decide enforcement depth before customer #1 cancels.

**RESOLVED 2026-06-13** — Vault V1 read-only enforcement, BOTH depths shipped: migration `20260613000000_vault_v1_readonly_enforcement.sql` (78 restrictive RLS policies over 28 public tables via `is_workspace_live()`/`is_lease_live()`, 3 on `storage.objects`, applied + verified live) AND `_shared/workspace_live.ts` liveness gates in all 21 user-invokable mutators, liveness skips in all 7 workspace-touching crons, and full-liveness backstops in `process_lease`/`retry_lease`/`manage-document-pack` — all 31 changed functions redeployed and content-verified. Three review rounds (lease-security-scanner + lease-repository-integrity-reviewer), both APPROVED. Accepted residuals documented in `VAULT_TIER_SPEC.md` V1 as-built note; the one knowingly open mutator is #84 (resolve-approval-chain frozen deployment). Follow-up (non-blocking): LeaseReview secondary writers swallow PostgREST errors — see #85.

---

### Item #76: Nine deployed edge functions write activity types the CHECK constraint rejects — audit rows silently dropped since 2026-05-08

**Symptom:** The 2026-05-08 `lease_insights` constraint re-snapshot (archive `20260508000000`) RENAMED several activity-type values (e.g. `counter_signature_received` → `counter_signature_recorded`, `ooo_revoked` → `out_of_office_revoked`, `delegate_activated` → `delegate_timer_activated`) without renaming the writers. Nine functions still write the OLD names — `record-counter-signature` (:306), `declare-out-of-office` (:198), `revoke-out-of-office` (:158), `process-delegate-timers` (:118), `voluntary-delegate-step` (:185), `handle-deactivated-approver` (:156, :185), `upload-lease-document` (:270), `escalate-to-concept-approver` (:295), `send-counter-signature-reminder` (:268) — and every one of those inserts is awaited WITHOUT an error check, so the constraint violation is invisible. Entire categories of approval-workflow audit evidence (counter-signatures, OOO, delegation, document iterations) have not been recorded since the re-snapshot.

**Severity:** CRITICAL for audit completeness (no data corruption; rows are missing, not wrong). Root cause: re-snapshot treated the archive as specification and nobody diffed writers against the constraint. Filed by lease-repository-integrity-reviewer reviewing 5fe9e06 (2026-06-12).

**Stub remediation:** Dedicated session: (1) migration appending the nine legacy writer values to the CHECK (fastest path to stop the bleeding) OR coordinated writer rename + redeploy of all nine functions; (2) add error checks to those inserts; (3) static test that greps `activity_type:` literals across `supabase/functions/` and diffs them against the migration's CHECK list so this class can't recur.

**RESOLVED 2026-06-12** (same day filed). Full writer sweep found **12** orphaned values, not nine — the variable-assignment pass added `final_review_returned_to_negotiation` (act-on-chain-step) and `unlock_rejected` (lease-governance-action; unlock denials were never logged). Remediation shipped: migration `20260612230000_restore_orphaned_activity_types.sql` appends all twelve (APPLIED to live DB — writer inserts started landing immediately, zero redeploys needed); AuditLog labels added for the restored types; every `lease_activity_log` insert in the 11 writer functions is now error-checked (`console.error` on rejection — takes effect on next redeploy of those functions); static test `src/lib/__tests__/activityTypeConstraintSync.test.ts` diffs every writer-emitted value (literal, switch-assigned, helper-funneled) against the latest constraint migration so the class can't recur silently. Residual (non-blocking): ~18 unchecked audit inserts in 8 functions OUTSIDE the #76 writer set (finalize-report-pdf, advance-to-final-review, revoke-voluntary-delegation, generate-lease-report, admin-override-step, detect-stuck-chains, admin-trigger-manual-reroute, assign-execution-owner) — their values are all IN the constraint (the sync test proves nothing is being dropped); harden opportunistically when those files are next touched.

---

### Item #77: Storage DELETE policies on leases/executed-leases are lock-unaware — locked leases' source files deletable via raw storage API

**Symptom:** `prevent_locked_lease_edits` guards the DB row, but the storage policies ("Users can delete own lease files", `executed_leases_delete`) check only path ownership. The uploader of a model-locked lease can delete its source PDF via a direct storage API call, destroying the audit-defensible source while the lease row still points at it. The Documents-tab UI (2026-06-12) gates correctly; the API path does not.

**Severity:** High. Pre-existing; surfaced by lease-security-scanner reviewing 5fe9e06.

**Stub remediation:** Security migration (reviewer routing BEFORE push): add a `NOT EXISTS (SELECT 1 FROM leases WHERE ... AND model_locked)` condition to both DELETE policies — or route deletion through an edge function that re-checks `model_locked` server-side.

**RESOLVED 2026-06-13** — migration `20260613030000_destruction_guards.sql` (applied + verified live): restrictive DELETE policy `locked lease source files are not deletable` on storage.objects blocks deleting a leases/executed-leases object referenced by a `model_locked` lease (ANDs with the V1 liveness policy). Pre-apply security+integrity review: APPLY.

---

### Item #78: Lease archive ("Delete") admin gate is UI-only; archived_by/archived_at are client-supplied

**Symptom:** `leases_update_own_or_workspace_editor` lets any workspace editor set `archived = true` on any lease (including locked ones — archive columns are in the lock trigger's ignored_keys) via direct PostgREST, with arbitrary `archived_by` attribution and a client-clock `archived_at`. The UI (ArchiveButton, AmendmentsList) gates to admin/owner and now logs both directions (2026-06-12), but the log writes are also client-side and skippable.

**Severity:** High (audit-relevant records hideable by non-admins with forged attribution). Pre-existing; surfaced by lease-security-scanner reviewing 5fe9e06.

**Stub remediation:** BEFORE UPDATE trigger on archive-column transitions: require admin/owner, stamp `archived_by = auth.uid()` and `archived_at = now()` server-side (disjoint-columns pattern; inventory existing triggers first per CLAUDE.md). Same family: "Users can create activity entries" INSERT policy allows any member to forge ANY activity_type with `user_id` self-or-NULL — constrain client-insertable types to an allowlist in the same pass.

**PARTIALLY RESOLVED 2026-06-13** — archive half APPLIED + verified live: migration `20260613040000_lease_archive_attribution_guard.sql` (BEFORE UPDATE trigger requiring admin/owner to toggle `archived`, stamping `archived_by`/`archived_at` server-side; firing order `enforce_lease_archive_attribution < enforce_model_lock` confirmed). Pre-apply integrity + security reviews both APPLY (no Critical/High/Medium). The activity-type allowlist half is split out as **#90** (still OPEN — needs per-type adjudication).

**Addendum (2026-06-12, lease-security-scanner reviewing 3b9ec87):** the #76 remediation widened the CHECK with 12 writer values, all of which are written EXCLUSIVELY by edge functions (service role) — the allowlist remediation above must exclude every one of them from client-insertable types. Priority subset: dashboard-consumed types, where a forged row drives admin action — `policy_assignee_validation_failed` and `stuck_chain_detected` both render as exception alerts in `ExceptionsDashboard.tsx` (:97, :104); a member-forged "validation failed" row (user_id NULL = system-attributed) can induce an admin to reassign/override a healthy chain step.

---

### Item #79: "Delete" means hard-delete on the Leases list but restorable-archive everywhere else

**Symptom:** `Leases.tsx` + `DeleteLeaseDialog` perform a true `DELETE` ("permanently removed… cannot be undone") while LockedHeader, LeaseReview's overflow, and AmendmentsList all use archive semantics under the same "Delete" label and trash iconography. A user who learns "Delete is restorable" on the detail page will hard-delete from the list expecting restorability.

**Severity:** High (misled-into-destructive-action class). Pre-existing; surfaced by lease-product-polish reviewing 5fe9e06.

**Stub remediation:** Pick the vocabulary once: either make the list delete archive-semantics (preferred — hard delete then only via a deeper governance path), or relabel it "Delete permanently" with distinct iconography.

**RESOLVED 2026-06-13** — chose archive-semantics (product decision): the Leases-list row action now archives (restorable, admin/owner-only, server-enforced by the #78 trigger) via the new `ArchiveLeaseDialog`, not hard-delete. True hard-delete remains only on the deeper path (ImportHistory import-rollback, `DeleteLeaseDialog`). Frontend; integrity/auditor reviewed. Remaining copy-layer work (archive still WORDED 'Delete' on detail-page surfaces) split to #92; archived-lease findability/restore-in-list to #91.

---

### Item #80: Profile Phone field is a dead control

**Symptom:** `AccountSettings.tsx` renders a Phone input that is never loaded from and never saved to `profiles` — Save Changes toasts success while silently discarding the value.

**Severity:** Medium-High (silent data loss + lying success toast on the first Settings tab). Pre-existing; surfaced by lease-product-polish reviewing 5cac271.

**Stub remediation:** Wire `phone` into the profile load + `handleSaveProfile` payload (column exists check first), or remove the field.

**RESOLVED 2026-06-13** — verified `profiles` has NO `phone` column (live DB), so the field was a pure dead control (never loaded, omitted from the save payload). Removed the Phone input + state from AccountSettings; #69 is the same issue and is resolved by this. Restore only with a real column + load/save wiring.

---

### Item #81: Audit-insert failures have no observer; two residual silent paths

**Symptom:** The #76 error-check pass converts rejected `lease_activity_log` inserts from silent to `console.error` — but nothing watches edge-function logs (no Sentry capture in functions; retention is short; cron writers have no user in the loop), so a future rejection from a new cause could again run for weeks. Residuals: (a) `request-lease-unlock/index.ts:130` uses `.catch()` on the insert — supabase-js RESOLVES with `{error}` on Postgres rejection, so the catch only fires on network failures (an error check that looks present but isn't); (b) ~18 unchecked audit inserts in 8 functions outside the #76 writer set (values all in-constraint per the sync test — nothing currently dropped); (c) repo-file ↔ live-constraint parity is statically unverifiable after the out-of-band apply.

**Severity:** Medium. Filed by lease-repository-integrity-reviewer + lease-security-scanner reviewing 3b9ec87/6110442 (2026-06-12).

**Stub remediation:** (1) wire audit-insert failure counts into the ops-monitoring surface at `/app/admin/operations` or the AI-operator nightly health check ("daily chain-step actions vs. audit rows"); consider failing the request when approval-evidence inserts (`status_change`, `chain_step_*`) fail — an approval without its row is not defensible; (2) convert request-lease-unlock to the destructure pattern next touch; (3) add a live constraint-vs-migration diff to `scripts/smoke-audit-hardening.mjs`.

---

### Item #82: Twelve dead renamed activity types in the constraint; one pre-existing label gap

**Symptom:** The 2026-05-08 re-snapshot's renamed values (`counter_signature_recorded`, `out_of_office_revoked`, `delegate_timer_activated`, `voluntary_delegation_set`, `deactivated_approver_handled`, `document_iteration_started`, `counter_signature_overdue_recorded`, etc.) have had ZERO writers ever — no rows exist or can exist under those spellings. They sit in the constraint advertising a vocabulary that was never real; a future writer "adopting" one would fork event vocabulary (two names for one event class — unreconstructable for an auditor). The writer spellings restored by #76 are canonical. Separately: `counter_signature_reminder_sent` is actively written but has no ACTIVITY_LABELS entry in AuditLog.tsx (renders raw).

**Severity:** Low. Filed by lease-repository-integrity-reviewer + lease-code-auditor (2026-06-12).

**Stub remediation:** Next constraint snapshot: after a live `SELECT activity_type, count(*)` confirms zero rows, drop the twelve dead values and comment the writer spellings as canonical — do-not-adopt. Add the missing label.

---

### Item #83: Owner can hard-DELETE the workspaces row via PostgREST, bypassing the deleted_workspaces forensic record

**Symptom:** The baseline permissive policy "Owners can delete their workspaces" lets an owner DELETE their `workspaces` row directly (PostgREST), cascading away the entire repository WITHOUT the forensic `deleted_workspaces` row that the `delete-workspace` edge function writes — unattributable bulk destruction. Pre-existing; reachable in any workspace state including grace/Vault (the Vault V1 restrictive layer deliberately leaves `workspaces` open for owner rename and must not block this path silently either way — it needs an explicit decision).

**Severity:** High (unattributable destruction of the audit-defensible repository). Filed by lease-repository-integrity-reviewer reviewing 69fdc2e (2026-06-13).

**Stub remediation:** Drop the permissive DELETE policy in favor of the `delete-workspace` edge function (which writes the forensic row), or add a restrictive DELETE policy on `workspaces` denying client deletes outright. Security migration — reviewer routing BEFORE push. Verify the delete-account flow doesn't depend on the client-side DELETE first. NOTE (Vault V1, 2026-06-13): the fix must also cover non-live workspaces — FK CASCADE deletes are not subject to the Vault restrictive DELETE policies on child tables, so this direct-DELETE path is also the one way a frozen repository can be destroyed client-side.

**RESOLVED 2026-06-13** — migration `20260613030000_destruction_guards.sql` (applied + verified live): dropped the permissive `Owners can delete their workspaces` policy and added a restrictive `workspace deletes are server-only` (USING false) DELETE policy. Verified both deletion paths (delete-workspace, delete-account) use service_role (RLS-exempt) and no client-side workspace DELETE exists, so the forensic/cleanup paths are unaffected. Pre-apply review: APPLY.

---

### Item #84: resolve-approval-chain deployed snapshot is un-gateable for Vault V1 (accepted residual)

**Symptom:** `resolve-approval-chain` is user-invokable (JWT member) and triggers service-role writes to `leases`, `lease_approval_chain`, `lease_attribute_snapshots`, `lease_reroute_events` — but its deployed copy is the frozen pre-Phase-7 snapshot whose redeploy is permanently deferred (CLAUDE.md / PHASE_7_BUILD_SPEC A4). The Vault V1 liveness gate therefore cannot reach it: a member of a canceled/soft-deleted/vault workspace can still invoke it directly and mutate chain state.

**Severity:** Medium (member-only exposure, chain-resolution logic only; the resulting writes are system-attributed). ACCEPTED RESIDUAL per product-owner decision 2026-06-13 — filed, not fixed, because gating requires overriding the standing Phase 7 redeploy deferral.

**Stub remediation:** When Phase 7 A4 remediation is eventually executed, add the `checkWorkspaceLive` gate (pattern: any gated chain function, e.g. `act-on-chain-step`) to the repo file in the same change and redeploy. Until then this is the one knowingly open mutator in the Vault V1 read-only surface.

---

### Item #85: LeaseReview secondary writers swallow PostgREST errors (optimistic UI lies on rejected writes)

**Symptom:** `src/pages/app/LeaseReview.tsx` — `handleConfirmTab` (~:1326), `handleConfirmSection` (~:1206), `handleConfirmAndAdvance` (~:1266), and `trackFieldCorrection` (~:1176) ignore the PostgREST `error` object. With Vault V1's restrictive `WITH CHECK` policies, a grace-workspace user unmarking an approved tab gets "Tab reopened" while the DB rejected the write (42501); section-confirm state diverges optimistically; `field_corrections` inserts drop silently. The main save handler (~:1588) does it right — destructure, throw, toast.

**Severity:** Medium (UI/DB drift for non-live workspaces; live workspaces unaffected). Filed by lease-repository-integrity-reviewer round 2 of Vault V1 (2026-06-13).

**Stub remediation:** Destructure and surface `error` in each of the four writers, matching the ~:1588 pattern. Frontend-only commit; route through auditor + security + polish (user-facing error copy).

**RESOLVED 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). All four named writers (`handleConfirmSection`, `handleConfirmAndAdvance`, `handleConfirmTab`, `trackFieldCorrection`) PLUS a fifth same-class writer the issue under-counted — `handleConfirmAllRequired`, which was the worst case (it toasted *success* before the unchecked write) — now destructure `error` and, on rejection, REVERT the optimistic React state and surface it (so the UI no longer claims a write the DB refused). `handleConfirmTab` reverts BOTH the confirm state and the approval-strip `extracted_json` mutation; `trackFieldCorrection` (background analytics) `console.error`s and does NOT advance its baseline so the next change re-attempts. The success toast in `handleConfirmAllRequired` now follows a confirmed write. Error copy is localized (`lease_review.strip.save_review_failed`, en+es) and softened to not over-promise a retry ("…If this keeps happening, your workspace may be read-only.") since the dominant trigger is a permanent read-only RLS block, not a transient error. Reviewed: integrity + security + auditor clean; polish confirmed correct-as-backstop and surfaced the broader root cause (grace-window users aren't gated out of the write surface at all) → filed as **#136**. typecheck clean; 1084 tests pass. NOTE: this is the honest-error backstop; the complete "don't offer a write you'll reject" fix for grace users is #136.

---

### Item #86: stripe-webhook trusts frozen subscription metadata plan_id over the live price

**Symptom:** `resolvePlan` (`supabase/functions/stripe-webhook/index.ts`) returns `metadata.plan_id` unconditionally before consulting the subscription's actual price. Metadata is stamped at creation and frozen; if the Stripe billing-portal configuration (dashboard-side, not in repo) ever permits price switches, a Business sub moved to the Starter price keeps `plan_id='business'` → Business entitlements at Starter money. All current creation paths stamp metadata server-side from validated input, so this is configuration-contingent, not exploitable today.

**Severity:** Medium. Filed by lease-security-scanner reviewing 59481c6 (2026-06-13); pre-existing class, V2 merely extended it to a third value (vault metadata can only under-privilege, so the new direction is benign).

**Stub remediation:** When both metadata and price resolve, prefer the price-derived plan and log a mismatch warning ("trust the money, not the metadata" — same principle as `applySingleLeaseCredit`). Or verify + document that the portal config disallows price changes.

---

### Item #87: WorkspaceSettings "General" save bundles name+timezone — rename fails as collateral during grace/Vault

**Symptom:** `src/pages/settings/WorkspaceSettings.tsx` `handleSaveGeneral` updates `name` AND `timezone` in one `workspaces` UPDATE. The read-only config guard (migration `20260613010000`) rejects the statement on a non-live workspace because `timezone` is a guarded column — so an owner on a canceled-in-grace / soft-deleted / Vault workspace who only wanted to rename gets a hard failure with no indication timezone is the cause. The dedicated rename path (`RenameWorkspaceInline.tsx`, name-only) still works, so rename is not globally lost.

**Severity:** Medium (UX wrinkle on a read-only workspace; no data risk — the guard is working as intended). Filed by lease-security-scanner pre-apply review of the Vault V3 read-only guard (2026-06-13). Root cause is broader: WorkspaceSettings' client `canEdit` is role-only and doesn't reflect non-live state — full client-side read-only gating of WorkspaceSettings is V4 (read-only UI walls) territory.

**Stub remediation:** Either split the name update out of `handleSaveGeneral` when non-live, or gate the General form (and the rest of WorkspaceSettings) client-side on `isReadOnlyRetention`/grace state as part of the V4 read-only UI pass. Until then, the inline rename remains the working path.

**RESOLVED 2026-06-13** — `handleSaveGeneral` now attempts the bundled name+timezone update, and on rejection retries the rename ALONE (so a non-live config-guard rejection of timezone no longer blocks the rename), with a `.select('id')` 0-row check (#70 defense-in-depth) surfacing RLS no-ops as honest errors instead of false success. Full client-side read-only gating of WorkspaceSettings remains V4 read-only-UI territory.

> **Superseded 2026-07-12 (unified-autosave rewrite):** `handleSaveGeneral` and its retry workaround no longer exist — name and timezone persist as SEPARATE writes (`saveName` on blur / `saveTimezone` on change), so a frozen timezone can't block a rename in the first place. The `.select('id')` no-rows check lives on in the shared `persistWorkspace` helper.

---

### Item #88: Vault dashboard still shows intake-oriented widgets with live CTAs

**Symptom:** On a Vault (read-only) workspace the Dashboard top-level "New Request" CTA is hidden and the VaultBanner explains the read-only state, but the dashboard BODY widgets (NeedsAction, LeasePipeline, etc.) still render and some of their inline items link to create/approve flows that can't run on a read-only workspace. The felt experience is a half-disabled cockpit rather than a clean archive. Server backstop blocks any write; this is UX completeness, not a data risk.

**Severity:** Medium (UX). Filed during Vault V4 polish review (2026-06-13); deliberately deferred from the V4 hardening round (diffuse, lower-priority than the LeaseReview/billing surfaces which were fixed).

**Stub remediation:** Thread a read-only signal into the Dashboard widgets (or gate per-widget create/approve CTAs on `isReadOnlyRetention`), so NeedsAction/pipeline items render view-only for Vault. Consider a "read-only archive" empty-affordance treatment.

---

### Item #89: Vault renewal-reminder email is English-only

**Symptom:** `supabase/functions/vault-renewal-reminder/index.ts` hard-codes English copy and `en-US` date formatting for the ~14-day renewal reminder, even though the owner may be a Spanish-locale user. Every other user-facing surface is bilingual.

**Severity:** Low. Filed during Vault V4 polish review (2026-06-13).

**Stub remediation:** Branch the subject/body/date-format on the owner's profile/workspace locale if available (the cancellation-lifecycle emails share the same English-only limitation — consider a shared bilingual email helper). Content itself is clear and correctly framed; this is i18n completeness only.

---

### Item #90: lease_activity_log INSERT policy allows any activity_type + forged system attribution (split from #78)

**Symptom:** The "Users can create activity entries" INSERT policy on `lease_activity_log` is `WITH CHECK (((user_id = auth.uid()) OR (user_id IS NULL)) AND <member-of-lease's-workspace>)`. So any workspace member can insert a row with ANY of the ~100 constraint activity_types AND `user_id = NULL` (system attribution) via direct PostgREST. The dashboard-consumed types are the sharp edge (#78 addendum): a member-forged `policy_assignee_validation_failed` / `stuck_chain_detected` row (NULL user_id = system-attributed) renders as an exception alert in `ExceptionsDashboard.tsx` and can induce an admin to reassign/override a healthy chain step. The 12 dead renamed types (#82) and every edge-function-exclusive writer type must be excluded from any client allowlist.

**Severity:** High (forgeable audit history + admin-misleading alerts in an audit-defensible product). Split from #78 (2026-06-13) — the archive half shipped as migration `20260613040000`; this half needs per-type adjudication across the ~100-value constraint and the ~10 client insert sites, so it's its own deliberate pass, not a same-migration rush.

**Stub remediation:** Security migration (reviewer routing BEFORE push). Enumerate every client insert site (grep `lease_activity_log` in `src/` — currently ~10 sites writing ~18 types) and confirm which types clients legitimately write directly vs. should be moved to an edge function (e.g. `status_change`/`approval` arguably belong server-side, cf. #32). Then narrow the INSERT policy WITH CHECK to `user_id = auth.uid()` (drop the NULL option) AND `activity_type = ANY(<client allowlist>)`. Verify no legitimate client flow breaks (each currently-written type stays allowed or is rerouted) before applying. Add a static/smoke test pinning the allowlist.

**RESOLVED 2026-06-13** — migration `20260613050000_activity_log_client_allowlist.sql` (applied + verified live): the INSERT policy now AND-s a 19-type client allowlist (enumerated + verified against all 37 src/ writer sites incl. the two dynamic ones), so a browser client can no longer forge the ~80 service-role-only types — the alert types (`policy_assignee_validation_failed`, `stuck_chain_detected`) are confirmed excluded. Predicate preserved verbatim; edge functions bypass RLS. `user_id` left flexible (NULL retained for legit system comments — tightening to NULL-only-for-comment is the noted follow-up). Regression test `src/lib/__tests__/clientActivityAllowlist.test.ts`. Pre-apply security + integrity: both APPLY (no Critical/High/Medium).

**#90-NULL RESOLVED 2026-06-13** — the noted follow-up shipped as migration `20260613070000_activity_log_null_attribution_comment_only.sql` (applied + verified live via `pg_policy.polwithcheck`): the user_id clause tightened from `(user_id = auth.uid()) OR (user_id IS NULL)` to `(user_id = auth.uid()) OR (user_id IS NULL AND activity_type = 'comment')`, so an authenticated member can no longer forge a system-attributed (NULL) row for any non-comment allowlisted type (`status_change`/`approval`/`lease_archived`/etc.). Strictly monotonic tightening; allowlist + EXISTS predicate + Vault RESTRICTIVE policy preserved verbatim. Verified non-breaking against every client writer: all literal `user_id: null` sites are comment-typed; the defensive `?? null` non-comment sites only run inside authenticated, member-gated flows (EXISTS already needs a non-null `auth.uid()`), so user_id is the real UID at runtime. Regression guard extended in `clientActivityAllowlist.test.ts` (pins the carve-out + sweeps for literal-null non-comment writers; 8/8). Pre-apply security + integrity: both APPLY (no Critical/High/Medium). PR #39.

---

### Item #91: Leases "Show archived" shows all leases (no archived-only filter) + no in-list restore

**Symptom:** `Leases.tsx` "Show archived" toggle widens the query but doesn't `.eq('archived', true)`, so it shows active + archived together with no badge distinguishing them; and archived rows have no in-list Restore action (restore lives only on the lease detail page via `ArchiveButton`). After #79 the archive dialog points users to "Show archived" + the detail page, so findability matters more.

**Severity:** Low-Medium (UX). Pre-existing filter gap surfaced by lease-repository-integrity-reviewer during the #79 review (2026-06-13); the #79 fix pointed restore at the detail page to avoid a false promise, leaving this as the polish follow-up.

**Stub remediation:** In the showArchived branch, filter `.eq('archived', true)` (or add an "Archived" badge on archived rows), and add an in-list Restore action on archived rows mirroring `ArchiveButton`'s restore (archived=false, null attribution, log `lease_restored`). Route through lease-product-polish.

**RESOLVED 2026-06-13** — 'Show archived' now filters to archived-only; archived rows get an 'Archived' badge + an in-list Restore action (mirrors ArchiveButton: non-destructive, admin-only via the #78 trigger, logs lease_restored, .select check). Polish-reviewed; follow-up fixes applied: archive-specific empty state with a 'Back to active leases' way-out (was the misleading 'No executed leases' dead-end), refreshProfile() after archive+restore so quota counters resync, and i18n'd restore toasts + tooltip labels. Accepted residual: in-list restore has no pre-action cap-warning dialog (non-destructive + reversible; counters resync + QuotaWarningBanner gives post-hoc feedback) — the dialog-gated ArchiveButton restore remains for the warned path.

---

### Item #92: Archive vocabulary is labeled "Delete"/"deleted" across ArchiveButton, badges, banners, and archive.* locale keys

**Symptom:** The restorable-archive action is worded as "Delete" throughout the detail-page surfaces: `archive.archive` = "Delete", `archive.archived_toast` = "Lease deleted", `archive.deleted_badge` = "Deleted", `archive.deleted_banner`, `archive.confirm_archive_title` = "Delete this lease?". So "Delete" still means archive (restorable) on the detail page while meaning permanent deletion in ImportHistory — the same dual-meaning #79 set out to remove, at the copy layer. #79 fixed the Leases-LIST semantics + used clear "Archive" wording in the new list dialog, but did not rename the detail-page archive vocabulary.

**Severity:** Medium (the core #79 confusion persists in detail-page copy). Surfaced during the #79 review (2026-06-13).

**Stub remediation:** Vocabulary unification pass (lease-product-polish + locale parity en/es): rename the `archive.*` key VALUES from Delete→Archive wording across `ArchiveButton`, badges, and banners so "Delete" means only permanent deletion anywhere. Multi-surface user-facing copy change — review before shipping.

**RESOLVED 2026-06-13** — archive vocabulary unified to Archive/Archived/Restore across archive.* + amendments.delete_* VALUES (en+es), AmendmentsList (Archive icon + aria-label, non-destructive), and the three trigger labels polish caught (LeaseReview toolbar + overflow menu, AmendmentsList confirm CTA — now localized, non-destructive). "Delete" now appears only for genuine permanent deletion (ImportHistory/DeleteLeaseDialog, LeaseDocumentsTab). Polish + auditor reviewed; locale parity holds. Minor LOW left: a couple of internal code comments still say "delete" (non-rendered).

---

### Item #93: delete-workspace writes the forensic deleted_workspaces row LAST; a failure leaves a destroyed workspace unrecorded

**Symptom:** `delete-workspace/index.ts` writes the `deleted_workspaces` forensic row near the END (after Stripe cancel + storage purge), and a forensic-insert failure is only logged — so a workspace can be destroyed with no forensic record. The cancellation cron does the opposite (forensic row BEFORE destruction, abort on failure). The two destruction paths use opposite forensic ordering by design; delete-workspace's is the weaker one.

**Severity:** Medium (forensic gap on the owner-initiated path). Pre-existing; surfaced by lease-repository-integrity-reviewer during the #74 review (2026-06-13).

**Stub remediation:** Move delete-workspace's forensic `deleted_workspaces` insert to BEFORE the destructive deletes (mirror the cron), aborting the delete if the forensic insert fails — so destruction is never unattributable.

**RESOLVED 2026-06-13** — delete-workspace (v23 deployed) reordered to match the cron: forensic `deleted_workspaces` row inserted BEFORE the lease/workspace deletes (aborts 500 `forensic_insert_failed` on a non-duplicate error; resumes on the unique-index duplicate), storage purge moved LAST, `storage_objects_purged` backfilled. Pre-deploy integrity review: DEPLOY (no findings).

---

### Item #94: UploadExecutedDocumentDialog sets lifecycle_status='executed' client-side without status_changed_at or an activity-log row

**Symptom:** `src/components/leases/UploadExecutedDocumentDialog.tsx:61` does a client-side `leases.update({ lifecycle_status: 'executed' })` with NO `status_changed_at` set and NO `lease_activity_log` row written in `src/` — it relies on `process_lease` having already written the `executed_uploaded`/`status_change` rows. This violates the Lifecycle Transition Convention (CLAUDE.md: any code transitioning `lifecycle_status` must set `status_changed_at` + write a `status_change` activity row with `from_status`/`to_status` + `routing_path`). If the process_lease path doesn't fire for this transition, the change is unattributable.

**Severity:** Medium (lifecycle-convention gap; potential unattributable status transition). Surfaced by lease-repository-integrity-reviewer during the #90 review (2026-06-13).

**Stub remediation:** Either route this transition through the canonical lifecycle writer (so status_changed_at + the activity row are guaranteed), or confirm + document that process_lease always writes them for this path and the client update is redundant/safe. Verify against the convention before closing.

**RESOLVED 2026-06-14** — the flip was moved server-side into `process_lease`'s executed branch (deployed v101, `verify_jwt` preserved false; deployed bundle confirmed to contain the change). It now captures `from_status` from the already-fetched `existingLease.lifecycle_status`, sets `lifecycle_status`+`status_changed_at` in the SAME existing UPDATE (single trigger fire), and writes a convention `status_change` row carrying the real `user.id` (top-level `from_status`/`to_status` AND `details.{from,to,routing_path:'extraction',triggered_by:'process_lease_executed_upload'}`). Idempotent: only flips+logs when prior status != 'executed' (`executed_uploaded`/`executed_terms_extracted` still log every upload). The client flip in `UploadExecutedDocumentDialog.tsx` was removed. Reviewers: auditor CLEAN, security APPLY, integrity APPLY (no Critical/High/Medium on the change). Test: `src/lib/__tests__/executedLifecycleFlip.test.ts`. Spawned follow-up #96 (pre-existing `transitioned_by` NULL gap). Verification ceiling: deployed-code == committed + convention-compliant by review; a live executed-upload was not exercised end-to-end (needs an approved lease + PDF). PR #41.

---

### Item #95: live smoke layer (`audit_rls_smoke_check`) has no key for the `lease_activity_log` INSERT policy

**Symptom:** The `audit_rls_smoke_check` SECURITY DEFINER function (`supabase/migrations/20260517000000_governance_hardening_followup.sql:~549`, run via `npm run smoke:security` / `scripts/smoke-audit-hardening.mjs`) content-checks 25+ policies against the live DB but has **no key for the `lease_activity_log` "Users can create activity entries" INSERT policy** — neither #90's 19-type client allowlist nor #90-NULL's `user_id IS NULL AND activity_type='comment'` carve-out. So the live net that catches Studio/MCP policy drift is blind to this policy. The static tests (`clientActivityAllowlist.test.ts`) catch in-repo drift only; the live layer is what would catch a hand-edit reverting the allowlist/carve-out in the DB. **The original #90 residual came from exactly this class of live policy state**, so the absence of a smoke key here is the meaningful gap.

**Severity:** Medium (live-drift blind spot on an audit-defensibility policy). Pre-existing — #90/#90-NULL added static guards but never a smoke key; surfaced by lease-test-author during the #90-NULL post-work sweep (2026-06-13).

**Stub remediation:** Add a boolean key (e.g. `lease_activity_log_insert_comment_null_only`) to `audit_rls_smoke_check` that introspects the policy's `with_check` (via `pg_policies` / `pg_get_expr`) and asserts BOTH the 19-type allowlist presence AND the comment-only NULL carve-out (`user_id IS NULL AND activity_type = 'comment'`), plus the absence of the loose unqualified `user_id IS NULL` clause. The runner is key-agnostic (any new boolean key is auto-asserted), so this is a superset addition. **Requires a new migration to a SECURITY DEFINER governance function → routes through lease-security-scanner review BEFORE `db push` (expect 3+ rounds per CLAUDE.md security-migration rule).** Add a static test pinning the new smoke key alongside.

---

### Item #96: `lease_state_transitions.transitioned_by` is NULL for every server-side (service-role) lifecycle flip

**Symptom:** The AFTER UPDATE trigger `log_lease_state_change()` (`supabase/migrations/20260516120000_baseline_schema.sql:~456`, bound at `:3063`) records `transitioned_by = auth.uid()` into the secondary `lease_state_transitions` table on every `lifecycle_status` change. Edge functions run as `supabaseAdmin` (service_role), where `auth.uid()` is NULL — so **every server-side lifecycle flip writes `transitioned_by = NULL`** to `lease_state_transitions`. An auditor reconciling that table finds executed/active/etc. transitions with no actor, even though the parallel `lease_activity_log.status_change` row DOES carry the real `user_id`. The two audit tables disagree on attribution for the same event.

**Severity:** Medium (secondary-audit-table attribution gap; the primary `lease_activity_log` is correctly attributed). **Pre-existing and broad** — affects ALL service-role flips: `process_lease`'s new-lease pipeline flip (`:~2619`) and the new #94 executed flip, plus the chain/legacy edge writers (`act-on-chain-step`, etc.) that hit the same trigger under service_role. NOT introduced by #94 — surfaced by lease-repository-integrity-reviewer during the #94 review (2026-06-14); #94 actually improves attribution (its `lease_activity_log` row carries the real actor).

**Stub remediation:** The fix lives in the trigger + the callers, not in any one edge function. Have the edge functions pass the actor explicitly into the transaction (e.g. `SET LOCAL` a `app.transition_actor` GUC, or `request.jwt.claim.sub`) and have `log_lease_state_change()` read `transitioned_by = COALESCE(auth.uid(), current_setting('app.transition_actor', true)::uuid)`. Touches a baseline trigger + every service-role lifecycle writer → security + integrity review BEFORE apply; sweep all callers in one pass so the GUC is set everywhere the trigger can fire.

---

### Item #97: workspace component tests fail locally on Node ≥22 (`localStorage` undefined) — CI on Node 20 is green — **RESOLVED 2026-07-16**

> **RESOLVED 2026-07-16** with option (b) from the stub, done as a vitest `setupFiles` shim rather than per-file polyfills: `src/test/setupStorage.ts` probes `localStorage`/`sessionStorage` with a real setItem/removeItem (Node ≥22's inert built-in THROWS rather than being undefined — the probe catches both shapes) and swaps a broken built-in for an in-memory `MemoryStorage`; working storage (jsdom's, or a future fixed Node) is left untouched. Wired via `vite.config.ts` `test.setupFiles`. Full suite now 1438/1438 on Node 26 locally — first green local run on modern Node. Unblocked because #161's fix had to modify `NewWorkspaceDialog.test.tsx` and the suite had to actually run to verify it. CI Node-version standardization stays with #98.

**Symptom:** `npm test` on Node ≥22 (reproduced on Node 26) fails 49 tests across `src/components/workspace/__tests__/NewWorkspaceDialog.test.tsx` and `WorkspaceCommandPalette.test.tsx` with `TypeError: Cannot read properties of undefined (reading 'setItem'/'clear')` plus `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`. Root cause: Node 22 introduced a built-in experimental `localStorage` global that is inert without `--localstorage-file`; under vitest's jsdom environment it shadows jsdom's own `localStorage`, so the bare `localStorage` these tests use resolves to `undefined`. On Node 20 (no built-in) jsdom's `localStorage` is used and the tests pass. **CI runs Node 20 (`.github/workflows/ci.yml:35`) so its "Run tests" step is green** — this is a local-dev-only failure, not a code or CI regression.

**Severity:** Low (developer-experience / test-portability; no production or CI impact). NOT a code defect — the components work in-browser where `localStorage` is real. Pre-existing — these workspace tests have always assumed jsdom's `localStorage`; surfaced 2026-06-14 during the #94 "nothing broken" verification when the suite was run on Node 26. Discovery side-note: the local `node_modules` was also stale (jsdom + `@stripe/stripe-js` declared but uninstalled), which masked the suite entirely until `npm ci` — unrelated, resolved by reinstall.

**Stub remediation (pick one):** (a) Pin local Node to 20 to match CI — add a `.nvmrc` (`20`) and/or `engines.node` in package.json so contributors don't run on a drifting toolchain; lowest effort, restores parity. (b) Make the tests Node-22+ tolerant — in `_jsdomPolyfills.ts` (or a shared setup), guard/stub `localStorage` when the global is the inert Node built-in (e.g. detect missing `setItem` and install an in-memory shim), so the suite passes on any Node. (b) is the more durable fix as the floor Node version rises; (a) is the quick parity fix. Either way, also consider bumping CI's `node-version` deliberately rather than letting local drift decide.

---

### Item #98: CI actions run on deprecated Node 20 — `actions/checkout@v4`, `actions/setup-node@v4`, `supabase/setup-cli@v1`

**Symptom:** The green CI run on 2026-06-14 (run 27520431813) emitted a GitHub deprecation warning: "Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, supabase/setup-cli@v1. Actions will be forced to run with Node.js 24 by default starting **June 16th, 2026**. Node.js 20 will be removed from the runner on **September 16th, 2026**." The workflow uses four action refs (all in `.github/workflows/ci.yml`): `actions/checkout@v4` (lines 30, 93), `actions/setup-node@v4` (line 33), `supabase/setup-cli@v1` (line 96). The runner explicitly flagged checkout@v4 and setup-cli@v1; setup-node@v4 also runs its action runtime on Node 20 (v5.0.0+ moved to node24), so it belongs in the same bump even though it wasn't named.

**Severity:** Low now (warning only; the 2026-06-14 run passed). Escalates on two dates: **2026-06-16** Node 24 becomes the forced default (could surface action-runtime incompatibilities early), and **2026-09-16** Node 20 is removed from the runner (hard break if not bumped). Ref: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/

**Stub remediation:** Bump each action ref to a major whose action runtime is Node 24, then push and confirm the next run still produces job rows (per the CLAUDE.md GH Actions gotcha — a broken workflow shows zero job rows). Targets verified 2026-06-14 (re-confirm latest at fix time): `actions/checkout@v4 → v6`; `actions/setup-node@v4 → v6` (v5+ runs node24); `supabase/setup-cli@v1 → v2` (Bun-based runtime, current major). Pure CI-config change; no app/DB impact. Note vs #97: the CI `node-version` is pinned to 20 in setup-node — that's the Node the workflow *installs* and is independent of the action *runtime* bump here, but revisit both together if standardizing the toolchain.

---

### Item #99: UsageContent "Unlimited active leases" branch (`activeMax === -1`) is unreachable for every current plan — Low

**Symptom:** `src/pages/app/UsageContent.tsx` carries an `activeUnlimited = activeMax === -1` branch (renders "Unlimited", no bar, no count line). `activeMax` comes from `workspace.maxActiveLeases`, which `AppContext.tsx:232` sets to `documentLimit` (the DB `document_limit`, or `planConfig.maxActiveLeases`). No plan in `pricing.ts` sets `maxActiveLeases` to `-1` (starter 15, business 50, vault 0; only `maxUsers` is `-1`), so the branch is dead defensive code — it only fires if a `document_limit` of `-1` is hand-written to a workspace row. Consequence: a Business workspace at 50/50 active leases shows a full red "100% used" bar, which is **correct** per the no-unlimited pricing model (CLAUDE.md Pricing: packs/overage are the relief valve), not a missing "Unlimited" state.

**Severity:** Low. NOT a defect — surfaced by lease-product-polish during the 2026-06-13 Usage row-redesign review and dismissed by the product owner as benign pre-existing code. Pre-existing: the original 4-card layout had the identical `activeMax === -1` handling; the redesign preserved it verbatim. No customer-facing wrongness today.

**Stub remediation:** Optional cleanup — either delete the `-1` branch (and the `activeUnlimited` plumbing) if no future plan will ever be unlimited, or keep it as forward-compat scaffolding with a one-line comment that no current plan config triggers it. Do NOT add an unlimited active-lease tier without a pricing decision (violates the 75%-margin / no-unlimited rule). A guard test pinning the branch already exists in `UsageContent.test.tsx` (added during the same review).

---

### Item #100: Billing tab — recovery banner and plan header offer two competing CTAs to the same Business checkout — Low

**Symptom:** On the Billing tab (`src/pages/settings/AccountSettings.tsx`) when a workspace abandoned a Business checkout (`intendedPlan === 'business' && plan !== 'business'` and not active/trialing), the recovery banner ("You picked Business during signup… complete Business checkout") renders, and directly below it the plan header shows the Starter plan with an "Adjust plan" button that also routes to a Business upgrade. Two stacked CTAs lead to the same checkout — extra decision friction on a conversion-critical surface (violates one-gesture-per-state).

**Severity:** Low. **Pre-existing** — the old design had the same double-up (recovery banner Card + inline upgrade Card); surfaced by lease-product-polish during the 2026-06-15 Billing Claude-redesign review and dismissed by the product owner as not blocking. Not a dead-end (both paths work); purely a friction/clarity nit.

**Stub remediation:** When the recovery banner is visible, suppress the plan header's "Adjust plan" button (or vice-versa) so there's one obvious next gesture. Both gate on the same `workspace.intendedPlan`/`subscriptionStatus` state already, so the condition is cheap to add.

---

### Item #101: Staging billing data is pre-Stripe synthetic — live card/invoice path unverified — Low (staging-only)

**Symptom:** The only staging workspace (`Labs Analytix`, `c9dad4c7-d04a-4d14-b846-8e017d662341`, owner `daniel.c.priest@gmail.com`) is `plan='business'`, `subscription_status='active'`, but has `stripe_customer_id=NULL`, `stripe_subscription_id=NULL`, and `subscription_period_end=NULL` (no `lease_credit_purchases` rows either). That's an impossible *real* state — the workspace was created 2026-01-07 (before billing was wired) and grandfathered to business/active directly in the DB, never through a Stripe checkout. Consequence: the new `get-billing-summary` edge function returns its `no_customer` 200 for it, so the Billing tab's Payment shows "Add payment method" / "No payment method on file yet" and Invoices shows "No invoices yet". The live Stripe card + invoice **retrieval** path therefore could not be smoke-tested end-to-end (verified live: deploy, CORS, auth gates, clean boot, and the `no_customer` branch — but not a real card/invoice fetch).

**Severity:** Low, **staging-only**. NOT a code defect — the redesign (PR #47, merged 2026-06-15) and `get-billing-summary` handle the no-customer state by design. The data inconsistency predates the billing work. Product owner chose to **leave the data as-is** (2026-06-15) rather than create test Stripe objects or reset the workspace.

**Stub remediation (when verification is wanted):** the path self-heals the first time any workspace completes a real checkout — `stripe-webhook` backfills `stripe_customer_id`/`stripe_subscription_id`/`subscription_period_end` and the Payment/Invoices sections light up. To force it on staging without a browser checkout: create a Stripe **test-mode** customer + card + Business subscription for the owner and write the IDs back (a one-off backfill), or reset this workspace to a pre-checkout state and run Stripe Checkout in-app with test card `4242 4242 4242 4242`. Do NOT write a fabricated `cus_…` id — the function would call Stripe with a non-existent customer and 502 instead of returning the clean empty state.

---

### Item #102: Phase 9 firm edge functions return raw DB error messages (constraint-name leak) — Low

**Severity:** Low. **Surfaced 2026-06-15** during the Phase 9 firm-foundation build (self-noted while writing `create-firm`/`add-firm-member`/`bind-workspace-to-firm`/`release-workspace-from-firm`); NOT yet fixed — filed as its own beat per the pre-existing-issue discipline.

**Symptom:** The four service-role firm edge functions surface Postgres errors to the client by passing `error.message` straight into the JSON response body. When a guard trigger or CHECK constraint fires (e.g. `enforce_firm_entitlement_guard`, `enforce_workspace_firm_binding_guard`, the plan-lock trigger, the child-limit enforcement, or a UNIQUE violation on `firm_members`), the raw message can include the trigger/constraint name and the `ERRCODE`. That's internal schema detail leaking to an authenticated caller — low impact (these are authorization-boundary functions, the caller is already authed and owns the firm), but it's information disclosure and makes the API contract brittle (clients keying on raw strings).

**Fix (its own beat):** map known constraint/trigger names to stable `{ ok: false, reason: '…' }` codes (e.g. `firm_plan_locked`, `firm_child_limit_reached`, `firm_member_exists`, `not_firm_owner`) + a static human message; log the raw error server-side only. Mirror the structured-error idiom the limit-wall functions already use (`reason: 'quota_exceeded'`). Sweep all four functions in one pass.

**Where to look:** `supabase/functions/{create-firm,add-firm-member,bind-workspace-to-firm,release-workspace-from-firm}/index.ts` (the `catch` / error-response blocks); reference idiom in `supabase/functions/process_lease/index.ts` (`quotaBlockResponse`).

---

### Item #103: Firm-bound workspace billing lockdown — server-side bypass RESOLVED in Phase 10; UI/UX residual open

> **PARTIALLY RESOLVED — server-side sub-items closed in Phase 10 (2026-06-16), re-verified by the 2026-06-17 audit (`docs/AUDIT_FINDINGS_2026-06-17.md`, Sweep 4).** The **HIGH server-side bypass is closed**: **sub-item 1** (`create-checkout` + `customer-portal` now firm-aware) and the **server half of sub-item 3** (`manage-document-pack` rejects firm-bound capacity purchase) all return **403 `reason: 'firm_managed'`** for any firm-bound workspace — `create-checkout/index.ts:129`, `customer-portal/index.ts:64`, `manage-document-pack/index.ts:207` (the latter gates `confirm`/`buy_single` modes). A firm-bound child can therefore no longer create a duplicate independent sub, open an irrelevant portal, or buy a workspace-scoped capacity pack via the server — the lockdown is **no longer "UI-only."**
>
> **STILL OPEN (UI/UX only — no security/revenue risk):** sub-item **2** (hide the "Update/Add payment method" button on a firm-bound workspace — server now rejects it, but the button still renders), sub-item **3-UI** (hide the Active-leases "Add capacity" CTA + short-circuit the `?packs=1` deep-link), and sub-items **4–8** (firm-banner dead-end, thin/stale plan-header card, sidebar switcher crowding, awkward fallback copy, selector inconsistency). Original gap description preserved below.

> **HIGH items (1–3) RESOLVED.** Server side closed in Phase 10 (#103 server guards: `create-checkout` / `customer-portal` / `manage-document-pack` all reject firm-bound workspaces fail-closed with `firm_managed`). Client side closed 2026-06-21 by **audit D1** (branch `claude/affectionate-hamilton-bp58tu`): item 2 — `AccountSettings` payment button now gated on `!firmBound`; item 3 — the capacity-pack doors are all firm-gated (the `LimitReachedDialog` pack/single doors → a "capacity managed by your firm" note, the `?packs=1` deep-link, and the `UsageContent` "Add capacity" CTA via `onAddCapacity={firmBound ? undefined : …}`; the AccountSettings pack section was already `!firmBound`). The remaining **MED/LOW UX items (4–8 below) are NOT resolved** — firm-banner dead-end, thin plan-header, sidebar crowding, fallback copy, selector inconsistency — and are tracked here as polish for a later pass.

**Severity:** High (items 1–3, now RESOLVED) + Med/Low (items 4–8, open polish). **Surfaced 2026-06-15** by the lease-security-scanner + lease-product-polish sweep of the Phase 9 minimal frontend (branch `claude/phase9-firm-foundation`, PR #49). **Decision (Daniel, 2026-06-15): defer all of it to Phase 10**, which owns the firm billing surface end-to-end. Nothing here is reachable by a customer today because firm minting is service-role-only (the 4 Phase 9 edge functions) — no user-facing firm onboarding exists until Phase 10, so no customer workspace has `firm_id` set. Filed as one beat; do NOT bundle a fix into the Phase 9 foundation PR.

**The gap (one theme — the firm-bound Billing tab promises "managed at the firm level" but several billing actions remain live, and the gates that exist are UI-only):**

1. **(HIGH, server) `create-checkout` + `customer-portal` are not firm-aware.** An owner/admin of a firm-bound child who calls `create-checkout` directly creates a *new independent* Stripe subscription stamped `metadata.workspace_id`; `stripe-webhook`'s `applySubscription` (service role) then writes it onto the child's `workspaces` row — clobbering `stripe_subscription_id`/`subscription_status`/`billing_interval`/`stripe_customer_id` and starting a duplicate charge against a workspace whose billing is firm-governed. The plan-lock trigger `prevent_independent_plan_change_for_firm_workspace` only blocks the *plan column* changing to non-`business`; it does NOT block a `business` checkout or protect the other billing columns. So the UI suppression in `AccountSettings` is the only firm-level gate on this path. **Fix:** firm-aware preflight in both fns — select `firm_id`; if non-null, reject fail-closed (`reason: 'firm_managed'`, mirroring `vault_owner_only` / `annual_not_configured`). This belongs with the deferred webhook-firm-branch deploy beat.
2. **(HIGH, UI) Payment section still renders the admin "Update/Add payment method" button on a firm-bound workspace** (`AccountSettings.tsx` Payment block, ~1131–1170) → opens `customer-portal` scoped to the child (whose `stripe_customer_id` is NULL) → errors or opens an empty/irrelevant portal, contradicting the banner directly above it. **Fix:** gate the Payment action button (or the whole Payment+Invoices block) on `!firmBound`, same pattern as the Adjust-plan/Cancel gates already shipped.
3. **(HIGH, UI+server) Capacity-pack purchase remains reachable on a firm-bound workspace** via the Usage tab Active-leases "Add capacity" CTA and the `?packs=1` deep-link (`AccountSettings.tsx:181,1229–1233,1279`; `setPackDialogOpen`). A pack is its own workspace-scoped Stripe sub — buying one under firm billing is a contradiction + unauthorized charge. **Fix:** thread `firmBound` into `UsageContent`/the Active-leases row to hide the CTA + short-circuit the `?packs=1` open path; AND reject workspace-scoped pack checkout for firm-bound workspaces server-side in `manage-document-pack` (UI-only is insufficient).
4. **(MED, UX) The firm banner is a dead-end** (`AccountSettings.tsx:982–990`) — explains WHY but not WHO can act. Add a "Contact your firm administrator to change the plan" line (surface firm billing_email/owner if resolvable) so the child admin has a next step.
5. **(MED, UX) Plan-header card is thin/stale for firm children** — `subscription_status`/`subscription_period_end` are populated by the firm webhook branch (not yet deployed), so until then the card shows a bare "Business" label with no renewal line and no controls. Confirm the firm sub mirrors period-end onto child workspaces; if intentionally not, add a "Plan set by {firm}" line so the card reads as intentional.
6. **(MED, UX) Sidebar switcher row crowding** (`AppSidebar.tsx:302–319`) — firm label (`text-[10px] max-w-[6rem] truncate`) + pending-resume label + check icon + name compete for the right edge on a ~240px dropdown; long names truncate harder. Consider showing the firm label only when multiple firms are present, or move to a second line/tooltip.
7. **(LOW) Fallback copy** "This workspace is part of your firm" reads awkwardly (doubled "firm"/possessive) — use a fallback-specific sentence ("This workspace is managed by your firm.") rather than interpolating "your firm" into the named template.
8. **(LOW) Selector inconsistency** — palette groups firm children under firm headings; sidebar uses a per-row label and no grouping; firm-bound children in "Recent" lose firm context. Acceptable given space constraints; optionally unify.

**Cleared as false positives in the same sweep (no action):** the blanket `where firm_id is not null` selector query is RLS-correct (`is_workspace_member` firm EXISTS with `restrict_firm_access=false`); the firm-name `in("id", firmIds)` resolution is row-filtered by `firms` RLS (`is_firm_member`) — no IDOR; the banner/label show only members-visible firm names through auto-escaped JSX — no info-disclosure or XSS. One LOW defense-in-depth note: the selector query trusts RLS entirely with no secondary client scoping (acceptable per LeaseIO's RLS-first model).

**Where to look:** `src/pages/settings/AccountSettings.tsx`, `src/pages/app/UsageContent.tsx`, `src/components/layout/AppSidebar.tsx`, `src/components/workspace/WorkspaceCommandPalette.tsx`; `supabase/functions/{create-checkout,customer-portal,manage-document-pack,stripe-webhook}/index.ts`. Related: #60 (firm billing model), #61 (create-checkout customer resolution).

---

### Item #104: delete-firm deferred to Phase 11 — firm_activity_log ON DELETE RESTRICT blocks a hard delete

**Severity:** N/A — deferred-feature note. **Surfaced 2026-06-15** during Phase 10 CP3. **Decision (Daniel, 2026-06-15): defer delete-firm to Phase 11.** It is a rare destructive operation not needed for "Business tier sellable" (a firm operates fine without ever being deleted), so FirmSettings (CP4b) omits the danger-zone delete or shows it as "coming soon."

**The schema constraint:** `firm_activity_log.firm_id` is `ON DELETE RESTRICT` (migration `20260615172439_phase9_firm_layer_foundation.sql` — Phase 9's deliberate "an audit log must never be silently erased" choice). Every firm has at least a `firm_created` audit row, so a hard `DELETE FROM firms` is **permanently blocked** while any audit history exists. Combined with `workspaces.firm_id` (NO ACTION, blocks delete while children are bound), a firm hard-delete is doubly blocked by design.

**The decision delete-firm needs (when Phase 11 builds it):** pick one —
- **Soft-delete (recommended):** add `firms.deleted_at`; delete-firm releases all children, captures the `deleted_firms` forensic row, sets `deleted_at`. Firm + audit preserved; hidden from all UI. Satisfies RESTRICT.
- **Hard-delete + audit archival:** copy `firm_activity_log` rows into `deleted_firms.details` (or an archive table), delete the audit rows, then hard-delete the firm. Truly removes the row but destroys the live audit FK — conflicts with the Phase 9 "never destroy the audit" intent.

The `deleted_firms` table + the `firm_deleted` activity_type already exist (Phase 9 / Phase 10 CP1) ready for whichever path is chosen.

**Where to look:** `supabase/migrations/20260615172439_phase9_firm_layer_foundation.sql` (the firm_activity_log FK + deleted_firms); a future `supabase/functions/delete-firm/index.ts`; `firms` RLS already has a "firm owner deletes firm" policy (the client DELETE attempt fails at the FK, as intended).

---

### Item #105: Self-serve firm onboarding (Stripe checkout) — pricing model DECIDED 2026-06-16; now a build task (no longer operator-blocked)

> **PRICING DECIDED 2026-06-16 (Daniel delegated; recorded in PRODUCT_STRATEGY.md §"Firm-level Stripe billing"): per-child quantity at the standard Business rate.** One Stripe subscription on the EXISTING Business price (`prod_TlQhRntCDhkxfK` / business monthly + `STRIPE_PRICE_BUSINESS_ANNUAL` — NOT a new firm Product) with `quantity` = bound child count + `metadata.firm_id`. N children = N × $499/mo; no base fee; no v1 volume discount (deferred GTM lever). Bind → quantity +1 (prorate); release → −1 (credit) + 30-day grace. summarized = one consolidated line; detailed = `invoice.created` webhook expands to N per-child lines via `firm_child_label`.
>
> **This resolves blocker (1) below and largely dissolves blocker (2):** reusing the Business price means NO firm-specific operator Stripe setup — the only operator dependency is the live-mode Business price (already owed for standalone Business, STOP 3/7). So this is now a **build task**, not an operator gate. **Build progress (each its own beat, all under the decided model):**
> 1. ✅ **#105-A (merged):** `create-firm-subscription` (firm sub on the Business price, quantity = child count, metadata.firm_id, 3DS); `applyFirmSubscription` webhook mirrors it + propagates `business`.
> 2. ✅ **#105-A (merged):** quantity sync — `bind`/`release`/`act-on-join-approve` call `syncFirmSubscriptionQuantity` (recompute from live child count). Closes the Phase 9 gap.
> 3. ✅ **#105-B:** `create-firm-workspace` edge fn + `create_firm_workspace_locked` RPC (firm child, no independent sub, + quantity sync). Applied/deployed to staging.
> 4. **`billing_summary_mode` — RESOLVED as IN-APP breakdown, NOT a Stripe-invoice handler.** Under the decided *quantity* model the firm sub emits ONE invoice line ("Business × N"); true per-child Stripe-invoice lines would require per-child *subscription items* (a different, more complex model — not chosen). So "detailed vs summarized" is the IN-APP FirmBilling view (it already shows per-child usage; the toggle controls that breakdown's emphasis, wired in #105-C). No `invoice.created` line-item manipulation is built — deliberately avoided (it would touch real invoice totals for marginal benefit). If a future GTM need demands per-child Stripe-invoice lines, switch the subscription to per-child items then.
> 5. **#105-C (remaining):** FirmOnboarding "one company or multiple?" fork + card-collection (SetupIntent) → `create-firm-subscription` 3DS flow + initial setup UI; FirmBilling wired to the real sub.
>
> Original deferral context (now mostly resolved) preserved below.

**Severity:** N/A — deferred-feature note (Phase 10 scope cut, surfaced 2026-06-16 during CP4b-ii). FirmOnboarding's self-serve flow up to firm creation is buildable, but the **Stripe-checkout step that creates the firm subscription** is blocked on two things, so it (and the pieces coupled to it) are deferred:

1. **The firm-subscription pricing model is unspecified.** PRODUCT_STRATEGY confirms "the firm pays a single subscription covering all child workspaces; children inherit the plan and have no independent subscription" — but NOT the price structure: per-child quantity (N × business rate, Stripe `quantity`), per-child line items, or a flat firm rate. The `billing_summary_mode` (detailed=per-child lines vs summarized=one line) strongly implies per-child items/quantity, but the exact mechanics (how a child added mid-cycle bills, proration) are a product/pricing decision not in the specs.
2. **No firm Stripe Product/Price exists** (operator setup, like Vault's STOP 10). There's no `STRIPE_PRICE_FIRM_*` and the firm Product isn't created in Stripe.

**Coupled pieces deferred with it:**
- **`create-workspace` firm_id extension** — creating a firm child should reconcile the firm subscription quantity/cost; without the pricing model that reconciliation is undefined. (Binding existing workspaces via `bind-workspace-to-firm` / join requests already works and does NOT touch the firm sub — a pre-existing Phase 9 gap that the pricing decision should also resolve.)
- **`billing_summary_mode` invoice line-item construction** (stripe-webhook `invoice.created`) — operates on the firm subscription's invoice; meaningless until the sub structure exists.

**What IS built + works without this:** firms are created via the service-role `create-firm` (admin/ops), then fully operated through the UI — invite/manage members, manage child workspaces + `restrict_firm_access`, the cross-workspace inbox, and the FirmBilling **visibility** page (subscription status, per-child usage, `billing_summary_mode` toggle). The `applyFirmSubscription` webhook branch is deployed + ready to mirror a firm sub onto `firms` + propagate `business` to children the moment a firm sub is created.

**When unblocking (the decision + setup needed):** (a) decide the firm pricing model (recommend per-child `quantity` on the existing business price — simplest, makes detailed/summarized natural); (b) operator creates the firm Stripe Product/Price + `STRIPE_PRICE_FIRM_*` env; (c) build FirmOnboarding's checkout (create-checkout firm branch or a new create-firm-subscription fn), the create-workspace firm_id reconciliation, and the invoice line-item handler. Mirrors the Vault operator-gate pattern.

**Where to look:** `src/pages/app/firm/FirmBilling.tsx` (the visibility page the checkout will extend); `supabase/functions/stripe-webhook/index.ts` (`applyFirmSubscription` + the deferred `invoice.created` handler); `docs/PRODUCT_STRATEGY.md` §"Firm-level Stripe billing"; `docs/ops/OPERATOR_PLAYBOOK.md` (add a firm-pricing STOP item).

---

### Item #106: Overlapping permissive `profiles` UPDATE policies — `current_firm_id`/`current_workspace_id` lack a WITH CHECK — Low (pre-existing)

**Severity:** Low. **Surfaced 2026-06-16** by the lease-security-scanner during the Phase 10 firm-frontend review. **Pre-existing** (baseline `20260516120000_baseline_schema.sql`), NOT introduced by Phase 10.

**Symptom:** `profiles` has two overlapping permissive UPDATE policies — `profiles_update_own` (`USING (id = auth.uid())`, **no WITH CHECK**) and `profiles_update_self` (with a WITH CHECK constraining `current_workspace_id` to a membership). Because Postgres OR's permissive policies and `profiles_update_own` has no WITH CHECK, the membership constraint is effectively bypassable, and `current_firm_id` (written by `FirmContext.tsx`) has no membership WITH CHECK at all.

**Why it's Low:** it's the user's OWN row, and `current_firm_id`/`current_workspace_id` are selection POINTERS only — a forged value grants no access (every downstream read is still RLS-gated, and FirmContext re-resolves the active firm via `resolveActiveFirm` against real memberships, so a stale/forged pointer is ignored). No privilege escalation.

**Fix (its own beat):** consolidate to a single `profiles` UPDATE policy with a complete WITH CHECK (id = auth.uid() AND the pointer columns reference real memberships, or simply id = auth.uid() with the membership checks dropped since pointers are harmless). Sweep both `current_workspace_id` and `current_firm_id`.

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql` (`profiles_update_own` / `profiles_update_self`); `src/contexts/FirmContext.tsx` (current_firm_id writes).

---

### Item #107: Firm billing reconciliation + offboarding-cancel (hard rule #9)

> **BUILT 2026-06-16 (mostly resolved) — remaining is OPERATOR setup.** `_shared/firm_billing.ts` `syncFirmSubscriptionQuantity` is now SELF-AUDITING (writes `firm_billing_quantity_changed` on a quantity change with old→new; writes the same with `details.sync_failed=true` on a Stripe failure so it's queryable) and does OFFBOARDING-CANCEL (0 children → `cancel_at_period_end`; re-binding a child UN-cancels — money-bug fixed in the integrity review). New `firm-billing-reconcile` cron (x-cron-secret, deployed) sweeps every subscribed firm and corrects drift. The `firm_activity_log` CHECK gained `firm_billing_quantity_changed` (migration `20260616140000`, applied). #102 raw-error leaks in bind/release fixed; a per-owner create-firm cap (10) added. Security+integrity reviewed (no unaddressed Critical/High). **OPERATOR remaining (STOP-style, before customer #1):** set `FIRM_BILLING_CRON_SECRET` (32+ char) + schedule `firm-billing-reconcile` (e.g. hourly) — until then the cron fail-closes (401) and the in-line self-healing sync + audits are the coverage. **Scale follow-up:** reconcile pagination (see note below). Original gap description preserved below.

**Severity:** Medium — **before-customer-#1 gate**, NOT deploy-blocking (no firm subscription exists anywhere yet; zero money moves until self-serve onboarding ships AND a real firm subscribes). **Surfaced 2026-06-16** by the security+integrity review of the #105 firm-billing core. The per-child quantity sync (`_shared/firm_billing.ts` `syncFirmSubscriptionQuantity`, called best-effort from bind/release/act-on) is correct and idempotent (recompute-from-live-child-count), but two revenue-integrity gaps remain that conflict with **CLAUDE.md hard rule #9 ("no silent vendor failures")**:

1. **Silent sync failure is unobserved.** Every `syncFirmBilling` caller swallows Stripe errors with only `console.error`. "Self-heals on next op" holds ONLY if there's a next bind/release for that firm — a firm that binds its last child (or releases one) and then stops is mis-billed indefinitely with no alarm. Per hard rule #9 this Stripe write is currently in the prohibited fourth "we'll notice if it breaks" state.
2. **Last-child release over-bills.** When a release drops the child count to 0, `syncFirmSubscriptionQuantity` no-ops at `qty < 1` (correctly avoiding a Stripe `quantity: 0` rejection) — but nothing cancels the now-childless subscription, so the firm keeps paying 1 × $499/mo. The code comment says "offboarding cancels the sub instead," but that offboarding-cancel flow is **not built**.

**Fix (before customer #1):**
- A **reconcile cron** (scheduled edge fn, like `vendor-health-check`) that, for every firm with a `stripe_subscription_id`, recomputes quantity = live child count and corrects drift (+ alerts on mismatch). Register it in the `vendor-health-check` / monitoring framework so the Stripe-quantity dependency is in the "monitored" state hard rule #9 requires.
- **Offboarding-cancel:** when a release drives the child count to 0, hand off to a cancel flow (`stripe.subscriptions.update(cancel_at_period_end: true)` or the 30-day grace offboarding path) rather than leaving a live 1×$499 sub.
- **Quantity-change audit:** have `syncFirmSubscriptionQuantity` return old→new and the caller write a `firm_activity_log` row (the dollar amount changing should be attributable — integrity-lane). Needs a new `firm_activity_log` activity_type value (e.g. `firm_billing_quantity_changed`) added to the CHECK.
- **#102 continuation:** `bind-workspace-to-firm` / `release-workspace-from-firm` still return raw DB error messages (`updErr.message`) — now in the money path; convert to structured `reason` codes like `create-firm-subscription` does.

- **(#107 build, 2026-06-16) reconcile-cron pagination (scale follow-up):** `firm-billing-reconcile` sweeps `firms WHERE stripe_subscription_id IS NOT NULL` with no `.limit()` — PostgREST caps at ~1000 rows and silently truncates beyond that. Fine at current scale (few firms); add keyset pagination + a `length < 1000` warn before firm counts approach four digits.
- **(#105-C LOWs, 2026-06-16):** add a per-user rate limit / cap on self-serve `create-firm` (spam-create / row-pollution defense-in-depth — an empty firm is inert but unbounded creation pollutes); and align `create-firm-checkout`'s customer resolution to fully dedup (it now stamps + scans, closing the double-sub HIGH, but a net-new owner with a pre-existing Stripe customer may still get a duplicate customer record — minor).

**Where to look:** `supabase/functions/_shared/firm_billing.ts`; `supabase/functions/{bind-workspace-to-firm,release-workspace-from-firm,act-on-firm-workspace-join-request,create-firm-subscription}/index.ts`; the monitoring framework in `docs/OPERATIONAL_MONITORING_SPEC.md`; `docs/ops/OPERATOR_PLAYBOOK.md` (add a firm-billing-reconcile STOP item).

---

**Status reconciliation (six-sweep project audit, 2026-06-17):** items #108–#119 filed below from a project-wide defect + UX audit (Approval / Workspace-isolation / Extraction / Billing / Data-fidelity / Reports). Full evidence + remediation + the items cleared/refuted lives in **`docs/AUDIT_FINDINGS_2026-06-17.md`**; each item below carries a first-hand verification status. NOT re-filed (already tracked): **W3** = #102 (`add-firm-member` raw error); **C1** relates to #84 (resolve-approval-chain deployed snapshot). Recorded but NOT bugs: **B1** (firm billing counts `restrict_firm_access=true` children — a "bill per bound Business child" *product decision* to confirm, not over-billing); **E4** (re-extraction clobbering approval — **REFUTED**: executed upload writes a separate `executed_extracted_json` + is `model_locked`-gated). Security-critical surfaces (tenant isolation, billing integrity, audit-log immutability, the not-a-compliance-tool line) were verified SOUND.

---

### Item #108: Internal stage/role jargon leaks into user-facing UI (the "concept approver" bug) — High

> **RESOLVED in code 2026-06-18 (branch `claude/approval-jargon-fix`), reviewed clean — pending merge.** Added shared `stageLabel()`/`roleLabel()` to `lifecycleStates.ts` (+ Deno mirror) and routed all 11 documented sites + 3 more found in review (`RerouteAuditDashboard`, the Escalate-to-Concept dialog/button, `LeaseReview` parent-match list) + the `ChainDiagram` role label. Terms: concept→"Initial approval", signator→"Final approval"; manager_approver→"Manager", financial_approver→"Finance", signator→"Signatory"; "Signator Review" page→"Final Review", PDF "Signator Attestation"→"Final Approval Attestation". Typecheck clean; `lifecycleStates`/`chainDiagram` tests green. Delete this item on merge.

**Severity:** High (user-facing comprehensibility; one site reaches external auditors). **Surfaced 2026-06-17** (audit Class 1). **Root cause:** the team de-jargoned lifecycle *statuses* (`lifecycleStates.ts:114-137` `displayLabel()`, comment "no jargon") but never built the equivalent `stageLabel()`/`roleLabel()` for chain-step **stages** (`concept`/`signator`) and raw `*_approver` roles. A role-label map exists but is walled inside the policy editor (`ChainDiagram.tsx:61-65`) and still ships "Signator".

**Symptom:** 11 render sites print internal vocabulary to users. The worst: `ApprovalQueue.tsx:288-291` ("Concept approver: role manager_approver" — the reported bug); `RerouteNotificationModal.tsx:151,153` (raw `concept_submitted → in_negotiation` enum in a modal, bypassing `displayLabel()`); `SignatorReview.tsx:357` (page title "Signator Review"); **`leaseDisclosureSections.tsx:451` ("Signator Attestation" printed into the exported disclosure PDF that can reach auditors/board)**. Full list (11) in the audit doc.

**Fix:** add shared `stageLabel()`/`roleLabel()` to `lifecycleStates.ts` with decided finance-English terms (concept→"Initial approval", signator→"Final/signature approval"; manager_approver→"Manager", etc.); route all 11 sites through `displayLabel()`/`stageLabel()`/`roleLabel()`; delete the inline ternary at `ApprovalQueue.tsx:288` and the `.replace('_',' ')`/`.slice(0,2)` hacks; keep `en`/`es` in lockstep. Add a static test asserting no raw stage/role/status string renders outside the helpers.

**Where to look:** `docs/AUDIT_FINDINGS_2026-06-17.md` (Class 1 leak register); `src/lib/lifecycleStates.ts`; the 11 cited files.

---

### Item #109: "Nudge approver" is a no-op — and the whole approval-notification system was write-only — High

> **BUILT 2026-06-18 (branch `claude/approval-jargon-fix`) — pending apply + deploy + cron schedule.** Investigation found the gap is bigger than the nudge: **every** approval event (submit/approve/reject/escalate/reroute) writes `lease_activity_log` 'comment' rows with `details.recipient_ids`, but NOTHING ever delivered them (the one dispatcher, `send-lease-notifications`, reads a different table and emails the lease *owner* about *dates*). Per Daniel's decision (2026-06-18) we fixed the **whole gap**, not just the nudge:
> - **Migration `20260618120000_notification_deliveries.sql`** — idempotency/delivery log (UNIQUE(activity_log_id, recipient_user_id, channel); service-role-only RLS).
> - **`_shared/notify_dispatch.ts`** (`dispatchNotificationRow`) — resolves each recipient's email, gates on `checkWorkspaceLive`, sends via Resend, upserts delivery status ('sent'/'failed'+error — hard rule #9), idempotent (never re-sends a 'sent' row).
> - **`dispatch-notifications`** (cron, `x-cron-secret` = `NOTIFICATION_DISPATCH_CRON_SECRET`) — sweeps recent comment/recipient_ids rows and delivers them (short 2h lookback so a first run can't blast historical backlog). This delivers **every** approval notification going forward.
> - **`send-nudge`** (Bearer JWT) — resolves the lease's pending approver(s) (chain `effective_assignee_user_id`/`approver_user_id`/role→`workspace_roles`; legacy manager/financial fallback), writes the notification + `lease_nudges` + `last_nudged_at`, **dispatches immediately**, returns who was emailed. Server-side 30-min cooldown + `enforceWorkspaceRateLimit`.
> - **`NudgeApproverButton`** rewired to call `send-nudge` (real cooldown; toast names the approver). **`_shared/resend.ts`** gained a generic `sendEmail`. Registered in `config.toml`; secret added to `.env.example`.
>
> **REMAINING (operator / deploy, before this is live):** (1) apply the migration (security-review the new RLS table first per CLAUDE.md); (2) deploy `send-nudge` + `dispatch-notifications` (+ the updated `_shared`); (3) set `NOTIFICATION_DISPATCH_CRON_SECRET` (32+ char) + schedule `dispatch-notifications` every ~10 min; `RESEND_API_KEY`/`RESEND_FROM_EMAIL` already exist. **Still UNBUILT (deliberately out of scope):** an in-app notification center (a UI surfacing `notification_deliveries`/recipient_ids) — the data model is laid for it. Original description preserved below.

**Severity:** High (a core approval action that silently does nothing; the requester gets false confidence). **Surfaced 2026-06-17** (audit Class 2).

**Symptom:** `NudgeApproverButton.tsx:64-71` toasts "Nudge sent to approver" and `useLifecycleWorkflow.ts:372-387` inserts a `lease_nudges` row (with `type`/`channel` fields) + sets `leases.last_nudged_at` — but **nothing anywhere reads `lease_nudges`**: no email, no in-app notification, no cron consumer. The table is write-only; the approver receives nothing.

**Fix:** wire `lease_nudges` to a real notification (email + in-app) with a per-approver cooldown and a "delivered" confirmation back to the requester. Integration test: a nudge produces a delivered notification row a consumer reads.

**Where to look:** `src/components/workflow/NudgeApproverButton.tsx`; `src/hooks/useLifecycleWorkflow.ts`; the `lease_nudges` table; the notification path.

---

### Item #110: Dead/misleading controls — dashboard drill-down stubs + `mailto:`-as-a-feature — Med

> **RESOLVED + REASSESSED 2026-06-18 (branch `claude/approval-jargon-fix`) — pending merge. The original finding was partly overstated; verified on inspection:**
> - **(a) Dashboard tiles — dead code REMOVED, no UX defect.** Contrary to the original note, the tiles had **no** misleading clickable affordance — no `cursor-pointer`, `hover:shadow`, or bar `onClick` (the only `onClick` is the working 30/60/90-day toggle). The single real issue was genuinely-dead code: `const navigate = useNavigate(); void navigate; // future`. Removed from `IntakeTrend` + `PipelineByDepartment`. (Wiring real department/period drill-downs is a possible future enhancement, not a defect.)
> - **(b) `mailto:` flows are NOT defects.** They're honest, legally-standard contact mechanisms: the privacy one is a proper GDPR/CCPA Subject Access Request card (the 5 rights listed + a documented 30-day response commitment + a SAR comment), and the data-export / "Contact Support" ones are Contact-style email buttons — the legitimate mechanism most SMB SaaS use. A *tracked in-app request queue* (so a request can't be lost if the inbox lapses — hard rule #9) remains an **optional enhancement**, not a bug; left un-filed as a defect.
>
> Typecheck green. Delete on merge.

**Severity:** Medium (one carries GDPR/CCPA SLA exposure). **Surfaced 2026-06-17** (audit Class 2 #2-6).

**Symptom:** (a) `IntakeTrend.tsx:36-37` and `PipelineByDepartment.tsx:80-81` render clickable-looking tiles whose handler is `void navigate; // future` — clicks go nowhere. (b) Three `mailto:`-as-a-feature flows: **`AccountSettings.tsx:1389-1393` "Submit a Privacy Rights Request" promises a 30-day GDPR/CCPA response but is just a `mailto:` with no tracking/SLA** (legal exposure); `AccountSettings.tsx:1362-1366` "Request Data Export" (mailto); `CancellationBanner.tsx:154-157` "Contact Support → restore workspace" (mailto).

**Fix:** wire the dead tiles to their drill-downs or make them non-interactive. Convert the `mailto:` flows to tracked in-app requests (or at minimum a monitored queue per hard rule #9); prioritize the privacy-rights one.

**Where to look:** the cited files; `docs/AUDIT_FINDINGS_2026-06-17.md` (Class 2).

---

### Item #111: Approval-chain Phase-7 edges (C1–C6) — High

> **PARTIALLY RESOLVED 2026-06-18 (branch `claude/approval-chain-phase7-edges`, pending merge — update this stub on merge).** C1/C2/C3/C5 shipped; **C4 + C6 are deliberate follow-on chunks** (see below). Originated as audit Class 3 in `docs/AUDIT_FINDINGS_2026-06-17.md`. **Cross-branch note:** also stubbed as #111 on PR #57's branch (`claude/approval-jargon-fix`, #108–#122) — whichever merges second conflicts on this entry; keep the most-resolved version. Daniel's directive: do all six, phased, verify-and-pivot; **C3 delegation = EXCLUSIVE.**

**Severity:** High (C1 silently disabled auto-escalation/stuck-detection; C5 could leave zero approvers).

**Resolved in this branch (applies/redeploys at deploy time post-merge — every edge fix needs its function redeployed):**
- **C1 ✅ — `supabase/migrations/20260618150000_backfill_phase7_chain_columns.sql`.** The repo `resolve-approval-chain` already sets the Phase-7 columns at creation; the **deployed** copy is the stale #84 one, so existing chains had NULL `effective_assignee_user_id`/`assignee_resolution_source`/`pending_since` and the crons (`process-delegate-timers`, `detect-stuck-chains`) skipped them. Shipped a **frontier-aware backfill** — **PIVOTED from the A4 note's one-liner**, which would (a) error (`lease_approval_chain` has no `status_changed_at` — only `leases` does) and (b) over-set `pending_since` on not-yet-active steps → false stuck alerts / early delegate activation. The backfill sets `pending_since` only on the frontier active required step per lease (mirrors creation). **Still needs the `resolve-approval-chain` REDEPLOY** to fix NEW chains (the #84 deferred redeploy — operator/CLI). One-time post-backfill burst of genuinely-aged stuck/delegate fires is expected + documented.
- **C2 ✅ (pivot: no code).** Verified the "first step in each stage" already gets `pending_since`: first concept step from `resolve` at creation (lands w/ the C1 redeploy), subsequent concept steps from `act-on-chain-step` on advance, first signator step from `advance-to-final-review` v2 (deployed); the signator stage completes on first approve (no subsequent signator steps). Pinned against regression.
- **C3 ✅ — EXCLUSIVE delegation.** `act-on-chain-step` now authorizes `effective_assignee_user_id` exclusively (the precedence-resolved actor: voluntary > OOO > policy-delegate > original); falls back to `approver_user_id` only when effective is NULL (role-based / un-backfilled). `ApprovalQueue` filter mirrors it so a delegated step leaves the delegator's queue. `approver_user_id` is KEPT (history); the audit tags actor + delegate. **Follow-through (review-surfaced, fixed before ship):** a new **"Delegated by me"** section in the ApprovalQueue "mine" tab with a **Revoke** button wiring the previously-caller-less `revoke-voluntary-delegation` fn (so exclusivity is recoverable); honest delegation toast/modal copy.
- **C5 ✅ — `supabase/migrations/20260618160000_reroute_reconcile_chain_steps_rpc.sql` + `resolve-approval-chain`.** Reroute did non-atomic supersede(UPDATE)+add(INSERT), each swallowing errors → a failed insert left zero active approvers while reporting success. New SECURITY DEFINER RPC `reroute_reconcile_chain_steps(uuid[], jsonb)` does both in one transaction (service_role-only); the edge fn now ABORTS (500 + `chain_resolution_failed`) on error.

**Tests:** `phase7ChainBackfill111` (C1 SQL), `rerouteReconcile111C5` (C5 RPC + edge), `exclusiveDelegation111C3` (C3 authz + queue), `frontierActiveStep111` (behavioral frontier predicate via the extracted `isFrontierActiveRequiredStep` helper). Reviewed BEFORE push by security/integrity/code-auditor/test+polish — correctness clean (no Critical/High in security/integrity/auditor); the polish Critical/High were the C3 recovery gaps, fixed above.

**Follow-on chunks:**
- **C4 ✅ RESOLVED 2026-06-18 (branch `claude/escalate-concept-reresolve-c4`, STACKED on #59 — merges after #111; redeploy both edge fns post-merge).** PIVOT FINDING (verified): the audit's "reuse the reroute path" is **invalidated** — `resolve-approval-chain` reroute mode is change-gated (returns `no_reroute_needed` when structured attributes are unchanged), so reusing it would make escalate a **no-op in exactly the C4 caveat case**. The real bug: `escalate-to-concept-approver` cloned concept rows of **any status** (no filter) → resurrected **superseded prior-policy approvers**, and never re-matched the policy. **Fix:** a new **`forceConceptReactivation` mode** in `resolve-approval-chain` (re-matches the live policy via the shared `matchPolicy` — no duplicated routing logic — loads concept steps, runs SoD, supersedes any lingering pending concept rows + inserts fresh ones ATOMICALLY via the C5 RPC, returns the assignees, does NOT touch the lifecycle). `escalate-to-concept-approver` invokes it BEFORE flipping to `concept_under_review`, so a failed/ambiguous/no-match/SoD/RPC failure leaves the lease safely in `in_negotiation` (never stranded with zero approvers); aborts on resolver rejection. Reviewed BEFORE push — security/integrity/code-auditor all clean (no Critical/High/Medium). Test: `escalateReresolve111C4.test.ts`. **Adjacent LOWs (file separately, not bundled):** `VALID_TRANSITIONS.in_negotiation` omits `concept_under_review` (advisory map drift — escalate has always done this raw transition; not enforced); escalate authorizes a submitter who may not be a `workspace_members` row while resolve requires owner/member (theoretical — resolve 403s safely with no stranding); CI runs no `deno check`, so Deno type errors in edge functions escape the static-test suite (consider wiring `deno check` into CI).
- **C6 ✅ RESOLVED 2026-06-18 (C6a+C6b; branch `claude/approval-policy-sla-c6`, STACKED on #60 — merges after #60→#59; redeploy nothing, frontend + a migration).** Per-policy SLA. **Shipped:** migration `20260618170000` adds nullable `approval_policies.sla_days` (CHECK > 0; NULL → default 7 in logic, `src/lib/slaStatus.ts`); `ChainStepBadges` drives its red "over SLA" badge off the policy SLA instead of a hardcoded 7, and `ApprovalQueue` fetches each step's policy `sla_days` so the **BLOCKING APPROVER** now sees SLA-aware aging in their own queue (the audit's core C6 complaint — previously only the admin ExceptionsDashboard saw it); `ApprovalPolicyEditPage` gains an admin "Approval SLA (days)" field (blank = default 7). Reviewed BEFORE push — security/integrity/code-auditor clean; behavioral test `slaStatus.test.ts` + static `policySla111C6.test.ts`.
  - **C6c (the over-SLA "Notify admin" action) DROPPED from this PR → follow-on.** Review found it was **cosmetic**: the `sla_breach_escalation` `comment` row it wrote is read by NO surface (`Notifications.tsx` reads the `notifications`/`lease_notifications` tables; `RecentActivity`/`ExceptionsDashboard` ignore `comment`; nothing reads `recipient_ids`) — the button toasted "admin notified" while delivering nothing. Root cause is a **pre-existing class bug: all ~15 `recipient_ids` notification writers are write-only (no fanout/reader exists in-repo).** An approver-initiated SLA escalation needs a real delivery path (write to the `notifications` table that `/app/notifications` actually reads) + a "blocked/reassign" framing + server-side de-dupe. **Filed as a follow-on** (with the write-only-`recipient_ids` rail gap as the blocking prerequisite). Also note it would partly duplicate the `detect-stuck-chains` cron's `stuck_chain_detected` alert.
  - **LOWs (optional, not blocking):** the amber warning band is hardcoded at 3 days (a short per-policy SLA jumps straight to red with no amber) — consider deriving it from `sla_days`; `sla_days` isn't in the generated `supabase/types.ts` (the editor/queue already cast `approval_policies` via `as any`; regenerate types at some point); `sla_days` deliberately not in the `increment_policy_version` watch list (harmless).

**Adjacent items surfaced during review (file with #-numbers at merge to avoid colliding with PR #57's #108–#122; not bundled):**
- *Deactivated effective-assignee → queue-invisible (MEDIUM, integrity):* with C3's exclusivity, if a delegate (effective assignee) is later deactivated and no active policy-delegate exists, `handle-deactivated-approver` leaves the step orphaned and queue-invisible to everyone — recoverable only via the admin ExceptionsDashboard (`admin-override-step` reassign). Attribution intact; a narrowing of the recovery surface, not data loss.
- *`handle-deactivated-approver` is never auto-invoked (pre-existing):* member removal is a raw client delete (`MembersPanel.tsx`) with no chain-orphan cleanup, so an orphaned delegated step only repairs if an admin manually runs the handler. C3 sharpens the consequence but didn't create it.
- *Delegation modal hardcoded English (LOW, pre-existing):* `VoluntaryDelegationModal` + the "Delegate…" button have no i18n.
- *C5 atomicity is smoke-tier-only (LOW):* the static test proves the supersede+insert live in one body + the edge aborts, but not that the rollback fires; a `scripts/smoke-*` firing the RPC with a malformed payload would prove it.

**Where to look:** the four migrations/edge files above; `src/pages/app/ApprovalQueue.tsx`; `src/lib/approvalChainLogic.ts` (`isFrontierActiveRequiredStep`); `docs/PHASE_7_BUILD_SPEC.md` (A4); `docs/AUDIT_FINDINGS_2026-06-17.md` (Class 3 + C4 caveat).

---

### Item #112: `delete-workspace` is firm-unaware → child-counter drift + billing over-charge (W1 + B2) — High

> **RESOLVED in code 2026-06-18 (branch `claude/approval-jargon-fix`), reviewed clean — pending merge + apply.** Migration `20260618130000_firm_counter_delete_decrement.sql` adds a DELETE branch to `maintain_firm_child_workspace_counter` (trigger now `BEFORE INSERT OR DELETE OR UPDATE OF firm_id`; `RETURN OLD`) and one-time-reconciles any drifted counter (bracketed by disable/enable of `enforce_firm_entitlement_guard`, since a migration isn't `service_role`). `delete-workspace` now resyncs the firm Stripe quantity after a firm-bound delete (best-effort; the #107 cron backstops). 5 static tests; firm-billing 105/107 green. Security/integrity/auditor reviewed (no Critical/High). **The sibling `delete-account` path has the same billing-resync gap → filed as #120.** Delete this item on merge + apply (security migration — the review gate is satisfied by the #112 review).

**Severity:** High (integrity/availability + revenue). **Surfaced 2026-06-17** (audit W1 + B2 — same root cause).

**Symptom:** `delete-workspace` deletes a workspace row with **no firm handling**. (a) `maintain_firm_child_workspace_counter` (`20260615172439_…:133-189`) has no DELETE branch and its trigger (`:191-194`) is `BEFORE INSERT OR UPDATE OF firm_id` — DELETE excluded — so `firms.child_workspaces_used` drifts upward permanently and the firm falsely hits `child_workspace_limit` (can't bind new children). (b) No firm billing resync fires, so the firm is over-billed for the deleted child until the #107 reconcile cron runs.

**Fix:** make `delete-workspace` release `firm_id` (→ NULL, which fires the counter decrement) **and** call `syncFirmSubscriptionQuantity` before/after the delete; OR add a DELETE branch to the counter trigger + a billing resync hook. New migration; reconcile already-drifted counters in the same migration. One fix covers both W1 and B2.

**Where to look:** `supabase/functions/delete-workspace/index.ts`; `supabase/migrations/20260615172439_phase9_firm_layer_foundation.sql` (counter trigger); `supabase/functions/_shared/firm_billing.ts`. Related: #107 (reconcile cron is the billing safety net), #83 (the workspaces hard-delete analog).

---

### Item #113: Firm plan-lock trigger is UPDATE-only — a firm-bound INSERT keeps a non-business plan — Med (latent)

**Severity:** Medium, **latent** (only the UPDATE bind path exists today; bites when self-serve firm-workspace creation ships). **Surfaced 2026-06-17** (audit W2).

**Symptom:** `workspaces_plan_firm_lock` (`20260615172439_…:219-222`) is `BEFORE UPDATE` only, so the force-to-`business` logic can't fire on an INSERT that already carries `firm_id`. The sibling counter trigger DOES handle INSERT — the two are asymmetric. A firm-bound workspace created via INSERT (the `create_firm_workspace_locked` RPC path / #105) would keep a non-business plan.

**Fix:** extend the trigger to `BEFORE INSERT OR UPDATE` and force `plan='business'` when `NEW.firm_id IS NOT NULL` on INSERT. Ship alongside the #105 create-workspace-with-firm path so children are plan-locked from creation.

**Where to look:** `supabase/migrations/20260615172439_phase9_firm_layer_foundation.sql` (`prevent_independent_plan_change_for_firm_workspace` + its trigger); #105.

---

### Item #114: `NeedsReviewBanner` low-confidence warnings are DEAD — `leases.confidence_scores` is never written — High

> **RESOLVED in code 2026-06-18 (branch `claude/approval-jargon-fix`) — pending merge.** Frontend fix (no deploy gate): `LeaseReview`'s `confidenceScores` memo no longer reads the always-empty `leases.confidence_scores` column — it now builds the 0–100 per-field map from `extracted_json` via `getFieldConfidence` (the same populated source the inline field borders use; 0-1 → 0-100). This revives the NeedsReviewBanner low-confidence list (the one genuine consumer). The four section-card pass-sites turned out to be **vestigial** — `SectionCard` destructures `confidenceScores` but never uses it (it reads `extracted_json` directly via `getFieldConfidence`), so they're unchanged; that dead prop is filed as #122. The unused `confidence_scores` column could later be dropped or populated by process_lease. Reviewed clean; typecheck green. Delete on merge.

**Severity:** High (a core review-trust signal is silently off). **Surfaced 2026-06-17** (audit E1, verified — grep shows 0 writes).

**Symptom:** `process_lease` never writes the `leases.confidence_scores` JSONB column (it persists per-field confidence to the normalized `lease_field_confidence` table instead). `LeaseReview.tsx:330-332` builds a `confidenceScores` memo from that always-empty column and feeds it to `NeedsReviewBanner.tsx:45-50`, where `confidenceScores[field.key]` is therefore always `undefined` → the "X has low confidence (Y%)" list never renders. (The inline amber/red field borders still work — they read `extracted_json` via `getFieldConfidence` — so it's a precise dead-summary, not "confidence is broken.")

**Fix:** feed `NeedsReviewBanner` from `extracted_json` via `getFieldConfidence` (consistent with the inline borders), OR write `confidence_scores` in the extraction UPDATE. (Note the historical NUMERIC(3,2) overflow scar at `process_lease:245` when re-introducing a confidence write.)

**Where to look:** `src/components/leases/NeedsReviewBanner.tsx`; `src/pages/app/LeaseReview.tsx:330-341`; `supabase/functions/process_lease/index.ts`.

---

### Item #115: Extraction fidelity residuals — per-entry confidence dropped, amendment field-coverage incomplete — Med

**Severity:** Medium / Low. **Surfaced 2026-06-17** (audit E2/E6/E7).

**Symptom:** (E2) `rent_schedule`/`risks` arrays carry per-item `confidence` in the Opus JSON, but the INSERT payloads (`process_lease:~2740,~2758`) omit it → uncertain rows/risks can't be flagged downstream. (E6) Amendment comparison diffs only a hardcoded ~12-field list (`COMPARABLE_FIELDS`, `process_lease:~2549`); clause fields (permitted_use, guarantees, the `rent_schedule` array) aren't compared → a material amendment change can go unsurfaced (matches CLAUDE.md's "verify completeness" flag). (E7, Low) No AI-origin-vs-human marker on the `leases` row; attribution lives only in `field_corrections` + `lease_field_confidence`.

**Fix:** add `confidence` columns to `rent_schedules`/`risks` and persist; drive `COMPARABLE_FIELDS` from the full extracted field set (+ flag uncompared fields); optionally a self-describing origin marker on the lease row.

**Where to look:** `supabase/functions/process_lease/index.ts` (the rent_schedule/risks inserts + `COMPARABLE_FIELDS`); `docs/AUDIT_FINDINGS_2026-06-17.md` (Sweep 3).

---

### Item #116: Lease hard-delete destroys the audit trail — no `BEFORE DELETE` guard on `leases` — Med

> **RESOLVED — merged via PR #58 (`claude/lease-delete-audit-guard`).** Closed by a `BEFORE DELETE` trigger `prevent_committed_lease_hard_delete` on `public.leases` (migration `20260618140000`) + an ImportHistory Archive-steer (deep-links to the lease's archive dialog). Disposable (client-hard-deletable) allowlist = `model_locked IS NOT TRUE AND (lifecycle_status IS NULL OR lifecycle_status = 'draft')`; `service_role` bypasses (delete-workspace/-account + FK cascade). Extracted `isCommittedLease()` (`src/lib/leaseDisposability.ts`) as the client mirror + behavioral test. 5-way reviewed clean before push (security/integrity/auditor/polish/test). Full detail in PR #58. The original audit description is preserved below.

**Severity:** Medium (forensic integrity). **Surfaced 2026-06-17** (audit DF1; analog of #83 for leases).

**Symptom:** the `leases` DELETE RLS `leases_delete_own_or_workspace_admin` (`20260516120000_baseline_schema.sql:4206`) lets the lease's creator OR a workspace admin hard-delete **any** lease via PostgREST — including a `model_locked`/active one, because the governance triggers (`prevent_locked_lease_edits`, `prevent_unauthorized_lease_workflow_edits`) are **`BEFORE UPDATE` only and don't cover DELETE**. The `lease_activity_log`/`lease_governance_audit` FKs are `ON DELETE CASCADE`, so the delete **cascades away the entire audit trail** with no archive-first requirement and no forensic record. (Intended for ImportHistory rollback, but the RLS isn't gated to Failed/unapproved leases.)

**Fix:** add a `BEFORE DELETE` guard on `leases` that blocks deleting `model_locked`/non-`Failed` leases (require archive-first) and/or writes a `workspace_activity_log` forensic row on hard-delete; tighten the DELETE RLS to Failed/unapproved. Verify: a client hard-delete of a locked lease is blocked + a forensic row is written.

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql` (the leases DELETE policy + audit FKs + governance triggers); `src/pages/app/ImportHistory.tsx`; #83.

---

### Item #117: Lease-review integrity residuals — executed-variance ungated, concurrent-edit overwrite, model_lock gate — Med

**Severity:** Medium / Low. **Surfaced 2026-06-17** (audit DF2/DF3/DF5/DF4/DF6; DF2 = E5).

**Symptom:** (DF2/E5, Med) an executed-document upload flips lifecycle to `executed` and records variance but has **no server-side materiality gate / re-approval** — materially-different signed terms can replace approved terms without acknowledgment (`process_lease:2069-2148`, flip at `:2106`; related #94; hard rule #2 leans toward a gate). (DF3, Med) the review save (`LeaseReview.tsx:1596-1599`) has **no optimistic-concurrency check** → two simultaneous editors silently last-writer-wins. (DF5/E3, Low) server `model_lock` (`legacy-lease-action:247-252`) lacks a `confirmed_sections` check (client-gated only; asymmetric vs the chain path). (DF4, Low) unchecking a confirmed tab strips `_approval` from `extracted_json` with no activity row (`LeaseReview.tsx:1314-1335`). (DF6, Low) rent-schedule re-generate appends instead of replacing (`LeaseReview.tsx:1478`).

**Fix:** DF2 — server-side materiality gate → re-route to approval on material executed variance. DF3 — `updated_at`/version guard → 409 on conflict. DF5 — enforce `confirmed_sections` server-side if locking must require review. DF4 — log the approval-revert. DF6 — DELETE before INSERT.

**Where to look:** `supabase/functions/process_lease/index.ts`; `src/pages/app/LeaseReview.tsx`; `supabase/functions/legacy-lease-action/index.ts`; #94.

---

### Item #118: `RentRollExport` is a diverged export — CSV formula injection + wrong status/archived filter — High

> **RESOLVED in code 2026-06-18 (branch `claude/approval-jargon-fix`) — pending merge.** R1: extracted a shared, tested `src/lib/csv.ts` `escapeCsvCell()` that neutralizes formula-injection prefixes (`=`/`+`/`-`/`@`/tab/CR → leading `'`) on top of RFC-4180 quoting, and routed RentRollExport through it (use it for any future CSV export). R2: the query now filters `lifecycle_status` (on-the-books states: executed/fully_executed/pending_counter_signature/active) + `archived=false` instead of the legacy `status` column. R4: "Total Annual Obligation" → "Total Annual Rent (run-rate)". Frontend-only (no deploy gate); 6 csv tests + typecheck green. **Product decision (Daniel, 2026-06-18): executed + active only** — pre-signature pipeline (approved/in_negotiation/final_review) excluded so the run-rate totals reflect committed rent. Delete on merge.

**Severity:** High (injection + completeness). **Surfaced 2026-06-17** (audit R1/R2/R4, verified).

**Symptom:** (R1) `escapeCSV` (`RentRollExport.tsx:135-141`) quotes only `,`/`"`/`\n` and does **not** neutralize formula prefixes (`=`/`+`/`-`/`@`) → user+AI-sourced tenant/landlord/address fields execute as formulas in Excel/Sheets. (R2) the query filters the legacy `status` column (`:82` `.in('status', ['Ready','final','review'])`) instead of `lifecycle_status`, and omits an `archived=false` filter → it includes draft/archived leases and misses some active ones (`Reports.tsx` uses `lifecycle_status` — this surface diverged). (R4, Low) "Total Annual Obligation" = `monthly × 12` (`:93,123`) ignores escalations — misleading label.

**Fix:** prefix-escape `=/+/-/@` in `escapeCSV` (and reuse for any other CSV export); switch the query to `lifecycle_status` + `archived=false` (align with `Reports.tsx`); relabel the annualization. Verify: a tenant name of `=HYPERLINK(...)` exports neutralized.

**Where to look:** `src/components/reports/RentRollExport.tsx`; `src/pages/Reports.tsx` (the correct filter pattern).

---

### Item #119: Index/CPI lease PV may be understated in the single-lease path; summary-token lacks rate limiting — Med

**Severity:** Medium (R3) / Low (R5). **Surfaced 2026-06-17** (audit R3/R5).

**Symptom:** (R3, Med — needs caller-trace) `calculateLease:66` computes `monthlyPayment * (1 + escalationRate/100)^yearIndex`; a null `escalationRate` coerces to **0%**. The *portfolio* path explicitly excludes index/CPI leases from PV, but the *single-lease* stored PV likely passes null→0% and understates the liability — an inconsistency between the two surfaces. (R5, Low) `generate-summary-token` has no rate limiting (not exploitable — RLS-protected — but every sibling report fn rate-limits; + a service-role lease-fetch code smell).

**Fix:** R3 — exclude or flag index/CPI leases in the single-lease PV exactly as the portfolio path does (confirm the stored `calc_pv_liability` for an index lease first). R5 — add workspace-scoped rate limiting (20/hour) + use the user client for the initial fetch.

**Where to look:** `src/lib/leaseCalculations.ts:66`; `src/lib/portfolioAnalytics.ts` (the index-lease exclusion to mirror); `supabase/functions/generate-summary-token/index.ts`.

---

### Item #120: `delete-account` doesn't resync firm billing when it deletes a firm-bound workspace — Med

**Severity:** Medium (revenue drift; the #107 cron backstops it). **Surfaced 2026-06-18** during the #112 security/integrity review — filed as its own beat (CLAUDE.md "pre-existing issues are their own beat"), NOT bundled into #112.

**Symptom:** `delete-account` deletes the user's owned workspaces by `owner_id` via the service role (`supabase/functions/delete-account/index.ts` workspace-delete). After #112, the `maintain_firm_child_workspace_counter` DELETE branch correctly decrements `firms.child_workspaces_used` for any firm-bound child removed — the **integrity** side is handled. BUT delete-account does NOT select `firm_id` or call `syncFirmSubscriptionQuantity`, so the firm's Stripe **quantity** is left stale until the #107 `firm-billing-reconcile` cron runs — a silent vendor drift (hard rule #9) for the interim. Mostly academic today: a firm *owner* can't hard-delete while children still reference the firm (#104 / FK guards), so the realistic case is a non-owner whose owned workspace was bound into someone else's firm.

**Fix:** mirror the #112 `delete-workspace` change — select `firm_id` on the workspaces being deleted, and after the deletes call `syncFirmSubscriptionQuantity` once per distinct affected `firm_id` (best-effort; the cron stays the backstop).

**Where to look:** `supabase/functions/delete-account/index.ts` (the workspace-delete path); `supabase/functions/_shared/firm_billing.ts`; reference fix in `supabase/functions/delete-workspace/index.ts` (#112).

---

### Item #121: CSV formula-injection in two more exporters (LeaseExports + AuditLog) — Med

> **RESOLVED in code 2026-06-18 (branch `claude/approval-jargon-fix`) — pending merge.** Migrated both to the shared `escapeCsvCell()` (#118); widened its param to `unknown`. Surfaced by the #118 review.

**Severity:** Medium (CSV/formula injection; same class as #118 R1, different surfaces). **Surfaced 2026-06-18** during the #118 review — filed as its own beat, then fixed.

**Symptom:** `LeaseExports.tsx` (lease-detail + rent-schedule CSV) and `AuditLog.tsx` (audit-log CSV) used local escaping that only RFC-4180-quoted commas/quotes/newlines — it did NOT neutralize formula prefixes (`=`/`+`/`-`/`@`). CSV quoting escapes *delimiters*, not formulas: Excel/Sheets strip the surrounding quotes and still execute a leading `=` (e.g. a tenant_name or audit-reason of `=HYPERLINK(...)`). Same injection vector as #118 R1 on two more user/AI-sourced surfaces.

**Fix (done):** both route every cell through `src/lib/csv.ts` `escapeCsvCell()` (formula-prefix neutralization + RFC-4180). Delete on merge.

**Where to look:** `src/components/leases/LeaseExports.tsx`; `src/pages/app/AuditLog.tsx`; `src/lib/csv.ts`.

---

### Item #122: `SectionCard` `confidenceScores` prop is vestigial (dead prop) — Low

**Severity:** Low (dead code; no user impact). **Surfaced 2026-06-18** during the #114 review. **Pre-existing** (predates #114; the prop was equally ignored when it received `{}`).

**Symptom:** `LeaseReviewSections.tsx` `SectionCard` declares + destructures a `confidenceScores` prop (`:128`, `:152`) but never references it in its body — all per-field confidence display inside the card reads `extracted_json` directly via `getFieldConfidence` (`:176` border, `:210`/`ConfidenceBadge`). `LeaseReview` passes `confidenceScores={confidenceScores}` at four section-card sites where it has no effect (so #114's memo fix correctly revives only the `NeedsReviewBanner`, the one real consumer).

**Fix:** remove the unused prop from `SectionCard`'s interface + destructure + the four `LeaseReview` pass-sites. (Alternatively route `SectionCard` confidence through the prop, but the inline `extracted_json` read is the working path — removal is simpler.) lease-code-auditor territory.

**Where to look:** `src/components/leases/LeaseReviewSections.tsx:128,152`; `src/pages/app/LeaseReview.tsx` (the four `confidenceScores={confidenceScores}` section-card pass-sites).

---

### Item #123: Notification rail — `recipient_ids` fanout (follow-on from #111 C6c review) — RESOLVED (in-app) 2026-06-18

> **RESOLVED — merged via PR #62 (branch `claude/notification-rail-followup`).** Assigned **#123** at merge (the #108–#122 range was used by the audit branches; this item was surfaced later by the #111 C6c review, not the original audit).

**The gap (verified first-hand):** ~17 code paths (approval chain, delegation, counter-signature, execution-owner, escalation, stuck-chain) signal an in-app notification by writing a `lease_activity_log` row with `activity_type='comment'`, `user_id=null`, `details.{notification_type, recipient_ids, message}`. **Nothing reads `recipient_ids`** — no fanout trigger, no cron, no UI surface — so every targeted approval/delegation/counter-sig notification reached no one. The real in-app rail is the `notifications` table (read by `Notifications.tsx`), which only `process-alerts` ever wrote. (This is why #111 C6c's "Notify admin" button was cosmetic.)

**Fix shipped (approach B — central trigger, in-app only):** migration `20260618180000_fanout_recipient_notifications.sql` — a `SECURITY DEFINER` `AFTER INSERT` trigger on `lease_activity_log` (WHEN `comment` + has `recipient_ids`) fans each row into one `public.notifications` row per recipient — the schema `Notifications.tsx` already renders. Best-effort (`EXCEPTION WHEN OTHERS` → `RAISE WARNING`; **never aborts the audit insert**); resolves `workspace_id` from the lease; skips non-live (Vault/grace) workspaces; **fans only to genuine workspace members** (firm-aware `is_workspace_member` — security review Tier 2 hardening); guards non-array/malformed ids; idempotent (one fire per insert); **not backfilled** (historical dead rows stay — backfilling would deliver a flood of stale alerts). `Notifications.tsx` humanizes the fallback badge label for the new `notify_*` alert_types. Chosen over migrating 17 writers (which re-creates the "every writer must remember" fragility that caused the gap). Reviewed BEFORE push — security/integrity/code-auditor all clean (no Critical/High). Test: `notificationFanout.test.ts`.

**CORRECTION (2026-06-18): EMAIL delivery for this rail is ALREADY built in PR #57** (the #109 work) — the rail-mapping agent + the reviews ran on this off-`main` branch, which lacks #57, so they wrongly concluded "no reader / no email." On `main` after #57 merges, `dispatch-notifications` (cron) sweeps every `lease_activity_log` `comment`+`recipient_ids` row and **emails each recipient** (idempotent via `notification_deliveries`, Vault-gated, `notify_dispatch.ts`). So this `recipient_ids` rail delivers BOTH ways: **in-app via this #62 trigger + email via #57's dispatcher.** Email is **operator-gated** (schedule the `dispatch-notifications` cron + set `NOTIFICATION_DISPATCH_CRON_SECRET`), not code-gated — see the deploy runbook. The earlier "counter-sig sends no email" was likewise wrong: `send-counter-signature-reminder` writes a `recipient_ids` comment row that the dispatcher emails; #57 was further updated (commit `ef9673a`) to give counter-sig + delegation/execution/signator types specific email copy instead of the generic "Lease update."

**Genuinely remaining follow-ons (filed, NOT bundled):**
- **The OTHER rail has no email (Medium).** `process-alerts` writes the `notifications` table directly (expiry_approaching / approval_pending / covenant_breach / variance_high) — those are **in-app only**; `dispatch-notifications` reads `lease_activity_log`, not `notifications`, so the alert_rules alerts never email. Emailing them is a separate, smaller build (a dispatcher over the `notifications` table, or have `process-alerts` also write `recipient_ids` rows).
- **Client-forgeable fanned notifications (LOW, pre-existing).** A workspace member can write a `comment`+`recipient_ids` row with arbitrary `message`/`notification_type`; the fanout now delivers it as a system-looking in-app notification to *co-members* (same-tenant only, RLS-contained, no cross-tenant/no injection). The member-filter bounds it to genuine co-members; the residual (spoofed text to peers) is the accepted #90-NULL `comment` carve-out class. Full close = require `user_id=auth.uid()` for `recipient_ids` comments (would force the 2–3 client writers to service-role edge fns) OR set `title` from a server-side template instead of echoing `details.message`.
- **No live-DB test of the fan (LOW).** The static test pins the trigger source; the actual fan behavior belongs in `scripts/smoke-*` (not CI-wired, KNOWN_ISSUES #26). Relatedly: **no `deno check` in CI** (edge type errors escape the static suite).

**Where to look:** `supabase/migrations/20260618180000_fanout_recipient_notifications.sql`; `src/pages/Notifications.tsx`; `src/lib/leaseNotifications.ts` (canonical writer shape); the 17 writers (grep `recipient_ids`); `supabase/functions/{process-alerts,send-lease-notifications,send-counter-signature-reminder}/index.ts`.

---

### Item #124: process-alerts notifications now email the lease owner — RESOLVED 2026-06-18

> **RESOLVED — merged via PR #64 (branch `claude/process-alerts-email`).** Assigned **#124** at merge (closes the "OTHER rail has no email" follow-on filed in #123). This was the one genuinely-open email gap noted in the notification-rail entry: `process-alerts` writes `notifications`-table alerts (expiry_approaching / approval_pending / covenant_breach / variance_high) that were **in-app only** — `dispatch-notifications` reads `lease_activity_log`, not `notifications`, so the alert-rule alerts never emailed.

**Fix:** `process-alerts` now emails each newly-created alert to the **lease owner** (`leases.user_id` → `profiles.email`) via Resend (`RESEND_ALERTS_FROM_EMAIL`), in addition to the in-app insert. Best-effort (per-recipient try/catch + a profiles-lookup guard; never fails the cron or undoes the in-app rows — hard rule #9), `escapeHtml`'d title/body, respects the existing `profiles.email_notifications_enabled` opt-out (the AccountSettings toggle, default on). Reuses the existing `wasRecentlyAlerted` 24h dedup → no re-email. No schema change; no migration; no #57 dependency. Reviewed BEFORE push — security/integrity/code-auditor all clean (no Critical/High/Medium). Test: `processAlertsEmail.test.ts`.

**Design note:** recipient = **lease owner only** — deliberately narrower than the in-app notification (which is a workspace-wide broadcast, `user_id` NULL). Conservative for a new outbound-email channel. If broader reach is wanted (e.g. also workspace admins for governance alerts like covenant/variance), that's a one-spot extension to `sendAlertEmails`'s recipient resolution.

**Where to look:** `supabase/functions/process-alerts/index.ts` (`sendAlertEmails`); `supabase/functions/send-lease-notifications/index.ts` (the email/escape precedent); `profiles.email_notifications_enabled` + `src/pages/settings/AccountSettings.tsx`.

---

### Item #125: Edge-function CI lint gate added; `deno check` (type-check) still blocked — 2026-06-18

> **RESOLVED (lint half) — merged via PR #65 (branch `claude/ci-deno-check`).** Assigned **#125** at merge; **sequenced LAST** as planned so the other edge PRs did not re-run against the new gate. Closes the "edge functions have no CI verification" gap for LINT. The TYPE-CHECK half remains open (see below).

**Done:** a PR-only `deno-lint` CI job (`.github/workflows/ci.yml`) lints the edge `.ts` files a PR *changes* (diff `base...HEAD` under `supabase/functions`), via `supabase/functions/deno.lint.json` which excludes `no-explicit-any` (the deliberate Supabase-row casting pattern; a dedicated non-`deno.json` name so Supabase deploy doesn't auto-pick it). So any new/modified edge function must be lint-clean (unused vars, unreachable code, missing await, etc.) — the class that previously escaped (Node `typecheck` covers only the Vite app). Scoped to changed files so it does NOT fail on the 233 `no-explicit-any` + 22 other pre-existing problems in untouched legacy functions. Self-validated (deno 2.1.4 installed locally: YAML parsed by 2 parsers; the diff+lint command run; secrets-in-`if:` grep clean). Test: `denoLintCi.test.ts`.

**STILL OPEN — `deno check` (full type-checking) cannot run in CI:** it 404s resolving supabase-js's deep type graph via esm.sh (`@supabase/storage-js@2.99.1/dist/module/StorageClient` → 404 while the package root is 200; `skipLibCheck` doesn't help — it's a *load* failure). Every supabase-js function would false-red. **Fix (separate, bigger effort):** route supabase-js through a type-resolvable source — a bare specifier + import map to `jsr:@supabase/supabase-js` (or `deno.land/x`) — then add a blocking `deno check`. Until then, type errors in edge functions are caught only by review + the static `readFileSync` tests, not automatically.

**Two follow-ups noted, not done:**
- **22 pre-existing lint problems** (13 `no-unused-vars`, 3 `require-await`, 3 `prefer-const`, 3 `no-control-regex`) across 13 legacy functions — **9 in `process_lease`**. The changed-files gate means a future PR touching one of these must clean it (boy-scout). A one-time sweep could clear them + flip the gate to tree-wide. (`no-control-regex` ones are likely intentional → `// deno-lint-ignore`.)
- **In-flight PR interaction (resolved):** landed LAST — #57/#59/#60/#62/#64/#66 all merged before this, so no other open PR re-ran against the new gate. The gate now applies to all *future* PRs (a PR touching an edge file with a pre-existing issue must clean it).

**Where to look:** `.github/workflows/ci.yml` (`deno-lint` job); `supabase/functions/deno.lint.json`; `denoLintCi.test.ts`.
**Where to look:** `supabase/migrations/20260618140000_prevent_committed_lease_hard_delete.sql`; `src/pages/app/ImportHistory.tsx`; `src/lib/leaseDisposability.ts`; the deep-link in `src/pages/app/LeaseReview.tsx` + `src/components/leases/locked/LockedHeader.tsx`; the sibling guard `prevent_locked_lease_edits` (`baseline_schema.sql:526`) and the #77/#83 destruction-guard pattern (`20260613030000_destruction_guards.sql`); archive flow `src/components/leases/ArchiveButton.tsx`.

---

### Item #139: Dead `confidenceScores` plumbing (`leases.confidence_scores` is never written)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, P0 audit remediation). Surfaced by the code-auditor while reviewing the B1 fix; **pre-existing** (git blame `^0575f35`, 2026-06-04), exposed — not introduced — by that fix. Per "pre-existing issues are their own beat," filed here rather than bundled.

**Severity:** Medium (dead code / fragility — the exact "reads a column nothing populates" pattern B1 just removed from the banner, still live on the section-card surface).

**Symptom:** `leases.confidence_scores` (a `Json` column typed `0-100` via `ConfidenceScores` in `src/types/workflow.ts:23`) is **read-only across the entire codebase and written by nothing** — no edge function (`process_lease` emits per-field confidence into `extracted_json`, not this column), no client write. After the B1 fix re-pointed `NeedsReviewBanner` to the live `extracted_json[field].confidence` source, the only remaining consumer is:
- `LeaseReview.tsx:331-333` — the `confidenceScores` memo reads `lease?.confidence_scores` (always `{}`),
- passed to `SectionCard` at `LeaseReview.tsx:3112/3289/3310/3342` via the `confidenceScores` prop,
- which `SectionCard` (`LeaseReviewSections.tsx:122` decl, `:146` destructure) **never references** — the section cards read confidence solely via `getFieldConfidence(extractedJson, …)`.

So the prop, the memo, the `ConfidenceScores` type, and the column read form a dead chain that implies a data dependency that isn't real.

**Fix (stub):**
- Remove the `confidenceScores` prop from `SectionCardProps` + the four `LeaseReview.tsx` call sites.
- Delete the `confidenceScores` memo (`LeaseReview.tsx:331-333`) and the now-unused `ConfidenceScores` import; the `ConfidenceScores` interface in `types/workflow.ts:23` would then have no consumers (remove it too).
- Optional DB cleanup: a migration to drop the unpopulated `leases.confidence_scores` column (schema-change rule applies — write the `.sql`, confirm no other reader first).

**Where to look:** `src/pages/app/LeaseReview.tsx:331-333,3112/3289/3310/3342`; `src/components/leases/LeaseReviewSections.tsx:122,146`; `src/types/workflow.ts:23`.

**Adjacent minor items surfaced in the same B1/polish review (not bundled):**
- *Banner field-name lost `<strong>` emphasis (LOW, polish):* moving `NeedsReviewBanner`'s copy into single-`<span>` i18n strings dropped the bold on the interpolated field name (both the missing + low-confidence lines), a minor scan-ability regression. Restoring it correctly needs react-i18next `<Trans>` (a `<strong>` placeholder) — deferred because `<Trans>` is not an established pattern here and would require reworking the `useAppTranslation`-mock-based banner tests; disproportionate for a LOW.
- *Banner field labels render English inside Spanish copy (LOW, i18n):* `TIER1_FIELDS` labels ("Landlord Name", …) are English literals interpolated into the translated `{{label}}` slot, so ES users see "Falta Landlord Name". Intentional for now — field labels are English everywhere on this surface (section cards / `SECTION_CONFIG`), so translating them banner-only would create a same-field-two-names mismatch. Fix only as part of an app-wide field-label i18n pass (TIER1_FIELDS + section config together).

---

### Item #140: FailedLeaseBanner partial i18n + retry_lease raw-error leak (C1 review pre-existing LOWs)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, C1 in-place re-upload review). Two pre-existing LOWs surfaced by product-polish + security while reviewing C1. The C1 change made the i18n contrast more visible but did **not** introduce either (the new re-upload paths already return generic errors + are localized). Filed, not bundled.

**Severity:** Low (×2).

- **FailedLeaseBanner partial i18n (polish).** `src/components/leases/FailedLeaseBanner.tsx` — the new re-upload branch is fully localized (`failed_lease.*`, en+es), but the rest is hardcoded English: the title "Processing Failed", the `errorMessage` fallback, the canRetry button ("Retry Processing" / "Retrying..."), and the `handleRetry` toasts ("Re-processing started", "Failed to retry processing", "Cannot retry: original file not found in storage", "Please log in to retry"). An ES user on a failed lease that DOES have a stored file (the common retry case) sees a half-translated surface. **Fix:** migrate the remaining literals into the established `failed_lease.*` namespace as a small i18n pass.
- **retry_lease top-level catch leaks raw error (security).** `supabase/functions/retry_lease/index.ts` — the outer `catch` returns `error.message` to the client, which can surface the Anthropic/Azure vendor error string or the internal "Failed to download file" message. Pre-existing; C1's own new failure paths already return generic copy + `console.error` the detail. **Fix:** apply the same generic-to-client + log-server pattern to the top-level catch (and audit `process_lease`'s outer catch for the same habit).

**Where to look:** `src/components/leases/FailedLeaseBanner.tsx`; `src/locales/{en,es}/common.json` (`failed_lease`); `supabase/functions/retry_lease/index.ts` (top-level catch).

---

### Item #141: Formatting-sweep leftovers — LeaseReview parent-rent currency + deferred date tail

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, formatting-consistency sweep). Surfaced by product-polish while reviewing the currency/date migration. Filed, not bundled — each needs a small targeted decision the sweep deliberately scoped out.

**Severity:** Low (×3).

- **`src/pages/app/LeaseReview.tsx:3153` — un-migrated parent-lease rent currency (same-screen inconsistency).** `${parentLease.current_monthly_rent?.toLocaleString() || parentLease.base_rent_amount || 'N/A'}` was left as-is by the currency sweep because its `||` fallback chain relies on `?.toLocaleString()` returning `undefined`; the canonical helper's truthy `'—'` sentinel would break the `|| base_rent_amount` fallback. After the sweep, the migrated metric cards on the same screen render `-$1,234` / `USD 1,234` (es) while this sibling still shows `$1,234` (browser-locale, no es). Polish flagged the side-by-side dialect mismatch. **Secondary bug:** the `||` chain mixes a formatted string, a raw `base_rent_amount` (string of uncertain format), and the literal `'N/A'`. **Fix:** `parentLease.current_monthly_rent != null ? formatLocalizedCurrency(parentLease.current_monthly_rent, language) : (parentLease.base_rent_amount ? '$' + parentLease.base_rent_amount : 'N/A')` — but first confirm `base_rent_amount`'s stored format (it may already include `$`/grouping).
- **Deferred date tail — bare `.toLocaleString()` admin/internal timestamps.** `OperationsPage.tsx:248,343`, `PortfolioReportsAdmin.tsx:271`, `DisclosureReportLibrary.tsx:238`, `LeaseReportDetail.tsx:127,317`, `Asc842InputsTab.tsx:660`, `LeaseDiscountRateCard.tsx:299` render "generated/last-updated" timestamps via bare `new Date(x).toLocaleString()` (follows browser locale). Migrating to `formatLocalizedDateTime(x, language)` would localize them but also CHANGE the format (short month, no seconds), so it needs a quick design nod. Low value (admin/internal surfaces). **Fix:** migrate to `formatLocalizedDateTime` if a format change is acceptable.
- **Deferred date tail — already-correct DRY collapses.** `VaultBanner.tsx:32`, `CancellationBanner.tsx:79`, `AccountSettings.tsx` (×4), `DocumentPackDialog.tsx:116` already localize correctly via an inline `language === 'es' ? 'es-419' : 'en-US'` ternary. They're not buggy — just a second date-formatting pattern alongside the canonical `formatLocalizedDate`. **Fix:** optional DRY collapse onto the helper (watch the `parseToLocalDate` off-by-one semantics for any date-only inputs).

- **Mixed-locale on partially-i18n'd surfaces (pre-existing, made slightly more visible).** Localizing dates exposed that some surfaces are otherwise hardcoded English: `src/pages/LeaseAudit.tsx` — the public lead-magnet card (currency `fmt()` was since migrated, so dates+currency now both localize, but labels "Tenant"/"Landlord"/"Monthly Rent" stay English); `src/components/dashboard/RecentActivity.tsx` — older feed rows show a localized date while "Today"/"Yesterday"/"N days ago" stay English. These surfaces just need a full i18n pass (labels + relative-time strings), not a piecemeal fix. **Fix:** fold each surface into i18n as its own pass; do not half-translate.
- **`src/components/QuotaWarningBanner.tsx` null-limit copy has a doubled space.** When `limit_value` is null the banner renders e.g. `"5 of  documents."` (the `?? ''` leaves a gap). Pre-existing (faithfully preserved through the number-formatting migration). **Fix:** tidy the template to drop the "of {limit}" clause entirely when the limit is absent.
- **`src/components/billing/PlanPickerDialog.tsx:114` uses a hardcoded `$` in the i18n template** (`account.billed_annually` with a `formatLocalizedNumber` total), diverging in strategy from sibling sites that route the symbol through `formatLocalizedCurrency`. Correct as-built (no `$$`), but worth unifying when the annual-billing copy next gets touched.

**Where to look:** `src/pages/app/LeaseReview.tsx:3153`; the timestamp + DRY files listed above; `src/pages/LeaseAudit.tsx`, `src/components/dashboard/RecentActivity.tsx`; canonical helpers in `src/lib/dateFormatters.ts`.

---

### Item #126: B3 monthly-rent consolidation — follow-ups surfaced by the integrity/auditor/polish review

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, audit finding B3). The B3 change centralized the "current monthly rent" chain into `getMonthlyRent(lease)` / `getBaseMonthlyRent(lease)` in `src/lib/leaseCalculations.ts` (display vs PV-base). These are adjacent issues the reviewers surfaced that were deliberately NOT bundled — each needs its own decision/scope.

- **(HIGH — reporting fidelity) RentRoll single-field rent — RESOLVED 2026-06-22.** `RentRollExport.tsx` previously used only `current_monthly_rent || 0`, so an executed lease whose rent lives in `executed_monthly_payment` (with `current_monthly_rent` null) exported as **$0**, understating the auditor-facing CSV + its footer totals. Fixed alongside **B4** (P3): both the per-row figure and the `totalMonthly` reduce now resolve via `getBaseMonthlyRent(lease)` (the explicit static chain executed→current→base — chosen over `getMonthlyRent` so the export can't silently become schedule-aware if the query ever embeds `rent_schedules`, keeping it consistent with Portfolio). Integrity-reviewed; static regression guard added (`src/components/reports/__tests__/rentRollExport.test.ts`).
- **(MEDIUM — financial trust) Portfolio totals use *base* rent; Dashboard totals use *current escalated* rent, for the same leases.** `Portfolio.tsx` (annual obligation / asset breakdown / lease register) doesn't load `rent_schedules`, so it resolves the static base; the dashboard (`SummaryStrip`/`FinancialSummary`) loads schedules and shows the escalated current step. For an escalating portfolio past year 1 the two highest-traffic financial surfaces show **different totals**, and the gap widens over the term. Pre-existing (not introduced by B3 — B3 preserved each site's data-loading). Integrity rated the *display* disagreement MEDIUM (a deferred modeling decision); polish rated the *trust* impact HIGH. **Fix options:** (a) label the basis on each surface ("base obligation" vs "current annualized") + tooltip; or (b) make Portfolio's *display* sums schedule-aware (load `rent_schedules`, use `getMonthlyRent`) while keeping PV on `getBaseMonthlyRent` — note (b) requires confirming the PV-base decision is acceptable. **Owner decision pending** before any fix.
- **(MEDIUM — drift) The same rent chain is still inline ×4 in Deno edge functions with no `_shared` mirror.** `supabase/functions/{ai-assistant:40,58, generate-portfolio-report:599, generate-lease-report:551, generate-workspace-asc842-report:412}/index.ts` hand-roll the chain, and use `??` (null-coalescing — a legit `0` does NOT fall through) where the canonical helper uses `||` (treats `0` as falsy and walks on). Latent semantic divergence between the on-screen total and the generated PDF/ASC842 report total for a `$0`-rent edge case. **Fix:** add a `supabase/functions/_shared/` Deno mirror of `getMonthlyRent`/`getBaseMonthlyRent` (per the Node⇄Deno mirror-pair convention) and route all four onto it. Its own task.
- **(LOW — polish) `src/pages/Reports.tsx` variance card is a half-localized island.** The numbers localize (and now route through `formatLocalizedPercent`) but the surrounding words ("variance", "View", "Unnamed lease", "/mo", card title/description, chart "Commitment") stay hardcoded English. Pre-existing i18n gap, made marginally more visible. **Fix:** fold the card into i18n as its own pass; do not half-translate.
- **(LOW — polish) `src/pages/Reports.tsx:302,319` — a null-`pct` outlier row renders with no variance badge.** When `monthly_payment` (pipeline) is 0/null, `pct` is null and the badge is suppressed, so a lease appears in the "largest variance" list with no number explaining why. **Fix:** render a neutral fallback chip (e.g. the raw `variance_monthly_payment` dollar amount) so every outlier row carries a value.
- **(LOW — note, already tracked) `src/components/dashboard/FinancialSummary.tsx` appears orphaned/unmounted** (no JSX mount; only unrelated identifiers `buildFinancialSummary`/`canShareFinancialSummary` match elsewhere) — see KNOWN_ISSUES #42. CLAUDE.md's file-map still presents it as a live Dashboard component. This orphan status is what kept the (now-fixed) PV double-count latent rather than live. **Fix:** confirm orphan status and either re-mount or delete (owned by #42).

**Where to look:** `src/lib/leaseCalculations.ts` (`getMonthlyRent` vs `getBaseMonthlyRent`), `src/lib/portfolioAnalytics.ts:57`, `src/components/reports/RentRollExport.tsx`, `src/pages/app/Portfolio.tsx`, `src/pages/Dashboard.tsx`, the four edge functions above.

---

### Item #127: Checkout edge functions interpolate the raw `Origin` header into Stripe `success_url`/`cancel_url` — Low (pre-existing, codebase-wide)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-security-scanner while reviewing the audit-C3 firm-checkout fix. Pre-existing convention, NOT introduced by C3 (C3 only changed the path segment of an already-existing `${origin}/...` string).

**Severity:** Low. **Where:** `supabase/functions/create-firm-checkout/index.ts` (`const origin = req.headers.get("origin") || "http://localhost:5173"` → interpolated into `success_url`/`cancel_url`) and the identical pattern in `supabase/functions/create-checkout/index.ts` (workspace billing).

**What / why low:** `getCorsHeaders` only *chooses the response header value* via `resolveAllowedOrigin`; it never *rejects* a disallowed origin, so a non-browser caller (curl/Postman) can send `Origin: https://evil.com` and have it land in the Stripe return URLs. Blast radius is small: the owner-auth gate means the caller is acting on their own firm/workspace, and they can only redirect *their own* checkout return — there's no third-party victim (it's a self-redirect, not a reflected/stored redirect). The same raw-`origin` pattern is the established convention across both checkout functions.

**Fix:** gate on `isAllowedOrigin(req.headers.get("origin"))` and fall back to a canonical `APP_URL` when not allowlisted, applied uniformly across `create-firm-checkout` + `create-checkout`. Hardening, not urgent.

---

### Item #128: `workspace_roles` pre-existing gaps surfaced by the D3 atomic-replace fix — Low (×2)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-security-scanner + lease-repository-integrity-reviewer while reviewing the D3 fix (`set_workspace_roles` RPC). Both are pre-existing properties of the table/RLS — the new atomic RPC neither introduced nor widened them, so they're filed, not bundled.

- **(Low — concurrency) No row lock → concurrent functional-role saves are silent last-write-wins.** `set_workspace_roles` does a full-set replace with no `SELECT … FOR UPDATE` on the workspace row, so two admins saving at once → the last writer's full set silently clobbers the first's edits, with no error. Pre-existing (the old client DELETE+INSERT had the same). The D3 audit row (`functional_roles_changed`) at least makes the overwrite visible after the fact now. **Fix (if hardened):** `SELECT 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;` at the top of the RPC, matching `transfer_workspace_ownership_locked`.
- **(Low — permissions correctness) `workspace_roles` has no FK to `workspace_members`, so a role can be assigned to a non-member (orphaned permission row).** `p_assignments` accepts any `user_id` uuid; the INSERT only validates the `role` CHECK, not membership. The UI only ever offers current members, so the happy path is clean, but the RPC (like the old client code) accepts arbitrary uuids. Blast radius: an orphaned `financial_approver`/`admin` row still satisfies several RLS policies that gate on `workspace_roles` (e.g. `leases_update_own_or_workspace_editor`), so it's a latent permissions-correctness concern. Pre-existing. **Fix (if tightened):** validate each `user_id` is an accepted `workspace_member` (or the owner) before insert and `RAISE` on a non-member, and/or add a membership FK.

---

### Item #129: Binding a workspace to a firm leaves its workspace-level `subscription_status` stale — Low (data hygiene)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-product-polish during the audit-D1 surface sweep. The audit-D1 UI gating now SUPPRESSES the symptom (firm-bound workspaces no longer render trial/past-due/payment banners), so this is no longer customer-visible — but the underlying data is still inconsistent.

**Severity:** Low. **Where:** `supabase/functions/bind-workspace-to-firm/index.ts` (+ `stripe-webhook` `applyFirmSubscription`) only write `plan = 'business'` (and firm columns) when a workspace joins a firm; they never normalize the workspace's own `subscription_status`/`subscription_period_end`/`intended_plan`. So a workspace bound while it was `trialing` (or `past_due`, or mid-abandoned-checkout) keeps that stale status on its `workspaces` row even though billing is now firm-governed.

**Why low now:** audit D1 gates every workspace-level billing banner on `!firmBound`, so the stale status no longer drives any UI. It's a latent data-hygiene gap: any future code that reads a firm-bound child's `subscription_status` without also checking `firm_id` would misbehave. **Fix:** when binding, clear/normalize the child's `subscription_status` (e.g. to `'active'` or null) + `intended_plan`, so a firm-bound child's billing columns reflect "firm-governed" rather than a frozen pre-bind snapshot.

---

### Item #130: Vault read-only ASC 842 / discount-rate cards show a permission-flavored "read-only" note that misdescribes WHY — Low (copy)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-product-polish during the audit-D2 Vault read-only surface sweep.

**Severity:** Low (copy). **Where:** `src/components/leases/Asc842InputsTab.tsx:673-678` + `src/components/leases/LeaseDiscountRateCard.tsx:384-389`. On a Vault (read-only retention) workspace, `canEditAsc842` is false (because `!readOnly` is false), so the inputs + Save are correctly disabled — but the explainer note reads "Read-only — only workspace admins, editors, or the owner can edit…". The Vault user IS the owner, so the copy implies they should be able to edit; the real reason is the archive/read-only state. **Fix:** when the disable is due to read-only retention (not a permission gap), swap the note for the Vault message (`t('vault.lease_readonly_note')`, matching what `LockedHeader` already shows). Needs a read-only signal threaded into those two cards to branch the copy.

---

### Item #131: Two polish LOWs surfaced during the P3 C4/D5 batch (deferred)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-product-polish while reviewing the C4/D5 fixes. Both deferred — out of those findings' de-scoped intent.

- **(Low — firm onboarding) The billing step shows the per-workspace *rate*, not the firm's *total*.** `src/pages/app/firm/FirmOnboarding.tsx` billing step renders "$499 / workspace / month" (now from config, audit D5) under "billed per workspace, together." A finance buyer scanning for their monthly charge may read $499 as the whole bill rather than the per-unit rate. At onboarding the firm has 1 child so total == rate, but it's a preview-the-outcome gap before the Stripe redirect. **Fix:** show the computed total (e.g. "N workspaces × $499 = $X / month") using the bound-child count, or make the multiplier explicit in `billing_summary`.
- **(Low — pre-existing) `src/pages/app/AuditLog.tsx` has hardcoded English on an otherwise-i18n'd surface.** The "Activity type" label, "All activity types" item, the "Activity"/"Transition" table headers, and the `ACTIVITY_LABELS` map (~line 62) are literal English while the rest of the page uses `t()`. Predates the C4 change (which only touched the empty state). **Fix:** move these into the `audit` locale block in both en + es.

---

### Item #132: P3 audit items C2 + D6 — BOTH RESOLVED 2026-06-22

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Deferred from the P3 remediation pass: C2 because it's a high-risk change to the core approval-submission path (CLAUDE.md flags approval tickets for extra care + 3+ review rounds), D6 because it's a zero-visible-impact DRY refactor whose churn isn't justified at the tail of a long session. The other P3 items (B4/B5/C4/C5/D4/D5) shipped.

- **(MED — dead-end) C2: a request whose approval routing failed sits in `draft` with no retry. — RESOLVED 2026-06-22.** Built a focused "Retry routing" recovery on LeaseReview, gated on `intake_source === 'request_workflow' && lifecycle_status === 'draft'`. **Divergence from the original plan:** rather than extract LeaseRequestForm's inline finalize block into a shared helper, the retry orchestration lives in a NEW self-contained `src/lib/retryRequestRouting.ts` (it reuses all the shared *business-logic* helpers — `getApprovalRequirements`/`getInitialStatusAfterSubmission`/`decideSubmissionOutcome`/`notify*` — and only repeats the ~25-line orchestration SEQUENCE). This was deliberate: refactoring the primary submission path (which has no integration-test safety net) was higher-risk than the duplication; the shared-orchestration refactor is the remaining follow-up below. Heavy review ran (integrity + auditor + security + polish + test-author); the integrity reviewer caught a **CRITICAL** — the idempotent-replay case (chain rows already exist but lease still `draft`) returned a bare `alreadyResolved` payload that fabricated `finalStatus:'submitted'` and threw in `notifyChainAssignees(undefined)`, producing an unlogged/mis-statused transition. Fixed with a dedicated `completeExistingChainRouting` recovery (flips to the deterministic `concept_submitted`, reads first-step assignees from the existing chain). 8 regression tests in `src/lib/__tests__/retryRequestRouting.test.ts`. **Remaining follow-up (LOW):** extract LeaseRequestForm's inline finalize block (lines ~348–424) + `retryRequestRouting`'s orchestration into ONE shared `finalizeRequestRouting` helper, once the primary submission path has an integration-test safety net. Do this before the orchestration drifts.
- **(LOW — consistency) D6: the six `/app/firm/*` pages hand-roll their page header. — RESOLVED 2026-06-22.** Extracted `src/components/firm/FirmPageHeader.tsx` (`{ icon: LucideIcon, title, subtitle?, badge?, actions? }`, wrapping `flex items-start justify-between gap-4`; FirmDashboard's superset shape) and applied it to all six pages (Dashboard/Inbox/Billing/Members/Settings/Workspaces). The FirmMembers invite Dialog moved verbatim into `actions=`; FirmDashboard's role badge + Inbox action preserved. Reviewed clean: auditor (no orphaned imports / no duplicate `<h1>`), polish (no visible layout drift — the FirmMembers `items-center`→`items-start` shift top-aligns the invite button to the title row, judged an improvement), security (the `canManage`/`isOwner` invite gates preserved verbatim; the component is auth-neutral and injection-safe). typecheck clean; 1060 tests pass.

### Item #133: `LeaseReview` has a `useEffect` after early returns (rules-of-hooks) — pre-existing, from the #116 archive-deep-link change — RESOLVED 2026-06-22

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-code-auditor during the C2 review as a **HIGH**, but it is NOT C2 — it predates C2 and was introduced by the `#116` archive-deep-link change on this same branch. Filed separately per the "pre-existing issues are their own beat" rule rather than bundled into the C2 commit. **RESOLVED 2026-06-22** in a focused follow-up commit (auditor + security re-reviewed clean — equivalent, no-weakening refactor).

- **(HIGH — react-hooks/rules-of-hooks) `src/pages/app/LeaseReview.tsx` (the `?action=archive` deep-link `useEffect`) sat AFTER the `if (loading) return` / `if (isProcessing) return` early returns.** Every other hook in this component is above the first early return; this one was conditionally called, so when the component transitioned out of loading/processing the hook order changed and React could throw or misfire effects. **Fix applied:** hoisted the effect above the `if (loading) return` (now sits right after the last `useCallback`), inlined the admin check as `const isAdmin = userRole === 'admin' || userRole === 'owner'` (the `isAdminUser` const is declared below the early returns and was therefore unusable up top), and swapped the dep `isAdminUser`→`userRole`. The body still self-guards (`if (!lease …) return`) so it no-ops until the lease loads. `npx eslint src/pages/app/LeaseReview.tsx` now reports zero `rules-of-hooks` errors; typecheck clean; 1060 tests pass.

### Item #134: C2 retry-routing — server RLS admits any workspace editor, broader than the requestor/admin UI gate (accepted defense-in-depth)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-security-scanner during the C2 review as a **MEDIUM**. Recorded as an accepted/known posture rather than changed, because the action is benign and tightening it would require redeploying `resolve-approval-chain` (a redeploy CLAUDE.md flags as deferred).

- **(MED — authorization precision) The C2 "Retry routing" UI is gated on `!isReadOnly && (isRequestor || isAdminUser)`, but the actual server boundary on the `leases` lifecycle UPDATE is the `leases_update_own_or_workspace_editor` RLS policy, which also admits any workspace _editor_ (plus manager/financial approvers).** So a plain editor who is neither the requestor nor an admin could call `retryRequestRouting(...)` directly and route a stranded draft forward. **Why this is acceptable (not a hole):** routing a stuck draft to its approvers is a low-impact, idempotent action an editor could arguably perform anyway; it is fully workspace-scoped (RLS + the edge function's own JWT + membership + rate-limit checks block any cross-tenant use); and the Vault read-only RESTRICTIVE layer still blocks the write in a read-only workspace regardless of the UI gate. The UI gate is a convenience filter, not the security boundary. **If we ever decide retry must be strictly requestor/admin-only,** the only enforceable place is server-side — add a requestor-or-admin check to `resolve-approval-chain` for `initialResolution=true` retries (client code cannot tighten the editor-level RLS). Until then, no action. (Related pre-existing LOW, not fixed here: the client supplies `user_id` on the `lease_activity_log` row, so audit attribution on this and all the other inline client writers is self-asserted; the structural fix is server-side log writes via the edge function's verified identity.)

### Item #135: Two stale `eslint-disable` directives in stripe-webhook (surfaced once lint became usable)

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-code-auditor during the E1 review. Pre-existing — NOT caused by E1; they only became *visible* because E1 made `npm run lint` usable again (it previously drowned in 908 errors). Filed per the "pre-existing issues are their own beat" rule rather than bundled into the E1 commit (and stripe-webhook is a critical billing function not worth touching for a lint cosmetic mid-E1).

- **(LOW — lint cleanup) `supabase/functions/stripe-webhook/index.ts:326` and `:435` carry `// eslint-disable-next-line no-constant-condition` directives that no longer suppress anything** → ESLint now reports each as an "Unused eslint-disable directive" warning. Either the constant-condition code they guarded changed, or the directives were always misplaced. **Fix:** confirm the guarded lines no longer trip `no-constant-condition` (they don't, per the unused-directive report) and delete the two stale directive comments. Behavior-neutral; verify `npm run lint` shows no new warnings after. Defer to a stripe-webhook-touching change so the critical billing function isn't redeployed solely for a comment removal.

### Item #136: LeaseReview's read-only gate covers only Vault (plan), not the cancellation grace window — grace users see the full write surface and every write is RLS-rejected

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-product-polish as a **HIGH** during the #85 review (the state walk found the root cause beneath #85's symptom). Pre-existing — predates #85; the `isReadOnly = isReadOnlyRetention(workspace?.plan)` line is old. Filed (not bundled into #85) per the "pre-existing issues are their own beat" rule; #85's honest-error toast is the backstop until this lands.

**Symptom:** On `src/pages/app/LeaseReview.tsx:217`, `const isReadOnly = isReadOnlyRetention(workspace?.plan)` is **plan-based only**, so it's true for Vault but **false for a cancellation-grace workspace** (whose plan is still `'starter'`/`'business'`). A Vault user is fully gated — `primaryAction` returns `null` (~:2787), `renderTabFooter` returns `null` (~:2841), the status strip is `!isReadOnly` (~:3040) — so they never reach any mutating control. But a **grace** user (product intent: view/export only until `graceExpiresAt`, identical to Vault — see `CancellationBanner.tsx`) sees the FULL live write surface: Approve, Post, Lock, Reopen, and the four confirm controls. Every one is rejected server-side by the V1 restrictive-RLS layer. #85 only de-lied the four confirm handlers (revert + honest toast); **Approve/Post/Reopen/Lock still optimistically claim success for grace users.** Field-locking is also wrong for grace: `isLocked` (~:432) folds in `isReadOnly`, so grace fields are editable (and each edit RLS-rejects + `console.error`s on blur).

**Severity:** High (audit-defensible product showing a write surface it will reject + optimistic-success lies on Approve/Lock for grace users). Broader scope than #85's five handlers — it changes the page's read-only semantics (~30 `!isReadOnly` gates + `isLocked` + the read-only note copy), so it's its own deliberate pass with full review, not a #85 bundle.

**Stub remediation:** Extend the page's read-only concept from "Vault plan" to "Vault plan OR in grace/soft-deleted". The workspace object already carries `canceledAt`/`graceExpiresAt`/`softDeletedAt` (`AppContext.tsx:281-283`) and there's a canonical pure helper — e.g. `const isReadOnly = isReadOnlyRetention(workspace?.plan) || deriveLifecycleState({ canceledAt, graceExpiresAt, softDeletedAt, purgeAfter: null }) !== 'active'` (import `deriveLifecycleState` from `@/lib/cancellationLifecycle`). Every existing `&& !isReadOnly` gate then suppresses the confirm controls, `primaryAction`, the strip, and (via `isLocked`) field editing for grace users too — so nobody hits a rejection. The read-only note copy (`vault.lease_readonly_note`, says "in Vault") needs a grace-neutral variant or a conditional message in the same change. Verify against a real grace workspace that Approve/Post/Lock/Reopen + the confirm controls all disappear and the note explains why. Route through polish + security + integrity (it's the read-only enforcement surface). Also re-walk other intake surfaces for the same plan-only `isReadOnly` assumption (this is likely not the only site — cf. #88 Vault dashboard widgets).

**RESOLVED 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`) — for LeaseReview. New shared single-source-of-truth helper `src/lib/workspaceReadOnly.ts` (`isWorkspaceReadOnly(workspace)` = Vault retention OR `deriveLifecycleState(...) !== 'active'`), adopted at `LeaseReview.tsx:217` so the page's ~30 `!isReadOnly` write-gates + `isLocked` (field editing) + `primaryAction`/`renderTabFooter`/strip now suppress for grace/soft-deleted users, not just Vault. The `vault.lease_readonly_note` copy was neutralized (en+es) to read correctly for BOTH tiers ("This workspace is read-only — you can view and export…"); the key name was kept (used by 8 sites). New test `src/lib/__tests__/workspaceReadOnly.test.ts` (6 cases). Reviewed: integrity + security + auditor + polish — all clean on the change (integrity confirmed NO false-positive lockout: `canceled_at` is written only on Stripe terminal `canceled`, never past_due/trialing, and the client helper exactly matches the server `is_workspace_live()` read-only set). typecheck clean; 1090 tests pass. The four same-class write-gate sites on OTHER surfaces + two polish MEDIUMs are filed as **#137** (the sweep), not bundled.

### Item #137: The plan-only read-only write-gate (#136's root cause) repeats on four other surfaces + two polish follow-ups

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Surfaced by lease-code-auditor + lease-product-polish during the #136 LeaseReview fix. These are pre-existing instances of the SAME class #136 fixed (and two copy/placement nits on the shared read-only surface); filed (not bundled) per the "pre-existing issues are their own beat" rule. The new `src/lib/workspaceReadOnly.ts` helper is the ready-made fix to adopt at each site.

- **(HIGH ×4 — grace-window write surface that fails opaquely) These write-gates use `isReadOnlyRetention(workspace?.plan)` ALONE, so a cancellation-grace / soft-deleted workspace (plan still starter/business) sees the affordance and the server RLS rejects the write:**
  - `src/pages/Dashboard.tsx:29` (gates the "New Request" header action, used at :61).
  - `src/pages/Leases.tsx:92` (gates "Add Lease" :408, `EmptyLeaseState` readOnly :432, archive/unarchive row :592 — three affordances).
  - `src/pages/Reports.tsx:344` (gates the report/financial CONFIG block that writes `workspaces.discount_rate`/`report_*`, server-rejected for non-live workspaces per migration `20260613010000`).
  - `src/pages/app/UsageContent.tsx:89` (gates purchase/upgrade affordances + the read-only note, used at :122/:171).
  - **Fix:** replace each with `isWorkspaceReadOnly(workspace)` (the #136 helper). **Explicitly NOT bugs (do not change):** the read-ACCESS grants `Reports.tsx:71` + `Portfolio.tsx:29` (`canAccessFeature('business') || isReadOnlyRetention(...)` — grant read to a Business surface; grace keeps its plan's access), `AccountSettings.tsx:1526` (intentionally Vault-specific "convert to Vault" note), and `AppLayout.tsx:32`/`AppSidebar.tsx:212`/`VaultBanner.tsx:27` (genuinely plan/Vault-specific). Route the sweep through security + integrity + polish; re-verify each against a real grace workspace.
- **(MEDIUM — i18n namespace smell) `vault.lease_readonly_note` is now the canonical grace/soft-delete message too but lives under the `vault.*` namespace** — a future translator editing the `vault` block could re-Vault-ify it and silently regress #136. Fix: move the key to a neutral namespace (e.g. `readonly.lease_note`) referenced from all 8 sites, in the same sweep that touches these surfaces.
- **(MEDIUM — placement) `LeaseReview.tsx` intake-stage header (~:2235) renders the read-only note as a bare `<p>` inside the flex `actions` button-row** (cramped next to the "Approval Queue" button at narrow widths) — every other read-only-note site places it as a standalone muted line under the header. Fix: move it out of the `actions` slot to a standalone line, matching the other placements.
- **(LOW — FailedLeaseBanner) a grace user on a failed-extraction lease sees "Processing Failed" + the read-only note with no export hint** — optional: when `readOnly`, append "You can still export what was captured." Low frequency; defer unless grace users commonly land on failed leases.

**RESOLVED 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). Adopted the `isWorkspaceReadOnly(workspace)` helper at the three genuine write-gate sites — `Dashboard.tsx` ("New Request"), `Leases.tsx` ("Add Lease" + archive/restore row + EmptyLeaseState), `Reports.tsx:347` (report/financial CONFIG block) — so cancellation-grace / soft-deleted users are gated out, not just Vault. `Reports.tsx:72` deliberately KEEPS `isReadOnlyRetention` (read-access grant). **UsageContent.tsx:89 was RECLASSIFIED and EXCLUDED** (the auditor's initial "4th HIGH" was a mis-classification): its `readOnlyRetention` isn't a write-gate — it hides the upgrade banner + swaps the metered board for a Vault note *because Vault zeroes its limits*; a grace user's limits are NOT zeroed, so adopting the helper there would hide their real usage board behind Vault copy (a loss), and gating purchases would wrongly block reactivation. Integrity+security confirmed the exclusion is correct. The i18n note key was moved `vault.lease_readonly_note` → top-level `readonly.lease_note` (8 code sites + en/es; 0 stale refs) and the intake-stage note placement was fixed (out of the AppHeader actions button-row → standalone caption). Polish caught two more read-only-coherence items on the LeaseReview intake surface (now reachable by grace users), both fixed in the same change: the **nextStepBanner** (MEDIUM — said "upload the executed document" under a caption saying uploads are disabled) is now gated `!isReadOnly`; the **Returned-for-Revision** instruction sentence (LOW) is hidden under read-only (the rejection-reason quote stays). Doc reconciled (`VAULT_TIER_SPEC.md` key ref). Reviewed: integrity + security + auditor + polish — all clean on the adoptions (no false-positive lockout: trialing/past_due stay active; helper === server `is_workspace_live()` set). typecheck clean; 1090 tests pass. **Deferred (non-blocking):** FailedLeaseBanner export-hint for grace users on failed leases (original #137 LOW — low frequency); component-level regression tests asserting grace gating on the 3 pages (the pure helper logic is covered by `workspaceReadOnly.test.ts`; the adoptions are mechanical + statically verified) — add when those pages next get a test harness.

### Item #142: `deno-lint` CI gate excludes `no-import-prefix` + `no-control-regex` repo-wide (gate-config decision) — RESOLVED 2026-06-22

> **Filed 2026-06-22** (branch `claude/affectionate-hamilton-bp58tu`). The `deno-lint` job (added #65, `.github/workflows/ci.yml`, `deno-version: v2.x`) began failing on PR #71 because Deno shipped **`no-import-prefix`** as a default rule after #65 landed. It rejects the canonical inline `https://esm.sh`/`https://deno.land` imports used by **all 62 edge functions**, so any PR that changes any edge function now fails the gate regardless of the actual change. A second new default rule, **`no-control-regex`**, fired on the intentional `\x00-\x1f` filename sanitizers (`process_lease`/`retry_lease`/`audit-session`/`_shared/audit.ts`).

**Resolution:** added both rules to the `exclude` list in `supabase/functions/deno.lint.json` (alongside the pre-existing `no-explicit-any`). `no-import-prefix` is incompatible with the repo's edge-function architecture without a 62-function `deno.json` import-map migration (out of scope); `no-control-regex` only flagged security-positive control-char strippers. The genuinely-useful rules (`no-unused-vars`, `require-await`) stay ON — the same PR cleared the 9 real hits they surfaced in `process_lease`/`ai-assistant` by removing dead code (see PR #71). Verified green locally with Deno 2.8.3 running the exact gate command (`deno lint --config supabase/functions/deno.lint.json <changed files>`).

**Residual (LOW — deferred, both always-on reviewers flagged it as a judgment call, not a defect):** the two exclusions are **repo-wide**, so a *future accidental* control-char regex or a genuinely-wrong inline import won't be caught by the gate anywhere. The narrower alternative is per-site `// deno-lint-ignore no-control-regex` directives at the four sanitizer sites + keeping `no-import-prefix` excluded (it has no acceptable per-site story without the import-map migration). Revisit if/when the edge functions adopt a `deno.json` import map.

---

### Item #143: `retry_lease` `source_document_replaced` audit insert passes a non-existent `workspace_id` column (silent audit-row loss)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-repository-integrity-reviewer` while reviewing the Cluster B2 race fix; **pre-existing** (from the C1 in-place re-upload work, 2026-06-21, commit on `claude/affectionate-hamilton-bp58tu`) — unrelated to the B2 change. Per "pre-existing issues are their own beat," filed not bundled.

**Severity:** Medium (audit-trail loss — "every change is attributable" gap on the source-document-replacement event).

**Symptom:** `supabase/functions/retry_lease/index.ts:712-723` inserts the `source_document_replaced` audit row with `workspace_id: lease.workspace_id ?? null`, but `lease_activity_log` has **no `workspace_id` column** (confirmed live 2026-06-23: columns are `id, lease_id, user_id, activity_type, from_status, to_status, details, created_at`; an archived migration added `workspace_id` long ago but the squashed baseline `20260516120000_baseline_schema.sql` dropped it). supabase-js/PostgREST rejects an insert with an unknown column (`PGRST204`), so this insert **always fails** — and because the failure is best-effort (`if (logError) console.error(...)`, :724-726), the file IS re-pointed but the attribution row for the source-document swap is silently lost. An auditor reconstructing why a lease's stored PDF changed finds no record.

**Fix (stub):** drop the `workspace_id` key from the insert object (the reclaim-stuck-extractions sweep + the convention writers already omit it). Confirm no other `lease_activity_log` insert in the repo passes `workspace_id` (grep `lease_activity_log`); if others do, fix them in the same pass. Then exercise a retry-with-re-upload and confirm the `source_document_replaced` row lands.

**Where to look:** `supabase/functions/retry_lease/index.ts:712-726`; schema `supabase/migrations/20260516120000_baseline_schema.sql` (lease_activity_log).

---

### Item #144: Firm-page polish LOWs surfaced during the Cluster C layout consolidation (deferred)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-product-polish` while reviewing the firm-page layout consolidation (Cluster C). All **pre-existing** (the consolidation only changed page wrappers/headers, not these behaviors) — filed, not bundled, per "pre-existing issues are their own beat."

**Severity:** Low (×3).

- **FirmDashboard loading-frame flash.** `src/pages/app/firm/FirmDashboard.tsx` — the not-member guard is `!isLoading && !isFirmUser`, so during the brief `isLoading` window a real firm user sees the header title fall back to `firm.fallback` ("your firm") and all four stat cards render `0` — reads as "your firm is empty" rather than "loading" for ~1 frame. **Fix:** gate the header title on `currentFirm?.firm_name` (skeleton title while loading) and skeleton the stat cards, matching the `usageLoading` line already shown below.
- **FirmOnboarding has no Back affordance between wizard steps.** `src/pages/app/firm/FirmOnboarding.tsx` — the `details → workspace → billing` stepper only advances; a user who mistypes the firm name on step 1 has no in-wizard way back. **Fix:** add a ghost "Back" button on steps 2/3 that decrements `step`. (The centered-wizard treatment itself is correct and documented inline — no change there.)
- **FirmNotMemberState title may oversell an action it doesn't offer.** `src/components/firm/FirmNotMemberState.tsx` — `firm.none_title` ("No firm yet") reads like a setup prompt, but the only action is "Back to workspace." **Fix:** either soften the title to a closed-state phrasing, or (if self-serve firm onboarding is surfaced) add a "Set up a firm" link to `/app/firm/onboarding` — a product/copy decision tied to #105's self-serve onboarding rollout.

---

### Item #145: App shell has no mobile/narrow-viewport sidebar collapse — content unusable below ~640px (pre-existing, app-wide)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-layout-design-reviewer` while reviewing the Cluster C.2 Dashboard responsiveness fix. **Pre-existing** app-shell limitation, identical on every authenticated page — NOT introduced by the responsiveness work (which correctly targets laptop + tablet and nails both). Filed for prioritization, not bundled.

**Severity:** High (true-mobile usability) — calibrated below "Critical" because LeaseIO is a desktop/laptop-first SMB finance tool and phone usage is likely rare, but it IS a real broken state.

**Symptom:** The shell sidebar is a `fixed` overlay and `<main>` reserves its width via padding, with **no responsive breakpoint** — so below ~640px the content column is only ~70–120px wide regardless of which page. The per-page responsive grids (Dashboard, etc.) are correct, but they have almost no width to work with because the shell never yields the sidebar inset.

> **Update 2026-06-23** (sidebar collapse/resize/reorder, same branch): the static `w-64` / `pl-64` cited in the original filing are **gone** — `AppSidebar.tsx` now sets the `<aside>` width via inline style and `AppLayout.tsx` sets `<main>`'s `paddingLeft` dynamically from `useSidebar()` (`collapsed ? 72 : width`). A manual collapse **toggle** now exists, so a user who finds it can shrink the rail to 72px — a partial mitigation. But there is still **no automatic** responsive collapse / off-canvas drawer below `lg`, so the core defect stands: a phone/tablet user lands on the un-collapsed shell with a crushed content column and must discover a 24px edge chevron to recover. Surfaced again here by both `lease-product-polish` (rated Critical for this feature's premise) and `lease-layout-design-reviewer` (rated High, ≤768px tablet) — both confirmed pre-existing and NOT regressed by the collapse work.

**Fix (stub):** below `lg`, render the sidebar as an off-canvas drawer (hamburger toggle in `AppHeader`; `AppSidebar` slides in over a scrim) and set `<main>`'s `paddingLeft` to 0. The desktop collapse/resize/reorder affordances are conveniences layered on top; the mobile case needs a real drawer. Shell-level change touching `AppLayout` + `AppHeader` + `AppSidebar` — its own ticket with layout + polish review, not folded into a page-level change. Confirm with the product owner whether mobile is a target before investing.

**Where to look:** `src/components/layout/{AppLayout,AppHeader,AppSidebar}.tsx`.

---

### Item #146: Layout-scaffold residuals from Cluster C.3 (deferred)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-layout-design-reviewer` + `lease-product-polish` while reviewing the content-page width standardization (Cluster C.3). Both **pre-existing** / scaffold-level — filed, not bundled.

**Severity:** Low (×2).

- **AppHeader is full-bleed while PageLayout caps the body → header right-edge floats on ultrawide.** `src/components/layout/AppHeader.tsx:34` (`px-4 sm:px-6`, no `mx-auto`/max-width) vs `src/components/layout/PageLayout.tsx` (`mx-auto max-w-*`). On a screen wider than the page's width cap (≈≥1536px for a `wide` page), the sticky header's right-aligned actions (e.g. "Add Lease", "Export all", "New Request") sit flush to the viewport edge while the body content is pulled in — header and body no longer share a right edge. Consistent app-wide (every AppHeader page), so it reads as a deliberate convention, not a regression — but it's the one remaining "is this on purpose?" beat in the scaffold. **Fix (scaffold ticket, not page-level):** give `AppHeader`'s inner content the same width treatment as the page body — either a width prop matching PageLayout's variant, or wrap the header's title/actions row in `mx-auto max-w-7xl` (keeping the bar itself full-bleed for the border/backdrop). Note a single header cap won't perfectly align the `narrow` ApprovalQueue, so a width-prop is the clean solution.
- **Leases over-filtered empty result has no one-click "Clear filters".** `src/pages/Leases.tsx` (the `filteredAndSortedLeases.length === 0` cell, ~:530) shows "No leases match your filters" but the user must manually clear the search box AND reset the expiration Select to recover. Pre-existing; C.3 made the table the page's focal element so the blank result cell is more prominent. **Fix:** when the filtered result is empty while filters are active, render a "Clear filters" button in the empty cell that resets `searchQuery=''` + `expirationFilter='all'`.

---

### Item #147: Cluster D (performance/advisor remediation) — status + remaining lints

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Tracks the Supabase performance-advisor remediation. Two slices DONE + APPLIED to staging this session; two lower-priority lints remain.

**DONE (applied to staging, reviewer-clean):**
- **`unindexed_foreign_keys` (13) + `duplicate_index` (2) — RESOLVED.** Migration `20260623120000_perf_fk_indexes_and_dedupe.sql`. Covering indexes added for the 13 flagged FKs; 2 redundant duplicate indexes dropped. Auditor APPROVED + integrity INTEGRITY-NEUTRAL.
- **`auth_rls_initplan` (134) — RESOLVED.** Migration `20260623140000_wrap_rls_auth_uid_initplan.sql`. All 134 public RLS policies' bare `auth.uid()` wrapped as `(select auth.uid())` (InitPlan caching) via an idempotent, semantics-preserving in-place `ALTER POLICY` generator with a fail-closed string-literal guard. Verified: 0 bare remaining, 134 wrapped, 0 double-wraps, idempotent re-run = no-op. Security APPLY + integrity INTEGRITY-NEUTRAL.

**REMAINING (not started — lower priority):**
- **`multiple_permissive_policies` — RESOLVED 2026-06-23.** Migration `20260623160000_consolidate_multiple_permissive_policies.sql` (APPLIED to staging). Collapsed the overlapping PERMISSIVE policies on 9 tables (alert_rules, approval_chain_steps, approval_policies, firm_invitations, firm_members, invite_tokens, lease_approval_chain, profiles, workspace_approvers) into one policy per command whose USING/WITH CHECK is the OR-union of the originals — semantics-preserving by the permissive-OR-union principle (Postgres already OR's permissive policies per command). ALL-policies that overlapped a separate SELECT read were split into per-command write policies + a merged read. Verified: 0 remaining overlap groups (all public tables), 0 bare `auth.uid()` reintroduced, every command retains exactly one permissive policy, RESTRICTIVE "live workspace" gates untouched. Security APPLY + integrity INTEGRITY-NEUTRAL. **Two follow-up notes:** (1) **#106** — the profiles UPDATE merge PRESERVED current behavior; the `current_workspace_id` WITH CHECK guard in the old `profiles_update_self` was already dead (OR'd against the looser `profiles_update_own`), so enforcing it remains a separate authorization decision. (2) **Static test drift** — `src/lib/__tests__/firmUxMigration.test.ts:139-140` asserts the OLD firm-invitation policy names against the historical file `20260616120000_phase10_firm_ux.sql` (still passes — it reads that file, not live state). The live firm policies are now the consolidated names (`firm invitations read/insert/update/delete`, `firm members read/insert/update/delete`); if the team wants the firm-policy invariants re-asserted against live names, add a test against the new migration. Non-blocking (pre-existing static-test limitation per CLAUDE.md).
- **`unused_index` (53, INFO).** Indexes with no recorded scans. **Do NOT drop blindly** — advisor "unused" reflects current pg_stat usage, which resets and misses rarely-run-but-important paths (reports, admin, cron). Audit each against the query that created it before dropping; defer until there's a reason to touch it.

---

### Item #148: Sidebar nav residuals surfaced by the collapse/resize/reorder review (deferred)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-product-polish` + `lease-layout-design-reviewer` while reviewing the sidebar collapse/resize/reorder feature. Both **pre-existing** — filed, not bundled (the collapse work neither introduced nor materially worsened them; the firm entry was already a translated label adjacent to the English ones).

**Severity:** Low (×2).

- **Workspace nav labels are hardcoded English while the Firm entry + firm-mode nav are i18n'd → mixed-language for ES users.** `src/components/layout/AppSidebar.tsx` builds `standardItems` with literal `'Dashboard' | 'Leases' | 'Approvals' | 'Portfolio' | 'Reports'`, but the Firm item uses `t('firm.nav.firm')` and the firm-mode block uses `t('firm.nav.*')`. An ES user sees `Panel`-adjacent English ("Dashboard, Leases, Firma, Approvals, Portfolio, Reports") in one vertical list; the collapsed-rail tooltips inherit the same English labels. **Fix:** the keys mostly already exist (`nav.dashboard`, `nav.leases`, `nav.portfolio`, `nav.reports` in both locales) — swap the literals for `t('nav.*')` and add the one missing key (`nav.approvals`) to `en`+`es`. Small, closes the half-translated state. (Pre-existing hardcoding; per project rule filed rather than bundled into the collapse change.)
- **Active-route highlight uses exact `pathname === href` match → no parent highlight on nested routes.** `src/components/layout/AppSidebar.tsx` (`isActive` in the link renderers). On `/app/leases/:id`, `/app/reports/disclosure`, `/app/reports/audit-log`, etc. the parent nav item shows no active state in either width — momentary "where am I?" disorientation, sharper in the collapsed rail where the label is also gone. **Fix:** use a route-prefix (`startsWith`) match for the parent item, guarded against false matches (e.g. `/app/leases` matching a hypothetical `/app/leasesX`) by requiring an exact match or a trailing `/`. Pre-existing; the collapsed rail makes the lost orientation more noticeable.

**Where to look:** `src/components/layout/AppSidebar.tsx`; `src/locales/{en,es}/common.json` (`nav.*`).

---

### Item #149: Sidebar drag-reorder — accepted design decisions (WONTFIX, do not re-flag)

> **Filed 2026-06-23** (branch `claude/relaxed-clarke-oksfz4`). Recorded so the collapse/resize/reorder feature's deliberate tradeoffs aren't re-surfaced as bugs by future polish/a11y reviews. Both were raised as **High** by `lease-product-polish` during the feature review and **explicitly accepted by the product owner**.

**Status:** WONTFIX (conscious decisions, not gaps).

- **Reorder is intentionally low-discoverability.** The drag grip in `src/components/layout/AppSidebar.tsx` (`SortableNavItem`) stays `opacity-0` until row hover/focus, and reorder is unavailable while the sidebar is collapsed. This makes nav-reorder a power-user/pointer feature most users won't find — accepted as designed. If you ever want to raise discoverability, the cheapest lever is a faint persistent grip (`opacity-30`); do that as a deliberate choice, not a "fix."
- **No screen-reader a11y for reorder.** The dnd-kit `KeyboardSensor` is wired (baseline space-to-lift / arrow-to-move works), but no `accessibility.announcements` / `screenReaderInstructions` are provided and the grip's aria-label is the generic `nav.sidebar_reorder`. A keyboard/SR user gets no narration of the interaction or result. Accepted/skipped by the product owner. If revisited, add dnd-kit announcements + a descriptive grip label.

**Where to look:** `src/components/layout/AppSidebar.tsx` (`SortableNavItem`, `useSensors`).

---

### Item #150: Portfolio Intelligence — deferred follow-ups from the build review (PR #73)

> **Filed 2026-06-24** (branch `claude/relaxed-clarke-oksfz4`). The Portfolio page was recomposed from the PV/liability view into the occupancy-cost & commitment "Portfolio Intelligence" surface (`src/lib/portfolioIntelligence.ts` + `portfolioWatchlist.ts` + `src/pages/app/Portfolio.tsx`). The 5 reviewer-surfaced **High** findings were fixed in PR #73; these are the **deferred** items, recorded so they aren't re-discovered cold.

**MEDIUM**
- **Forecast tail bucket counts only one year, not "and beyond."** `rentCommitmentForecast` (`portfolioIntelligence.ts`) walks the window to `tailYear+1`, so the `"{year}+"` bar represents a single year — a lease running to 2050 contributes the same 12 months to the tail as a 2032 lease. The `+` label implies an aggregate. Fix options: (a) fold all months ≥ tailYear into the tail for *contracted* (true aggregate) while capping *uncontracted* to one representative year (run-rate doesn't aggregate across years), or (b) relabel the bucket as the single year. Deferred — both options have honesty tradeoffs; needs a product call on the tail's meaning.
- **Layout: no shared stat-tile / card-padding drift.** Portfolio's `KpiTile` duplicates the Dashboard `SummaryStrip` stat treatment (different type scale, lacks `tabular-nums`), and the page mixes `p-4`/`p-5` card paddings. The clean fix is extracting a shared `StatTile` primitive + a `warning` Card variant (the Index-Lease Disclosure hand-rolls `border-l-amber-400` instead of a `--warning`-tokened variant). Deferred — cross-page refactor, wants its own pass.

**LOW**
- **Full i18n of the Portfolio surface.** Copy is English-hardcoded (matching the *prior* Portfolio page — not new drift; only `formatCurrency` is localized). Includes the watchlist's generated factual sentences in `portfolioWatchlist.ts`, which would need the engine to return structured params + a UI-side translator. Deferred.
- **Header `Export` action not built.** The design's top-right Export (XLSX/PDF portfolio summary) is the one open *product decision* (format/scope). `AppHeader` already supports an `actions` slot; wire it when the format is decided. Deferred (KNOWN_ISSUES — open product decision).
- **Watchlist `sourceField` provenance not wired to a deep-link anchor.** Each flag carries `sourceField` (provenance), but the "View lease" link goes to the lease detail without scrolling to the cited clause. Either thread `sourceField` into the link as an anchor the LeaseReview page consumes, or drop the "deep-link anchor" phrasing from the JSDoc. Deferred.
- **Dept palette dark-mode contrast.** `DEPT_COLORS[0]` navy (`hsl(213 50% 23%)`) is low-contrast on dark cards. The cost-per-sqft + forecast collision was fixed via `--chart-*` tokens (PR #73), but the segmented dept bar still uses fixed hsl. Minor; bump the navy lightness or route through a token if it bothers in dark mode.

**Related:** this rewrite fully **unanchors the #42 dead-PV cluster** — `src/lib/portfolioAnalytics.ts` is now imported only by the unmounted `FinancialSummary.tsx`, so closing #42 (delete `FinancialSummary.tsx`) also makes `portfolioAnalytics.ts` + its test deletable. Not bundled into PR #73 per the pre-existing-issues rule.

---

### Item #151: Leases redesign — Dashboard "Chain violation" drill-down lost its violations-only filter (LOW)

> **Filed 2026-06-25** (branch `claude/relaxed-clarke-oksfz4`, Leases redesign Phase 1/2 reviewer gate). The Leases page replaced the legacy `?view=` query params (`active`/`approval`/`violations`) with a single `?status=` scope (`active`/`archived`/`all`). All stale links were repointed: `?view=active` → `?status=active`, `?view=approval` → `/app/approvals` (the page these leases moved to). **But `?view=violations`** (the `useNeedsAction` "Chain violation — retroactive approval required" flag, `src/hooks/useNeedsAction.ts:162`) had no equivalent — the redesigned Leases page has no violations-only filter.

**Current behavior (acceptable, not broken):** the flag now points at `?status=active`. `chain_violation` ∈ `PORTFOLIO_STATUSES` and the `active` scope is `.in('lifecycle_status', PORTFOLIO_STATUSES).eq('archived', false)`, so the violation lease(s) ARE visible in the landing list — the user just lands on the full active list instead of a pre-filtered violations view, and must eyeball/search for the `chain_violation` status badge.

**Fix options (deferred — needs a product call):** (a) add a `chain_violation` quick-filter chip to the Leases toolbar and deep-link to it; (b) keep the drill-down on the Dashboard's existing `EscalationReviewPanel`/violations surface instead of routing to Leases; (c) accept the degraded landing as-is. Low priority — the lease is reachable and the lease-detail page is the actual resolution surface (the retroactive-approval banner lives there, per the #A* / Phase-6 governance work).

---

### Item #152: Leases redesign — deferred i18n LOWs (status-badge labels + ES singular subtitle) — **RESOLVED 2026-07-12**

> **RESOLVED 2026-07-12** (full-repo i18n sweep, #160). Status badges: `src/lib/lifecycleLabels.ts` now wraps `displayLabel`/`stageLabel`/`roleLabel` with `lifecycle.status/status_short/stage/role.*` locale keys (the pure `lifecycleStates.ts` + its Deno mirror stay English-canonical); `LeaseStatusBadge` + all ~12 raw call sites render the localized labels. ES subtitle: `leases.subtitle_rent` now composes a pluralized `leases.subtitle_active_one/_other` sub-key, so n=1 reads "1 activo".

> **Filed 2026-06-25** (branch `claude/relaxed-clarke-oksfz4`, Leases redesign Phase 1/2 polish review). The Phase-1/2 i18n pass localized the Leases page chrome + the `EmptyLeaseState` card; these two remainders were deferred as pre-existing/broad.

**MEDIUM (app-wide, pre-existing — NOT introduced by the redesign)**
- **Lifecycle status-badge labels render English-only.** `LeaseStatusBadge`/`displayLabel()` (`src/components/leases/LeaseStatusBadge.tsx` + `LIFECYCLE_STATUS_CONFIG`) emit "Executed"/"Active"/"Expired"/etc. unconditionally, so an ES user sees a Spanish "Estado" header over English status pills — visible on the Leases table, Dashboard pipeline, and every lease-detail surface. Fix is a cross-surface localization of the status config (return a key per status; translate at render). Deferred — touches many surfaces, wants its own pass; out of scope for the Leases redesign.

**LOW**
- **ES subtitle has no singular agreement at n=1.** `leases.subtitle_rent` renders `"{{rent}} / mes · {{active}} activos · {{total}} total"`; at one active lease the ES reads "1 activos" (should be "activo"). i18next can't pluralize mid-string, so a correct fix means splitting into pluralized sub-keys or accepting the terse stat-chip convention (agreement often dropped in dashboard chips). Deferred as cosmetic.

---

### Item #153: Leases Phase 3 (soft-delete) — deferred follow-ups from the build review

> **Filed 2026-06-25** (branch `claude/relaxed-clarke-oksfz4`, Leases redesign Phase 3 polish review). The admin "Delete permanently" (soft-delete + 14-day retention + restore + purge cron) shipped; these are the reviewer-surfaced follow-ups deliberately deferred so they aren't re-discovered cold.

**MEDIUM**
- **RESOLVED 2026-07-12** (full-repo i18n sweep, #160 — dialog converted to `archive.*` keys, en+es): ~~`ArchiveLeaseDialog` is hardcoded English while the new `DeleteLeaseWithRetentionDialog` is i18n'd.~~ Both now sit in the same Leases kebab, so an ES user opening it sees a translated Delete dialog beside an English Archive dialog ("Archive Lease", body, "Cancel"/"Archive" buttons) — a newly-conspicuous (but pre-existing, #79) locale gap. Fix: move the Archive dialog's strings into `archive.*` keys (en+es) mirroring the delete dialog. Note the existing `archive.confirm_archive_title`/`confirm_archive_desc` keys already exist and could be reused. NOT bundled into Phase 3b per the pre-existing-issue rule.
- **No "Recently deleted" admin view for restore beyond the same-session Undo.** Phase 3b adds an Undo action on the delete success toast (immediate misclick safety) + ops-assisted restore via the `restore-lease` function. But a soft-deleted lease is hidden from every authenticated read (the `leases_hide_soft_deleted` RLS), so an admin who dismissed the toast has no in-product way to see/restore a lease deleted earlier in the window — they must contact support. Fix options: (a) a 4th Status-filter scope "Recently deleted" backed by a service-role list-deleted-leases function (RLS hides them from a normal client query, so it needs a service-role endpoint), with a per-row Restore; (b) accept ops-assisted restore for non-immediate recoveries. Needs a product call on whether self-serve late restore is wanted. The backend (`restore-lease`) is already built and ready either way.

**LOW**
- **Deleting an already-archived lease** uses generic dialog copy that doesn't acknowledge the archived state. The 14-day window still applies correctly; only the messaging could note it. Cosmetic.

---

### Item #154: Leases table — status-coherence + scope-blind-empty-state findings (polish surface sweep)

> **Filed 2026-06-25** (branch `claude/relaxed-clarke-oksfz4`). Surfaced by `lease-product-polish`'s broad surface+state walk while fixing the archived double-badge (Active+Archived → Archived-only) + adding Status/Days-to-Expiry sort. The double-badge + sort fixes shipped; the items below are the OTHER findings on the same surface, NOT bundled into that fix per the pre-existing-issue rule. Severities are the agent's rating with my (operator) re-assessment noted.

**HIGH (agent) → MEDIUM (my reassessment: redundant, not contradictory) — expired lease shows "Expired" twice.** `src/pages/Leases.tsx`: the Days-to-Expiry cell (`getExpirationBadge`, `days < 0` → red destructive "Expired") and the Status cell (`LeaseStatusBadge`, `expired`) both render "Expired" for a non-archived expired lease, in different colors. Same "two status" *felt* problem the owner caught, one column over — though the two AGREE (redundant) rather than contradict, so I down-rate it. Fix: when expired, let Status own the word and render the Days-to-Expiry cell as the numeric overage (e.g. "−42d") or "—".

**HIGH (agent) → MEDIUM-HIGH (my reassessment) — scope-blind empty state.** `Leases.tsx` `leases.length === 0` branch only special-cases `scope === 'archived'`. With `scope = 'active'` (or `'all'`) and zero portfolio leases but archived/in-flight ones existing, the user gets the full marketing `EmptyLeaseState` ("Submit a request to get started") — a dead-end that ignores the leases they actually have, reachable in one click via the scope select, and the scope control itself isn't rendered in the empty branch. Fix: scoped empty state + a visible "Show all leases" reset, and keep the scope `Select` visible above any empty body.

**MEDIUM — "Clear filters" doesn't reset scope.** The over-filtered "no match" → Clear-filters button resets search/type/expiry but NOT `scope`, so a user filtered into an empty Archived/Active scope stays at zero rows after clicking the button that promises a clean slate. Fix: also reset `scope` to `'all'` (or relabel).

**MEDIUM — false expiry countdown on dead leases.** Days-to-Expiry renders a colored countdown / red "Expired" for `rejected` / `cancelled` / archived leases (which still carry a `lease_end`), implying a renewal action on a dead lease. Fix: suppress the expiry badge ("—") unless the lease is live (`active`/`executed`/`fully_executed`). (Overlaps the HIGH-#1 fix.)

**MEDIUM — scope control hidden when list is empty.** The filter/search/export toolbar (including the scope `Select`) is hidden whenever `leases.length === 0`, removing the primary axis control exactly when the user needs it to change scope. Fix: keep the scope `Select` visible above the empty body.

**LOW** — ~~(a) property cell has no `title`/tooltip for long addresses~~ ✅ RESOLVED (the fit-to-width + resize work added `title` to property/landlord/monthly-rent and dropped `max-w` for table-fixed column control); ~~(b) double horizontal-scroll container~~ ✅ RESOLVED (the redundant outer `overflow-x-auto` wrapper was removed in the same work — the `Table` primitive's own `overflow-auto` is the sole scroll container); (c) keyboard pass on the kebab actions cell (confirm Tab-reachability + that Enter on the kebab doesn't bubble to the row's navigate handler) — still open.

> **Note (2026-06-25):** The Leases table was reworked to fit the viewport (`table-fixed` + percentage widths, no forced horizontal scroll) and gained drag-to-resize columns (`src/lib/leaseColumnPrefs.ts`). Reset is a visible toolbar button (shown when the layout is non-default); resize is pointer-only on lg+ (no keyboard resize — consistent with the sidebar resize, #149 WONTFIX). Header/body `-ml-3` 4px offset is the accepted shadcn sortable-header pattern (not a defect).

**Already filed elsewhere (re-surfaced, not duplicated here):** lifecycle status-badge labels English-only → #152; `ArchiveLeaseDialog` hardcoded English → #153. NOTE: the archived-badge fix localizes the "Archived" pill, which now *spotlights* #152 (an ES Status column shows "Archivado" beside English "Executed"/"Active").

> **RESOLVED 2026-06-25** (commit on `claude/relaxed-clarke-oksfz4`) — the two HIGH items + the two expiry/empty-state MEDIUMs were fixed: the Days-to-Expiry chip is now gated to live leases (`isExpiryRelevant`) so it never duplicates "Expired" or flashes a false red on a dead lease (Status owns the word; overdue live leases show a tooltipped "-Nd"); empty states are scope-aware (marketing card only for a truly-empty `scope=all` workspace; scoped slices keep the toolbar + a "Back to all" reset); "Clear filters" resets scope. **Still open (LOW, deferred):** (a) the property-cell tooltip + the double horizontal-scroll container + the kebab keyboard pass; (b) the export button stays clickable on a zero-row scoped-empty slice (self-corrects with a "nothing to export" toast — acceptable); (c) **orphaned locale key `leases.expired`** in both `en`/`es` (`common.json:604`) — dead even before this change (old code used a hardcoded "Expired" string), safe to delete in a locale-cleanup pass.

---

### Item #155: Leases table — Path 2 column-visibility width-model follow-ups (deferred, need visual verification)

> **Filed 2026-06-25** (branch `claude/relaxed-clarke-oksfz4`). The Path 2 "Columns" show/hide menu + double-click auto-fit shipped (layout/polish/auditor reviewed; the clear discoverability/labeling/clamp fixes were applied). These two are **MEDIUM** layout items deferred because they require a width-model change that interacts with the resize math and the responsive `hidden` classes — and can't be verified in a headless environment. They affect the *hide-columns* state only; the default all-visible table is correct.

**MEDIUM — hidden-column redistribution is by default weight, not renormalized.** Hiding columns just stops rendering their `<th>`/`<td>`; `table-fixed` then splits the freed % among the survivors *proportionally to their default weights*, so e.g. hiding all 6 hideable columns leaves Property/Rent/Status at ~28–30% each — fills the row but reads loose/lopsided rather than deliberate. Proper fix: renormalize the **visible** set to sum 100 in JS before emitting `style.width` (and re-base the persisted widths on visibility change so the resize delta math stays consistent). Deferred — couples with `applyBoundaryResize`'s `dx/tableWidth` mapping; needs a browser to tune.

**MEDIUM/LOW — user-hidden and responsive-`hidden` are two independent truths.** A column can be `colVisible` (checkbox ticked) yet `display:none` from its responsive class (e.g. `sqft` is `hidden lg:table-cell`). At `md`/`sm` the Columns menu shows a *checked* box for a column that doesn't render → "is it broken?" + the freed-space redistribution is computed over a different set than the menu implies. Fix: make `colVisible` the single source (fold the responsive breakpoints into it, or disable/annotate menu items whose column is breakpoint-hidden at the current width). Deferred with the renormalization above.

Also noted (LOW, optional): the four bare-text cells (`monthly_rent`/`lease_start`/`lease_end`/`sqft`) have no `firstElementChild`, so double-click auto-fit on them falls back to `cell.scrollWidth` (current width) instead of intrinsic content width — graceful (the header measurement still contributes via `Math.max`), just less precise than the element-wrapped columns. Wrap their content in a `block truncate` span to make auto-fit uniform.

---

### Item #156: Lease Review — `LeaseReviewSections.tsx` field UI is hardcoded English (LOW, pre-existing) — **RESOLVED 2026-07-12**

> **RESOLVED 2026-07-12** (full-repo i18n sweep, #160): section titles + all 27 field labels render via `lease_review.section_config.*` / `lease_review.field_labels.*` with `defaultValue` fallbacks to the config literals; placeholders, empty-field captions, and the View-in-document affordance are keyed in both locales. `NeedsReviewBanner` reuses the same `field_labels` keys for vocabulary coherence.

> **Filed 2026-06-26** (branch `claude/relaxed-clarke-oksfz4`, Lease Review Phase-1 polish). **Pre-existing** i18n debt surfaced by the product-polish review; the Phase-1 "View in document" affordance joins it but did not introduce the gap. Same class as #68 (intake buttons) and #152 (status-badge labels).

**Symptom:** `SectionCard` never routes copy through `t()` — the field placeholders (`No <label> extracted`, `No asset type specified`), the empty-field caption (`Field is empty — not extracted or not present in document`), and the new `View in document` verify affordance + its `See where the AI found this — page N` tooltip are raw English. A Spanish-language reviewer sees English field chrome on the confirmation workbench while the surrounding app is translated.

**Fix (when scoped):** one i18n sweep over `LeaseReviewSections.tsx` — move all field-chrome copy into `common.json` (en + es), polish-review the Spanish. Bundle with #68/#152 if a dedicated i18n pass is scheduled rather than fixing piecemeal.

**Where to look:** `src/components/leases/LeaseReviewSections.tsx` (placeholders, empty caption, the `sourceViewable` affordance + tooltip).

---

### Item #157: Lease Review — `h-screen` workbench shell is clipped below in-flow banners (HIGH, pre-existing)

> **Filed 2026-06-26** (branch `claude/relaxed-clarke-oksfz4`, surfaced by the layout-design review of the #3/#4 responsive work). **Pre-existing** — NOT introduced by the responsive change; but that change advertises "the panes are bounded by `h-screen`", so it's the right moment to fix.

**Symptom:** `LeaseReview.tsx` mounts its root as `<div className="flex flex-col h-screen max-h-screen overflow-hidden ...">` (100vh), but `AppLayout`'s `<main>` is `min-h-screen` and renders `CancellationBanner` / `VaultBanner` / `QuotaWarningBanner` **above** `children` as in-flow `border-b` blocks (none are `position:fixed`). When any banner shows, the page is `bannerHeight + 100vh` tall, so the workbench root's `h-screen` claims a full 100vh and its **bottom edge — the resize handle + the lower portion of both PDF/form panes — lands `bannerHeight`px below the viewport bottom**, with no page-level scroll to reach it (root is `overflow-hidden`). The inner `overflow-y-auto` column still scrolls its own content, but the panel bottom / PDF page is clipped off-screen.

**Who it hits:** `QuotaWarningBanner` shows for a workspace near its abstraction cap (an engaged paying customer); `VaultBanner` shows for every Vault owner. Exactly the users who should NOT see a clipped workbench.

**Root-cause hypothesis / fix (when scoped):** the workbench root should consume *remaining* space below the banners, not a fixed 100vh — e.g. make `AppLayout`'s `<main>` an `h-screen` flex column and give the routed children `flex-1 min-h-0`, OR change the LeaseReview root from `h-screen` to `h-full`/`flex-1 min-h-0` inside a height-bounded parent. Verify with a banner visible at 1280×720.

**Where to look:** `src/components/layout/AppLayout.tsx` (the `min-h-screen <main>` + banner stack), `src/pages/app/LeaseReview.tsx:~2877` (the `h-screen max-h-screen overflow-hidden` root).

---

### Item #158: Change-set concurrency — no DB guard for "one open change set per lease" + unlock-while-pending — RESOLVED 2026-06-26

> **Filed + RESOLVED 2026-06-26** (branch `claude/changeset-concurrency-guard`, its own PR). The change-set/unlock model in `lease-governance-action`.

**Design intent (works in the happy path):** one open change set per lease at a time, serialized by (a) only a `model_locked` lease can be unlocked and (b) `createDraftChangeSet` *reuses* any existing `draft`/`pending_approval` set. Approval is **whole-change-set, all-or-nothing** — there is no per-field or per-user accept/reject, and the approver never sees "user 1 vs user 2 competing values."

**Gap 1 (resolved):** `createDraftChangeSet`'s reuse was a read-then-insert with **no DB unique constraint**, so two concurrent unlocks could both insert → two open change sets for one lease (the frontend then resolves "the lease's open set" expecting exactly one). **Fix:** partial unique index `lease_change_sets_one_open_per_lease ON lease_change_sets (lease_id) WHERE status IN ('draft','pending_approval')` (migration `20260626150000`) makes it a DB invariant; `createDraftChangeSet` now catches the 23505 the losing concurrent insert receives and re-selects the winner (reuse).

**Gap 2 (resolved):** `direct_unlock` guarded only on `model_locked && active` — it did not reject when a `pending_approval` change set already existed, so a second admin's unlock reused the pending set and left the lease `model_locked=false` but not editable. **Fix:** `hasPendingChangeSet()` + a 409 guard in `direct_unlock` and `approve_unlock_request`.

**As-built:** migration applied to staging (verified zero pre-existing duplicates first; index confirmed). No in-migration dedupe because `prevent_change_set_field_tampering` blocks `status` writes from the migration role by design — duplicates (if ever) must be cleared via the service-role function before the index can build. Security + integrity reviewed clean.

**Where:** `supabase/functions/lease-governance-action/index.ts` (`createDraftChangeSet`, `hasPendingChangeSet`, `direct_unlock`, `approve_unlock_request`), `supabase/migrations/20260626150000_changeset_one_open_per_lease.sql`.

---

### Item #159: `lease_change_sets` INSERT RLS is open to any workspace member — bypasses createDraftChangeSet (MEDIUM, pre-existing)

> **Filed 2026-06-26** — surfaced by the integrity review of the #158 concurrency fix. Pre-existing; NOT introduced by #158 (which actually *hardens* the worst symptom).

**Symptom:** the baseline RLS policy "workspace members can create change sets" (`supabase/migrations/20260516120000_baseline_schema.sql:4534`) is `FOR INSERT WITH CHECK` open to **any** authenticated workspace member, and `prevent_change_set_field_tampering` is `BEFORE UPDATE` only (it does not gate INSERT). So a member can PostgREST-insert a `draft` change set **directly**, bypassing the `createDraftChangeSet` edge path — which emits **no `change_set_created` audit row** and (post-#158) gets a raw 23505 instead of the graceful reuse if it collides with an existing open set. Weakens "every change is attributable."

**Mitigated, not closed, by #158:** the new partial unique index now blocks a *second* open set at the DB layer regardless of writer (the edge-function-only guard never could) — so the duplicate-draft hole is closed, but the un-audited direct INSERT path remains.

**Stub remediation (own PR):** restrict the change-set INSERT policy to `service_role` only (forcing all creation through `createDraftChangeSet`, matching the status-write posture), OR add a `BEFORE INSERT` audit/guard trigger that stamps the creation event. Sweep `lease_change_set_items` INSERT policy in the same pass.

**Where:** `supabase/migrations/20260516120000_baseline_schema.sql:4534` (INSERT policy), `supabase/functions/lease-governance-action/index.ts` (`createDraftChangeSet` — the intended sole creator).

---

### Item #160: Full-repo en/es i18n sweep — as-built + the deliberate remainders (2026-07-12)

> **Filed 2026-07-12** after the owner's directive that the Spanish experience be 100% translated repo-wide. The sweep converted ~850+ strings across ~95 files (7 parallel batches A–G + a coordinator straggler pass H): every page, dialog, toast, badge, PDF builder, and lib-generated copy surface now renders through i18next with en+es keys (formal usted). `localeParity.test.ts` fails CI on key drift; CLAUDE.md's locale rule is ENFORCED. Resolves #68, #152, #156, and the #153 ArchiveLeaseDialog bullet. The items below are the **deliberate remainders**, each with a reason — not misses.

**MEDIUM — DB-written notification/audit messages are frozen in English at write time.** `lease_activity_log.details.message` inserts (`LeaseRequestForm` notify helpers, `FinancialReview`/`ApprovalQueue`/`LeaseReview` comment-row writers: 'Request details updated', 'Abstraction triggered', 'Processing cancelled by user', chain notifications) and `createLeaseNotification` message args are shared records read by *other* users — translating at write time would bake the writer's language into everyone's audit trail. Correct fix is render-side: store a `message_key` + params (or `notification_type`-keyed rendering) and translate at display, keeping the stored record language-neutral. Touches the activity-log shape → wants its own scoped pass.

**MEDIUM — ASC 842 exception flags are English in the PDF + JSON.** `asc842Report.ts` `buildExceptions` emits ~12 `{severity, title, explanation}` flags with no machine code; they ship in the disclosure JSON (schema-documented contract, `docs/JSON_REPORT_SCHEMA.md`) and render verbatim in the PDFs. Localizing needs an `exception_code` per flag (JSON keeps canonical English + code; PDF translates by code) and a schema-version bump. The PDF *chrome* (headings, disclaimer band/box via `reports.not_financial_statement`/`reports.disclaimer_body`, footer, page numbers) IS localized.

**LOW — date-fns formatting is en-only in a few spots.** `format(date, 'MMM d')`-style month/day names (UpcomingEvents calendar, two dashboard files, DocumentsTimeline timestamps) and `formatDistanceToNowStrict` durations (`workflow.share.expires_in`) render English month/duration words under es. Fix is date-fns locale plumbing (pass `{ locale: es }` from the active language) — a logic change kept out of the string sweep. `dateFormatters.ts` + `Intl`-based surfaces (incl. the new watchlist) already localize.

**LOW — portfolio dept buckets 'Other'/'Unassigned'.** `portfolioIntelligence.ts` uses these as grouping KEYS (compared in code) and they surface in Portfolio charts. Translating at source breaks comparisons; fix is a display-map at the chart boundary.

**LOW — es terminology unification.** Coexisting choices from parallel batches: "Escalación" (reused older keys) vs the STYLE-glossary "incremento(s) de renta"; `dashboard.lifecycle.executed` = "Firmado" vs the glossary "Ejecutado" (the new `lifecycle.status.*` uses "Ejecutado"). One dedicated es-copy review pass to unify; all strings are already in `common.json`, so it's a locale-file-only edit.

**Intentionally NOT translated:** language self-names ("English"/"Español"), plan names (Starter/Business/Vault — brand nouns), machine values (raw DB enums shown only in dev surfaces, filenames, `PDF`/`JSON`/`CSV`), diagnostic detail lines behind reason-coded translated errors (`NewWorkspaceDialog` stripe_error extras), and the canonical-English JSON export contract fields (`liability_disclaimer`, `banner`).

**Where:** locale files `src/locales/{en,es}/common.json` (~+870 keys each this pass); new `src/lib/lifecycleLabels.ts` + `src/lib/assetTypeLabels.ts`; converted lib generators `leaseAnalysisProse.ts`, `portfolioWatchlist.ts` (+ `language` in Portfolio's memo deps), `useNeedsAction.ts` (language-keyed query); PDF builders under `src/lib/reports/`; guardrail `src/lib/__tests__/localeParity.test.ts`.
