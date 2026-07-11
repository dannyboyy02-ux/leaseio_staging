# Path 2 Review — Direct Lease Add (Leases page → abstraction → review → posting)

Reviewer scope: `src/pages/Leases.tsx`, `src/components/leases/*`, `src/pages/app/LeaseReview.tsx`,
`supabase/functions/{upload-lease-document,process_lease,retry_lease,reclaim-stuck-extractions}/index.ts`,
plus every server/RLS surface those files reach. All claims carry file:line evidence from the code as of
branch HEAD on 2026-07-03. Items already tracked in `docs/KNOWN_ISSUES.md` are cited as such and not
re-reported as new.

---

## 1. Exact map of the direct-add flow (as built)

### 1.1 Entry

- **Add Lease button** — `src/pages/Leases.tsx:706-712`. Shown to every member of a live workspace;
  the only gate is `isWorkspaceReadOnly` (Vault/grace). **There is no role gate** — a `viewer` sees and
  can use it. Click → client quota check (`handleAddLease`, Leases.tsx:145-151; `useWorkspaceQuota`
  `src/hooks/useWorkspaceQuota.ts:31-59`) → at cap opens `LimitReachedDialog`, else opens
  **AddLeaseDialog**.
- **AddLeaseDialog** (`src/components/leases/AddLeaseDialog.tsx:38-70`) is a two-way chooser:
  - "Request Approval" → `LeaseRequestForm` (Path 1, out of scope here).
  - "Upload Document" → `LeaseUploadModal`. The card copy is explicit:
    *"For leases you already have signed. AI extracts the terms immediately — **no approval needed**."*
    (AddLeaseDialog.tsx:66-67). That copy is an accurate description of the code (see 1.3) and an
    inaccurate description of the product owner's stated intent ("submits for approval, unless they
    have permission to post without approval").

### 1.2 Upload

- **LeaseUploadModal** (`src/components/leases/LeaseUploadModal.tsx`):
  - dropzone, PDF-only, 50MB (`:126-131`); classify step (master vs amendment, `:326-363`); amendment
    parent picker fetches **only `lifecycle_status='active'`** leases (`:95-100`).
  - `performUpload` (`:137-214`) POSTs multipart to **`process_lease`** with `file`, `leaseType`,
    `workspaceId` (pinned to the active workspace — the 2026-05-13 wrong-workspace fix, `:154-162`),
    `parentLeaseId`, `forceTier2Override`.
  - Handles the three structured server outcomes: `tier2_classification_failed` → override step
    (`:181-186`), `quota_exceeded` → limit wall (`:190-194`), `leaseId` success → `startProcessing`
    global poller + `onSuccess` navigation to `/app/leases/{id}` (`:200-204`; Leases.tsx:1070-1078).
- **ProcessingContext** (`src/contexts/ProcessingContext.tsx:57-102`) polls every 3s and toasts
  "ready for review" with a link to `/app/leases/{id}/review` (route exists, `src/App.tsx:200`).

### 1.3 Server pipeline — `process_lease` (pipeline mode)

`supabase/functions/process_lease/index.ts`:

1. Auth = any authenticated user (`:1674-1681`); workspace authorization = **membership of any role,
   or ownership** (`resolveAuthorizedWorkspaceId`, `:261-328`). No role check anywhere in pipeline mode.
2. Validation: PDF magic bytes (`:59-66`), 50MB (`:1706`), leaseType/parentLeaseId shape (`:2076-2102`).
3. Amendment parent must exist in the same workspace **and be `lifecycle_status='active'`** (`:2149-2161`).
4. Rate limit (`:2168-2174`) → quota gate (`checkProcessingQuota`, `:990-1115`): monthly = trailing-30-day
   count of extracted leases vs `document_limit`+addon; active cap = **count of `lifecycle_status='active'`
   only** (`:1079-1094`); over-cap with a purchased credit → deferred claim (`:2313-2327`).
5. AI consent gate (`:2215`), Tier 2 Haiku classification hard-gate at >0.85 confidence (`:2244-2295`,
   fail-open on Haiku outage `:2230-2242`), override records a `classification_corrections` row (`:2391-2427`).
6. Lease row is created **before** extraction: `status='Processing'`, `intake_source='manual_upload'`,
   `processing_started_at` (`:2194-2196`).
7. Extraction = Haiku page-map + **one** combined Opus call with page hints + workspace risk watchlist
   (`extractLeaseDataWithClaude`, `:1145-1239`), per-field `{value, confidence, page, source_text}`.
8. Amendment diff: `_amendment_changes` computed **only here** (pipeline amendment path) by comparing 12
   scalar `COMPARABLE_FIELDS` against the parent's `extracted_json` (`:2440-2484`). Rent-schedule arrays,
   clause fields, and formatting-only changes are out of scope (already filed, KNOWN_ISSUES #115).
9. Final UPDATE (`:2513-2542`): `status='Ready'`, **`lifecycle_status='executed'`**, `status_changed_at`,
   all extracted columns, `extracted_json`; then a convention `status_change` activity row with
   `routing_path:'extraction'` (`:2546-2559`); calc_* financials (`:2563-2608`); `lease_field_confidence`
   upsert (`:2610-2627`); `rent_schedules` and `risks` delete+insert (`:2629-2663`); completion email
   **to the uploader only** (`:2665-2714`).

**Answer to the mapping questions:**

- **Lifecycle state on add:** `Processing` (status) → on success **`lifecycle_status='executed'`** — a
  portfolio status. The lease is immediately visible in the Leases list (`PORTFOLIO_STATUSES`
  includes `executed`, Leases.tsx:120) and counted in the header "active" rent subtitle
  (Leases.tsx:601-607) *before any human has reviewed a single field*.
- **Approval routing:** **none.** The approval-policy engine (`resolve-approval-chain`) is only invoked
  from the request workflow (`LeaseRequestForm` / `retryRequestRouting`); nothing in the direct-add
  path creates a chain, matches a policy, or notifies an approver. There is no "submit for approval"
  concept for a direct-added lease anywhere in the code.
- **Who can confirm/post:**
  - *Review attestation + "Approve"*: anyone who can UPDATE the row — the uploader (`user_id = auth.uid()`)
    or any workspace **editor+** (`leases_update_own_or_workspace_editor`,
    `supabase/migrations/20260516120000_baseline_schema.sql:4214`). `handleApproveLease`
    (LeaseReview.tsx:1713-1795) is a **browser UPDATE** that writes `extracted_json._approval`
    `{approved, approved_at, approved_by}` — `extracted_json` is NOT covered by the
    `prevent_unauthorized_lease_workflow_edits` trigger (baseline:589-600), so this "approval" has no
    server-side authorization at all and the uploader can self-approve their own upload.
  - *"Activate" (the real post)*: `handleLockAction` → `legacy-lease-action` `model_lock`
    (LeaseReview.tsx:1109-1154), which is **server-gated**: workspace owner, `workspace_members.role='admin'`,
    or `workspace_roles` `financial_approver`/`admin` (`supabase/functions/legacy-lease-action/index.ts:211-234`),
    precondition `lifecycle_status='executed'` and not already locked (`:260-265`). It flips lifecycle to
    `active`, sets `model_locked/_at/_by`, writes the audit rows (`:401-411`).
- **Does confirmation immediately activate?** No — it's a two-click self-service ladder on the same page:
  confirm 4 tabs → "Ready to Approve" (writes `_approval`) → "Activate" (server flip to `active`).
  Notably the server does **not** require `_approval` (or even `confirmed_sections`) before `model_lock`
  — the Approve step is UI theater (the confirmed_sections gap is filed as KNOWN_ISSUES #117/DF5).
- **What roles can direct-add:** all of them, including `viewer` (enum `admin|editor|viewer`,
  baseline:49-53). `process_lease` checks only membership (`:281-290`), and the UI shows Add to every
  non-read-only member (Leases.tsx:706). A viewer can burn paid Opus extractions and insert portfolio
  rows they cannot even edit afterwards.

### 1.4 Post-activation

`model_locked && lifecycle_status='active'` renders `LockedLeaseDetail` (LeaseReview.tsx:2728-2730);
edits go through the unlock-request → change-set → submit/self-approve governance
(LeaseReview.tsx:1853-1947, 1900-1928) — that machinery is real and server-enforced
(`lease-governance-action`).

### 1.5 `upload-lease-document` (for the record)

Not part of this pipeline: it is the Phase-4 negotiation-document **metadata** function (bytes uploaded
client-side, function inserts the `lease_documents` row), invoked from
`src/components/leases/documents/UploadDocumentDialog.tsx:116`
(`supabase/functions/upload-lease-document/index.ts:1-28`). No findings against it in this scope beyond
its irrelevance to direct-add.

---

## 2. Findings

Severity legend: **critical** = data loss / security / blocks core flow · **high** = core flow broken or
badly misleading · **medium** = friction/confusion · **low** = polish.

### GAPS (product/architecture)

**G1 — HIGH — Direct-add has no approval concept at all; "post without approval" permission does not exist.**
Evidence: no chain/policy invocation anywhere in `process_lease` pipeline mode; lease lands `executed`
(process_lease:2517) directly into the portfolio; AddLeaseDialog.tsx:66 says "no approval needed";
`resolve-approval-chain` is invoked only by the request workflow. The owner's stated Path-2 contract
("user reviews fields → submits for approval, unless they have permission to post without approval") is
unimplemented in both halves: there is no submit-for-approval, and no permission model — just an implicit
gate where only financial_approver/admin/owner can Activate. See §3 for the scoping proposal.

**G2 — HIGH — Dead-end for non-privileged reviewers: Activate is shown to everyone, 403s for most, and no one is told.**
`canShowLock` (LeaseReview.tsx:2747) has no role check, so an editor/uploader sees the green "Activate"
primary button; the server rejects with "Financial approver role required to lock executed records"
(legacy-lease-action:232-234), surfaced only as an error toast (LeaseReview.tsx:1149-1150). There is no
notification, queue entry, or handoff to anyone who *can* activate — `process_lease` emails only the
uploader (:2665-2714), `useNeedsAction` has no "executed awaiting activation" flag (see U1: the flag it
does have is wrong). An executed lease uploaded by a non-privileged member sits in limbo until a
financial approver stumbles on it.

**G3 — HIGH — Failed-extraction recovery (`retry_lease`) strands the lease outside the portfolio forever.**
The retry success UPDATE (`supabase/functions/retry_lease/index.ts:812-832`) sets `status='Ready'` but
**never sets `lifecycle_status`** (a failed direct upload has lifecycle NULL — the pipeline's lifecycle
flip at process_lease:2517 never ran). Consequences: (a) the lease never matches `PORTFOLIO_STATUSES`
(Leases.tsx:120,244-261) → invisible in the Leases list except via ImportHistory; (b) `canShowLock`
requires `lifecycle_status==='executed'` (LeaseReview.tsx:2747) → **no Activate button, ever** — the
lease can be reviewed and "approved" but can never be posted. This also violates the CLAUDE.md lifecycle
convention (no status_change row); KNOWN_ISSUES #33 fixed process_lease and explicitly said "audit any
sibling lifecycle write in retry_lease" — never done.

**G4 — HIGH — `retry_lease` is a divergent, degraded second pipeline.**
It OCRs with **Azure DI** as the primary path (`retry_lease:156-164, 774-785`; fails hard if
`AZURE_DI_ENDPOINT/KEY` unset since they're non-null-asserted) and runs a 3-call text-based Opus pass
whose schema **omits** `square_footage`, all seven clause fields, `uncertain_fields`, and risks-array
confidences (`CORE_SYSTEM`/`CLAUSES_SYSTEM`, `:310-364` vs process_lease's `COMBINED_SYSTEM` `:814-886`).
It also skips: Tier-2 classification, `_tier2_classification`/`_validation_warnings` stamping,
`lease_field_confidence` writes (:812-897 — none), amendment comparison, and the quota gate (filed #67).
A retried lease is therefore materially *worse* than a first-pass lease and the user is never told.
CLAUDE.md says "Azure DI only as fallback for scanned/handwritten docs" — here it's mandatory for every
retry (docs drift D3).

**G5 — MEDIUM — `viewer` role can direct-add (spend AI money, create portfolio rows).**
process_lease pipeline mode authorizes any member (`:281-290`); UI shows Add to all non-read-only
members (Leases.tsx:706-712). Viewers can't UPDATE leases (RLS is editor+, baseline:4214) so they create
rows they can't review — the worst of both.

**G6 — MEDIUM — `jsonResponse` is called but never defined in process_lease.**
`process_lease/index.ts:2126` (`return jsonResponse({error: 'No workspace found...'}, 400, ...)`) —
grep confirms no definition/import in the file. A user with no workspace hits a `ReferenceError`
caught by the outer catch → **500 "jsonResponse is not defined"** instead of the intended 400 with a
helpful message. Latent (needs a workspace-less user), but it's a real broken branch on the entry path.

**G7 — MEDIUM — The active-lease cap never counts direct-added inventory.**
Both server (`checkProcessingQuota`, process_lease:1079-1094) and client (AppContext.tsx:216-222) count
only `lifecycle_status='active'`. Every direct-added lease is `executed` until someone activates it, so
a workspace can accumulate unbounded `executed` leases — visible in the portfolio, driving rent totals —
while `activeUsed` stays at 0. Only the rolling monthly extraction cap binds. Either count
executed+active for the cap, or stop presenting executed rows as portfolio inventory.

**G8 — MEDIUM — Approval attestation is unguarded, self-approvable, and reversible without trace.**
`_approval` lives in `extracted_json`, writable by uploader/editor via plain PostgREST
(LeaseReview.tsx:1755-1763; trigger coverage excludes extracted_json, baseline:589-600). Reopen deletes
`_approval` with **no activity row** (LeaseReview.tsx:1798-1826; the approve path does log, `:1770-1780`).
Adjacent to filed #117 (DF4/DF5) — the unfiled part is: any editor can *mint* an approval attributed to
themselves on someone else's lease, and the uploader can approve their own upload; the server's Activate
gate never checks `_approval` at all.

### UX ISSUES

**U1 — HIGH — Every direct-added lease is flagged "Executed — document missing" on the Dashboard, forever.**
`useNeedsAction` flags `lifecycle_status='executed' && !executed_document_url`
(`src/hooks/useNeedsAction.ts:140-147`); `SummaryStrip` does the same (`SummaryStrip.tsx:102`). But
**nothing in the entire codebase ever writes `executed_document_url`** (grep: only reads + the column
definition, baseline:1511; even the executed-upload path writes `executed_storage_path`,
process_lease:1979). So the direct-add happy path — document uploaded, extracted, sitting right there in
`storage_path` — is permanently reported as a missing-document problem, and it's the *only* dashboard
signal these leases get (no "awaiting review/activation" flag exists). Misleading on every single Path-2
lease.

**U2 — HIGH — UploadAmendmentDialog demands an "Approver Email" that is silently thrown away, and can target the wrong workspace.**
`src/components/leases/UploadAmendmentDialog.tsx:64-67` blocks submit without a valid email and appends
`approverEmail` + `category` to the form (`:82-84`) — **process_lease never reads either field** (its
formData reads are `file/leaseType/parentLeaseId/forceTier2Override/extractionMode/leaseId/workspaceId`,
process_lease:1685-1697). The user is coerced into naming an approver and reasonably believes an
approval request was sent; nothing happens. Worse, the dialog does **not** send `workspaceId`, so
`resolveAuthorizedWorkspaceId` falls back to "most-recently-created owned workspace"
(process_lease:293-327) — the exact wrong-workspace bug class fixed in LeaseUploadModal on 2026-05-13
(LeaseUploadModal.tsx:154-162) — which for a multi-workspace user makes the parent lookup 404
("Parent lease not found in the selected workspace", process_lease:2149-2154) or, if the parent id
happens to exist there, lands the amendment in another workspace. Also: 20MB cap (`:55`) vs 50MB
everywhere else; raw English (i18n class filed as #68 for the sibling dialogs).

**U3 — HIGH (as filed-status drift) — NeedsReviewBanner is still unreachable; KNOWN_ISSUES #114 is marked RESOLVED but the banner cannot render.**
Render gate: `needsReviewStatus(lease?.lifecycle_status)` (LeaseReview.tsx:3163) matches only
`'Needs Review' | 'Review Required' | 'pending_review'` (`LeaseStatusBadge.tsx:128-130`). No live writer
produces any of those: `pending_review` was migrated away (`_archive/20260221000000:28-31`), and
`status='Needs Review'` exists only in the CHECK constraint + a partial index (baseline:1580,2835) with
zero writers. #114's resolution note claims the confidence-source fix "revives the NeedsReviewBanner
low-confidence list" — it fixed the *inputs* to a component whose *mount condition* is always false. The
missing-Tier-1-field / low-confidence summary the banner implements simply never appears. (Field-level
borders, badges, and the status-strip flagged-fields counter do work — the review UX is not blind, but
the designed summary surface is dead and the tracker says otherwise.)

**U4 — MEDIUM — Amendments become standalone portfolio rows and double-count rent.**
The pipeline gives an amendment `lifecycle_status='executed'` like any lease (process_lease:2517, with
`parent_lease_id` set :2519). The Leases query does not exclude children (Leases.tsx:233-261), so the
amendment appears as its own row beside its parent, and once executed it joins `activeLeases` →
`totalMonthlyRent` (Leases.tsx:601-611) — the parent's rent plus the amendment's extracted rent are both
summed. Meanwhile the parent's stored terms are never updated from `_amendment_changes` (no code applies
the diff), so the "repository record" shows stale terms with the correction hidden in a child row's
General tab (`AmendmentChanges` renders only there, LeaseReview.tsx:3363-3366).

**U5 — MEDIUM — "Upload amendment" is offered where the server will reject it.**
The menu item shows for any non-processing master lease (LeaseReview.tsx:3028-3033) including
`executed`/not-yet-activated ones, but the server requires the parent to be `active`
(process_lease:2156-2161) → the user picks a file, types the (discarded) approver email, uploads, and
gets a 422. Conversely, executed-but-unactivated leases can never be selected as parents in
LeaseUploadModal (`:99` filters `active`), which is at least consistent — but nothing explains the rule
anywhere in the UI.

**U6 — MEDIUM — The Approve → Activate two-step is redundant self-approval friction (simplification opportunity the owner asked for).**
Same person, same page, two green buttons in sequence: "Ready to Approve" (writes `_approval`,
LeaseReview.tsx:2776-2791) then "Activate" (`:2792-2800`). The server neither requires nor checks
`_approval` before `model_lock` (legacy-lease-action:260-265). For the user with activation rights this
is one decision presented as two ceremonies; for the user without rights the second button is a 403 trap
(G2). Recommendation in §3 collapses this to a single "Post" action with a permission-aware label.

**U7 — MEDIUM — Client-side 3-minute auto-fail races the server and "Cancel Processing" doesn't cancel anything.**
LeaseReview auto-writes `status='Failed', error_message='Processing timed out after 3 minutes'` from the
browser at 180s (LeaseReview.tsx:987-995), while process_lease's own call budget can legitimately exceed
that (Haiku 30s + 30s + Opus 100s + capped retries/backoffs, process_lease:345-420,711-718,772-779,1202-1209;
the server-side stuck sweep uses **30 minutes**, reclaim-stuck-extractions:44). The server run keeps
going and may later overwrite Failed→Ready, so the user sees a failure banner, possibly retries
(spawning a *second* paid extraction via retry_lease), then the state flips under them.
"Cancel Processing" (LeaseReview.tsx:1829-1851) likewise only writes Failed — the Opus spend still
happens and the result can resurrect the lease. Client writes to `status` also mean any editor can fail
any Processing lease.

**U8 — LOW — Retry from the modal creates a new lease per attempt.**
LeaseUploadModal's error step "Try Again" re-runs `performUpload` (`:229-232`), and each run creates a
fresh lease row (process_lease:2191-2198). Two failures = two Failed rows in ImportHistory (plus the
storage objects). The in-place `retry_lease` path exists but is only reachable from FailedLeaseBanner on
the lease page. Cosmetic accumulation, admin cleanup via ImportHistory.

**U9 — LOW — i18n: AddLeaseDialog, LeaseUploadModal, most of LeaseReview, UploadAmendmentDialog, UploadExecutedDocumentDialog are hardcoded English.**
Already filed for the intake surfaces as KNOWN_ISSUES #68; noting UploadAmendmentDialog and the LeaseReview
workbench strings (e.g. all dialog copy at LeaseReview.tsx:3691-3894) belong to the same sweep.

### INCOMPLETE WORK (dead ends, unwired code, half-built)

**I1 — `handleRunAbstraction` is dead code that would create a duplicate lease if wired.**
Defined with its `runningAbstraction` state at LeaseReview.tsx:263,775-823; grep shows **zero call sites**
— no button invokes it. If ever wired as-is it would double-bill and duplicate: it re-POSTs the stored
file to process_lease *without* `leaseId`/`extractionMode`, so the server creates a brand-new lease
(process_lease:2191-2198) and the UI then navigates away to the clone (`:814-816`), leaving the original
request lease orphaned. Delete it, or rebuild it on an in-place contract like retry_lease's.

**I2 — The "needs review queue" exists only as schema fossils.**
`status='Needs Review'` CHECK member (baseline:1580), partial index `idx_leases_review_queue`
(baseline:2835), `needsReviewStatus()` helper + `pending_review` badge config
(LeaseStatusBadge.tsx:51,128-130), and the NeedsReviewBanner mount — all with no writer (see U3).
Either introduce the state (recommended — it's exactly the review-stage direct-add needs, §3) or remove
the fossils.

**I3 — `executed_document_url` is a Phase-4 column nothing writes** (baseline:1511; only readers are
useNeedsAction.ts:143 and SummaryStrip.tsx:102) — the direct cause of U1. Write it, or re-point the two
readers at `storage_path`/`executed_storage_path`.

**I4 — ~400 lines of dead OpenAI code with undefined identifiers in process_lease.**
`_extractLeaseDataWithOpenAI_DEPRECATED` (process_lease:1242-1648) references `OPENAI_API_KEY`,
`OPENAI_MODEL`, `OPENAI_MAX_TOKENS` — none defined anywhere in the file (grep). Never called, so inert,
but it bloats a hot 2,700-line function file, contradicts Hard Rule #3's "No OpenAI" at a glance, and
would ReferenceError if ever invoked. Plus the live `jsonResponse` bug (G6) in the same file.

**I5 — UploadAmendmentDialog's `approverEmail`/`category` are dead parameters end-to-end** (see U2).

**I6 — `hideConfidence` on active leases vs dead prop chain.**
`SectionCard` receives `confidenceScores` but never uses it (filed as #122 per #114's note); the pass
sites remain at LeaseReview.tsx:3308 etc. Cleanup pending.

### DOCS DRIFT

**D1** — CLAUDE.md ("Amendment Sub-Workflow"): "`process_lease/index.ts` populates a `_amendment_changes`
array **on the executed/amendment path**". Wrong path: it's populated only on the **pipeline amendment**
path (process_lease:2440-2484); executed mode computes variance_* columns instead (:1947-1961) and never
`_amendment_changes`. CLAUDE.md's own "verify completeness" hedge is warranted — the comparison is 12
scalar fields, no schedule/clause diffing (#115).

**D2** — KNOWN_ISSUES #114 is stamped RESOLVED with the claim that the fix "revives the NeedsReviewBanner
low-confidence list". The banner's mount gate (LeaseReview.tsx:3163 + LeaseStatusBadge.tsx:128-130)
still never passes for any value the system writes — the banner remains dead (U3). The resolution fixed
`confidenceScores` consumers (status strip, flagged-field counts) but the named component did not revive.

**D3** — CLAUDE.md Hard Rule #3 / AI Architecture: "Azure DI only as fallback for scanned/handwritten
docs." In code, Azure DI is the **mandatory first step of every retry** (retry_lease:156-164,774-785)
and is never used by process_lease at all. Neither doc nor code matches the other.

**D4** — CLAUDE.md File-map: "Lease Review & Confirmation" lists `NeedsReviewBanner` as a live surface;
it is unreachable (U3/I2).

**D5** — KNOWN_ISSUES #43 (Cluster B, 2026-06-23) records that redeploy of process_lease/retry_lease was
"STILL OWED" — if that's still true, the `processing_started_at` stamping and retry fixes reviewed here
describe the repo, not the deployed copies. Flagging for the deploy-state reviewer; I reviewed the repo
as instructed.

---

## 3. Scoping: how "post without approval" SHOULD work here

Design constraints taken from the code: lifecycle flips must be service-role (trigger
`prevent_unauthorized_lease_workflow_edits`, baseline:575-607); the policy engine keys on
`asset_type / department / annual cost / region / lease_type` (`preview_policy_resolution`,
baseline:613+; `resolve-approval-chain` RequestBody, resolve-approval-chain:61-75); functional roles
live in `workspace_roles` (manager_approver / financial_approver / admin) and are already the
`model_lock` gate (legacy-lease-action:203-234). The owner wants Path 2 to stay simple.

### Recommended shape (Option A): review state + per-member posting permission + optional policy routing

1. **Land extractions in a review state, not the portfolio.** Change the pipeline UPDATE
   (process_lease:2517) from `lifecycle_status:'executed'` to **`'pending_review'`** — the vocabulary
   already exists in badge config (LeaseStatusBadge.tsx:51) and its historical enum slot; keep the
   status_change convention row (`routing_path:'extraction'`). `PORTFOLIO_STATUSES` stays unchanged, so
   unreviewed AI output stops appearing as portfolio inventory (fixes the G7 cap hole and the premature
   rent-total inclusion). Fix retry_lease to set the same state (closes G3). This also finally gives
   `needsReviewStatus()`/NeedsReviewBanner a real trigger (closes U3/I2) and gives the dashboard an
   honest "N leases awaiting review" flag to replace U1.

2. **Permission = a functional role, not a boolean column.** Add `'direct_poster'` to the accepted
   `workspace_roles.role` values (it's a text column with app-level vocabulary; mirror wherever the
   role CHECK/UI enumerates roles). Semantics: *may post a reviewed direct-add straight to the
   portfolio*. Owner / workspace-admin / `financial_approver` implicitly qualify (same derivation as
   `canFinancial`, legacy-lease-action:223-224). Managed from the existing WorkspaceSettings roles UI.
   (A `workspace_members.can_post_directly` boolean also works, but roles are where every other
   approval capability already lives, and `workspace_roles` writes are already service-role-managed —
   migration `20260621120000_set_workspace_roles_atomic.sql`.)

3. **One server action, two outcomes.** Add `post_direct` to `legacy-lease-action` (or a sibling
   `post-direct-lease` fn), precondition `lifecycle_status='pending_review'` + `status='Ready'`:
   - **Caller has posting permission** → single transition `pending_review → active` with
     `model_locked=true`, the status_change row (`routing_path:'direct'`), and a
     `details.posted_without_approval: true` marker (mirror of the change-set `self_approved` audit
     convention, LeaseReview.tsx:1893-1899). This *replaces* the Approve+Activate two-step (U6): the UI
     primary button becomes **"Post to portfolio"**, enabled by the existing all-tabs-reviewed gate —
     and make the server actually check `confirmed_sections` (closes #117/DF5).
   - **Caller lacks it** → the action invokes `resolve-approval-chain` with `initialResolution:true`
     for the lease (the engine already matches on the lease row's attributes; direct-added leases carry
     asset_type/department only if entered during review — the fallback policy covers the rest), flips
     to the chain's entry review state, and notifies via the existing chain notification path. The UI
     button reads **"Submit for approval"**. Because the document is already signed, the chain enters at
     the *final-review/signator* stage, not concept stage — add a `chain_entry_stage:'final_review'`
     hint to the resolve call (small engine change: skip concept stages when the lease has an executed
     document). If the workspace has no policies at all, fall back to a minimal one-step
     financial-approver queue (exactly today's `model_lock` gate, but with a notification and an
     Approval-Queue row so it's discoverable — closing G2).

4. **Enforcement points (server, in order):** (a) pipeline UPDATE target state (process_lease:2517 and
   retry_lease:815); (b) `post_direct` role check in legacy-lease-action beside `canFinancial`
   (:223-234); (c) keep the workflow-edit trigger exactly as is — it already forces all of this through
   service role; (d) delete the client `_approval` write (LeaseReview.tsx:1755-1763) — attestation is
   `confirmed_sections` + the server-side post action; `_approval` in a mutable JSON blob (G8) should
   not survive this change.

5. **Explicitly rejected: Option B (auto-approve policy match for every direct add).** Creating a
   `lease_approval_chain` with a zero-step/auto-approved policy for permitted users keeps "one engine"
   but drags every already-signed document through chain vocabulary designed for pre-signature requests
   (concept stages, signator, counter-signature), makes the trivial case (bookkeeper uploads 30 signed
   leases) generate 30 chain snapshots, and still needs a permission to decide *who* gets the
   auto-approve policy — i.e., it needs Option A's permission anyway plus chain overhead. Use the chain
   only for the "needs approval" branch, entered at final-review stage.

**Simplification notes for the owner (invited pushback):** collapsing Approve+Activate into one "Post"
button removes one of the two ceremonies on the happy path; the tab-by-tab "Reviewed" attestation is
good friction and should stay (it's the human-in-the-loop hard rule); the "Approved" green badge and the
Reopen loop can be deleted outright once posting is a single server action.

### Adjacent must-fixes in the same beat
- Write or retire `executed_document_url` (U1/I3) — one-line re-point of two readers.
- retry_lease lifecycle + pipeline parity (G3/G4) — at minimum set the review state and stamp
  `lease_field_confidence`; ideally make retry re-run process_lease's native-PDF path in place.
- UploadAmendmentDialog: drop `approverEmail`, pass `workspaceId`, align 50MB (U2).
- Define `jsonResponse` or inline the Response at process_lease:2126 (G6).
- Decide amendment presentation: either exclude `parent_lease_id IS NOT NULL` rows from the Leases
  portfolio query + rent totals, or make amendment confirmation apply `_amendment_changes` to the parent
  under the change-set governance (U4).

---

## 4. Verdict on rebuild vs fix

**Fix.** The pipeline core is genuinely solid: input validation, consent/rate/quota gates, deferred
credit claim, Tier-2 learning loop, two-pass extraction with per-field provenance, convention-compliant
lifecycle writes on the primary path, and a server-enforced lock/change-set governance layer. The
failures are seams, not foundations: one wrong landing state (`executed` instead of a review state), one
missing permission concept, one divergent retry pipeline, and a cluster of dead/unwired UI
(NeedsReviewBanner, handleRunAbstraction, approverEmail, executed_document_url). §3 is roughly one
focused migration + two edge-function edits + targeted UI deletions — far cheaper and safer than a
rebuild that would forfeit the audited governance trigger stack.
