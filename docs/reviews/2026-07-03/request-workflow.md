# LeaseIO Audit — Path 1 (Lease Request Workflow), End to End

**Reviewer scope:** the request → approval → negotiation → signature → execution → abstraction → active pipeline, as implemented in code. All claims cite `file:line` in the repo at `/home/user/leaseio_staging` (branch HEAD `fd31dfe`).

---

## 1. Executive summary

The **server side of the chain workflow is genuinely well built** — the policy resolver, chain-step actions, lifecycle convention, audit rows, rate limits, and pure helper mirrors are consistent, defensive, and heavily unit-pinned. The **legacy (no-policy) path works end-to-end**: submit → manager approve → financial review → approved → upload executed copy → AI extraction → review → Activate → active.

The **chain (policy-driven) path — the flagship of Phases 2–7 — is broken at the UI layer in four places that each fully block the flow**:

1. `in_negotiation` (and both concept states) render LeaseReview's *intake-stage* early-return page, which does **not** mount the Phase 4 `DocumentsPanel`. The negotiation document loop, "Send back to initial approval," and "Advance to Final Review" are **unreachable**. Since `advance-to-final-review` requires a `final_negotiated` document that can only be uploaded through that unreachable panel, **a chain lease can never leave `in_negotiation` through the UI**.
2. A concept-stage **send-back permanently strands the lease**: the lease returns to `concept_submitted` but every concept chain row is `sent_back`/`superseded`, no resubmit path exists for chain leases, and nothing ever re-pends the steps.
3. A signator **send-back permanently disables final approval**: re-advancing does not insert (or re-pend) a signator chain row, so `SignatorReview` finds "No pending signator step."
4. `fully_executed` is a **dead end**: nothing triggers AI abstraction of the counter-signed document, and no code path anywhere transitions `fully_executed → active`.

On top of that, the **requestor is never told anything** at any gate (concept approval, rejection, send-back — no notification carries `recipient_ids`, which the dispatcher requires), the **nudge system's only button is gated behind a hardcoded `false`**, the signator's queue-card Approve **always fails server-side** (no attestation) while the dedicated SignatorReview page is **linked from nowhere**, and Phase 7's admin-override and out-of-office UIs are **built but mounted nowhere**.

Verdict: **fix, not rebuild** — the engine is sound; what's missing is the last mile of UI wiring, notifications, and three small server fixes. Details and a minimal-delta plan in §7–8.

---

## 2. The actual state machine, as implemented

### 2.1 Submission (both paths)

`LeaseRequestForm` (`src/components/workflow/LeaseRequestForm.tsx`, opened from Dashboard.tsx:109 and Leases.tsx:1049):

- Inserts the lease as `draft` with `intake_source='request_workflow'`, `status:'Ready'` (LeaseRequestForm.tsx:275–308). Comment at :298–300: *"Lease requests don't go through AI abstraction."*
- Optional single PDF ("Attach Quote / Draft Lease", :723–725) stored in the legacy `storage_path` slot — **not** a `lease_documents` row, no document type.
- Calls `resolve-approval-chain` `{initialResolution:true}` (:348–351). Decision logic is pure (`src/lib/leaseSubmissionDecision.ts`).
- **Server** performs the draft→X flip + `status_change` audit row (browser lifecycle writes are rejected by the `prevent_unauthorized_lease_workflow_edits` trigger, baseline_schema.sql:575/3075).

`resolve-approval-chain` (`supabase/functions/resolve-approval-chain/index.ts`):

- **No policies** → legacy fallback: recomputes requirements server-side, flips draft → `submitted` / `under_review` / `approved` (:1096–1156).
- **Policy matched** → inserts full chain (concept + signator rows), flips draft → `concept_submitted` (:1275–1368). Phase-7 columns (`effective_assignee_user_id`, `pending_since`) set at insert (:1275–1302).
- **Ambiguous / no-match / SoD violation / network error** → lease stays `draft`; LeaseReview shows a focused retry page (`isFailedRoutingDraft`, LeaseReview.tsx:549–550, 2068–2118) driving `retryRequestRouting` (`src/lib/retryRequestRouting.ts`), which correctly handles the `alreadyResolved` replay (:79–81, 129–162). This recovery loop is solid.

### 2.2 States, actors, transition owners

| State | Entered by | Who acts, where | Exits (function) |
|---|---|---|---|
| `draft` (routing failed) | form insert | requestor/admin — LeaseReview retry card | retry → resolver; cancel (`legacy-lease-action cancel_request`) |
| `concept_submitted` | resolver flip | concept assignee — ApprovalQueue `ChainStepCard` | approve/reject/send_back (`act-on-chain-step`) |
| `concept_under_review` | first concept approval (act-on-chain-step:597–613) | remaining concept assignees | same |
| `in_negotiation` | concept stage complete (act-on-chain-step:546–589) | submitter/admin — **DocumentsPanel (unreachable, §3.1)** | `advance-to-final-review`, `escalate-to-concept-approver`, cancel |
| `final_review` | advance-to-final-review:307–323 | signator — SignatorReview page (**orphaned, §4.1**) or queue card (**approve always fails, §4.1**) | approve → `pending_counter_signature` (act-on-chain-step:644–788); send_back → `in_negotiation`; reject → `rejected` |
| `pending_counter_signature` | signator approve (sets due date, execution owner) | execution owner/admin — `CounterSignaturePanel` (LeaseReview Documents tab :3629–3643) + queue inbox section (ApprovalQueue.tsx:534–542, 804–812) | upload `fully_executed_counterparty_returned` + `record-counter-signature` → `fully_executed`; `assign-execution-owner` reassigns; `send-counter-signature-reminder` cron escalates |
| `fully_executed` | record-counter-signature:283–305 | **nobody — dead end (§3.4)** | none implemented |
| `chain_violation` | reroute of executed lease (resolve-approval-chain:826–836) | admin — `ChainViolationBanner` (LeaseReview:3644–3653) | resolve → active/cancelled |
| legacy `submitted`/`under_review`/`approved`/`executed` | legacy fallback | queue cards + FinancialReview + `legacy-lease-action` | full working loop incl. `financial_send_back` → Edit & Resubmit (LeaseReview:2192–2217, 480–544) and `model_lock` → `active` |

Send-backs/rejections exist at every chain gate **server-side**; rejection is terminal + supersedes remaining steps (act-on-chain-step:433–461). The two send-backs strand the lease (§3.2, §3.3).

---

## 3. CRITICAL findings (each blocks the core chain flow)

### 3.1 `in_negotiation` renders the intake page — the entire Phase 4 negotiation surface is unreachable

- `STATE_GROUPS.post_concept_pre_signator = ['approved','in_negotiation']` (src/lib/lifecycleStates.ts:66).
- `isIntakeStage` includes `isEquivalent(status,'approved')` (LeaseReview.tsx:429–433) → **`in_negotiation` is "intake stage."**
- The intake-stage branch returns early (LeaseReview.tsx:2121–2677) and contains **no `DocumentsPanel`** — only Report Attributes, Internal Notes, a single-slot Attachments card (`handleStageDocumentUpload`, :728–773, which *overwrites* `storage_path`), and financial cards.
- `DocumentsPanel` — the only mount of the negotiation timeline, `UploadDocumentDialog`, "Send back to initial approval" (escalate) and "Advance to Final Review" — exists solely in the workbench Documents tab (LeaseReview.tsx:3606–3616), which `in_negotiation` can never reach. The escalate/advance buttons themselves are additionally gated `lifecycleStatus === 'in_negotiation'` (DocumentsPanel.tsx:119, 173–201) — i.e., they can **never render**: the only state that shows them is the only state that can't reach them.
- Knock-on: `advance-to-final-review` refuses without a `final_negotiated` `lease_documents` row (advance-to-final-review/index.ts:211–240), and `UploadDocumentDialog` is mounted only by DocumentsPanel (:212) and CounterSignaturePanel (:365, gated to `pending_counter_signature`). **Therefore no chain lease can ever reach `final_review` through the UI.** `escalate-to-concept-approver` is likewise UI-unreachable.
- Same earlier: `concept_submitted`/`concept_under_review` also render the intake page, so `concept_attachment`/`loi` uploads (leaseDocuments.ts:124–130) are equally unreachable — the typed-document model effectively has **no reachable entry point before `pending_counter_signature`**.
- Bonus insult: the intake banner for the `approved` group tells the user *"This request is approved. Upload the executed document to advance to Executed status"* (LeaseReview.tsx:2061–2063) — wrong instruction for a chain lease, and the referenced control (`UploadExecutedDocumentDialog`) renders only for legacy `'approved'` (:2450–2456), so `in_negotiation` shows an instruction with no button.

**Fix (small):** exclude `in_negotiation` from `isIntakeStage` and give it its own view, or mount `DocumentsPanel` (+ correct banner copy) inside the intake-stage branch for chain-vocabulary states. Phase 4's spec itself expects this surface on the detail page for `in_negotiation` (PHASE_4_BUILD_SPEC.md:536).

### 3.2 Concept-stage send-back permanently strands the lease

- `act-on-chain-step` send_back (concept): lease → `concept_submitted`; the acted row → `sent_back`; **all other pending rows in the stage → `superseded`** (act-on-chain-step/index.ts:462–537). Result: zero pending concept steps.
- The approver dialog claims *"The submitter must resubmit"* (ApprovalQueue.tsx:458) — **no chain resubmit exists**: `legacy-lease-action resubmit_request` requires `status==='submitted' && financial_returned_to_submitter` (legacy-lease-action/index.ts:276–286); the resolver's idempotent branch only flips `draft` and never rebuilds steps (resolve-approval-chain:1026–1079); nothing anywhere returns a `sent_back` row to `pending` (repo-wide grep: only `admin-override-step`:123 can act on `sent_back`, and its UI is unmounted — §5.1).
- The requestor sees the intake page saying *"Your request is pending manager review. You'll be notified when the status changes."* (LeaseReview.tsx:2049–2054) — a lie: nothing is pending and no notification was sent (§4.2). The queue is empty for everyone. The only exits are Cancel or attribute-edit-triggered reroute to a *different* policy.

**Fix (small/medium):** on concept send_back, either leave the acted row `pending` semantics (comment-only return), or add a requestor "Revise & resubmit" that re-pends/rebuilds the concept stage (the `forceConceptReactivation` resolver mode built for #111 C4, resolve-approval-chain:394–607, is exactly the right primitive — it just needs a caller for this case).

### 3.3 Signator send-back breaks all future final reviews of that lease

- Signator send_back: lease → `in_negotiation`; signator row → `sent_back`; pending signator rows → `superseded` (act-on-chain-step:474–537). The code comment promises re-advance "will insert a fresh pending signator row" (:525–531).
- `advance-to-final-review` **inserts nothing** — it only stamps `pending_since` on rows already `status='pending'` (advance-to-final-review/index.ts:330–348).
- So after one signator send-back (even if §3.1 were fixed), the lease re-enters `final_review` with zero pending signator steps; `SignatorReview` errors *"No pending signator step exists for this lease"* (SignatorReview.tsx:186–194) and the queue shows nothing. Dead end.

**Fix (small):** in `advance-to-final-review`, re-pend `sent_back`/`superseded` signator rows (or clone fresh pending rows from the policy) when no pending signator step exists.

### 3.4 `fully_executed` is a dead end — no abstraction, no activation (KNOWN_ISSUES #94's open half)

- `record-counter-signature` lands the lease in `fully_executed` and its header claims "the existing extraction → active flow (process_lease etc.) takes over from there" (record-counter-signature/index.ts:3–5, 27–29). The confirm dialog repeats it (CounterSignaturePanel.tsx:431–434).
- **Nothing takes over.** `process_lease` executed mode is invoked only by `UploadExecutedDocumentDialog` (:56), which renders only for legacy `'approved'` (LeaseReview.tsx:2450). The counter-signed PDF sits in the `lease-documents` bucket as a metadata row; no code feeds it to extraction.
- Activation: the "Activate" primary action requires `lifecycleStatus === 'executed'` (LeaseReview.tsx:2747, 2792–2800), and `legacy-lease-action model_lock` rejects anything but `'executed'` (legacy-lease-action:260–261). Repo-wide grep: **no writer of `fully_executed → active` exists** (`VALID_TRANSITIONS` permits it, lifecycleStates.ts:189, but nothing implements it).
- What the user actually sees at `fully_executed`: the extraction-review workbench with empty AI sections, a "Pending Review"/"Ready to Approve" primary action derived from section-review state (LeaseReview.tsx:2776–2790) that relates to a document that was never extracted. There is no forward action.

**Fix (medium):** at `fully_executed`, surface an "Extract & activate" step: run `process_lease` executed-mode against the latest `fully_executed_counterparty_returned` document (or auto-invoke from `record-counter-signature`), then allow `model_lock`/Activate from `fully_executed` (or normalize to `executed`). Note `process_lease` executed-mode currently flips any non-`executed` status to legacy `'executed'` (process_lease:1972–2004) — acceptable as vocabulary normalization, but should be deliberate.

---

## 4. HIGH findings

### 4.1 The signator cannot actually approve from anywhere discoverable

- Queue `ChainStepCard` Approve calls `act-on-chain-step` **directly with no comment** (ApprovalQueue.tsx:390–397, 311–338). For signator steps the server correctly rejects: *"Signator approval requires a non-empty attestation…"* (act-on-chain-step:252–262). So the signator's inbox Approve button **always errors**.
- The purpose-built `SignatorReview` page (route `/app/leases/:leaseId/signator-review`, App.tsx:229–233) is **linked from nowhere** — no `navigate()` or href anywhere (repo grep); the queue's View goes to the lease detail page (ApprovalQueue.tsx:1201); the advance notification text has no link (advance-to-final-review:378–389). The page is reachable only by hand-typing the URL.
- `SignatorReview` authorization also ignores Phase 7 delegation: it checks only `approver_user_id`/role (SignatorReview.tsx:198–207), never `effective_assignee_user_id` — a delegated/OOO/admin-reassigned signator is refused by the page even though `act-on-chain-step` would authorize them (act-on-chain-step:289–299).

### 4.2 The requestor is never notified at any gate; several "notifications" are unsendable

Email delivery requires `details.recipient_ids` (dispatch-notifications/index.ts:60–62; `_shared/notify_dispatch.ts`). Against that contract:

- **Concept approval → in_negotiation:** `act-on-chain-step`'s concept-completion block writes activity rows only (`concept_stage_completed`, `negotiation_stage_entered`, act-on-chain-step:546–589) — **no recipient row for the requestor**. The owner's "requestor is notified they may seek a quote" step does not exist. Combined with §3.1's wrong banner, the requestor has no way to learn they were approved or what to do next.
- **Chain reject / send-back:** `ChainStepCard.submit` writes no notification at all (ApprovalQueue.tsx:311–338).
- **Sequential chains:** `act-on-chain-step` computes `nextAssignees` when a step-order advances (:615–643) and returns them; the caller ignores them. Second-level approvers are never emailed.
- **Legacy notifications that can never send:** `notify_submitter_rejected` (ApprovalQueue.tsx:1068–1078), `notify_submitter_approved` / `notify_submitter_returned` / `notify_submitter_rejected` (FinancialReview.tsx:247–256, 288–309) are all inserted **without `recipient_ids`** → the dispatcher skips them forever. The requestor hears nothing on approve, return, or reject even on the working legacy path.

### 4.3 The nudge system is dead in the UI

- `send-nudge` is complete and good (cooldown, effective-assignee resolution, immediate dispatch — supabase/functions/send-nudge/index.ts).
- Its only UI, `NudgeApproverButton`, renders solely behind `isPendingApproval` — **hardcoded `const isPendingApproval = false;`** (LeaseReview.tsx:436, 2989–2991). No other mount (repo grep). The intake-stage page where a waiting requestor actually sits has no nudge affordance at all. KNOWN_ISSUES #109 claims the button was "rewired" (docs/KNOWN_ISSUES.md:2090+) — the component was, but it never renders. The owner's "nudge system" is 95% built and 0% reachable.

### 4.4 Approval-route preview and "no approvers" warning ignore the policy engine

`LeaseRequestForm` derives its preview and the amber "No approvers configured — this request will be auto-approved" warning exclusively from legacy `workspace_roles` + threshold (LeaseRequestForm.tsx:131–144, 204–223, 438–488). A workspace using approval **policies** with user-based steps and no legacy roles is told the request will be auto-approved; the resolver then routes it into a chain. The submitter's first impression of the routing is wrong whenever policies exist.

---

## 5. MEDIUM / LOW findings

### 5.1 Built-but-unmounted Phase 7 surfaces (dead components)
- `AdminOverrideModal` (`src/components/workflow/AdminOverrideModal.tsx`) — imported nowhere; `admin-override-step` (the only function able to rescue a `sent_back` step, :123–125) has **no UI**.
- `OutOfOfficeSettings` (`src/components/workflow/OutOfOfficeSettings.tsx`) — imported nowhere; `declare-out-of-office`/`revoke-out-of-office` unreachable. OOO delegation can never activate for real users.
- `ParentLeaseCombobox` (`src/components/workflow/ParentLeaseCombobox.tsx`) — imported nowhere (amendment selection lives in `UploadAmendmentDialog`).
- `useLifecycleWorkflow` (`src/hooks/useLifecycleWorkflow.ts`) — retired (App.tsx:184) but still shipped; contains client-side `lifecycle_status` writes (:197–205, 465–471) that the governance trigger silently rejects; two test files pin it as a "writer" (`clientActivityAllowlist.test.ts:174`). Delete it.

### 5.2 Queue oversight gaps
- "All Pending" and "Reviewed" tabs query legacy states only (`in ('submitted','under_review')`, ApprovalQueue.tsx:628–636) — chain leases (`concept_*`, `in_negotiation`, `final_review`, `pending_counter_signature`) are invisible to admins in the oversight tabs; chain approvals never appear in "Reviewed."

### 5.3 Workflow crons absent from the active migration set
Active migrations schedule only 4 jobs (cancellation, dispatch-notifications, reclaim-stuck-extractions, lease-retention — grep `cron.schedule` over `supabase/migrations/*.sql`). The schedules for `send-counter-signature-reminder`, `process-delegate-timers`, `detect-stuck-chains`, and the Phase 6 reroute pollers live only in `_archive/20260507220000_phase567_crons.sql` / `_archive/20260506000000_phase6_chain_rerouting.sql`. They may still exist on the live DB, but the repo (declared source of truth, CLAUDE.md) no longer expresses them; a replayed environment silently loses counter-signature reminders, delegate timers, stuck-chain detection, and auto-reroute.

### 5.4 Misc
- `upload-lease-document` never enforces `isDocumentTypeAllowed(type, lifecycle)` server-side (upload-lease-document/index.ts:121–131) — any type at any state via direct call; low impact because the state machines gate on state, but the helper exists and is unused there.
- Legacy `manager_approve` always → `under_review` (legacy-lease-action:329–339) even when routing determined financial review wasn't required (below threshold), and even when no financial approver exists; the queue card then offers financial actions only to `financial_approver` holders (ApprovalQueue.tsx:100), and `FinancialReview.canAct` excludes admins (FinancialReview.tsx:339–340). A manager-only workspace can strand leases in `under_review` (server would accept an admin, but no UI offers it).
- `FinancialReview.canAct` includes `concept_under_review` (:340) but its actions call `legacy-lease-action`, which 409s for chain states (legacy-lease-action:253–258) — harmless mostly, misleading if reached by URL.
- "(AI will extract from document)" labels on Monthly Payment / Term / Start Date in the request form (LeaseRequestForm.tsx:600, 634–635, 687–689) are false — request-path attachments are never extracted (:298–300). A submitter who trusts the label files a request with no financials, breaking routing thresholds and the impact preview.
- `LeaseRequestForm` never uses `ParentLeaseCombobox`/amendment linkage — fine (amendments are a sub-workflow), noted for completeness.

---

## 6. Mapping the owner's ideal flow onto the code

| Owner's step | Implemented? | Where / gap |
|---|---|---|
| Ops-level requestor submits request via portal | **Yes** | LeaseRequestForm; draft-first + server-side flip is robust |
| Manager initial approval | **Yes** | concept stage; ApprovalQueue ChainStepCard → act-on-chain-step (legacy fallback also works) |
| Requestor notified "approved — go get a quote" | **No** | No notification (§4.2); UI banner actively misleads (§3.1) |
| Requestor brings quote back | **Partial-broken** | No `quote` document type (leaseDocuments.ts:27–38 — closest are `loi`/`draft`); the typed-upload surface is unreachable before `pending_counter_signature` (§3.1). Only a generic single-slot attachment exists at request time (LeaseRequestForm:723) |
| Manager approves/denies the quote | **No** | No quote gate exists. The chain is concept → (negotiation loop) → signator; the only mid-loop manager touch is the *voluntary* `escalate-to-concept-approver` (itself unreachable, §3.1). The submitter self-advances to final review with no manager sign-off on the negotiated artifact |
| Requestor submits vendor's lease contract | **Built server-side, unreachable** | `draft`/`redline`/`final_negotiated` uploads via upload-lease-document + DocumentsPanel (§3.1) |
| Manager approves contract | **No** (by design) | advance-to-final-review authorizes the *submitter or admin* (advance-to-final-review:173–209); no manager gate |
| CFO (signator) signs | **Built, undiscoverable + fragile** | SignatorReview page with checklist + ≥30-char attestation is excellent, but orphaned; queue approve always errors (§4.1); one send-back kills the stage (§3.3) |
| Finance simultaneous visibility at signature | **No feature** | advance-to-final-review notifies only `signator` role (:369–389); financial_approver gets nothing; SignatorReview page is signator-only (SignatorReview.tsx:199–207). Finance can passively open the lease like any member — that's all |
| Fully executed lease | **Yes** | counter-signature chase (panel, reassign, tiered reminder cron) is complete and good |
| AI abstraction of executed doc | **No** | §3.4 — nothing invokes extraction on the chain path |
| Active repository record | **No** (chain) / **Yes** (legacy) | no `fully_executed → active` writer (§3.4); legacy `executed` → Activate works |
| Send-backs/rejections at every gate | **Partial** | rejections fine; both send-backs strand the lease (§3.2, §3.3) |
| Nudge system | **Built, dead** | §4.3 |

### Where does the QUOTE step fit today?
Nowhere, structurally. `lease_documents.document_type` = `concept_attachment | loi | draft | redline | counter_redline | final_negotiated | our_signed | fully_executed_counterparty_returned | amendment | side_letter | other` (leaseDocuments.ts:27–38). There is no "quote" concept, no quote-approval gate, and the negotiation loop that would host it (`in_negotiation`) collapses everything into upload-typed-docs → submitter self-advances. The only place the word "quote" appears in product UI is the request form's attachment label (LeaseRequestForm.tsx:724).

**Simplification pushback (the owner asked):** do **not** add a new lifecycle state for quotes. The existing two-stage chain + negotiation loop can express his flow with two small moves: (a) add `quote` as a document type allowed in `in_negotiation` (one line in both `leaseDocuments` mirrors + the CHECK constraint), and (b) if a real manager gate on the quote/contract is wanted, gate `advance-to-final-review` on a concept-approver ack rather than adding a state — or simply present "Send back to initial approval" (already built) as the manager's quote-review mechanism. Anything more (a `quote_review` state, a third stage) would compound the current complexity that already lost the UI.

---

## 7. How far is the build from the ideal?

Structurally close, operationally far. Everything the owner described has a server-side skeleton (concept gate, negotiation loop, signator, counter-signature, send-backs, nudges, delegation). But **through the actual UI today, a policy-routed request can progress exactly this far: submit → concept approve(s) → `in_negotiation` → stop.** Everything after that (documents, quote, final review, signature, execution, abstraction, activation) is reachable only by hand-crafted API calls. The legacy no-policy path is the only complete journey, and even it never emails the requestor.

## 8. Minimal delta to reach the owner's flow (ordered)

1. **Un-strand `in_negotiation`** (§3.1): render DocumentsPanel + correct guidance in the chain intake states (or exclude them from `isIntakeStage`). ~1 day. This alone unblocks the whole back half.
2. **Signator path** (§4.1, §3.3): link queue card → SignatorReview for signator steps (replace the inline Approve); re-pend signator rows in `advance-to-final-review`; honor `effective_assignee_user_id` in SignatorReview auth. ~1 day.
3. **Concept send-back recovery** (§3.2): requestor "Revise & resubmit" that calls the existing `forceConceptReactivation` resolver mode. ~0.5–1 day.
4. **fully_executed → extraction → active** (§3.4): invoke `process_lease` executed-mode on the counter-signed doc (button or auto), permit Activate from the executed group. ~1 day.
5. **Notifications** (§4.2): add `recipient_ids` to the four submitter notifications; notify requestor on concept completion ("approved — upload your quote/contract in Documents") and on chain reject/send-back; notify `nextAssignees`. ~0.5 day.
6. **Nudge**: render `NudgeApproverButton` on the intake-stage page for the requestor (replace the hardcoded `false`). ~0.5 hr.
7. **Quote semantics**: add `quote` document type + copy; decide whether the manager quote gate = escalate-to-concept (no new code) or an advance-gate ack. ~0.5 day.
8. **Finance visibility**: CC `financial_approver` role holders on the advance-to-final-review notification (one query + one row). ~0.5 hr.
9. Mount or delete `AdminOverrideModal` / `OutOfOfficeSettings`; delete `useLifecycleWorkflow` + `ParentLeaseCombobox`; restore workflow cron schedules to the active migration set; include chain states in the queue's All Pending tab.

Total ≈ 5–7 focused days. **Rebuild is not warranted** — the resolver/chain/audit core is the hard part and it is done well.

---

## 9. Docs-vs-code drift

| Doc claim | Reality |
|---|---|
| APPROVAL_ROUTING_ARCHITECTURE.md:71–84 state machine — send_back "(revise concept)", `fully_executed → active (verification)` | Neither exit implemented (§3.2, §3.4) |
| PHASE_4_BUILD_SPEC.md:536 "Lease detail UI shows … (for `in_negotiation` leases) the escalate and advance buttons" | Unreachable — intake early-return swallows `in_negotiation` (§3.1) |
| act-on-chain-step:529–531 "re-advanced via advance-to-final-review … which will insert a fresh pending signator row" | advance-to-final-review inserts nothing (:330–348) (§3.3) |
| record-counter-signature:3–5,27–29 "existing extraction → active flow takes over" (echoed in CounterSignaturePanel dialog :431–434) | No caller; no such flow for chain leases (§3.4) |
| KNOWN_ISSUES #109 "NudgeApproverButton rewired… BUILT" | Component rewired but never renders (hardcoded `false`, LeaseReview:436) (§4.3) |
| CLAUDE.md "Phases 1–8 all CLOSED"; file-map lists NudgeApproverButton as live workflow surface | The chain path is UI-blocked at `in_negotiation`; the nudge button is dead |
| ApprovalQueue send-back dialog: "The submitter must resubmit" (:458) | No resubmit exists for chain leases (§3.2) |
| CLAUDE.md "repo is source of truth for config" | Phase 5/6/7 cron schedules exist only in `_archive` migrations (§5.3) |
| LeaseRequestForm "(AI will extract from document)" | Request-path attachments are never extracted (:298–300) |

---

## 10. What is genuinely good (credit where due)

- Draft-first submission with server-owned flips + idempotent retry recovery (#132 C2) — half-state elimination actually works (LeaseRequestForm:270–363, retryRequestRouting.ts).
- Lifecycle Transition Convention followed at every server writer (act-on-chain-step:126–179, advance-to-final-review:264–304, record-counter-signature:256–305, legacy-lease-action:450–479, process_lease:2502–2559).
- Pure, mirror-pinned chain logic with strong tests (approvalChainLogic.ts + `_shared/approval_chain.ts`; frontier predicate #111 C1).
- SoD enforcement, rate limits, workspace-liveness gates, and attestation defense-in-depth are consistently present.
- Counter-signature chase (urgency buckets, tiered reminder cron with idempotency, execution-owner reassignment) is complete.
- SignatorReview's checklist + intent-to-bind attestation design is exactly right — it just needs a road leading to it.
