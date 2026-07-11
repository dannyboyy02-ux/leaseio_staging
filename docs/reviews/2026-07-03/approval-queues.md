# LeaseIO Audit — Approval Queues & Acting Surfaces

Reviewer scope: every surface where an approver/requestor SEES and ACTS on pending work.
Method: code-first; docs used only for intent comparison. All claims carry `file:line` evidence from repo `/home/user/leaseio_staging` (branch state as of 2026-07-03).

---

## 1. Inventory of acting surfaces (as built)

| # | Surface | Route | Who | Can act? | How reached |
|---|---------|-------|-----|----------|-------------|
| 1 | **ApprovalQueue** | `/app/approvals` (`src/App.tsx:304`) | manager/financial approvers, admins (`src/components/layout/AppSidebar.tsx:292-293,300`) | YES — legacy manager inline approve/reject (`src/pages/app/ApprovalQueue.tsx:171-194`); chain-step inline approve/send-back/reject/delegate (`:389-437`); delegation revoke (`:1230-1243`); governance unlock/change-set approvals (`:1383-1396,1466-1479`) | Sidebar "Approvals" |
| 2 | **FinancialReview** | `/app/leases/:id/financial-review` (`src/App.tsx:211`) | financial approver, legacy `under_review` only (`src/pages/app/FinancialReview.tsx:339-340`) | YES — classify + approve/reject/return (`:593-611`) | Only via queue card "Open Financial Review" (`ApprovalQueue.tsx:1190-1194,1291-1293`) |
| 3 | **SignatorReview** | `/app/leases/:id/signator-review` (`src/App.tsx:229`) | pending signator step assignee (`src/pages/app/SignatorReview.tsx:199-206`) | YES — checklist + ≥30-char attestation + approve/send-back/reject | **NOTHING LINKS TO IT** (see Finding C1) |
| 4 | **NeedsActionPage** | `/app/needs-action` (`src/App.tsx:424`) | any member | NO — navigation only (rows → lease page) | Only the "View all" link on the dashboard NeedsAction card (`src/components/dashboard/NeedsAction.tsx:191`) |
| 5 | **Dashboard cards** | `/app/dashboard` (`src/pages/Dashboard.tsx:76-106`) | any member | Mostly navigate-only; EscalationReviewPanel edits escalation inline (`src/components/dashboard/EscalationReviewPanel.tsx:70-102`) | Sidebar "Dashboard" |
| 6 | **LeaseReview (lease detail)** | `/app/leases/:id` | any member | Partially — Documents tab: `advance-to-final-review` / escalate (`src/components/leases/documents/DocumentsPanel.tsx:127-201`), CounterSignaturePanel (`LeaseReview.tsx:3629-3643`), ChainViolationBanner (`:3644-3653`). **No chain-step approve/reject anywhere on the page** (`lease_approval_chain` is read only by ApprovalQueue, SignatorReview, ChainViolationBanner — grep) | Everywhere (all deep links land here) |
| 7 | **ExceptionsDashboard** | `/app/admin/exceptions` (`src/App.tsx:274`) | admin/owner | YES (stuck chains, overrides, OOO) | **NO inbound link anywhere** (grep: only the route) |
| 8 | **RerouteAuditDashboard** | `/app/admin/reroute-audit` (`src/App.tsx:241`) | admin/owner | YES ("Trigger Manual Reroute") | **NO inbound link anywhere** |
| 9 | **Notifications page** | `/app/notifications` (`src/App.tsx:320`) | any member | Mark-read + navigate | **No sidebar entry, no bell** — the header bell was deliberately removed with the claim it "duplicated /app/notifications" (`src/components/layout/AppHeader.tsx:28-30`); only inbound link is an OnboardingChecklist step (`src/components/dashboard/OnboardingChecklist.tsx:53`) |

**Answer to the fragmentation question:** an approver does NOT have one obvious place. Pending work is spread across the sidebar badge, ApprovalQueue (4 tabs), the dashboard NeedsAction card, the NeedsActionPage duplicate, SummaryStrip "Awaiting Approval" tile, LeasePipeline bars, PendingCounterSignatureCard, and email — each computed from a DIFFERENT query with different scoping (user-assigned vs workspace-wide), so the numbers disagree with each other routinely (details in Findings H4, M2).

---

## 2. CRITICAL findings

### C1 — The signator (CFO) approval gate is broken end-to-end in the UI
The owner's Path-1 flow culminates in "CFO (signator) signs". As built:

1. **SignatorReview is orphaned.** The dedicated attestation page exists and is routed (`src/App.tsx:227-235`) but a repo-wide grep for `signator-review` finds ZERO navigations to it — only the route definition and docs. `docs/PHASE_5_BUILD_SPEC.md:226` explicitly says "Clicking the row navigates to a dedicated signator page at `/app/leases/{id}/signator-review`" — the code never does this.
2. **The queue's inline Approve on a signator step is a guaranteed dead-end.** `ChainStepCard`'s Approve button calls `submit('approve')` with `comment: comment.trim() || undefined` where `comment` is only ever set inside the send-back/reject dialogs (`src/pages/app/ApprovalQueue.tsx:311-338,389-397`). The server rejects signator approves without an attestation: `supabase/functions/act-on-chain-step/index.ts:252-262` returns 400 "Signator approval requires a non-empty attestation. Type your intent-to-bind statement before approving." — but the card has **no field to type it** and no route to the page that has one.
3. **The "View" escape hatch leads to a trap.** `onView` navigates to `/app/leases/{id}` (`ApprovalQueue.tsx:1201`). A `final_review` lease renders the extraction workbench (`LeaseReview.tsx:429-433` — `isIntakeStage` excludes `final_review`), whose header primary button is "Ready to Approve"/"Pending Review" (`LeaseReview.tsx:2776-2790`) — which calls `handleApproveLease` (`:1713`), the **AI-extraction section-review approval** that writes `extracted_json._approval`. It has nothing to do with the signator step. A CFO clicking the only "Approve" they can find approves the wrong thing.
4. **The signator is never notified anyway** — see H2.

Net: the final signature gate of the core flow cannot be completed through the UI without hand-typing `/app/leases/<uuid>/signator-review`. **Severity: critical (blocks core flow).**

**Fix:** (a) In `ChainStepCard`, when `step.stage === 'signator'`, replace inline Approve with a primary "Open Final Review" button navigating to `/app/leases/${leaseId}/signator-review`; (b) add a `final_review` banner + same link on LeaseReview for the pending signator assignee; (c) suppress the extraction "Ready to Approve" primary on chain in-flight statuses.

---

## 3. HIGH findings

### H1 — Legacy approve/reject/return notifications to the submitter are silently dead-lettered
The delivery pipeline only delivers rows carrying `details.recipient_ids`:
- Email cron skips rows without recipients (`supabase/functions/dispatch-notifications/index.ts:59-60`).
- In-app fanout trigger fires only `WHEN (NEW.details ? 'recipient_ids')` (`supabase/migrations/20260618180000_fanout_recipient_notifications.sql:110`).
- `legacy-lease-action` itself writes **no** notification rows at all (full read of `supabase/functions/legacy-lease-action/index.ts` — only audit rows, `:459-468`).

But every submitter-outcome row is written WITHOUT `recipient_ids`:
- Manager reject from queue: `ApprovalQueue.tsx:1069-1077` (`notify_submitter_rejected`, no recipients) — while the dialog promises "The submitter will be notified with your reason" (`:1600-1603`).
- Financial approve: `FinancialReview.tsx:247-256` (`notify_submitter_approved`, no recipients).
- Financial return/reject: `FinancialReview.tsx:288-309` (`notify_submitter_returned` / `notify_submitter_rejected`, no recipients).

So the requestor is never told, by any channel, that their request was approved, rejected, or returned. (Returned-for-revision is partially rescued by the dashboard NeedsAction "Returned for Revision" bucket, `src/hooks/useNeedsAction.ts:75-84`; rejection has no surface at all except the lease's own status badge.) **Fix:** add `recipient_ids: [lease.requestor_id]` to these four writes — ideally move them server-side into `legacy-lease-action` so they can't be skipped by a closed tab.

### H2 — Nobody is notified when a chain advances (mid-chain steps and the signator)
- `act-on-chain-step` computes `nextAssignees` after each approve but explicitly does not notify them — comment: "Phase 2/3 does not notify signator yet, but compute and return them so the caller has the data if it wants to surface it" (`supabase/functions/act-on-chain-step/index.ts:586-589`, also `:617`). Both frontends discard the response payload (`ApprovalQueue.tsx:314-334`, `SignatorReview.tsx:276-288`). Only submission-time first-step assignees are notified (`src/components/workflow/LeaseRequestForm.tsx:395-404`, `src/lib/leaseNotifications.ts:102-139`).
- `advance-to-final-review` notifies only the `workspace_roles.role='signator'` cohort (`supabase/functions/advance-to-final-review/index.ts:369-389`) — but **no UI can grant the `signator` role**: WorkspaceSettings assigns only the two approver slots + submitter/admin checkboxes (`src/pages/settings/WorkspaceSettings.tsx:596-600,715`), even though the DB CHECK allows `signator` (`supabase/migrations/20260516120000_baseline_schema.sql:2101`) and the policy editor offers it as a step role (`src/pages/settings/ChainDiagram.tsx:56-66`). It also ignores the signator chain step's actual `approver_user_id`. In practice `recipientIds` is empty → zero notification.

Net effect: in any chain with >1 sequential concept level, or any chain at all reaching the signator, downstream approvers learn about their work only if they habitually open `/app/approvals`. **Fix:** notify `nextAssignees` inside `act-on-chain-step` (server-side, atomic with the transition) and make `advance-to-final-review` notify the pending signator step's assignee (user or role holders).

### H3 — The nudge system has no working entry point (button is dead code)
`NudgeApproverButton` renders in exactly one place, gated on `isPendingApproval` (`src/pages/app/LeaseReview.tsx:2988-2991`) — and `isPendingApproval` is hardcoded: `const isPendingApproval = false;` (`LeaseReview.tsx:436`). It can never render. The intake-stage view (submitted/under_review — where nudging matters) doesn't include it at all (`:2121-2677`). The whole server side exists and works (`supabase/functions/send-nudge/index.ts` — chain-aware recipient resolution `:95-121`, cooldown `:82-89`, immediate dispatch) but is unreachable. `docs/KNOWN_ISSUES.md:2090-2099` (#109) records the nudge as "BUILT … `NudgeApproverButton` rewired to call `send-nudge`" — the rewiring is real but the render gate was never fixed, so #109's symptom ("the approver receives nothing") is still user-reality. Also: `NudgeType` defines `automatic_day2/5/10` (`src/types/lifecycle.ts:78`) with no implementation anywhere (only `manual` is written, `send-nudge:146`). **Severity: high** — it is the requestor's only recourse against a stalled approver, and the owner named the nudge system as part of the core flow.

### H4 — Sidebar "Approvals" badge and nav visibility do not match who actually has work
- **Badge counts the wrong thing.** It counts workspace-wide leases in `submitted`/`concept_submitted` for anyone holding `manager_approver`, and `under_review`/`concept_under_review` for `financial_approver` (`src/components/layout/AppSidebar.tsx:222-242`) — not steps assigned to the user. For chain workspaces this produces a **phantom badge**: chain lifecycle states are counted, but the queue's legacy tabs exclude chain statuses (`ApprovalQueue.tsx:607-619,628-630`) and the chain section only shows steps assigned to *you* — so a financial approver can see "3" in the sidebar and an empty queue. Conversely the badge **omits**: pending signator steps (lease is `final_review` — in no badge query), execution-owner counter-signature items, delegated/chain steps assigned to you by user id, and governance items (all of which the queue's own tab badge counts, `ApprovalQueue.tsx:1306-1308`). Two different numbers for "my pending approvals" in the same viewport.
- **Badge never fetches for admins without functional roles** — early return on `!userFunctionalRoles.length` (`AppSidebar.tsx:217`), yet admins see the nav (`:292,300`).
- **Nav hidden from legitimate assignees.** `canAccessApprovals` requires manager/financial role (`src/lib/authorization.ts:29-30`) and `isSubmitterOnly` hides the entry for anyone with roles that aren't manager/financial/admin (`:33-37`) — while the policy editor lets ANY workspace member (`src/pages/settings/ApprovalPolicyEditPage.tsx:120-135`) or the `signator` role be a chain-step assignee. A user-assigned or signator-role approver has pending steps in the queue they can never navigate to.

**Fix:** derive both badge and nav visibility from the same query the queue's "Needs My Review" tab uses (assigned pending chain steps + legacy role queries + execution-owner + governance), and show the nav whenever that count can be >0.

### H5 — In-flight chain leases vanish from every list surface
- Leases page shows only portfolio statuses in **all** scopes (`src/pages/Leases.tsx:120` `PORTFOLIO_STATUSES = ['executed','active','fully_executed','expired','chain_violation']`; `:244-259`), by design ("Approvals owns that lifecycle", `:113-115`).
- But ApprovalQueue "All Pending" is **legacy-only** (`.in('lifecycle_status', ['submitted','under_review'])`, `ApprovalQueue.tsx:628-630`) — chain leases (`concept_submitted`, `concept_under_review`, `in_negotiation`, `final_review`, `pending_counter_signature`) never appear there.
- Dashboard NeedsAction "Pending Approvals" covers only the under-review group (`useNeedsAction.ts:86-90`); nothing lists `in_negotiation`/`final_review` (PendingCounterSignatureCard covers only `pending_counter_signature`).
- LeasePipeline's Submitted/Under Review/Approved bars DO count chain leases via `isEquivalent` (`src/components/dashboard/LeasePipeline.tsx:29-31,74`) but clicking navigates to `/app/approvals` where those leases are not listed — a count that leads to a page showing nothing.

Net: a requestor or finance user cannot find an `in_negotiation` or `final_review` lease from any list; they need a saved URL or a dashboard card that happens to include it. **Fix:** make "All Pending" cover all non-terminal, non-portfolio lifecycle statuses (both vocabularies) — one query change.

### H6 — Chain steps are actionable out of order (governance + UX)
`resolve-approval-chain` inserts every step (including the signator step) as `status='pending'` at submission (`supabase/functions/resolve-approval-chain/index.ts:496,550,797`). The queue then surfaces **all** pending steps assigned to you with no frontier filter (`ApprovalQueue.tsx:684-712` — only `.eq('status','pending')`), so a step-2 approver (or the CFO) sees the card while step 1 is still undecided. And `act-on-chain-step` enforces **no ordering**: authorization checks assignee/role/owner/admin only (`act-on-chain-step:273-359`), `updateLifecycle` validates nothing (`:133-149`), and the DB guard trigger bypasses service role entirely (`supabase/migrations/20260516120000_baseline_schema.sql:580-582`). A step-2 concept approval before step 1 is accepted; a signator approve on a concept-stage lease would jump it to `pending_counter_signature` (`act-on-chain-step:644+` — no lifecycle precondition; only the missing-attestation 400 stands in the way of the queue's one-click path). The purpose-built frontier predicate `isFrontierActiveRequiredStep` (`src/lib/approvalChainLogic.ts:433-470`, Deno mirror `_shared/approval_chain.ts:455`) is used **only by tests and a backfill migration** — no runtime surface calls it. **Fix:** filter the queue's chain cards to frontier steps and add the same predicate as a precondition in `act-on-chain-step`.

---

## 4. MEDIUM findings

### M1 — Notification emails and in-app alerts deep-link to a non-acting surface
Every approval email links to `/app/leases/{id}` (`supabase/functions/_shared/notify_dispatch.ts:146`), and in-app alert rows navigate the same (`src/pages/Notifications.tsx:251-254`). For a legacy manager that lands on the intake view with an "Action required" banner (`LeaseReview.tsx:2049-2054`) and an "Approval Queue" button (`:2135-2138`) — act-able only after two more hops and re-finding the lease. For chain approvers the destination has **no act affordance at all** (Section 2/C1). "Action needed" mail should link to `/app/approvals` (or the financial/signator review page when the type is known — the `notification_type` is right there in `copyForType`, `notify_dispatch.ts:34-92`).

### M2 — "Needs Your Action" is workspace-scoped, not user-scoped
`useNeedsAction.pendingApprovals` lists ALL of the workspace's under-review leases (`src/hooks/useNeedsAction.ts:41-58,86-104`) and both the dashboard card ("Needs Your Action", `NeedsAction.tsx:36`) and the page ("Needs Your Action … N items require attention", `NeedsActionPage.tsx:33-34`) present it as personal. A submitter-only user sees their own waiting request under "Needs Your Action" — it needs the approver's action, not theirs. Same hook feeds both surfaces (duplication — see consolidation).

### M3 — The queue's "Reviewed" tab misses all chain history
It matches only `manager_approved_by`/`financial_approved_by` columns and `activity_type IN ('rejection','send_back')` (`ApprovalQueue.tsx:632-651`); chain actions write `chain_step_approved/rejected/sent_back` (`act-on-chain-step:71-75`) and touch neither column. An approver who works chain items has a permanently empty "Reviewed" tab.

### M4 — Stalled-approval alert rule covers only legacy status
`process-alerts` `approval_pending` triggers only on `lifecycle_status === 'under_review'` (`supabase/functions/process-alerts/index.ts:129-141`) — `concept_submitted`/`concept_under_review`/`final_review` leases never fire the stall alert (detect-stuck-chains covers 7d+ chain stalls to admins, but the configurable workspace alert rule silently doesn't apply to chain workspaces).

### M5 — Requestor has no progress/timeline view and may be unable to upload the quote
- No component anywhere renders the approval chain to the requestor (only ApprovalQueue/SignatorReview/ChainViolationBanner read `lease_approval_chain` — grep). What the requestor sees is a status badge + one prose banner ("Your request is pending manager review", `LeaseReview.tsx:2052-2053`); who holds it, which step, how long — invisible. With the nudge dead (H3), a requestor's mid-pipeline experience is a black box.
- In negotiation (the owner's "requestor brings quote back" beat): `DocumentsPanel.canUpload` is admin/editor/owner only (`src/components/leases/documents/DocumentsPanel.tsx:114-115`), while `canTransition` includes the submitter (`:116-118`). A submitter whose workspace role is viewer can press "Advance to Final Review" (disabled until a final_negotiated doc exists) but cannot upload the document that enables it — a dead-end for exactly the persona this stage is about.

### M6 — In-app notifications rail is written but effectively unreadable
The 2026-06-18 fanout trigger (`supabase/migrations/20260618180000_fanout_recipient_notifications.sql:106-111`) fans every approval/delegation/counter-signature notification into per-user `notifications` rows, rendered only by `/app/notifications` (`src/pages/Notifications.tsx:99-115,212-287`) — which has no bell (removed, `AppHeader.tsx:28-30`), no sidebar entry (`AppSidebar.tsx:296-303`), and no unread indicator anywhere. Users receive in-app notifications they will never see.

---

## 5. LOW findings

- **L1** — `PendingApprovalsSection.tsx` is defined and imported nowhere (grep; already noted in KNOWN_ISSUES #42/`:1175`). Dead file in a directory of live dashboard cards.
- **L2** — Financial quick-approve is a dead branch: `handleApprove` supports `financial_approve` with a hardcoded `classification: 'operating'` (`ApprovalQueue.tsx:1002-1008`) but the Approve button renders only in the `canManagerAct` branch (`:171-194`); the financial card shows "Open Financial Review"/Reject only. The behavior (forcing classification via the deep page) is arguably right; the dead handler branch and its comment ("the queue defaults to 'operating'") are misleading.
- **L3** — Generic empty states: "Nothing here / No items to show in this tab" on all queue tabs (`ApprovalQueue.tsx:1129-1134,1267-1274`) — no role-aware guidance (e.g. "You're not assigned any approvals; requests you submitted appear on your dashboard").
- **L4** — Manager-reject submitter notification is gated on `lease.requestorEmail` being loaded (`ApprovalQueue.tsx:1068`) — a profile-join hiccup silently drops even the (already dead-letter, H1) record.
- **L5** — `send-nudge` nudges assignees of ALL pending required steps including not-yet-active later steps (`send-nudge:95-108`) — consistent with the queue's frontier gap (H6).
- **L6** — `SignatorReview` displays "PV liability" (`SignatorReview.tsx:524-527`) and `FinancialReview` is titled around ASC-842 classification (`FinancialReview.tsx:81-93,459`); Portfolio was recomposed in June to remove PV per Hard Rule #1. Not judging product intent here — flagging the internal inconsistency for the strategy owner.

---

## 6. Docs vs code drift

| Doc claim | Code reality |
|---|---|
| `docs/PHASE_5_BUILD_SPEC.md:226,338` — queue row navigates to `/app/leases/{id}/signator-review`; page "gated to signator role" | No navigation exists anywhere (grep); queue navigates to lease detail (`ApprovalQueue.tsx:1201`). Page auth also checks step assignee, not a grantable role (no UI grants `signator`, `WorkspaceSettings.tsx:596-600,715`) |
| `docs/KNOWN_ISSUES.md:2090-2099` (#109) — nudge "BUILT … NudgeApproverButton rewired to call send-nudge" | The button's only render site is gated on hardcoded `false` (`LeaseReview.tsx:436,2989`); user-reality is still #109's original symptom |
| CLAUDE.md — "Phases 1–8 are all CLOSED" | Phase 5's signator surface unreachable (C1); Phase 6 RerouteAuditDashboard and Phase 7 ExceptionsDashboard have zero inbound navigation (`src/App.tsx:241,274`; grep) |
| `docs/KNOWN_ISSUES.md:1263` — "`src/components/lifecycle/ActivityTimeline.tsx` is still imported in non-lease contexts" | File does not exist; no reference in `src/` (grep) |
| KNOWN_ISSUES #109 — in-app notification center "Still UNBUILT" | Half-drift: the fanout + reading page now exist (migration `20260618180000`, `Notifications.tsx` Alerts tab); what's missing is any navigation/bell to reach it (M6) |
| CLAUDE.md file map lists `NudgeApproverButton` as a live Path-1 component | Dead render gate (H3) |

---

## 7. Consolidation assessment (owner invited simplification pushback)

The backend acting machinery is genuinely good — `act-on-chain-step`, `legacy-lease-action`, the governance function, delegation/revoke, and the dispatch pipeline are coherent and audited. The problem is **surface sprawl + missing wiring**, not architecture. Concretely:

1. **One inbox.** Make `/app/approvals` "Needs My Review" the single acting inbox it already almost is (it merges legacy + chain + execution-owner + delegated + governance). Then:
   - Point the dashboard NeedsAction card's approval rows and "View all" at `/app/approvals`, and **delete `NeedsActionPage`** (it is a pixel-level duplicate of the card, `NeedsActionPage.tsx` vs `NeedsAction.tsx`, same hook).
   - Derive the sidebar badge from the same query as the queue's tab badge (H4).
2. **Deep-link to the acting surface.** `notify_dispatch` already knows the notification type; route "action needed" types to `/app/approvals`, signator types to the signator page, outcome types to the lease (M1).
3. **Wire the three orphans or delete them.** SignatorReview must be wired (C1). ExceptionsDashboard/RerouteAuditDashboard: either add an "Admin" sidebar group (or fold both into the queue's Governance tab, which already exists and is where an admin looks) — or they will keep silently rotting.
4. **Frontier-filter the queue** (H6) — also *reduces* what an approver sees to only what they can act on now, which is the simplification the owner is asking for.
5. **Restore one notification affordance** — a bell with unread count in AppHeader linking to `/app/notifications` (the removal comment's premise, "duplicated /app/notifications", was wrong: there is no other path).
6. **Two vocabularies of "Approve" collide on the lease page** — the extraction-review "Ready to Approve" vs workflow approval (C1.3). Rename the extraction action ("Confirm extracted data" / "Mark review complete") so "Approve" means exactly one thing in the product.

## 8. Rebuild vs fix

**Fix.** Every critical/high item above is a wiring gap concentrated in ~6 files (ApprovalQueue, AppSidebar, LeaseReview gate flags, notify_dispatch link, act-on-chain-step notify+frontier, the four browser-side notification writes). The queue's unified-inbox design, the chain engine, and the dispatch pipeline are sound and well-tested. A rebuild would discard the strongest part of this codebase.

### Suggested fix order (by user pain)
1. C1 signator wiring (unblocks Path 1's final gate)
2. H1 submitter outcome notifications (+ move server-side)
3. H2 next-assignee/signator notifications in `act-on-chain-step`/`advance-to-final-review`
4. H4 badge/nav unification; H5 "All Pending" chain statuses
5. H3 nudge render gate (`isPendingApproval` → real predicate: in-flight status && viewer is requestor)
6. H6 frontier filter (UI + server precondition)
7. M1 deep links; M6 bell; consolidation items 1/3/6
