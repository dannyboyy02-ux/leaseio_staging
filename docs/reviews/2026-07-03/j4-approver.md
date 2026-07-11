# J4 — Approver Journey Review (Manager / Concept Approver + CFO / Signator + Finance visibility)

Reviewer: J4 (approver-journey lane). All claims verified against code at HEAD of `/home/user/leaseio_staging` (single squashed commit `5295f02`). Docs read for intent only; every contradiction is flagged.

---

## 0. Architecture recap (as actually built)

Two parallel approval vocabularies coexist:

- **Legacy path** (no approval policies configured): `submitted → under_review → approved …`, acted on via `legacy-lease-action` (supabase/functions/legacy-lease-action/index.ts:55-79). Manager acts from ApprovalQueue legacy cards; Financial acts from `FinancialReview.tsx`.
- **Chain path** (workspace has approval policies): `concept_submitted → concept_under_review → in_negotiation → final_review → pending_counter_signature → fully_executed`, driven by `resolve-approval-chain` (chain creation), `act-on-chain-step` (approve/reject/send_back), `advance-to-final-review`, `record-counter-signature`.

Notification delivery rail: writers insert `lease_activity_log` rows with `activity_type='comment'` + `details.{notification_type, recipient_ids, message}`. Delivery is (a) in-app via DB trigger `fanout_recipient_notifications` → `notifications` table (migration `20260618180000_fanout_recipient_notifications.sql:106-111` — trigger fires ONLY when `details ? 'recipient_ids'`), and (b) email via the `dispatch-notifications` cron → `notify_dispatch.ts` (skips any row without `recipient_ids`, `notify_dispatch.ts:124-127`). Email is operator-gated (cron + `NOTIFICATION_DISPATCH_CRON_SECRET`, `docs/DEPLOY_RUNBOOK_2026-06-18.md:101-108`).

---

## 1. Manager (concept approver) journey

### 1a. How they learn a request awaits them

- **On submission — WORKS (both paths):** `LeaseRequestForm.tsx:374-404` writes recipient-bearing rows: legacy `notifyRoleHolders('manager_approver', …)` and chain `notifyChainAssignees(...firstStepAssignees…)` (`src/lib/leaseNotifications.ts:63-139`). These fan out in-app and email (once the cron is scheduled).
- **In-app queue + badge:** Sidebar "Approvals" badge counts leases at `submitted/concept_submitted` for `manager_approver` holders and `under_review/concept_under_review` for `financial_approver` holders (`AppSidebar.tsx:216-243`). Problems:
  - The badge counts by **lifecycle status, not chain assignment** — a manager sees a count for chain leases whose concept step is assigned to someone else entirely (overcount), and a step-2 sequential approver at `concept_under_review` who holds only `manager_approver` is not counted (the `concept_under_review` bucket is financial-only) (undercount).
  - **Signator/final_review items are never counted** — no badge bucket exists for `final_review` (`AppSidebar.tsx:222-242`).
- **Notifications page is orphaned from navigation.** The in-app rail's UI destination (`/app/notifications`, Alerts tab reading the `notifications` table, `Notifications.tsx:98-115`) is reachable only via an onboarding-checklist link (`OnboardingChecklist.tsx:53`) or a typed URL. The header bell was deliberately removed ("the bell duplicated /app/notifications", `AppHeader.tsx:28-29`) and the sidebar has no Notifications entry (`AppSidebar.tsx:296-303`). The #123 fanout fix delivers into a page users cannot find.

### 1b. Where they act & context

- Chain: `ChainStepCard` in ApprovalQueue "Needs My Review" (`ApprovalQueue.tsx:289-487`) — title, dept, asset type, monthly, total commitment, submitted date, delegation badges. "View" goes to the lease workbench (`ApprovalQueue.tsx:1201`).
- Legacy: `LeaseQueueCard` (`ApprovalQueue.tsx:70-236`) — adds term, covenant flag, submitter, and a confirm dialog on Approve (`ApprovalQueue.tsx:1567-1590`).
- **Friction — chain Approve is one-click, no confirmation** (`ApprovalQueue.tsx:390-397` calls `submit('approve')` directly), while the legacy Approve has a confirm dialog. Inconsistent risk posture for the same decision.
- **Friction — "Approve" terminology collision.** Clicking "View" lands the approver on the extraction workbench whose primary button is "Pending Review / Ready to Approve" (`LeaseReview.tsx:2776-2790`) — that "Approve" is the AI-abstraction confirmation (`handleApproveLease`, `LeaseReview.tsx:1713-1753`), not their chain/queue decision. The workbench offers no chain act buttons (grep: `act-on-chain-step` only invoked from ApprovalQueue + SignatorReview). An approver can plausibly "approve" the wrong thing or hunt for the real button.
- **Queue shows non-frontier steps.** The chain query filters only `status='pending'` + assignee (`ApprovalQueue.tsx:684-712`); there is no frontier/ordering filter, and `isFrontierActiveRequiredStep` exists but is used only by the pending_since backfill migration (grep: no UI usage). A step-2 sequential approver — and the signator, from day 1 — sees an actionable card long before their turn.
- **Server allows out-of-order acting.** `act-on-chain-step` checks only `step.status === 'pending'` (`act-on-chain-step/index.ts:229-235`); no lifecycle or frontier precondition. A signator-step **reject** at `concept_submitted` immediately terminalizes the lease; a signator **send_back** flips a not-yet-concept-approved lease to `in_negotiation` (`act-on-chain-step/index.ts:474-537`), skipping concept approval entirely. (Signator *approve* is accidentally blocked from the queue only because the attestation is empty — see 2c.)

### 1c. Approve / reject / send-back

- Reject and Send Back require a comment (UI: `ApprovalQueue.tsx:462-478`; server: `act-on-chain-step/index.ts:203-209`). Dialog copy is clear and states consequences (`ApprovalQueue.tsx:455-459`). Good.
- **Bug — stale comment reuse:** the shared `comment` state is not cleared when the reject/send-back dialog is cancelled (`ApprovalQueue.tsx:449, 471`; only cleared after successful submit at :333). A later bare "Approve" click sends the leftover text as the approval comment — and for a signator step it would *satisfy the attestation requirement with a rejection-reason string*, polluting the legally-styled audit record.

### 1d. After they act

- **Next approver is never notified (chain).** `act-on-chain-step` computes `nextAssignees` but writes **no** recipient-bearing row for them (`act-on-chain-step/index.ts:586-589` — "Phase 2/3 does not notify signator yet, but compute and return them so the caller … if it wants"; :615-617 for mid-stage advance) and returns them to `ApprovalQueue.tsx:311-338`, which ignores them (`onActed → fetchLeases`). Grep confirms the only recipient row the function ever writes is `execution_owner_assigned` (:770-783). Sequential chains stall silently until the next person happens to open the queue.
- **Submitter is never told the outcome (chain).** Chain reject / send-back / stage-completion write only audit rows (`status_change`, `chain_step_*`), never a `recipient_ids` comment (`act-on-chain-step/index.ts:433-537, 546-585`). No email, no in-app row. The owner's "requestor is notified they may seek a quote" moment (concept stage complete → `in_negotiation`) does not exist.
- **Submitter outcome rows are dead on the legacy path too.** `ApprovalQueue.tsx:1068-1078` (`notify_submitter_rejected`), `FinancialReview.tsx:247-256` (`notify_submitter_approved`), `FinancialReview.tsx:288-309` (`notify_submitter_returned/rejected`) all omit `recipient_ids`. The fanout trigger's WHEN clause requires `recipient_ids` (migration `20260618180000:110`) and the email dispatcher skips such rows (`notify_dispatch.ts:124-127`). So across BOTH paths, no requestor is ever notified of approval/rejection/return — the only working outcome surface is the legacy "Returned for Revision" banner + NeedsAction card, both gated on `financial_returned_to_submitter` which only the legacy `financial_send_back` sets (`legacy-lease-action/index.ts:372-386`).
- **"Reviewed" tab misses chain history.** It matches `manager_approved_by/financial_approved_by = me` + legacy activity types `('rejection','send_back')` (`ApprovalQueue.tsx:632-643`); chain actions write `chain_step_approved/rejected/sent_back`, so a chain approver's history tab stays empty.
- **"All Pending" tab is legacy-only:** query `.in('lifecycle_status', ['submitted','under_review'])` (`ApprovalQueue.tsx:628-630`) — chain-mode pending leases (`concept_submitted/concept_under_review/final_review`) never appear, so the tab is misleadingly empty for policy-based workspaces.

### 1e. CRITICAL — chain send-back is a dead-end state

A concept-stage send-back sets the lease to `concept_submitted` and supersedes all pending concept rows (`act-on-chain-step/index.ts:477-537`). After that:
- No pending concept step exists → nothing in anyone's queue; the sidebar badge still counts it (status-based), pointing at a queue with nothing actionable.
- The "Returned for Revision" banner + Edit & Resubmit require `financial_returned_to_submitter && lifecycle==='submitted'` — literal legacy values (`LeaseReview.tsx:2192`); chain send-back sets neither.
- `legacy-lease-action resubmit_request` 409s unless `status==='submitted' && financial_returned_to_submitter` (`legacy-lease-action/index.ts:276-286`).
- `resolve-approval-chain` initialResolution is an explicit no-op when a chain exists (`resolve-approval-chain/index.ts:6, 25`).
- The concept-rebuild path (`escalate-to-concept-approver` / `forceConceptReactivation`) is only reachable from DocumentsPanel at `in_negotiation` (`DocumentsPanel.tsx:119, 173-182, 222-229`).
- Meanwhile the requestor's banner says "Your request is pending manager review. You'll be notified when the status changes." (`LeaseReview.tsx:2049-2054`) — both halves false.

**Result: a manager clicking the prominent "Send Back" button on any chain concept step permanently strands the request.** No exit exists in the UI. (Signator-stage send-back is fine — it lands at `in_negotiation`, where re-advance exists.)

---

## 2. CFO (signator) journey

### 2a. How the CFO learns it's their turn

`advance-to-final-review` notifies **only the `workspace_roles.role='signator'` cohort** (`advance-to-final-review/index.ts:369-389`). Two compounding failures:

1. **The `signator` role is ungrantable.** The DB allows it (`baseline_schema.sql:2101`), the policy editor offers "Signatory" as a step role (`ChainDiagram.tsx:56-66`), but the workspace Team-roles UI assigns only manager_approver / financial_approver selects + submitter/admin checkboxes (`WorkspaceSettings.tsx:226-243, 715`). No surface anywhere writes `workspace_roles.role='signator'`. So the notified cohort is empty → `recipientIds.length===0` → **no notification, silently** (:378).
2. **Direct-user signator steps are ignored by the notifier.** If the policy names the CFO by user id (the only workable configuration), the notification still queries only the role cohort — the actual pending-step assignee is never looked up. The CFO learns nothing.

Corollary: a policy step configured as role="Signatory" is **unactionable and invisible** — the queue's role filter requires the viewer to hold that role in `workspace_roles` (`ApprovalQueue.tsx:701-706`), SignatorReview's `holdsRole` can never be true (`SignatorReview.tsx:200-202`), and `send-nudge` resolves the role to zero members → "No pending approver to nudge" (`send-nudge/index.ts:110-121`). Only owner/admin override authz in `act-on-chain-step` (:333-351) could ever act on it — and no admin surface lists such steps (see 4c).

Additional discovery gaps:
- The **Approvals nav item is hidden** unless the user holds manager_approver/financial_approver or is workspace admin (`authorization.ts:29-37`; `AppSidebar.tsx:292-300`). A CFO who is a direct-user signator assignee with no functional role (or only `submitter`) has their queue hidden — the ONLY surface listing their pending step is unreachable by navigation.
- Dashboard "Needs Your Action" never includes `final_review` (`useNeedsAction.ts:51-58, 86-104`); sidebar badge never counts it (`AppSidebar.tsx:222-242`). (The one dashboard component that queried `final_review` — `PendingApprovalsSection.tsx:36` — silently drops those rows in its bucketing loop (:57-99) *and* is dead code, imported nowhere; already filed as KNOWN_ISSUES :1161.)

### 2b. SignatorReview page — good, but ORPHANED

The page itself (`src/pages/app/SignatorReview.tsx`) is the best-built surface in the flow: final negotiated doc iframe + Open (:407-452), document history (:455-486), lease summary, 3-item checklist + ≥30-char intent-to-bind attestation with live counter (:534-589), high-stakes banner (:388-402), send-back/reject with required reason and accurate consequence copy (:645-703).

**But nothing navigates to it.** Route exists (`App.tsx:227-235`); grep for `signator-review` across `src/` finds zero inbound links — ApprovalQueue's signator ChainStepCard "View" goes to `/app/leases/{id}` (`ApprovalQueue.tsx:1201`), the notification email links to `/app/leases/{id}` (`notify_dispatch.ts:146`), and the lease workbench renders no signator CTA at `final_review` (grep `final_review` in `LeaseReview.tsx` — only a share-gate list at :2040). Phase 5's spec explicitly required a special queue row navigating to the page (`docs/PHASE_5_BUILD_SPEC.md:224-226`) and CLAUDE.md marks Phase 5 closed — **docs drift: the handoff into the signature ceremony was never wired.**

### 2c. Acting from the queue instead — dead end

The signator's step *does* appear as a generic ChainStepCard (tagged "Final approval") — from day 1, per 1b. Clicking **Approve** sends an empty comment; the server correctly 400s: "Signator approval requires a non-empty attestation. Type your intent-to-bind statement before approving." (`act-on-chain-step/index.ts:252-262`). **There is no attestation input anywhere reachable.** The CFO is told to type a statement with no place to type it. Net: **the signator stage cannot be completed through any discoverable UI** — the core Path 1 flow is blocked at its most important gate. (The only accidental workarounds: leftover-comment reuse (1c), or hand-typing the URL.)

### 2d. Delegation / OOO for an absent CFO

- **Voluntary delegation works** (modal `VoluntaryDelegationModal.tsx`, edge fn `voluntary-delegate-step`, exclusive-assignee semantics + revoke from "Delegated by me", `ApprovalQueue.tsx:756-799, 967-985`). But a delegated **signator** step leaves the delegate strictly worse off: `SignatorReview` authorizes only `approver_user_id` or role (`SignatorReview.tsx:199-208`) — it never checks `effective_assignee_user_id` or the voluntary-delegation table, so even if the delegate finds the URL they get "You are not authorized to act on this signator step," while `act-on-chain-step` *would* authorize them (`act-on-chain-step/index.ts:289-320`). Authz asymmetry between the page and the API.
- **OOO is half-removed.** `OutOfOfficeSettings.tsx` (calls `declare-out-of-office`/`revoke-out-of-office`) is imported nowhere (grep). `AccountSettings.tsx:143,155` says "out-of-office → profile (feature removed)". Yet the OOO backend remains fully live — `process-delegate-timers` cron, `chain_step_out_of_office` handling, ExceptionsDashboard's "Active OOO declarations" panel (`ExceptionsDashboard.tsx:10, 63-72`), and Phase 7 spec claims "ApprovalQueue + AccountSettings wired" (`docs/PHASE_7_BUILD_SPEC.md:701`). CLAUDE.md lists Phase 7 (…OOO…) as CLOSED. **No user can declare OOO; the exceptions dashboard displays a list that can never be populated.** Docs drift both ways.

### 2e. After signator approval — counter-signature handoff (mostly good)

`act-on-chain-step` signator-approve is solid: one UPDATE sets `pending_counter_signature` + attestation + due date (workspace-configurable, default 21d) + execution owner (defaults to requestor), with full audit rows and an execution-owner notification WITH recipient_ids (`act-on-chain-step/index.ts:667-783`). The execution owner then has: a "Counter-signature follow-up" section in the queue (`ApprovalQueue.tsx:1139-1177`), the dashboard `PendingCounterSignatureCard`, and the lease-page `CounterSignaturePanel` (urgency banner, reassign, upload, confirm-receipt; `CounterSignaturePanel.tsx:1-15`). Comprehensible. Caveats:
- The execution owner learns of their assignment via the rail (in-app fanout + operator-gated email) — but the *requestor-as-execution-owner* may not hold approver roles, so the queue section may sit behind a hidden Approvals nav item (same gap as 2a).
- Multi-signator concurrence is explicitly unsupported: the FIRST signator approve moves the lease regardless of other required signator rows (`act-on-chain-step/index.ts:656-664`), leaving stragglers pending against a moved lease; a second "approve" would re-run the whole transition (re-setting attestation/owner/due-date).

---

## 3. Finance simultaneous visibility at signature (owner requirement)

**Not built, and not buildable with current mechanics:**
- `FinancialReview.tsx` is legacy-only: `canAct` requires `under_review`/`concept_under_review` (`FinancialReview.tsx:339-341`); it plays no role at `final_review`.
- No notification, queue item, or dashboard surface targets finance when a lease reaches `final_review` or when the signator approves (grep: the only final_review notification is the empty signator-cohort one; the only post-approve notification targets the execution owner).
- The one mechanism that *could* express "finance sees/concurs at signature" — a parallel required signator step for the financial approver — is explicitly bypassed by the first-approve-wins rule (`act-on-chain-step/index.ts:656-664`).

Also: `FinancialReview` renders always-failing actions for chain leases — at `concept_under_review` it shows Approve/Reject (`canAct` true) but `legacy-lease-action` 409s any financial action unless status is literally `under_review` (`legacy-lease-action/index.ts:253-259`). A financial approver reaching it from the dashboard NeedsAction card (which lists `concept_under_review`, `useNeedsAction.ts:86-89`) hits "Action financial_approve is not valid from lifecycle_status='concept_under_review'".

---

## 4. Adjacent approver-governance surfaces

### 4a. Nudge system — fully built server-side, unreachable in UI (CRITICAL for the owner's stated "nudge system")

`send-nudge` is genuinely good: submitter/admin-only, 30-min cooldown, resolves current pending chain assignees (incl. effective assignee) with legacy fallback, writes the rail row AND emails immediately (`send-nudge/index.ts:68-161`). `NudgeApproverButton` is mounted in exactly one place, gated by `isPendingApproval` — which is **hardcoded `const isPendingApproval = false;`** (`LeaseReview.tsx:436`, gate at :2989-2991). The button can never render. No other surface invokes `send-nudge`. The nudge feature is dead in the UI. (Automatic day-2/5/10 nudges exist only as type names, `src/types/lifecycle.ts:78` — no cron implements them.)

### 4b. Chain-violation remediation is runtime-broken (dead-end terminal state)

`ChainViolationBanner.handleAcknowledgeOverride` reverts lifecycle via a **browser** `supabase.from('leases').update({lifecycle_status…})` (`ChainViolationBanner.tsx:151-158`), but the `prevent_unauthorized_lease_workflow_edits` trigger raises on ANY authenticated lifecycle write (`baseline_schema.sql:575-607`) — the CLAUDE.md convention itself says transitions "must run server-side… never as a browser UPDATE." The override will always fail with the raw trigger error; the lease stays in `chain_violation` forever (useNeedsAction :149-154 calls the banner "the resolution surface"). KNOWN_ISSUES :1161 asserts "admin-override goes through ChainViolationBanner + admin-override-step" — false on both counts: the banner never calls `admin-override-step`, and its direct write is trigger-blocked.

### 4c. AdminOverrideModal orphaned / no admin step surface

`AdminOverrideModal.tsx` (the only invoker of the `admin-override-step` edge fn, :138) is imported nowhere (grep; KNOWN_ISSUES :1161 files it as dead). `act-on-chain-step` authorizes owner/admin on any step (:333-351), but no surface lists other people's pending steps for an admin to act on — ExceptionsDashboard shows stuck chains read-only. When `detect-stuck-chains` emails an admin "a lease approval is stuck," the admin has no reassign/force-act affordance; their only real lever is deleting/re-creating the policy or acting via the API.

---

## 5. Simplification pushback (owner explicitly invited)

The approver surface currently multiplexes **two vocabularies** (legacy + chain) across every screen: two card types in one queue tab, two approve handlers, a financial-review page valid for one vocabulary but reachable in both, badges counting one vocabulary, history tabs recording the other. Every finding above is a seam of that duplication. Recommendation: pick the chain model as the single path (auto-create a trivial 1-step policy for un-configured workspaces), delete `legacy-lease-action`'s approval branch + `FinancialReview`'s legacy gate, and make the queue frontier-only. That single consolidation removes ~half the states an approver can encounter and most of the misleading copy. Second, the owner's Path 1 mental model has **two gates the product doesn't have** (manager quote approval — submitter self-advances to final review per `advance-to-final-review/index.ts:173-209` — and finance-at-signature): decide deliberately whether these are cut (fine — simpler) or required (then they are missing features, not bugs), and update PRODUCT docs accordingly.

---

## 6. Findings table (severity-ranked)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 1 | CRITICAL | Signator stage uncompletable via UI: SignatorReview orphaned (no inbound nav), queue Approve 400s on attestation with no input offered | App.tsx:227-235; ApprovalQueue.tsx:1201, 390-397; act-on-chain-step:252-262; PHASE_5_BUILD_SPEC.md:224-226 |
| 2 | CRITICAL | Chain concept send-back strands the request: no pending steps, no resubmit path, misleading "pending manager review" copy | act-on-chain-step:477-537; LeaseReview.tsx:2192, 2049-2054; legacy-lease-action:276-286; DocumentsPanel.tsx:173 |
| 3 | CRITICAL | Nudge system unreachable: `isPendingApproval` hardcoded false; sole mount never renders | LeaseReview.tsx:436, 2989-2991; send-nudge/index.ts |
| 4 | CRITICAL | chain_violation override always fails: browser lifecycle write blocked by governance trigger; state has no exit | ChainViolationBanner.tsx:151-158; baseline_schema.sql:575-607; KNOWN_ISSUES:1161 (wrong) |
| 5 | HIGH | Signator never notified: notify targets ungrantable `signator` role cohort; direct-user assignees ignored | advance-to-final-review:369-389; WorkspaceSettings.tsx:226-243,715; ChainDiagram.tsx:64 |
| 6 | HIGH | No mid-chain or outcome notifications in chain mode (next approver, submitter approve/reject/send-back) | act-on-chain-step:586-589,433-537; ApprovalQueue.tsx:311-338 |
| 7 | HIGH | Legacy submitter-outcome rows omit `recipient_ids` → never delivered (in-app or email) | ApprovalQueue.tsx:1068-1078; FinancialReview.tsx:247-309; 20260618180000:110; notify_dispatch.ts:124-127 |
| 8 | HIGH | Approvals nav hidden for direct-assignee approvers without manager/financial roles (incl. typical CFO); badge never counts final_review | authorization.ts:29-37; AppSidebar.tsx:222-242,292-300 |
| 9 | HIGH | Out-of-order acting: queue shows non-frontier steps; server has no lifecycle/frontier gate (premature signator reject/send-back derails lifecycle) | ApprovalQueue.tsx:684-712; act-on-chain-step:229-235,474-537 |
| 10 | HIGH | OOO feature half-removed: settings UI unmounted ("feature removed") while backend/cron/dashboards/docs treat it as shipped | OutOfOfficeSettings.tsx (0 imports); AccountSettings.tsx:143,155; PHASE_7_BUILD_SPEC.md:701 |
| 11 | HIGH | Finance simultaneous visibility at signature: absent; parallel signator concurrence explicitly bypassed | FinancialReview.tsx:339-341; act-on-chain-step:656-664 |
| 12 | MEDIUM | Notifications page orphaned from nav (bell removed, no sidebar entry) — in-app rail lands where no one looks | AppHeader.tsx:28-29; AppSidebar.tsx:296-303; OnboardingChecklist.tsx:53 |
| 13 | MEDIUM | SignatorReview authz excludes delegates (`effective_assignee_user_id` not checked) — asymmetric with act-on-chain-step | SignatorReview.tsx:199-208; act-on-chain-step:289-320 |
| 14 | MEDIUM | FinancialReview shows always-409 Approve/Reject at `concept_under_review` | FinancialReview.tsx:339-341; legacy-lease-action:253-259 |
| 15 | MEDIUM | "All Pending" / "Reviewed" tabs legacy-only — empty/misleading for chain workspaces | ApprovalQueue.tsx:628-643 |
| 16 | MEDIUM | Stale dialog comment reused as approve comment / signator attestation | ApprovalQueue.tsx:299,333,449,471 |
| 17 | MEDIUM | AdminOverrideModal orphaned; no admin surface to reassign/force-act a stuck step | AdminOverrideModal.tsx:138 (0 imports); KNOWN_ISSUES:1161 |
| 18 | LOW | Chain Approve one-click without confirm (legacy has confirm dialog) | ApprovalQueue.tsx:390-397 vs 1567-1590 |
| 19 | LOW | "Approve" terminology collision: workbench "Ready to Approve" = abstraction confirm, not the chain decision | LeaseReview.tsx:2776-2790,1713 |
| 20 | LOW | Badge counts by status not assignment (over/undercounts) | AppSidebar.tsx:216-243 |
| 21 | LOW | PV Liability / ASC 842 classification panels on approver surfaces vs Hard Rule #1 "no ASC 842 features" (rule is internally contradicted by Phase 8) | SignatorReview.tsx:524-527; FinancialReview.tsx:81-93,459 |
| 22 | LOW | Email delivery of every approval notification is operator-gated (cron + secret) — until scheduled, only in-app fanout works | dispatch-notifications:28-32; DEPLOY_RUNBOOK_2026-06-18.md:101-108 |

## 7. Concrete recommendations (priority order)

1. **Wire the signature ceremony:** in `ChainStepCard`, when `step.stage==='signator'`, render the spec'd special row and route both the card CTA and the queue "View" to `/app/leases/{id}/signator-review`; add a `final_review` banner + CTA on the lease workbench for authorized signators; include the deep link in the `signator_review_required` email. Fix SignatorReview authz to accept `effective_assignee_user_id`/active delegation.
2. **Fix chain send-back:** either (a) have `act-on-chain-step` send_back re-insert fresh pending concept rows (mirroring `forceConceptReactivation`) and notify the submitter with `recipient_ids`, or (b) introduce a real `returned_to_submitter` chain state with an Edit & Resubmit path. Update the `concept_submitted` banner copy to reflect actual pending steps.
3. **Notify on every chain transition:** in `act-on-chain-step`, write `recipient_ids` rows for `nextAssignees` after each advance and for the requestor on approve/reject/send-back; add `recipient_ids: [requestor]` to the four legacy submitter rows.
4. **Un-hardcode `isPendingApproval`** (derive from lifecycle ∈ pending states + viewer is requestor) so NudgeApproverButton renders; or surface nudge in the lease header for pending states.
5. **Route the chain-violation override through a service-role function** (`admin-override-step` or a new `resolve-chain-violation`), not a browser UPDATE.
6. **Close the signator-role loop:** either add "Signatory" to the Team-roles UI, or forbid role-based signator steps in `validatePolicy` and make `advance-to-final-review` notify the actual pending-step assignees.
7. **Frontier-filter the queue** with `isFrontierActiveRequiredStep` (already written and tested) and add the same guard server-side in `act-on-chain-step`.
8. **Show Approvals nav (or a "My approvals" surface) to anyone with a pending assigned step**, and count signator/final_review + exec-owner items in the badge.
9. **Restore a notifications entry point** (sidebar item with unread badge, or reinstate the bell).
10. **Decide** on the two absent Path-1 gates (manager quote approval; finance-at-signature) and either build them as chain steps or record the simplification in PRODUCT_STRATEGY.
