# J5 — Direct-Add Journey Review (Path 2: Leases page → upload → AI abstraction → review → repository)

Reviewer scope: a finance user direct-adds an existing signed lease from the Leases page. Everything below is verified from code (file:line cited). Docs read for context: `CLAUDE.md`, `docs/KNOWN_ISSUES.md`.

---

## 1. Journey walkthrough (as the code actually behaves)

### 1.1 Entry — Leases page "Add Lease"
- `src/pages/Leases.tsx:707` — header "Add Lease" button → `handleAddLease` (`Leases.tsx:145-151`): if `quota.blocked` opens `LimitReachedDialog`, else opens `AddLeaseDialog`.
- `AddLeaseDialog` (`src/components/leases/AddLeaseDialog.tsx:38-70`) offers two cards: **Request Approval** (Path 1 drawer) and **Upload Document** — copy: *"For leases you already have signed. AI extracts the terms immediately — no approval needed."* (`AddLeaseDialog.tsx:66`). This copy is **misleading**: the actual flow requires marking 6 sections reviewed, clicking Approve, then a role-gated "Activate" (financial approver/admin/owner only — see §3.3). "No approval needed" is only true relative to Path 1's chain; the lease still cannot reach `active` without a privileged actor.

### 1.2 Upload modal
- `src/components/leases/LeaseUploadModal.tsx` — dropzone (PDF only, 50MB — `:126-131`), then a "classify" step (New Lease vs Amendment, `:283-407`), then `performUpload` invokes `process_lease` with FormData (`:170-172`), correctly pinning `workspaceId` (`:160-162`, the 2026-05-13 wrong-workspace fix).
- **The entire AI pipeline runs synchronously inside this one HTTP request.** `process_lease` classifies (Haiku), page-maps (Haiku), extracts (Opus), writes ~8 tables, and only then returns (`supabase/functions/process_lease/index.ts:2217-2719`). The user's only feedback for the whole 30–150+ seconds is the submit button text flipping to `"Submitting..."` (`LeaseUploadModal.tsx:403`). No progress bar, no elapsed timer, no "this takes ~a minute" copy, no spinner screen.
- The dialog is **closable mid-flight** (`Dialog onOpenChange={handleClose}`, `:235`): the invoke promise keeps running invisibly; there is no persistent processing indicator anywhere (`ProcessingContext.jobs` is rendered by nothing — grep confirms only `startProcessing` is ever consumed, `src/contexts/ProcessingContext.tsx` + one import in `LeaseUploadModal.tsx:58`). When it finishes, `onSuccess` fires `navigate('/app/leases/'+id)` (`Leases.tsx:1073`) — the user is **teleported to the lease page from wherever they now are**, or if it fails, they get only a `toast.error('Failed to process lease')` with the failed row left somewhere they can't see (§3.1).
- **Backwards toast:** on completion the modal calls `startProcessing(result.leaseId, ...)` (`LeaseUploadModal.tsx:201`) which toasts *"Abstracting 'file'..."* (`ProcessingContext.tsx:108-117`) — after abstraction is already done — and 3s later the poll sees `status='Ready'` and toasts *"file is ready for review [Review Now]"* (`ProcessingContext.tsx:71-79`) while the user is already standing on the review page. Three redundant/contradictory signals in ~4 seconds.

### 1.3 What lands in the database
- `process_lease` pipeline mode: quota check (`:2182-2189`) → insert lease `status='Processing'` (`:2194-2196`) → storage upload → consent gate (`:2215`) → Tier 2 classify (`:2223-2295`) → credit claim if over-cap (`:2318-2327`) → Opus extraction (`:2329-2337`) → **UPDATE `status='Ready'`, `lifecycle_status='executed'`** + all extracted fields (`:2513-2542`) → `status_change` audit row (`:2546-2559`) → calc fields, per-field confidence, `rent_schedules`, `risks` (`:2563-2663`) → optional email (`:2666-2714`) → 200 response (`:2717`).
- So a direct-add is auto-promoted to lifecycle `executed` **before any human looks at it**, and immediately appears in the Leases portfolio list (`PORTFOLIO_STATUSES` includes `'executed'`, `Leases.tsx:120`), in the header rent total (`Leases.tsx:601-611`), and in the Dashboard SummaryStrip portfolio rent (`src/components/dashboard/SummaryStrip.tsx:69-78`).

### 1.4 Review workbench (`src/pages/app/LeaseReview.tsx`)
- Happy path lands here with `status='Ready'`. Split view: PDF panel (wide viewports, `:454`, `:3073-3108`) + 7 tabs (General/Vendor/Rent/Options/Risks/Documents/ASC 842, `:3288-3296`).
- **Confidence cues are good**: per-field `ConfidenceBadge` (green ≥90 / amber ≥70 / red <70, `src/components/leases/LeaseReviewSections.tsx:52-89`, `src/lib/extractedFieldHelpers.ts:59-85`), red/amber field borders (`LeaseReviewSections.tsx:175-184`), a "flagged fields" primary action that jumps to the first unreviewed low-confidence field (`LeaseReview.tsx:2769-2775`, threshold 80% — `src/types/workflow.ts:75`), and a per-field "view in document" jump that highlights the source quote in the PDF (`LeaseReviewSections.tsx:251-260`).
- **Editing a wrong field**: inline edit → `handleFieldChange` appends to a client-side audit log (`:1170-1184`); on blur `trackFieldCorrection` records a `field_corrections` analytics row (`:1208-1240`); a visible "Save draft" appears when dirty + `beforeunload` guard (`:372-390`, `:2996-3000`). Solid.
- **Rent schedule**: editable table + generate-from-base-rent (single/annual escalation) (`:1521-1582`, `RentScheduleTable`), persisted to `rent_schedules`. Deliberately not change-set-staged on governed edits (documented at `:3503-3510`).
- **Attestation gate**: all 6 sections across 4 tabs must be marked "Reviewed" before approve (`:461-466`); a status strip names what's left (`LeaseReviewStatusStrip.tsx`) — but it also offers a one-click **"Mark all reviewed"** bulk CTA (`LeaseReview.tsx:1486-1518`, strip CTA `LeaseReviewStatusStrip.tsx:119-121`) that satisfies the entire human-review gate without opening a single tab.
- **Confirm**: "Ready to Approve" → `handleApproveLease` (`:1713-1795`) — a plain **browser** UPDATE writing `extracted_json._approval` + best-effort activity row. No role gate in UI or server beyond leases-UPDATE RLS (editor+ or functional role — `supabase/migrations/20260516120000_baseline_schema.sql:4214-4216`). Lifecycle does not change; the lease stays `executed`.
- **Post to repository**: primary action becomes "Activate" (`canShowLock`, `:2747`, `:2792-2800`) → lock dialog → `legacy-lease-action {action:'model_lock'}` (`:1142-1147`) → server sets `lifecycle_status='active'`, `model_locked=true` (`supabase/functions/legacy-lease-action/index.ts:401-411`). **Server requires financial approver/admin/owner** (`legacy-lease-action/index.ts:232-234`) and `lifecycle_status='executed'` (`:260-265`). After activation the page early-returns to the read-only `LockedLeaseDetail` (`LeaseReview.tsx:2728-2730`), and the lease counts against the active-lease cap (`process_lease:1078-1094`; `AppContext.tsx:216-222`).

**No approval chain is ever invoked on Path 2.** The approval-policies engine (`resolve-approval-chain`) is exclusively Path 1. Path 2's only "approval" is the self-serve `_approval` browser write plus the role-gated Activate.

### 1.5 Time-to-value feel
Upload wait 30–150s (opaque) → workbench (good) → 4 tab confirms + approve + activate ≈ 2–5 min of real review. The product delivers its promise ("send us your lease, we'll tell you what's in it") in under ~5 minutes **if** you hold the financial-approver role and nothing fails. Every failure branch below degrades to opaque or invisible states.

---

## 2. Failure branches

### 2.1 Extraction fails
- Server marks the lease `status='Failed'` with `error_message` and returns **500** (`process_lease:2333-2337`, catch `:2721-2728`). `supabase.functions.invoke` collapses any non-2xx into `FunctionsHttpError` whose `.message` is the generic *"Edge Function returned a non-2xx status code"* — the modal's error step shows exactly that (`LeaseUploadModal.tsx:174-176`, `:409-430`). The real reason (stored in `error_message`) is never shown at the moment of failure.
- The failed row is then **invisible**: it has `lifecycle_status=NULL`, so the Leases list excludes it in every scope except archived (`Leases.tsx:245-261`); it appears only on ImportHistory (`/app/imports`) — which has **no navigation entry anywhere** (`AppSidebar.tsx:297-302` nav list has no imports item; only inbound links are the Processing screen's "View Import History" button `LeaseReview.tsx:2006` and `OnboardingChecklist.tsx:30`). If the user dismisses the error toast/modal, the failed document is effectively lost to them. Recovery UX (FailedLeaseBanner with Retry / re-upload — `src/components/leases/FailedLeaseBanner.tsx:34-121` invoking `retry_lease`) is genuinely good, but only reachable if you can find the failed lease.
- **Stuck-Processing dead end**: if the error is thrown after the lease insert but outside an inner catch — the AI-consent gate is the concrete case (insert at `process_lease:2196`, `assertAiConsent` at `:2215`, outer catch `:2721` does not mark Failed) — the row stays `status='Processing'` forever. Safety nets: a client-side 3-minute auto-fail that only runs if the user sits on the lease page (`LeaseReview.tsx:987-995`) and the `reclaim-stuck-extractions` cron (30-min threshold, `supabase/functions/reclaim-stuck-extractions/index.ts:44`), whose scheduling is an operator step this review cannot verify. `ProcessingContext` re-adopts such rows on every mount and polls them every 3s indefinitely with no visible UI (`ProcessingContext.tsx:27-45`).
- Latent crash: the "user has no workspace" branch calls `jsonResponse(...)` (`process_lease:2126-2130`) which is **never imported** (only `getCorsHeaders` from `_shared/cors.ts` at `:8`; the only definition is `cors.ts:54`). That branch throws `ReferenceError: jsonResponse is not defined` at runtime → 500 with the internal error text instead of the intended "complete account setup" 400.

### 2.2 Quota exhausted mid-upload
- Best-built branch. Server returns **200 + `reason:'quota_exceeded'`** (`process_lease:971-988`, checked before any record is created `:2182-2188`); modal hands off to the wall (`LeaseUploadModal.tsx:190-194`); `LimitReachedDialog` is plan-aware with archive/upgrade/pack/buy-1 doors, idempotency-key reuse, pending-payment marker, firm-bound handling (`src/components/leases/LimitReachedDialog.tsx` throughout). Client gate mirrors server (`useWorkspaceQuota.ts`). Two nits: (a) the active-lease cap counts only `lifecycle_status='active'` (`process_lease:1083`), so never-activated `executed` leases occupy the portfolio without consuming the cap — the cap is porous by design asymmetry; (b) monthly-count DB error fails open silently (`:1066-1071`, documented).

### 2.3 Duplicate document
- **Nothing exists.** No hash column, no filename check, no dedupe query — every call mints a fresh `crypto.randomUUID()` lease (`process_lease:2191-2199`; grep for hash/dedupe: zero hits). Uploading the same signed lease twice yields two `executed` portfolio rows, two extraction spends against the monthly quota, and double-counted rent in the Leases header (`Leases.tsx:601-622`) and Dashboard (`SummaryStrip.tsx:69-78`). The journey brief assumed some handling; there is none, not even a warning.

### 2.4 Wrong classification (invoice, MSA, etc.)
- Good core: Tier 2 Haiku hard gate at confidence >0.85 (`process_lease:2244-2295`), 200 + `tier2_classification_failed`, modal shows the reason with an explained **Override and proceed** that records an `is_lease_override` correction for in-context learning (`LeaseUploadModal.tsx:432-470`, `process_lease:2391-2427`). Post-extraction soft warnings surface in the workbench with a "Submit a correction" path (`LeaseReview.tsx:3204-3233`, `Tier2CorrectionDialog`).
- Debris: the rejected upload already created a lease row marked `Failed` (`:2252-2255`). If the user cancels ("wrong file"), that row persists forever in the invisible ImportHistory. If the user overrides, a **second** lease row is created (new UUID per call) and the first Failed row remains. Same accumulation from the error step's "Try Again" (`LeaseUploadModal.tsx:229-232`).

---

## 3. Findings

### 3.1 HIGH — Failed/mid-processing uploads land in a surface with no navigation entry
Covered in §2.1. `/app/imports` (the only place a failed direct-add is visible or retryable) is absent from `AppSidebar.tsx:297-302`. Dead-end for the "extraction failed and I missed the toast" user. **Fix:** add ImportHistory to nav (or a "Processing/Failed (n)" chip on the Leases toolbar), and/or include `status='Failed'` rows in the Leases list with their badge.

### 3.2 HIGH — Upload processing is a synchronous black box in the modal
§1.2. Recommend: return the leaseId immediately and run extraction via `EdgeRuntime.waitUntil` (or at least show a proper in-modal progress state with elapsed time + "safe to close, we'll notify you"), make `ProcessingContext.jobs` render a persistent indicator, and stop firing "Abstracting…" after completion. Also remove the surprise `navigate()` when the modal was dismissed.

### 3.3 HIGH — Path 2 posting is role-gated with no fallback path and an opaque error
"Activate" renders for any editor (`LeaseReview.tsx:2747`), but `legacy-lease-action` 403s for non-financial/admin/owner (`legacy-lease-action/index.ts:232-234`). The 403 body is swallowed: `error.message` is the generic FunctionsHttpError text, so the toast reads *"Edge Function returned a non-2xx status code"* (`LeaseReview.tsx:1145`, `1150`). There is no "request activation" queue, no notification to financial approvers that an executed lease awaits posting (the only email goes to the uploader, `process_lease:2666-2714`), and the Approval Queue only handles Path 1 lifecycles. The journey brief's "submits for approval unless they have permission to post" **is not built** — there is no submit-for-approval branch at all on Path 2. **Fix:** hide/replace Activate for non-privileged roles with a "Request activation" action (notify financial approvers), and surface server error bodies (read `error.context` or return 200+error like process_lease does).

### 3.4 HIGH — No duplicate-document detection (§2.3)
**Fix:** store a SHA-256 of the file bytes on the lease row; on upload, warn-and-confirm when an existing non-deleted lease in the workspace has the same hash.

### 3.5 HIGH (misleading data) — "Executed — document missing" fires for every direct-add
`useNeedsAction.ts:140-147` and `SummaryStrip.tsx:96-104` flag `executed` leases where `executed_document_url` is null — but **no code path ever writes `executed_document_url`** (only definition sites: schema + generated types; grep for assignment: zero). The executed-path writer stores `executed_storage_path` instead (`process_lease:1979-1983`). Result: every freshly direct-added lease increments Dashboard "Needs Action" with the label *"Executed — document missing"* — factually wrong (the document was just uploaded) and permanently wrong for Path 1 executed leases too. **Fix:** test `executed_storage_path ?? storage_path`, or repurpose the flag as "Executed — awaiting activation" (which is the *useful* signal this journey actually lacks).

### 3.6 MEDIUM-HIGH — NeedsReviewBanner (missing/low-confidence Tier-1 fields) is unreachable dead code
`LeaseReview.tsx:3163` gates it on `needsReviewStatus(lease?.lifecycle_status)` = `'Needs Review' | 'Review Required' | 'pending_review'` (`LeaseStatusBadge.tsx:128-130`). No writer produces any of these: process_lease/retry_lease write `Ready/Failed/Processing` + lifecycle `executed`; `pending_review` was migrated away (`supabase/migrations/_archive/20260221000000_phase1_financial_columns.sql:28-31`). So the banner listing *missing* landlord/tenant/start/end (`NeedsReviewBanner.tsx:52-70`) never renders for a direct-add whose extraction came back empty. KNOWN_ISSUES #114 fixed the banner's confidence *source* but not the dead gate. Note "Needs Review queue" per CLAUDE.md belongs to unbuilt email intake — for direct-add nothing distinguishes a reviewed from an unreviewed `executed` lease in any list (both show "Executed"). **Fix:** gate the banner on `status==='Ready' && !isApproved` (or missing Tier-1 fields directly), and consider a "Needs review" list cue for executed-but-unapproved leases.

### 3.7 MEDIUM — Mandatory attestation of never-populated fields + one-click bulk attestation
The approval gate requires confirming the **Vendor** tab (7 fields: vendor name/address/city/state/zip/phone — `leaseReviewSectionConfig.ts:36-48`) and property `location/building/region`, none of which the AI pipeline ever extracts (the Opus schema has no vendor_* fields — `process_lease:857-886`); on Path 2 they are always empty. Meanwhile the strip's "Mark all reviewed" (`LeaseReview.tsx:1486-1518`) collapses the whole gate to one click. The gate is simultaneously too demanding (empty Vendor tab) and too weak (bulk bypass). Given the owner's simplification concern: drop Vendor from Path 2's required set, and reconsider the bulk CTA.

### 3.8 MEDIUM — Tier-2/error debris rows accumulate invisibly (§2.4)
**Fix:** on tier2 rejection, delete the placeholder row (or reuse it on override instead of minting a new UUID); on error-step "Try Again", reuse the failed row via retry_lease semantics.

### 3.9 MEDIUM — Amendment sub-flow defects (adjacent to this journey's modal)
1. Parent pickers and server both require parent `lifecycle_status='active'` (`LeaseUploadModal.tsx:99`, `process_lease:2156-2161`) — a just-uploaded, approved-but-not-activated (`executed`) master cannot be amended, with a 422 whose message surfaces generically.
2. `UploadAmendmentDialog` (used from the workbench "Upload amendment") **requires** an "approver email" that the server never reads (`UploadAmendmentDialog.tsx:64-67`, `:83`; zero reads of `approverEmail`/`category` in `process_lease`) — a phantom mandatory field.
3. It also omits `workspaceId` from the FormData (`:79-84`), re-exposing the documented 2026-05-13 wrong-workspace fallback bug (`process_lease:293-327`) that was fixed only in `LeaseUploadModal.tsx:154-162`. Same omission in `handleRunAbstraction` (`LeaseReview.tsx:795-799`), which additionally creates a brand-new lease and navigates away from the request record.
4. 20MB limit here vs 50MB everywhere else (`UploadAmendmentDialog.tsx:55`).
5. Amendments are separate `executed` rows, so parent + amendment rents both sum into the Leases header total and SummaryStrip (`Leases.tsx:601-622`, `getMonthlyRent` `leaseCalculations.ts:167-174`) — double-counted commitment.

### 3.10 MEDIUM — 50MB accepted, far less processable
`MAX_FILE_SIZE` 50MB (`process_lease:19`, modal copy `LeaseUploadModal.tsx:274`), but the full file is base64'd in a char-by-char loop (`:240-247`, ~67MB string for 50MB input — CPU/memory risk in the edge isolate) and sent whole to Anthropic up to 3× per upload (classify, page map, extract — `:711-718`, `:772-779`, `:1202-1209`). Anthropic's request-size/page caps sit well below a 50MB PDF, so large files fail as an opaque 500 after a long wait. **Fix:** validate a realistic ceiling (size + page count) at the modal with honest copy.

### 3.11 MEDIUM (docsDrift) — i18n abandoned on the intake surface
Full en+es translations exist for the upload modal (`lease.upload.*`, `src/locales/en/common.json:525+`, `es/common.json:525+`) but `LeaseUploadModal.tsx` and `AddLeaseDialog.tsx` hardcode English (no `t()` calls); most of `LeaseReview.tsx`'s workbench chrome ("Processing Lease", "Ready to Approve", "Reviewed", lock dialogs) is likewise hardcoded while adjacent banners are translated. Spanish users get a mixed-language core flow; CLAUDE.md's "both locale files updated together" discipline is moot when the components ignore the keys.

### 3.12 LOW — Misc
- ~250 lines of dead OpenAI code shipped in the deployed function (`process_lease:1242-1648`, `_extractLeaseDataWithOpenAI_DEPRECATED`).
- Client 3-minute auto-fail (`LeaseReview.tsx:987-995`) can race a slow-but-succeeding server extraction (server's later `status='Ready'` overwrites; transient contradictory state) and fires a browser write of `status` that depends on RLS permitting it.
- Approve is attributable only via a client-side best-effort activity insert (`LeaseReview.tsx:1770-1780`); `_approval` inside `extracted_json` is overwritable by re-extraction (acknowledged in-code).
- `ProcessingContext` recovery polls stuck rows every 3s forever with no UI (`ProcessingContext.tsx:27-45`).
- Toast on ready deep-links to legacy `/review` route (`ProcessingContext.tsx:77`) — works via the compat route.

---

## 4. What is genuinely good (so it doesn't get "fixed")
- Quota wall: layered client gate + server authority + credit claim only after Tier 2 pass so a rejected non-lease never burns a paid credit (`process_lease:2313-2327`).
- Tier 2 gate with override + per-workspace in-context learning loop, including document-summary few-shots (`process_lease:631-754`).
- The review workbench's confidence system (badges, borders, flagged-field jump, PDF source highlight) is coherent and reads from a single helper (`extractedFieldHelpers.ts`).
- FailedLeaseBanner's retry / in-place re-upload design (`FailedLeaseBanner.tsx`) — it just needs to be findable.
- Lifecycle Transition Convention is honored by process_lease's executed flip (both paths write `status_changed_at` + dual-format `status_change` rows).

## 5. Priority recommendations (condensed)
1. Make failures findable: nav entry for ImportHistory or Failed rows in the Leases list (3.1).
2. Async-ify or honestly instrument the upload wait; kill the backwards toasts (3.2).
3. Build the missing "request activation" half of Path 2, or hide Activate for non-privileged roles; stop swallowing edge-function error bodies app-wide (3.3).
4. Hash-based duplicate warning (3.4).
5. Fix `executed_document_url` needs-action logic → repurpose as "awaiting activation" (3.5) and un-dead the NeedsReviewBanner gate (3.6).
6. Trim Path 2's attestation to sections the AI actually fills; fix the amendment dialog's phantom approver email + missing workspaceId (3.7, 3.9).
