# AI Extraction Pipeline & Assistant — Code Review

Reviewer scope: `supabase/functions/{process_lease,retry_lease,reclaim-stuck-extractions,record-classification-correction,ai-assistant,audit-session}/index.ts`, `src/pages/app/ExtractionAnalytics.tsx`, `src/components/ai/AiAssistant.tsx`, `src/pages/LeaseAudit.tsx`, plus every file they invoke or that reads their outputs (`_shared/audit.ts`, `_shared/cors.ts`, `LeaseReview.tsx`, `LeaseUploadModal.tsx`, `FailedLeaseBanner.tsx`, `Tier2CorrectionDialog.tsx`, `RecentActivity.tsx`, config.toml, migrations). All claims verified against the code in this repo; deployed-copy state cannot be verified from here and is flagged where docs say the deploy is owed.

---

## 1. Overall shape (as-built)

Five distinct extraction pipelines exist, not one:

| Path | Entry | OCR | Classification gate | Extraction | Confidence rows | Quota gate |
|---|---|---|---|---|---|---|
| New upload (pipeline mode) | `process_lease` | none — native PDF to Claude | Haiku Tier 2 (hard gate 0.85) | Haiku page-map + **one** combined Opus 4.6 call | yes (8 fields → `lease_field_confidence`) | yes (monthly + active + credits) |
| Executed upload | `process_lease` (`extractionMode==='executed'`) | native PDF | Haiku Tier 2 | same combined call | no rows — JSON blob `executed_extraction_confidence` only | monthly *check* only; result never counted (see §5) |
| Retry | `retry_lease` | **Azure DI always** | **none** | Haiku page-map on OCR text + **three parallel** Opus 4.6 calls | **none** | **none** (KNOWN_ISSUES #67) |
| Free audit | `audit-session` | native PDF | none | single Opus 4.6 call, 2000 tokens | none | 5-doc cap + 5/hr rate limit |
| Assistant | `ai-assistant` | n/a | n/a | Sonnet 4.6 over structured context | n/a | 30/hr per workspace |

The primary path is solid and defensively written (empty-PDF backstop `process_lease:354-360`, bounded 429/5xx retry honoring Retry-After `:362-419`, JSON repair via `jsonrepair`, idempotent stuck-sweep). The problems are almost all **divergence between the five pipelines** and **computed signals that never reach a human**.

---

## 2. Model IDs — current, none deprecated

Hardcoded model strings (no env override):

- `claude-haiku-4-5-20251001` — `process_lease:712, 773`; `retry_lease:250`. Valid full ID for Haiku 4.5, Active.
- `claude-opus-4-6` — `process_lease:1203`; `retry_lease:395-397`; `audit-session:196`. Active (older-generation Opus; current Opus tier is 4.8; 4.6 has no announced retirement). Not a defect, but two generations behind and hardcoded in 5 call sites + stamped into `_extraction_model` forensics — a future model bump touches 3 functions and forensic strings.
- `claude-sonnet-4-6` — `ai-assistant:342`. Active (previous-gen Sonnet). Matches CLAUDE.md's "Sonnet for embedded assistant".
- `anthropic-beta: pdfs-2024-09-25` (`process_lease:378`, `audit-session:192`) — PDF support is GA; the header is a harmless legacy no-op but should be dropped on next touch.
- API version `2023-06-01` everywhere — fine.

**Verdict: no stale/retired IDs.** Consolidating the model IDs into one `_shared` constant (or env) is the cheap improvement.

---

## 3. CRITICAL / HIGH findings

### 3.1 `jsonResponse` is not defined in `process_lease` → ReferenceError on the no-workspace path (HIGH, unfiled)

`process_lease/index.ts:2126-2130` returns `jsonResponse({error: 'No workspace found…'}, 400, requestOrigin)` — but the file's imports (`:4-8`) bring in only `enforceWorkspaceRateLimit`, `repairJsonObject`, `getCorsHeaders`. `jsonResponse` exists in `_shared/audit.ts:3` (re-exported from cors.ts) but is **not imported here**. esbuild bundling doesn't type-check, so this deploys and throws `ReferenceError: jsonResponse is not defined` at runtime, caught by the outer catch (`:2721`) → the user with no resolvable workspace gets a 500 `{"error":"jsonResponse is not defined"}` instead of the intended onboarding message. Happens before the lease insert, so no data damage — but it proves this branch has never executed successfully and the file cannot pass `deno check`. Fix: add `jsonResponse` to the `_shared/audit.ts` import. Not present in KNOWN_ISSUES (grep confirms).

### 3.2 `retry_lease` is a second, worse pipeline — the recovery path degrades the record (HIGH)

Retry is the advertised recovery for **every** failure (`FailedLeaseBanner.tsx:49,101`, ImportHistory:151), yet it diverges from the primary path in seven load-bearing ways:

1. **Azure DI is the unconditional primary OCR** (`retry_lease:773-785` → `_shared/audit.ts:36`), violating Hard Rule #3 ("Azure DI only as fallback for scanned/handwritten docs"). If `AZURE_DI_ENDPOINT`/`AZURE_DI_KEY` are unset (`:13-14`, non-null-asserted at `:158-159`), every retry fails with "Document analysis failed" — the native-PDF path the original upload used is never attempted on retry.
2. **No Tier 2 gate and no quota gate** (KNOWN_ISSUES #67 covers quota; the Tier-2 bypass is additional): a Tier-2-rejected junk PDF becomes `status='Failed'` (`process_lease:2252`) and is then retryable through `retry_lease`, which runs **three** full Opus calls (`:394-398`) on it — the exact spend Tier 2 exists to prevent. Bounded only by the 20/hr workspace rate limit (`_shared/audit.ts:221`).
3. **The final UPDATE drops extracted columns** (`retry_lease:812-832`): `property_address`, `security_deposit`, `renewal_options`, `escalation_clauses`, `termination_clauses`, `rent_commencement_date` are extracted (CORE/CLAUSES prompts `:310-364`) and stored in `extracted_json`, but never written to their lease columns; `square_footage` and the seven Phase-clause fields (`permitted_use`, `insurance_requirements`, …) are not extracted at all on retry. A retried lease's columns silently diverge from its own `extracted_json`, and from what a first-pass lease would have.
4. **No `lease_field_confidence` rows** → the `update_lease_avg_confidence` trigger (baseline `:3083`) never fires → `avg_confidence_score` stays NULL for retried leases → `RecentActivity.tsx:227`'s low-confidence flag can never fire for them.
5. **No lifecycle flip / status_change row** — the primary pipeline flips `lifecycle_status → 'executed'` with the full convention triplet (`process_lease:2513-2559`, #33 RESOLVED); retry sets only `status: 'Ready'` (`:815`). A lease that failed and was retried ends in a different lifecycle state than one that succeeded first try.
6. **`extracted_json` is overwritten with a narrower shape** (`:426-444`): `_tier2_classification` is lost (so `Tier2CorrectionDialog`'s `originalClassification` becomes null, `LeaseReview.tsx:3928`), `_amendment_changes`, `_validation_warnings`, `_parent_lease_candidates` are lost, and none are regenerated.
7. **Haiku parse-failure fallback maps *every* page into *every* group** (`:270-275`) → three full-document Opus calls — maximum spend exactly when the pipeline is already misbehaving.

**Recommendation:** make retry re-invoke the same extraction function as `process_lease` (native PDF first, Azure DI only when the PDF has no text layer), with the same Tier-2/quota/confidence/lifecycle behavior. This is the single highest-leverage fix in this area.

### 3.3 Monthly-abstraction metering has three independent bypasses (HIGH, partially filed)

The monthly meter is `COUNT(leases WHERE uploaded_at >= now-30d AND extracted_json IS NOT NULL)` (`process_lease:1059-1065`):

- **Executed-mode uploads are gated against the count but never increment it** — results go to `executed_extracted_json` and `uploaded_at` is untouched (`:1976-2003`), so a workspace at 10/15 can run unlimited executed re-extractions (each = Haiku + Opus) forever. Unfiled.
- **Retries are unmetered** (#67, filed).
- **The count is TOCTOU-racy and fails open on count error** (#36, filed; `:1066-1071` returns `{kind:'ok'}` on error, skipping even the active check).

Combined with the 20/hr rate limit as the only true bound, "15/50 monthly abstractions" is enforced only for first-pass new uploads. The credit path itself is well done (claim deferred until after Tier 2 `:2313-2327`, atomic `consume_lease_credit` RPC) — but note a credit consumed just before an Opus failure is burned with nothing delivered; the free retry is the implicit recovery, which is why any #67 fix must preserve free retries of an already-passed upload (the KNOWN_ISSUES entry says exactly this).

### 3.4 50MB accepted, ~23MB actually processable (MEDIUM-HIGH)

`MAX_FILE_SIZE = 50MB` (`process_lease:19`, `retry_lease:62`, dropzone `LeaseUploadModal.tsx:130`), but the Anthropic Messages API caps requests at **32MB** and base64 inflates ~1.33× — any PDF over ~23MB passes validation, gets a lease row and a storage upload, then deterministically 400s at the API (terminal, not retried `:368`) → lease Failed "AI extraction failed". Additionally Haiku 4.5's 200K context caps PDFs at ~100 pages: on long documents Tier 2 classification 400s (fails open, `:2230-2242`) and the page map fails (`:794-797` full-document fallback), silently degrading the "two-pass" to nothing. There is no page-count check anywhere. Fix: cap uploads at ~20MB (and say so in the dropzone copy), and pre-flight page count if the two-pass architecture stays.

---

## 4. The "two-pass" architecture: as-built honesty check

CLAUDE.md claims: *"Pass 2 — Opus extracts from grouped relevant pages (5–8 focused pages per call, not 30 of boilerplate)… Cheaper and more accurate than single-pass full-document Opus"*, with an as-built note admitting a "single combined Opus call with page-group hints".

As-built reality in `process_lease`:

- Haiku receives the **full PDF** (`:756-779`), Opus then also receives the **full PDF** (`:1200-1209`). No page slicing occurs on this path — `buildPageGroups` output is flattened into one sentence: `"Key pages identified: 3, 4, 5."` (`:1176-1177`).
- So the pipeline is exactly "single-pass full-document Opus" **plus** a full-document Haiku call on top. The Haiku pass buys: (a) the focus-hint sentence, (b) disagreement warnings — which are never shown to anyone (§6.1). Cost per document is strictly higher than dropping Pass 1, unless the hint measurably improves accuracy (nothing measures this).
- Ironically, `retry_lease` **does** implement real page slicing (`slicePagesByNumbers:278-294`) and per-group calls (`:394-398`) — on the OCR-text path. The spec'd architecture lives only in the fallback pipeline.

**Recommendation:** either (a) delete Pass 1 from `process_lease` and save the Haiku spend (keep Tier 2, which pays for itself), or (b) actually slice pages. Update the CLAUDE.md architecture section — its cost claim is currently false for the primary path.

Cost bounding per document, as-built: bounded by max_tokens (Haiku 256 + 1024, Opus 4096 out) and input bounded only by the 32MB/600-page API caps; Tier 2 gates Opus for new+executed uploads only; per-workspace 20/hr rate limit is the real ceiling. `ai-assistant`: 1024 out, 30/hr, context bounded per-lease by `truncate`/`summarizeRisks` (`ai_context.ts`) — good.

---

## 5. Stuck-extraction coverage — mostly good, two gaps

`reclaim-stuck-extractions` is real and scheduled (pg_cron every 15 min, migration `20260623000000:88-97`), idempotent, keyed on `processing_started_at` with `uploaded_at` fallback, cron-secret gated, audit-logged with honest NULL attribution. Ways a lease enters `Processing` and how each resolves:

| Failure | Marked Failed inline? | Reclaimed? |
|---|---|---|
| Storage upload fails | yes `:2205-2208` | n/a |
| Tier 2 reject | yes `:2252` | n/a |
| Credit-claim race | yes `:2321-2324` | n/a |
| Opus/Haiku terminal error or timeout | yes `:2333-2337` | n/a |
| **`assertAiConsent` throws** (`:2215` — runs AFTER the insert at `:2194`) | **no** — outer catch returns 500, lease left `Processing` | yes, after 30 min, with misleading "Extraction timed out" copy |
| Final lease UPDATE fails (`:2544`) | no | yes |
| Isolate killed (wall clock / OOM — plausible on 50MB files given the per-byte `arrayBufferToBase64` loop `:240-247`) | no | yes |

Gaps: (1) move the consent gate before the lease insert (it needs nothing computed after it) — today a consent-revoked user gets a phantom spinner lease for 30 min and then a wrong error message; (2) KNOWN_ISSUES (line ~45) records that the redeploy of `process_lease`/`retry_lease` that stamps `processing_started_at` was **still owed as of 2026-06-23** — until the operator deploys, the sweep keys off `uploaded_at` (safe fallback, but the retry-race protection is inert). Verify deployment, don't recall.

---

## 6. Signals computed but never surfaced (incomplete work)

1. **`_haiku_warnings`** — the exact quality signal CLAUDE.md promises ("if Haiku says rent is on pp.3–5 but Opus extracts none there, flag for human review") is computed (`process_lease:1216-1226`, `retry_lease:411-421`) and stored in `extracted_json`, but **no file in `src/` reads it** (grep: zero hits). The reviewer is never flagged.
2. **`uncertain_fields` / `complex_clause_flags`** — requested from Opus in the schema (`:884-885`), paid for in output tokens, read by nothing anywhere.
3. **7 clause fields extracted only to JSON** — `permitted_use`, `insurance_requirements`, `maintenance_responsibilities`, `holdover_terms`, `assignment_consent`, `personal_guarantees`, `estoppel_snda` are extracted (`:874-880`) but never written to columns; whether LeaseReview's section config shows them from `extracted_json` should be confirmed against `SECTION_CONFIG` — the executed/retry paths definitely never produce them.
4. **`executed_extraction_confidence`** JSON blob (`:1982`) — no UI reader found.

What DOES reach the review UI (verified): `_tier2_warnings`, `_validation_warnings`, `_parent_lease_candidates`, `_amendment_changes` (`LeaseReview.tsx:3172-3365`), per-field confidence from `extracted_json` (post-#114 fix, `:341-355`), `_tier2_classification` → `Tier2CorrectionDialog` (`:3921-3941`).

---

## 7. Tier 2 gate & correction learning loop — works, with edges

The loop is genuinely closed: corrections table → few-shot injection into the Haiku system prompt, capped at 10, workspace-scoped (`process_lease:631-709`); UI dialog → `record-classification-correction` (member-gated, UUID/type/length-validated, lease-workspace cross-check, liveness-gated — clean function); override path records `is_lease_override` (`:2391-2427`). Never crosses workspace boundaries ✓.

Edges:
- **Every Tier-2 rejection leaves a permanent Failed lease row + stored PDF** (`:2252-2255`); the override path (`LeaseUploadModal.tsx:137-217`) re-uploads as a **new** lease, orphaning the first. Two junk rows per mistaken upload; nothing cleans them up, and each is retryable through the ungated retry path (§3.2.2).
- Fail-open on Haiku outage is reasonable and documented (`:2230-2242`), but the executed path's fail-open + no metering (§3.3) means an outage window is also an unmetered window.
- Retry path skips Tier 2 entirely, so the learning loop never sees retried documents.

---

## 8. Amendment extraction/compare — shallower than spec, and diffs stale data

Spec: "For amendments, Pass 1 maps changed sections; Pass 2 extracts changed terms vs parent." As-built (`process_lease:2440-2484`): the amendment goes through the identical generic extraction, then a **flat string diff of 12 scalar fields** against the parent. Gaps:

- **The diff baseline is the parent's `extracted_json`** (`:2137`, `:2442`) — the *original AI output*, not the parent's current column values. If the reviewer corrected the parent's rent from a bad extraction, `_amendment_changes.old_value` shows the uncorrected AI value. The comparison should read the confirmed columns.
- `rent_schedule`, `key_dates`, and the 7 clause fields are not compared.
- The diff only runs when `parentLeaseId` was declared at upload; Haiku-detected amendments get candidates (`:2357-2383`) but no diff, and there is no post-hoc "attach parent and diff" path.
- Rendering exists (`AmendmentChanges` at `LeaseReview.tsx:3364-3365`) but only under `isAmendment` — consistent.

---

## 9. ai-assistant (Leo) — grounding and gating

**Good:** server-side plan gate (`workspace.plan !== 'business'`, `:234`), membership/owner check (`:208-221`), liveness gate before spend (`:226`), consent gate (`:243-261`), 30/hr workspace rate limit, soft-deleted leases excluded (`:327`), per-lease context bounded (`ai_context.ts` truncation), grounding prompt forbids fabrication and handles truncation ellipses (`:102-115`), generic errors to client. Client (`AiAssistant.tsx`) also gates UI on `canAccessFeature('business')` and hits the endpoint with the user JWT — defense in depth ✓. Strictly single-workspace ✓ (Hard Rule #8 as amended).

**Gaps:**
1. **`.limit(60)` with no `.order()`** (`:328`) — >60 leases → nondeterministic subset; Leo then asserts "TOTAL ACTIVE LEASES: N" and portfolio totals from partial data with **no disclosure**. Directly violates "never fabricate numbers" in spirit: the numbers are computed from silently truncated data. Fix: order deterministically, and if count > limit, say so in the context so Leo discloses it.
2. **Firm-derived members are denied**: the check reads `workspace_members` directly, not the firm-aware `is_workspace_member()` semantics Phase 9 introduced — a firm_admin with implicit access to a child workspace sees the assistant button (client gate passes via plan) but gets `Access denied` from the server. Functional gap for the Business-tier firm story, not a security hole (it's stricter than RLS).
3. `buildLeaseContext` filters to `['active','executed','draft']` (`:35-37`) — leases in `under_review`/`approved`/etc. are fetched but invisible to Leo; a user asking "what's pending approval?" gets "no data". May be intentional; undocumented.
4. Rate-limit read-then-upsert is racy (same pattern as `enforceWorkspaceRateLimit`) — parallel requests can exceed 30/hr slightly. Low.

---

## 10. audit-session / LeaseAudit — built and coherent, minor items

Route exists (`App.tsx:129`), function deployed config'd `verify_jwt=false` with its own bearer-token auth (`:65-74`). Requires an authenticated session ("Please sign in before starting an audit", `LeaseAudit.tsx:93`) — the "lead magnet" is account-gated; the page copy ("Authenticated audit workspace") shows this is deliberate, but the funnel implication belongs to the GTM reviewer. Cost is well bounded (20MB, 5 docs, 5/hr, 2000 output tokens). Service-role workspace insert bypasses the entitlement guard legitimately (guard exempts service_role, `20260522000000:80-82`).

Minor: single-pass extraction with no Tier 2 (acceptable at 5 docs); lease insert failure is non-fatal (`:289-292`) but the risks insert that follows (`:296-305`) then FK-fails silently; no consent gate (audit users consented at signup presumably — verify); free-audit leases are created `lifecycle_status:'active'`/`status:'Ready'` (`:269-271`) — if such a user later upgrades the same account, 5 unreviewed AI-only extractions sit as "active" leases.

---

## 11. ExtractionAnalytics — consistent with "dev-only"

Route is genuinely dev-gated (`App.tsx:390-404`, `import.meta.env.DEV` else redirect) — matches CLAUDE.md. Data sources are real: `field_corrections` written by LeaseReview field edits (`:1222`), `lease_field_confidence` written by process_lease, `avg_confidence_score` maintained by trigger. Two soft notes: the `field_corrections`/`lease_field_confidence` queries are not workspace-scoped client-side (acknowledged in-file comment, RLS-scoped); retried leases never appear in confidence data (§3.2.4).

---

## 12. Smaller findings

- **Raw vendor error leakage**: `process_lease:2721-2727` returns `error.message` (can embed the full Anthropic error body incl. request details) to the browser; `retry_lease:909-916` same (filed for retry as #140 with a note to audit process_lease — the process_lease half is still unfixed).
- **Dead OpenAI extractor**: `_extractLeaseDataWithOpenAI_DEPRECATED` (`process_lease:1242-1648`, ~400 lines) references undeclared `OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_MAX_TOKENS` (`:1596-1604`). Never called (name-prefixed `_` so lint ignores it), but it blocks `deno check`, bloats the bundle, and keeps OpenAI request code in a codebase whose Hard Rule #3 says "No OpenAI". Delete it.
- **Executed-upload permission check has no owner bypass** (`process_lease:1749-1768`): non-creator must hold `workspace_roles` financial_approver/admin; `retry_lease` additionally allows the workspace owner (`:566-575`). A workspace owner who didn't create the lease and holds no role row gets 403 on executed upload but 200 on retry — inconsistent.
- **`arrayBufferToBase64` per-byte string concat** (`:240-247`) — O(n) string building over up to 50MB; risk of isolate CPU/memory kill on the biggest accepted files (which then becomes a stuck→reclaimed lease). Use chunked `String.fromCharCode.apply` or a streaming encoder.
- `retry_lease.callAnthropicAPI` has no request timeout (`:181-231`, no AbortSignal) and retries even terminal 400s; relies on the isolate wall clock + reclaim sweep.
- Rent-schedule delete-then-insert is non-atomic in both functions (filed, #35).
- Pipeline-mode leases without `workspaceId` land via a "most-recently-created workspace" fallback with only a console warning (`:292-327`) — all current callers pin `workspaceId` (`LeaseUploadModal.tsx:160-162`); the fallback plus the broken `jsonResponse` branch (§3.1) are the residue of the old behavior.

---

## 13. Docs drift summary

1. **Hard Rule #3 vs retry_lease**: "Azure DI only as fallback for scanned/handwritten docs" — retry uses Azure DI as unconditional primary for every retried document (`retry_lease:773-785`).
2. **CLAUDE.md two-pass cost claim**: "Cheaper and more accurate than single-pass full-document Opus" — the primary path *is* single-pass full-document Opus plus an extra full-document Haiku call; no page slicing (`process_lease:1176-1209`). The as-built note under-states the deviation.
3. **CLAUDE.md quality-signal claim**: "if Haiku says rent is on pp.3–5 but Opus extracts none there, flag for human review" — the flag (`_haiku_warnings`) is stored but rendered nowhere in `src/`.
4. **"Tier 2 … Gates expensive Tier 1 calls"**: true for new/executed uploads only; retry and audit-session run Tier 1 (Opus) with no Tier 2.
5. **"No OpenAI"**: dead OpenAI request code still ships inside `process_lease` (`:1594-1607`).
6. **`docs/CLAUDE.md` amendment sub-workflow** ("AI abstracts & compares"): the compare is a 12-field string diff against the parent's *raw* extraction, not a section-level AI comparison, and misses schedule/clause changes (§8).
7. **Deployed-vs-repo drift flagged in KNOWN_ISSUES** (redeploy of process_lease/retry_lease owed since 2026-06-23) — the repo behavior reviewed here may not be what's running.

---

## 14. Recommendations (priority order)

1. Fix the `jsonResponse` import in `process_lease` (one line) and run `deno check` in CI for edge functions.
2. Unify retry onto the primary extraction path (native PDF, Tier 2, quota policy per #67 design note, confidence rows, lifecycle convention, preserve/regenerate `_tier2_classification` + amendment data). Until then, at minimum: write the missing columns, write confidence rows, add Tier 2.
3. Meter executed-mode extractions (count them in the 30-day window or a dedicated counter) and close #36's fail-open.
4. Lower the accepted file size to ~20MB everywhere and reflect it in UI copy.
5. Decide the Pass-1 question: delete the Haiku page-map or make it slice pages; either way surface `_haiku_warnings` in `NeedsReviewBanner` (it's the promised human-review flag) or stop paying for it.
6. `ai-assistant`: add `.order()` + disclose truncation past 60 leases; decide firm-member access explicitly.
7. Move the consent gate above the lease insert; genericize both outer catches (#140 both halves).
8. Amendment diff: compare against parent's confirmed columns, include rent_schedule.
9. Delete the dead OpenAI function.
10. Clean up orphaned Failed rows on Tier-2 override (reuse the rejected lease row instead of creating a second one, or hard-delete the rejected row after override succeeds).

**Rebuild vs fix: FIX.** The primary pipeline, stuck-sweep, correction loop, and assistant gating are well-engineered and audit-conscious. The debt is concentrated in the retry path's divergence and in signals/metering that were built to 80% and never wired through — all incremental work on a sound base.
