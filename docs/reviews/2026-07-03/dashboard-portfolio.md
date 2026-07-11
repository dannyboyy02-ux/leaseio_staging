# Review — Dashboard, Portfolio, Usage/Ops Surfaces

Reviewer scope: `src/pages/Dashboard.tsx`, all `src/components/dashboard/*`, `src/pages/app/{Portfolio,UsageContent,OperationsPage,ExtractionAnalytics}.tsx`, `src/lib/{portfolioIntelligence,portfolioWatchlist,portfolioAnalytics}.ts`, `src/hooks/useNeedsAction.ts`, plus the routes/pages those surfaces link to (`App.tsx`, `Leases.tsx`, `ApprovalQueue.tsx`, `NeedsActionPage.tsx`, `AppSidebar.tsx`) and the RLS/trigger layer in `supabase/migrations/`. Every claim below was verified in code; where something is already tracked in `docs/KNOWN_ISSUES.md` I say so instead of re-filing it as new.

---

## 1. Overall verdict

The dashboard's *composition* is right for an SMB finance lead: onboarding checklist → 5-tile KPI strip → escalation alert panel → counter-signature card → action queue + pipeline funnel → risks/activity → events → dept/trend charts (`src/pages/Dashboard.tsx:74-107`). Workspace scoping is genuinely consistent — **every** dashboard query filters `.eq('workspace_id', …)` (verified in all 11 mounted cards), and soft-deleted leases are excluded globally by the restrictive RLS policy `leases_hide_soft_deleted` (`supabase/migrations/20260625130000_lease_retention_lifecycle.sql:62-63`), so no client query needs a `deleted_at` filter.

The problems are not architectural. They are: (a) the action layer is **persona-blind** — "Needs Your Action" is actually "the workspace needs action"; (b) the dashboard has a **lifecycle blind spot** — `final_review` (signator/CFO stage) leases appear in *no* dashboard surface; (c) several counts/links are **internally inconsistent** (two different "Needs Action" numbers on one screen; a KPI tile that links to a page that cannot show the items it counted; archived leases counted by some cards and not others; two different rent bases on one screen); and (d) a cluster of **tracked-but-unremoved dead code** (KNOWN_ISSUES #42).

**Fix, don't rebuild.** Each defect is a targeted change to an otherwise sound card system.

---

## 2. CRITICAL / HIGH findings

### H1. `final_review` (signator stage) leases are invisible on the entire Dashboard

The chain lifecycle vocabulary has groups `signator_review: ['final_review']` and `awaiting_counter_signature: ['pending_counter_signature']` (`src/lib/lifecycleStates.ts:62-74`). Coverage on the dashboard:

- **LeasePipeline** stages are `submitted / under_review / approved / executed / active` (`src/components/dashboard/LeasePipeline.tsx:28-34`), matched via `isEquivalent()` (`LeasePipeline.tsx:74`), which is group equality (`lifecycleStates.ts:88-91`). `final_review` and `pending_counter_signature` match **no stage** — they silently drop out of the funnel, and out of "Total in progress" (`LeasePipeline.tsx:128-130`).
- **useNeedsAction** queries only `under_review, executed, submitted, concept_under_review, fully_executed, concept_submitted, chain_violation` (`src/hooks/useNeedsAction.ts:51-58`) — no `final_review`, no `in_negotiation`, no `pending_counter_signature`.
- **SummaryStrip** "Needs Action" and "Awaiting Approval" tiles count only submitted/under_review/concept equivalents + executed-missing-doc (`src/components/dashboard/SummaryStrip.tsx:96-114`).
- **PendingCounterSignatureCard** covers `pending_counter_signature` only (`src/components/dashboard/PendingCounterSignatureCard.tsx:73`).

Net: a lease sitting with the CFO for signature review — arguably the single most finance-critical stage of Path 1 — appears **nowhere** on the dashboard. It is not in the funnel, not in the action queue, not in any KPI. The signator's only entry points are the lease detail page / notifications (`/app/leases/:leaseId/signator-review`, `src/App.tsx:227-235`). `in_negotiation` leases do land in the pipeline's "Approved" row (same group), so this is specifically the two chain-only stages, of which `final_review` has zero dashboard compensation.

**Fix:** add a "Signature" stage to `STAGES` (matching `signator_review` + `awaiting_counter_signature` groups), and include `final_review`/`pending_counter_signature`/`in_negotiation` in `useNeedsAction`'s status list with an appropriate bucket (or at minimum in the SummaryStrip "Needs Action" count).

### H2. "Needs Your Action" is persona-blind — it shows every user the whole workspace's queue

`useNeedsAction` builds `pendingApprovals` from **all** `under_review`/`concept_under_review` leases in the workspace (`src/hooks/useNeedsAction.ts:86-104`) and `returnedLeases` from **all** leases with `financial_returned_to_submitter` (`useNeedsAction.ts:75-84`) — with no filter on the current user's functional role, chain-step assignment (`effective_assignee_user_id`), or submitter identity. The card is titled "Needs **Your** Action" (`src/components/dashboard/NeedsAction.tsx:36`) and stamps items "Overdue" (`NeedsAction.tsx:85`).

Consequences per persona:
- A **requestor** (submitter-only — whose sidebar deliberately hides Approvals, `src/components/layout/AppSidebar.tsx:293,300`) still sees "Pending Approvals … Overdue" items they cannot act on, presented as their own to-do.
- An **approver** sees other submitters' "Returned for Revision" items as if they must revise them.
- ApprovalQueue itself IS persona-aware — it splits "my review" by `isManagerApprover`/`isFinancialApprover` (`src/pages/app/ApprovalQueue.tsx:605-620`) — so the dashboard is inconsistent with the page it feeds into.

The owner's stated worry ("this will lose interest fast if it is overcomplicated for the user") applies directly: the first card a requestor sees is full of other people's work labeled as theirs.

**Fix:** partition the card into "Yours" (assigned steps / your returned submissions) vs "Workspace" (visible to approvers/admins only), reusing the functional-role checks ApprovalQueue already has. `returnedLeases` should filter `user_id = auth.uid()` (submitter).

### H3. SummaryStrip "Needs Action" tile links to a page that cannot show the counted items

The tile counts `submitted / under_review / concept_submitted / concept_under_review` leases (+ executed-missing-doc) (`src/components/dashboard/SummaryStrip.tsx:96-105`) and navigates to `/app/leases` (`SummaryStrip.tsx:182`). But the redesigned Leases page only lists `PORTFOLIO_STATUSES = ['executed','active','fully_executed','expired','chain_violation']` in every scope — 'all' is "active portfolio + archived failed/NULL rows" (`src/pages/Leases.tsx:120,246,255-259`); pre-execution pipeline states never render there. A user clicking "Needs Action: 3 items need attention" lands on a list containing **none of those 3 items** — a dead-end that reads as data loss. (The card's sibling, the NeedsAction card, is the correct landing.)

**Fix:** point the tile at `/app/needs-action` (which exists and renders exactly these buckets), or at `/app/approvals`.

---

## 3. MEDIUM findings

### M1. Archived leases are inconsistently excluded — half the cards count them

Archiving sets `archived=true` but leaves `lifecycle_status` untouched (`src/pages/Leases.tsx:295-303`). Filters by card:

| Card | `archived=false` filter? |
|---|---|
| SummaryStrip (`SummaryStrip.tsx:56`) | Yes |
| UpcomingEvents (`UpcomingEvents.tsx:113`) | Yes |
| Portfolio (`Portfolio.tsx:308`) | Yes |
| useNeedsAction (`useNeedsAction.ts:41-58`) | **No** |
| LeasePipeline (`LeasePipeline.tsx:63-66`) | **No** |
| UpcomingRisks (`UpcomingRisks.tsx:46-52`) | **No** |
| PipelineByDepartment (`PipelineByDepartment.tsx:78-82`) | **No** |
| EscalationReviewPanel (`EscalationReviewPanel.tsx:40-53`) | **No** |
| PendingCounterSignatureCard (`PendingCounterSignatureCard.tsx:67-74`) | **No** |

Concretely: archive an expiring executed lease → it disappears from the SummaryStrip "Expiring" tile but keeps firing in UpcomingRisks and keeps counting in the pipeline's Executed/Active rows and in `noDocCount` ("Executed — document missing", `useNeedsAction.ts:140-147`). The same lease is simultaneously "gone" and "a risk" depending on which card you read.

**Fix:** add `.eq('archived', false)` to the six unfiltered queries (for `useNeedsAction`, arguably keep `chain_violation` regardless).

### M2. Two different "Needs Action" numbers on the same screen

SummaryStrip's "Needs Action" stat = submitted + under_review (+ chain equivalents) + executed-missing-doc (`SummaryStrip.tsx:96-105`). The NeedsAction card badge = pendingApprovals + returned + unlocked + flag-*types* (`NeedsAction.tsx:28` — note it counts flag categories, not flag totals, while `NeedsActionPage.tsx:176` sums `flag.count` — a third variant). These regularly disagree while sitting ~200px apart. Pick one definition (the hook's) and derive the tile from it.

### M3. Escalation edit is silent (no audit trail) and its promise is false

`EscalationReviewPanel.handleSave` updates `escalation_type`/`escalation_rate`/`needs_escalation_review` directly (`src/components/dashboard/EscalationReviewPanel.tsx:78-86`) and writes **no** `lease_activity_log` row. The DB triggers don't catch it either: `log_lease_state_change` fires only on status/lifecycle change (`supabase/migrations/20260516120000_baseline_schema.sql:433-470`), and `detect_lease_attribute_change` covers only `lease_type / requesting_department / region / monthly_payment` (`20260516120000:~160-198`). For a product whose promise is "every change is attributable," a direct edit of a financial term is invisible.

Also, the success toast says "Rent schedule will recalculate on next lease processing" (`EscalationReviewPanel.tsx:90-93`) — but `rent_schedules` is only written by `process_lease`/`retry_lease` (grep of `supabase/functions/`), and a confirmed/active lease is never reprocessed by any user-reachable action. The displayed rent schedule stays stale forever; the toast implies otherwise. Bonus dead reference: it invalidates the query key `['financial-summary', …]` (`EscalationReviewPanel.tsx:95`) — the component using that key (`FinancialSummary.tsx`) is unmounted (see M8). Finally, the Edit button renders for viewer-role members whose save will fail RLS (`leases_update_own_or_workspace_editor`, `20260516120000:4214-4216`).

### M4. UpcomingRisks is a dead-end card with a self-limiting filter

- Risk rows are **not clickable** — no navigation to the lease (`UpcomingRisks.tsx:202-231`), unlike every other dashboard list.
- The list is capped to 5 **before** the filter chips apply (`UpcomingRisks.tsx:150`, filter at `:157`), so selecting "CPI" shows only CPI items that happened to be in the global top-5 — a portfolio with 6 expiring + 3 CPI leases shows "No cpi risks detected" under the CPI chip.
- There is no "view all"; the code comment claims overflow lives in "Reports / per-lease Risks tab" (`UpcomingRisks.tsx:148-150`), but `src/pages/Reports.tsx` contains no risks surface (grep: zero matches for /risk/i).
- Negative-days display: both windows lack a `>= 0` floor (`UpcomingRisks.tsx:85-121`), so an expired-but-still-`active` lease renders "-30 days".
- It also duplicates the `risks` DB table system used by LeaseReview (`src/pages/app/LeaseReview.tsx:894` reads `risks … is('dismissed_at', null)`) — the dashboard derives risks client-side, so dismissing a risk on the lease page has no effect here, and vice versa (no dismissal here at all).

### M5. Three expiration surfaces, three dismissal models

Expiration/renewal urgency appears in: SummaryStrip tiles (dismiss = per-browser `localStorage`, `SummaryStrip.tsx:32-40,140-167`), UpcomingEvents (dismiss = per-user DB `dismissed_events`, `UpcomingEvents.tsx:67-97`; table verified in `20260516120000_baseline_schema.sql`), and UpcomingRisks (no dismissal). Dismissing an expiration in one place leaves it glowing in the other two; the localStorage variant silently resets on a new device. Also the two cards disagree on what "renewal" means: UpcomingEvents emits a renewal event for *any* lease expiring in 91–180d (`UpcomingEvents.tsx:146-156`), UpcomingRisks requires `renewal_options` text (`UpcomingRisks.tsx:74-75,85-102`).

### M6. Rent basis inconsistency across cards on one screen

Schedule-aware `getMonthlyRent()` (current escalated step; `src/lib/leaseCalculations.ts:167-174`) is used by SummaryStrip, UpcomingRisks, UpcomingEvents, and Portfolio (which embeds `rent_schedules` — `Portfolio.tsx:305`). Raw `monthly_payment` is used by LeasePipeline (`LeasePipeline.tsx:85-87`), useNeedsAction (`useNeedsAction.ts:101`), and PipelineByDepartment (`PipelineByDepartment.tsx:58`). For an escalated active lease, the pipeline "Active" row $ and the "Monthly Rent" tile $ disagree on the same screen. (KNOWN_ISSUES ~line 2411 tracks a related item but is **stale** — it claims Portfolio uses base rent; post-PR-#73 Portfolio is schedule-aware.)

### M7. PipelineByDepartment mislabels and miscounts

`buildDeptSummaries` filters to leases **uploaded** within the selected 30/60/90-day window (`PipelineByDepartment.tsx:40-43`), then labels a count "N active" (`:52-54,137`) — an active lease uploaded 4 months ago never counts, so "active" here secretly means "activated AND uploaded recently". Worse, `annualValue` sums `monthly_payment` for **every** lease in the window regardless of lifecycle (`:58`) — rejected, failed, and draft requests inflate a department's "annual value" bar. No archived filter either (M1).

### M8. Dead dashboard cluster (tracked as KNOWN_ISSUES #42, still unremoved)

Zero-reference components (grep of `src/`): `src/components/dashboard/FinancialSummary.tsx:45`, `CommitmentHistory.tsx:23`, `PendingApprovalsSection.tsx:21`; `src/lib/portfolioAnalytics.ts` (the PV layer, 129 lines) is imported only by the unmounted FinancialSummary + its test. Filed in `docs/KNOWN_ISSUES.md:1159-1161` and re-confirmed at `:2639` ("closing #42 … also makes portfolioAnalytics.ts + its test deletable") — but the deletion has never shipped. This is exactly the "shipped incomplete" pattern the owner is asking about: a known, zero-risk cleanup, tracked for weeks, not executed. Note PendingApprovalsSection is a *third* implementation of the pending-approvals list (after NeedsAction card + NeedsActionPage).

### M9. Dashboard i18n is half-done

The app is i18next EN+ES ("both locale files updated together" is a standing rule), and Dashboard.tsx itself, UpcomingEvents, and OnboardingChecklist use `t()` — but NeedsAction ("Needs Your Action", `NeedsAction.tsx:36`), SummaryStrip (all 5 labels, `SummaryStrip.tsx:171-208`), LeasePipeline (`:29-33,136-146,192-196`), UpcomingRisks (`:24-29,163-177`), RecentActivity (`:38-56,153-161`), PipelineByDepartment (`:117,128`), and IntakeTrend (`:77`) hardcode English. A Spanish-locale user gets a mixed-language dashboard. (Portfolio's hardcoding is at least declared as a tracked follow-up — `Portfolio.tsx:43-46`.)

---

## 4. LOW findings

- **L1. "View all" leads to a 1:1 duplicate.** `NeedsActionPage.tsx` uses the same `useNeedsAction` hook with the same unbounded lists — the card already shows everything, so "View all" (`NeedsAction.tsx:191`) shows nothing more. Either cap the card or enrich the page.
- **L2. RecentActivity "All activity" → `/app/leases`** (`RecentActivity.tsx:159`) — not an activity surface; the audit log lives at `/app/reports/audit-log` (`App.tsx:405-414`, role-gated). Mislabeled affordance.
- **L3. OnboardingChecklist completion checks leak scope.** 'upload' counts the user's leases across ALL workspaces (`.eq('user_id', user.id)` only, `OnboardingChecklist.tsx:98-101`) — completes in workspace B from workspace A activity, and stays incomplete if a teammate did the upload. 'notifications' counts `lease_notifications … is_confirmed=true` with no workspace/user predicate at all (`:132-135`), relying on RLS breadth. Also the 'approvers' step copy ("Assign manager and financial approvers", `:44`) reflects the legacy routing model; `workspace_roles` is still live (`WorkspaceSettings.tsx:197,262`) so it works, but it predates approval policies.
- **L4. LeasePipeline "Approved" row → `/app/approvals`** (`LeasePipeline.tsx:31`): approved leases only appear there in the viewer's own "reviewed by me" history (`ApprovalQueue.tsx:632-636`) — for most users the click lands on a page not showing that stage.
- **L5. IntakeTrend dead series.** `value` (annual $) is computed per month (`IntakeTrend.tsx:58`) and has a tooltip branch (`:111`), but the chart plots only `count` (`:121-127`) — the value branch is unreachable. Also counts every upload including failed/rejected (defensible for "intake", but unlabeled).
- **L6. UpcomingRisks CPI rule always fires.** Every CPI lease gets a permanent "CPI projection not applied" flag with no date logic (`UpcomingRisks.tsx:123-134`) — steady-state noise that crowds the 5-row cap for portfolios with several CPI leases.
- **L7. UsageContent dead unlimited branch + firm-bound gap.** `activeUnlimited = activeMax === -1` (`UsageContent.tsx:106`) can never be true — no plan sets `maxActiveLeases: -1` (`src/config/pricing.ts:57,85,122`). And the single-workspace "upgrade" hint (`UsageContent.tsx:270-286`) links every user (members, firm-bound) to the Billing tab, though the banner above it carefully handles both cases (`:146-166`).
- **L8. OperationsPage is unlinked.** Route exists (`App.tsx:287-294`) with a proper upfront gate (`am_i_ops_admin` RPC, `OperationsPage.tsx:127-139`; RPC verified in `supabase/migrations/20260622000000_billing_dead_letters.sql` + baseline), but no nav anywhere references `/app/admin/operations` (repo-wide grep: App.tsx only). Acceptable for ops-staff-only, but even ops admins must memorize a URL. Header comment also claims a "30-day sparkline" while the query is simply the last 500 snapshots (`OperationsPage.tsx:5,102-107`).
- **L9. ExtractionAnalytics mixed scoping.** `totalLeases` is workspace-scoped (`ExtractionAnalytics.tsx:100-104`) but `field_corrections` and `lease_field_confidence` queries are not (`:115-117,138-141`) — a multi-workspace user sees corrections from all their workspaces against one workspace's lease count. Acknowledged in-code (`:94-99`) and the page is dev-only + role-gated (`App.tsx:390-404`), so LOW.
- **L10. SummaryStrip expiry dismissal is device-local** (localStorage, `SummaryStrip.tsx:35-38`) while UpcomingEvents dismissal is server-side — covered in M5, listed here for completeness.

---

## 5. Portfolio Intelligence — assessment

**Good.** The recomposed page is the healthiest surface reviewed:
- Pure, unit-testable derivation layer with explicit `asOf` injection and no PV/ASC-842 (`src/lib/portfolioIntelligence.ts:1-18`) — Hard Rule #1 respected; KPIs reconcile with the Dashboard by design (`getMonthlyRent` + `rent_schedules` embed, `Portfolio.tsx:302-309`).
- Business gating works: `canAccessFeature('business') || isReadOnlyRetention(...)` skips the fetch and renders an upgrade wall (`Portfolio.tsx:293-297,344-370`); sidebar marks it `requiresBusiness` (`AppSidebar.tsx:301`). Client-side feature gating only, but the data is the workspace's own — no security issue.
- Honest partial-data banner (`Portfolio.tsx:401-410`), correct archived/lifecycle filters (`:308-309`), index-lease disclosure kept factual.

Two honesty gaps:
- **Watchlist is half-lit by design but oversold.** 2 of 4 rules can never fire: `renewalNoticeDeadline` and `escalationCapEndDate` are hardcoded `null` in the mapper (`portfolioIntelligence.ts:158-161`), acknowledged in comments (`portfolioWatchlist.ts:6-11`) as awaiting a Tier-1 extraction enhancement — but no tracking item forces that enhancement, so "deterministic rules engine, 4 rules" is in practice "2 rules". The config's `cap` doc also promises "a 'view all' affordance beyond it in the UI" (`portfolioWatchlist.ts:46-48`) — Portfolio.tsx has no such affordance (`Portfolio.tsx:246-280`).
- The dormant-rule pattern is fine engineering, but it should be stated on the page (e.g., "renewal-notice flags activate once notice deadlines are abstracted") rather than only in code comments.

---

## 6. Persona walkthrough — "does the dashboard lead with what needs MY action?"

- **Requestor:** No. Sees the workspace-wide approval queue labeled "Needs Your Action" (H2). Their own returned submissions ARE surfaced (good), but drowned among others'. No "my requests in flight" view.
- **Manager approver:** Partially. Pending approvals surface, but mixed with items for the financial approver; days-waiting/Overdue is right. Sidebar Approvals badge is persona-scoped (`AppSidebar.tsx:220-243`) — the dashboard card is not, so badge and card disagree.
- **CFO/signator:** No. `final_review` is invisible everywhere on the dashboard (H1); counter-signature is covered only after their own signature step.
- **Finance/admin:** Mostly yes — KPI strip, escalation panel, chain-violation flag, risks, events give good workspace awareness — subject to the archived/count inconsistencies (M1, M2) and risk dead-ends (M4).

An SMB finance lead's first-screen wants: (1) what's stuck and whose desk it's on, (2) money at risk in the next 90 days, (3) run-rate. The pieces all exist; the persona attribution and the two chain-stage holes are what's missing.

---

## 7. Docs drift

1. **KNOWN_ISSUES ~:2411** — "Portfolio totals use *base* rent" is stale post-PR-#73: `Portfolio.tsx:305` embeds `rent_schedules` and `portfolioIntelligence.ts:149` uses `getMonthlyRent`. The remaining basis drift is now the *pipeline* cards (M6), not Portfolio.
2. **`portfolioWatchlist.ts:46-48`** promises a UI "view all" affordance that doesn't exist in `Portfolio.tsx`.
3. **`UpcomingRisks.tsx:148-150`** claims Reports is a risks overflow surface; `Reports.tsx` has none.
4. **`OperationsPage.tsx:5`** claims "30-day sparkline"; implementation is last-500-rows unbounded (`:107`).
5. **CLAUDE.md file map** for Dashboard/Portfolio is accurate (11 mounted cards listed match `Dashboard.tsx:8-18`; portfolioAnalytics correctly flagged dead) — credit where due; the drift-correction discipline visibly worked here.
6. **KNOWN_ISSUES #42** says the orphan cluster should be deleted; it still exists — tracked-but-unexecuted rather than undocumented.

---

## 8. Recommendations (priority order)

1. **Add the signator stage to the dashboard** (H1): new pipeline stage covering `signator_review` + `awaiting_counter_signature` groups; add `final_review`/`in_negotiation`/`pending_counter_signature` to `useNeedsAction`'s query with a "Signature pending" bucket.
2. **Make Needs Action persona-aware** (H2): "Yours" vs "Workspace" split using the functional-role logic ApprovalQueue already has; filter `returnedLeases` to the current submitter.
3. **Fix the Needs Action tile link** (H3): `/app/needs-action`.
4. **Unify archived filtering** (M1): one shared query helper (or add `.eq('archived', false)` in the six missing places) + a vitest pinning the filter set per card.
5. **Single "needs action" definition** (M2): derive the SummaryStrip tile from `useNeedsAction`'s result.
6. **EscalationReviewPanel**: write a `lease_activity_log` row on save, fix or remove the recalculation toast, hide Edit for viewers (M3).
7. **UpcomingRisks**: make rows clickable, filter before capping, add a floor of `daysToExpiry >= 0`, and either read the `risks` table or delete the card in favor of UpcomingEvents (M4) — two of the three expiry surfaces should merge (M5).
8. **Execute KNOWN_ISSUES #42**: delete FinancialSummary, CommitmentHistory, PendingApprovalsSection, portfolioAnalytics.ts + test, and the stale `financial-summary` invalidation (M8). ~700 lines gone, zero risk.
9. Sweep dashboard strings into i18n (M9); fix PipelineByDepartment's "active" label + value sum (M7); align rent basis (M6).
10. Portfolio: add a one-line dormant-rules disclosure on the Watchlist card; file the Tier-1 structured-dates extraction as a tracked item so the two dormant rules have an owner.

## 9. Simplification pushback (invited by owner)

The dashboard has **four** overlapping "what's urgent" systems (SummaryStrip tiles, NeedsAction card, UpcomingRisks, UpcomingEvents) plus EscalationReviewPanel and PendingCounterSignatureCard. That's six urgency surfaces with three dismissal models and two risk definitions. For the SMB user this reads as noise, not thoroughness. A defensible target: KPI strip + ONE persona-aware action queue + ONE dated-events card (UpcomingEvents, which already has groups, calendar, server-side dismissal and is the best-built of the set) — folding UpcomingRisks into it and folding the escalation/counter-signature cards into action-queue buckets. That halves the surface count without losing any information.
