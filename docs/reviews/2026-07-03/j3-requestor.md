# J3 — Requestor Journey Review: Warehouse Ops Employee Requests a Forklift Lease

**Reviewer scope:** Path 1 (lease request workflow) lived end-to-end from the submitter/requestor seat. Code is the source of truth; every claim carries file:line evidence from repo `/home/user/leaseio_staging` @ HEAD (branch `claude/dazzling-franklin-klts6u` lineage, 2026-07-03).

**Headline:** The front half of the journey (find form → fill → submit → manager notified) is genuinely well built. The back half — everything after concept approval — is structurally broken for the chain (policy-driven) workflow, which is the flagship path. A chain-routed request dead-ends at `in_negotiation` (the Phase 4 negotiation UI is unreachable), the signator cannot approve through any linked UI, and a lease that survives to `fully_executed` can never become `active`. The requestor is never notified of the one event the product promises ("You'll be notified when the status changes"), and the advertised nudge feature is dead code behind a hardcoded `false`.

---

## 1. Journey walkthrough (what the code actually does)

### 1.1 Finding the request form

- Dashboard header renders a "New Request" button → opens `LeaseRequestForm` sheet (`src/pages/Dashboard.tsx:65-68`, `109-113`). Hidden for read-only workspaces (`Dashboard.tsx:31,63`). Quota-blocked users get `LimitReachedDialog` instead (`Dashboard.tsx:41-47`).
- Leases page also mounts the form (`src/pages/Leases.tsx:1049`) behind an Add chooser.
- Sidebar for a submitter-only user shows Dashboard / Leases / Portfolio / Reports; **Approvals is hidden** for submitter-only functional roles (`src/components/layout/AppSidebar.tsx:292-300`; `src/lib/authorization.ts:33-37`). Reasonable — but see §3.3: this also removes the only page that lists in-flight requests.

**Verdict:** discoverable. Two clicks from login.

### 1.2 The form, field by field (`src/components/workflow/LeaseRequestForm.tsx`)

- Required: asset type (4-tile picker, :503-536), description (:538-552), requesting department (free-text, :568-582). Optional: vendor, monthly payment, term, start date, escalation %, covenant checkbox, one optional PDF ("Attach Quote / Draft Lease", :718-754). Financial fields are labeled "(AI will extract from document)" (:600, 635, 688) — see §3.8: for request-workflow leases **AI extraction never runs**, so this label is a false promise.
- Live niceties that work: debounced `calculateLease` → `FinancialImpactPreview` (:165-186, 706-714); "Approval route preview" chips with threshold explanation (:468-488); "No approvers configured → auto-approved" warning with admin-aware copy (:437-466). Good.
- Submission (:225-425): inserts lease as `draft` (`lifecycle_status:'draft'`, `status:'Ready'`, `intake_source:'request_workflow'`, :275-308), uploads the PDF to the `leases` bucket (:312-323), logs `created` (:325-337), then calls `resolve-approval-chain` (:348-351). On success the **server** flips the lifecycle and writes the status_change row; the client only notifies approvers (`notifyRoleHolders`/`notifyChainAssignees`, :374-404 → `src/lib/leaseNotifications.ts:63-139` — these DO carry `recipient_ids`, so approver emails deliver). Then navigate to `/app/leases/{id}` (:418).
- On routing failure the lease stays `draft`, an error toast fires, and the sheet **stays open with no navigation** (:358-363). If the user closes the sheet, that draft request is invisible everywhere except Import History (see §2.5).

**Verdict:** the form itself is the best surface in the journey. One misleading label, one failure-path trap.

### 1.3 Waiting for manager (concept) approval

- Detail page for `submitted`/`concept_submitted` renders the intake-stage view (`src/pages/app/LeaseReview.tsx:429-433` — `isIntakeStage` covers the `submitted`, `under_review`, and `approved` equivalence groups; early return at :2121).
- Requestor banner: "Your request is pending manager review. You'll be notified when the status changes." (:2052-2054).
- Actions available: header "Approval Queue" button (:2135-2138 — for a submitter this leads to a page whose nav entry is hidden and which shows them nothing), "Cancel Request" with `window.confirm` (:2145-2157 → `legacy-lease-action cancel_request`, LeaseReview.tsx:594-608), edit report attributes/notes (:2229-2382), upload/replace an attachment (:2408-2447 — see §3.9, this overwrites `storage_path`).
- **No nudge**: the only `NudgeApproverButton` render site is gated on `isPendingApproval` which is hardcoded `const isPendingApproval = false;` (`LeaseReview.tsx:436`, render at :2988-2991). See §2.4.

### 1.4 "Concept approved — you may now seek a quote"

- Manager approves the chain step in ApprovalQueue (`ChainStepCard.submit` → `act-on-chain-step`, `src/pages/app/ApprovalQueue.tsx:311-338`).
- Server: concept stage completes → lease flips to `in_negotiation` (`supabase/functions/act-on-chain-step/index.ts:546-585`). It writes `concept_stage_completed` / `negotiation_stage_entered` activity rows and computes `nextAssignees` — **but writes NO notification row for the requestor** (:546-589; contrast :770-783 where signator approval does notify the execution owner). The client-side queue handler also writes nothing for chain approvals (`ApprovalQueue.tsx:311-338`).
- The email dispatcher only delivers `comment` rows that carry `details.recipient_ids` (`supabase/functions/dispatch-notifications/index.ts:59-60`). None exists for this event. The in-app Notifications page reads only the `notifications` alert table and `lease_notifications` scheduler (`src/pages/Notifications.tsx:99-130`), neither of which receives approval events.
- **Net: the requestor is never told their request was approved, and nothing anywhere says "seek a quote."** The only ways they learn: manually re-opening the lease URL, or noticing the Dashboard pipeline count move.

### 1.5 `in_negotiation` — the dead end (CRITICAL)

- `in_negotiation` is in the same equivalence group as legacy `approved` (`src/lib/lifecycleStates.ts:66`), so `isIntakeStage` is true (`LeaseReview.tsx:429-433`) and the page early-returns the intake view (:2121) — **the workbench that hosts the Phase 4 `DocumentsPanel` (:3606-3616, sole mount; verified only usage in repo) never renders for `in_negotiation` leases.**
- Consequences, all verified:
  - "Upload Document" (negotiation iteration timeline), "Send back to initial approval" (escalate), and **"Advance to Final Review"** (`src/components/leases/documents/DocumentsPanel.tsx:167-201` — buttons only visible when `lifecycleStatus === 'in_negotiation'`, :119,173) are mounted inside a component that is unreachable in exactly that state. The Phase 4 checkpoint-4 UI shipped unreachable.
  - The banner the requestor DOES see is the legacy-approved one: **"This request is approved. Upload the executed document to advance to Executed status."** (:2061-2063) — but the `UploadExecutedDocumentDialog` beneath it is gated `lifecycleStatus === 'approved'` strictly (:2450), so the instructed button does not exist. The user is told to do something the page does not offer.
  - `advance-to-final-review` (edge fn, deployed, fully implemented: `supabase/functions/advance-to-final-review/index.ts`) is therefore **uninvokable from the product** for the state it exists for.
- Even if the panel were reachable there is a **spec-inherited catch-22**: advancing requires a `final_negotiated` document (`advance-to-final-review/index.ts:229-240`; UI disable `DocumentsPanel.tsx:187`), but the upload dialog's type dropdown excludes `final_negotiated` at `in_negotiation` (`src/lib/leaseDocuments.ts:131-133`; Deno mirror identical) — that type is only allowed at `final_review` (:134-135), which you can't reach without it. The defect is verbatim in the spec (`docs/PHASE_4_BUILD_SPEC.md:352-356` vs its own smoke test at :540-545 which uploads `final_negotiated` while in `in_negotiation`). The server (`upload-lease-document`) doesn't enforce type-vs-lifecycle (`index.ts:121-131` validates against `ALL_DOCUMENT_TYPES` only), so only the UI creates the deadlock — but the UI is the product.
- Role gate stacked on top: `upload-lease-document` requires owner/admin/editor (`supabase/functions/upload-lease-document/index.ts:192-214`); `DocumentsPanel.canUpload` mirrors it (:114-115). A warehouse submitter with `viewer` workspace role could never upload a quote through the Phase 4 model even if it rendered — while `canTransition` (advance/escalate) explicitly includes the submitter (:116-118). The submitter may advance but not upload the thing advancing requires.

### 1.6 "Manager approves/denies the quote"

- **This gate does not exist in code.** Between concept approval and signator review there is no approval step: `in_negotiation → final_review` is submitter-initiated (`advance-to-final-review/index.ts:173-209` authorizes submitter or admin; no manager/quote approval), and the only manager re-entry is the *submitter-initiated* escalate-back (`EscalateToConceptDialog` → `escalate-to-concept-approver`, both reachable only via the unreachable panel). Whether this is deliberate simplification or omission, it contradicts the product owner's described flow — flagged as intent drift, and honestly it is the *right* simplification if made explicit (see §4).

### 1.7 `final_review` — signator review

- On entry, signators get a `signator_review_required` notification row **with** recipient_ids (`advance-to-final-review/index.ts:369-389`) → email links to `/app/leases/{id}` (`supabase/functions/_shared/notify_dispatch.ts:146`).
- The dedicated attestation page `SignatorReview` (documents checklist + ≥30-char intent-to-bind gate, `src/pages/app/SignatorReview.tsx:1-17,60`) is routed at `/app/leases/:leaseId/signator-review` (`src/App.tsx:229-232`) but **nothing anywhere navigates to it** — repo-wide grep for `signator-review` matches only App.tsx. Orphan page.
- The reachable surface, ApprovalQueue's `ChainStepCard`, fires `act-on-chain-step {action:'approve', comment: ''}` (`ApprovalQueue.tsx:311-320`; approve button :390-397 opens no comment dialog), and the server rejects signator approvals without attestation (`act-on-chain-step/index.ts:252-262`). **So the CFO's Approve click always fails with a 400 toast, and the UI that could collect the attestation is unlinked.** The chain path is hard-blocked at final_review unless someone hand-types the URL.
- Requestor's view meanwhile: `final_review` is NOT intake-stage, so they now get the full AI-extraction workbench — empty extraction fields (request leases never ran extraction), a "Pending Review"/"Ready to Approve" primary button that writes `extracted_json._approval` (`LeaseReview.tsx:2776-2791`, 1713-1795) and has **nothing to do with the chain approval** — a severe semantic trap for the very user waiting on the real approval.
- Also: signator chain rows are inserted `status='pending'` at initial submission (`resolve-approval-chain/index.ts:1275-1302`), the queue lists pending steps with **no stage/frontier/lifecycle filter** (`ApprovalQueue.tsx:684-714`), and `act-on-chain-step` has **no lifecycle guard** on the signator branch (:644-702). The CFO sees "Final approval" cards the moment a request is submitted, and can Reject (→ `rejected`, terminal) or Send Back (→ `in_negotiation`, even from `concept_submitted` — an invalid transition per `VALID_TRANSITIONS`, `lifecycleStates.ts:184-187`, never checked server-side) before the concept stage even runs.

### 1.8 `pending_counter_signature` → `fully_executed`

- Signator approve (if performed via hand-typed URL) sets `pending_counter_signature`, computes due date, and defaults `execution_owner_id` to the requestor (`act-on-chain-step/index.ts:686-702`). The requestor finally gets their **first notification of the entire journey**: "You are responsible for chasing the counter-signed document. Due …" (:770-783). They learn their request was approved only by being handed a chore.
- `CounterSignaturePanel` renders on the Documents tab (LeaseReview.tsx:3629-3643): urgency badge, due date, reminders count, Reassign, "Upload Counter-Signed Document," and "Confirm Counter-Signature Received" → `record-counter-signature` (`CounterSignaturePanel.tsx:243-263,336-352`). Good surface — but the upload button is shown ungated (:336-345) while the underlying `upload-lease-document` 403s for viewers (`upload-lease-document/index.ts:204-214`). The default execution owner (requestor, plausibly a viewer) is assigned the chase and then forbidden from uploading the returned document.
- `record-counter-signature` flips to `fully_executed`, notifies requestor + signator + admins + owner with recipient_ids (`record-counter-signature/index.ts:283-305, 341-394`). Correctly built.

### 1.9 `fully_executed` → `active` — the missing last step (CRITICAL)

- No code path transitions `fully_executed → active`. Verified: the only activation is `legacy-lease-action model_lock`, which requires `status === 'executed'` (legacy vocab) and rejects anything else (`supabase/functions/legacy-lease-action/index.ts:260-265, 401-411`); the UI's Activate/Lock button appears only for `executed`/`active` (`LeaseReview.tsx:2747,2792-2799`); repo-wide grep finds no other writer of `lifecycle_status:'active'`.
- So a chain lease that completes the entire gauntlet is stranded one step from the repository: excluded from active-lease counts (`process_lease/index.ts:1083`), amendment-parent matching (`process_lease/index.ts:2156` requires `active`), unlock requests (`request-lease-unlock/index.ts:96`), ASC 842 report inclusion (`_shared/asc842_report.ts:1018`), etc. It does appear in the Leases portfolio list (`fully_executed` ∈ `PORTFOLIO_STATUSES`, `Leases.tsx:120`) with a "Fully Executed" badge forever.
- **AI abstraction never runs on the chain path either.** Request leases are created `status:'Ready'` with an explicit "don't process" comment (`LeaseRequestForm.tsx:298-300`); `record-counter-signature` never invokes `process_lease`; and the one client hook that could (`handleRunAbstraction`, `LeaseReview.tsx:775-830`) is **defined but rendered nowhere** (dead code — no JSX reference to it or `runningAbstraction`). CLAUDE.md's Path 1 ("AI abstracts → user confirms → repository") is unimplemented for chain leases. The legacy path does do this (UploadExecutedDocumentDialog → `process_lease extractionMode:'executed'` → `executed` → Activate; `UploadExecutedDocumentDialog.tsx:50-65`), which makes the chain path's gap sharper: the modern workflow is missing the product's core deliverable.

### 1.10 Send-backs and rejections at each gate (requestor experience)

- **Chain concept send-back**: lease → `concept_submitted`, current-stage pending rows marked `superseded` (`act-on-chain-step/index.ts:477-537`). No notification row to the requestor. NeedsAction "Returned for Revision" keys only on the legacy `financial_returned_to_submitter` flag (`src/hooks/useNeedsAction.ts:75-84`) — chain send-back doesn't set it, so nothing surfaces. The LeaseReview revision banner has the same legacy gate plus `lifecycleStatus === 'submitted'` (`LeaseReview.tsx:2192`) — never shows for `concept_submitted`. `legacy-lease-action resubmit_request` refuses non-legacy states (`legacy-lease-action/index.ts:276-286`), and no client path re-invokes `resolve-approval-chain` outside the `draft` failed-routing view (`isFailedRoutingDraft`, `LeaseReview.tsx:549-550`). **Result: a sent-back chain lease is permanently stranded** — the requestor's page says "pending manager review," the queue has zero pending rows for anyone, and the sidebar Approvals badge counts it forever (`AppSidebar.tsx:222-231` counts `concept_submitted` with `manager_approved_by IS NULL`) — a phantom badge with no actionable item behind it.
- **Chain reject**: → terminal `rejected`; a clear terminal view exists (`LeaseReview.tsx:2685-2723`). But the queue's client-side rejection notification is written **without `recipient_ids`** (`ApprovalQueue.tsx:1068-1078`), so the "Your lease request was rejected" email (template exists: `notify_dispatch.ts:47-48`) never sends — dispatcher skips it (`dispatch-notifications/index.ts:60`). Same defect on the legacy financial-review outcomes: `notify_submitter_approved` (`FinancialReview.tsx:247-256`) and `notify_submitter_returned` (:288-297) both lack `recipient_ids` → never delivered. **Every submitter-outcome email in the system is silently dropped**; only approver-facing and Phase-5 notifications (which do set recipient_ids) work.
- **Legacy send-back** at least sets the flag → NeedsAction row + Edit & Resubmit banner + working resubmit (`LeaseReview.tsx:2192-2216, 480-543`; `legacy-lease-action` recompute :301+). The legacy loop is the only complete revision loop.

### 1.11 Where can the requestor even find their request later?

- Leases page is portfolio-only: `PORTFOLIO_STATUSES = ['executed','active','fully_executed','expired','chain_violation']` (`Leases.tsx:120`); all scopes exclude in-flight states, and the 'all' scope comment says in-flight "live in ImportHistory / processing" (:254-260). The Approvals page — the declared home of in-flight leases (:115) — is nav-hidden for submitter-only users (`AppSidebar.tsx:293,300`) and, even when visited, lists only steps *assigned to the viewer* plus legacy-only "All Pending" (`ApprovalQueue.tsx:596-630`). **There is no "my requests" surface anywhere.** Dashboard `LeasePipeline` stage chips link to `/app/approvals` (`LeasePipeline.tsx:29-31`) — a dead end for the submitter. A failed-routing `draft` is worse: not in Leases (any scope), not in Approvals, only in Import History (`ImportHistory.tsx:94-96` fetches all statuses) — a page whose name suggests document uploads, not requests.
- The Notifications page (`/app/notifications`) has no sidebar entry and no header bell ("the bell duplicated /app/notifications" — removed, `AppHeader.tsx:28-29`); its only inbound link is the onboarding checklist (`OnboardingChecklist.tsx:53`).

---

## 2. Dead ends (states/features with no exit or no entry)

1. **`in_negotiation` chain lease** — intake view renders; Phase 4 negotiation panel (upload/escalate/advance) unreachable; banner instructs a nonexistent button. No UI exit except Cancel. (`LeaseReview.tsx:429-433,2061-2063,2121,2450,3606`; `DocumentsPanel.tsx:119,173-201`.)
2. **Signator approval** — attestation-collecting page orphaned (route `App.tsx:229`, zero links); queue Approve always 400s on missing attestation (`ApprovalQueue.tsx:311-320,390-397`; `act-on-chain-step/index.ts:252-262`).
3. **`fully_executed`** — no transition to `active` exists in any function or UI (`legacy-lease-action/index.ts:260-265`; `LeaseReview.tsx:2747`; grep-verified absence).
4. **Chain concept send-back** — steps superseded, no reactivation/resubmit path, no notification, phantom sidebar badge (`act-on-chain-step/index.ts:477-537`; `legacy-lease-action/index.ts:276-286`; `useNeedsAction.ts:75-84`; `AppSidebar.tsx:222-231`).
5. **`final_negotiated` catch-22** — required to advance, unuploadable until after advancing (`leaseDocuments.ts:131-135`; `advance-to-final-review/index.ts:229-240`; defect originates in `docs/PHASE_4_BUILD_SPEC.md:352-356`).
6. **Nudge system** — server fn + cooldown + `last_nudged_at` all built (`supabase/functions/send-nudge`, `NudgeApproverButton.tsx`), sole render behind hardcoded `const isPendingApproval = false` (`LeaseReview.tsx:436,2988-2991`). Dead feature.
7. **`handleRunAbstraction`** — full abstraction trigger defined and never rendered (`LeaseReview.tsx:775-830`); with it dies Path 1's "AI abstracts the executed lease" for request leases.
8. **Failed-routing draft after sheet close** — exists only in Import History; invisible in Leases/Approvals/NeedsAction (`LeaseRequestForm.tsx:358-363`; `Leases.tsx:254-260`).

## 3. Notifications scorecard (requestor-relevant)

| Event | Written? | recipient_ids? | Delivered? |
|---|---|---|---|
| Submit → approvers notified | yes (`LeaseRequestForm.tsx:374-404`) | yes | yes (email, cron) |
| Concept approved ("seek a quote") | **no row at all** (`act-on-chain-step:546-589`) | — | **never** |
| Chain send-back | **no row** (`act-on-chain-step:477-537`) | — | **never** |
| Chain/legacy reject | yes (`ApprovalQueue.tsx:1068-1078`) | **missing** | **never** |
| Legacy financial approve | yes (`FinancialReview.tsx:247-256`) | **missing** | **never** |
| Legacy return-for-revision | yes (`FinancialReview.tsx:288-297`) | **missing** | **never** |
| Signator approve → execution owner | yes (`act-on-chain-step:770-783`) | yes | yes |
| Counter-signature received | yes (`record-counter-signature:381-394`) | yes | yes |
| In-app (bell/page) for any of the above | n/a — Notifications page reads other tables (`Notifications.tsx:99-130`) | — | never in-app |

## 4. Simplification pushback (owner asked for it)

The chain machinery (6 extra lifecycle states, 11 document types with iteration/version math, execution owners, delegation/OOO/attestation) is dramatically over-scaled for the warehouse-requestor experience the owner describes — and the maintenance cost is visible in this review: nearly every break above is a missed branch between the two permanently-coexisting vocabularies (legacy vs chain). Concretely:

1. Collapse the requestor's world to four visible stages: *Requested → Approved to proceed (get your quote) → Final sign-off → Done*. Keep internal states if needed, but the requestor-facing page should render one purpose-built "request status" view for ALL pre-repository states — not the AI-extraction workbench (final_review+) and not a banner that references buttons that aren't there.
2. Kill the document-type dropdown for requestors: one "Upload document" that auto-types by stage (quote at negotiation, signed copy at counter-signature). The 11-type taxonomy is an approver/audit concern, not a submitter concern.
3. Decide the quote gate explicitly: either add a lightweight "manager OKs the quote" action at in_negotiation (one button on the manager's queue card) or officially declare the submitter-advance model. Right now the docs describe a gate the code doesn't have, and the code has a gate (final_negotiated evidence) the UI can't satisfy.
4. Retire the legacy vocabulary at the UI layer behind `normalizeToChainStates` so single-branch rendering is possible — half the bugs here are `isEquivalent`/strict-equality mismatches (`LeaseReview.tsx:2450` vs :2061; `useNeedsAction.ts:75-84`; `legacy-lease-action:276-286`).

## 5. Recommendations (ordered)

1. **Unblock `in_negotiation`:** render `DocumentsPanel` (and the correct banner) in the intake-stage view for the `post_concept_pre_signator` group, or exclude `in_negotiation` from `isIntakeStage`. Fix the banner gate (`:2450`) to the equivalence group. Allow `final_negotiated` at `in_negotiation` in both mirrors (and update the spec).
2. **Link `SignatorReview`:** route signator-stage `ChainStepCard` Approve/View to `/app/leases/{id}/signator-review`; include the link in the `signator_review_required` email. Filter queue chain steps to the active frontier (or at least `pending_since IS NOT NULL`), and add a lifecycle guard to `act-on-chain-step`'s signator branch.
3. **Build `fully_executed → active`:** extend `model_lock` (or add `activate_chain_lease`) to accept `fully_executed`; show Activate for it; decide when AI abstraction runs on the counter-signed doc (natural spot: `record-counter-signature` enqueues `process_lease extractionMode:'executed'`).
4. **Fix submitter notifications:** add `recipient_ids: [lease.requestor_id]` at `ApprovalQueue.tsx:1068`, `FinancialReview.tsx:247,288`; write a `notify_submitter_approved`-style row (with recipients and "next step: upload your quote" copy) in `act-on-chain-step`'s concept-completion and send-back branches. Ideally move all of these server-side.
5. **Un-strand chain send-backs:** either reactivate concept rows on send-back (reuse `forceConceptReactivation`) or give the requestor an Edit & Resubmit path for `concept_submitted` chain leases; set/emulate the returned flag so NeedsAction + banner fire.
6. **Resurrect the nudge:** replace `isPendingApproval = false` with the real waiting-state check (`awaiting_concept_approval`/`in_concept_review`/`signator_review` groups + requestor identity) and render the button on the intake view where waiting actually happens.
7. **Give submitters a home:** a "My requests" filter/section (Leases scope or Dashboard card) listing their in-flight + draft requests; include failed-routing drafts.
8. **Reconcile the execution-owner role gate:** allow the lease's execution owner (and requestor for their own lease) through `upload-lease-document`, or stop defaulting execution ownership to users who can't upload.
9. Copy fixes: `concept_under_review` banner says "financial review" (`LeaseReview.tsx:2055-2060`) — for chain that stage is still initial approval; intake attachment upload overwrites `storage_path` (`LeaseReview.tsx:744-747`) — route it into `lease_documents` instead.

## 6. Docs drift noted

- CLAUDE.md Path 1 ("AI abstracts → user confirms → repository") and File Map (NudgeApproverButton as a live workflow component) vs dead abstraction/nudge code (§2.6, §2.7).
- `docs/PHASE_4_BUILD_SPEC.md` claims submitters exchange documents during `in_negotiation` (:15) — unreachable UI + viewer role gate; spec's own type matrix contradicts its own smoke test (:352-356 vs :540-545).
- Owner's described flow includes a manager quote-approval gate that exists nowhere in code (deliberate or not — undocumented either way).
- `LeaseRequestForm` field labels promise AI extraction that never runs on this path (:600,635,688).
