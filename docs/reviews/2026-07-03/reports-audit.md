# LeaseIO Audit — Reports, Audit Trail, Exports

Reviewer scope: src/pages/Reports.tsx, src/pages/app/{AuditLog,DisclosureReportLibrary,LeaseReportDetail,PortfolioReportsAdmin,ImportHistory}.tsx, src/components/reports/, src/lib/{asc842Report,reportGeneration,csv,leaseAnalysisProse}.ts, src/lib/reports/, edge functions generate-lease-report, generate-portfolio-report, generate-workspace-asc842-report, finalize-report-pdf, cleanup-expired-reports, generate-summary-token, get-summary-by-token, src/pages/PublicSummaryPage.tsx, plus the migrations/RLS/hooks they depend on. All claims carry file:line evidence from the repo (the only source of truth per the brief).

---

## 1. What actually exists and works

### Report surfaces (verified from routes in src/App.tsx)
| Surface | Route | Status |
|---|---|---|
| Reports hub | /app/reports (App.tsx:336) | Works; rent-roll export, 3 report cards, commitment-by-status chart, variance outliers, report settings |
| Rent roll CSV export | card on /app/reports (RentRollExport.tsx) | **Works end-to-end** |
| Disclosure report library | /app/reports/disclosure (App.tsx:264) | Page works; lists lease_reports rows; **PDF entries can never exist** (see 3.1) |
| Single-lease ASC 842 report detail | /app/leases/:leaseId/reports/:reportId (App.tsx:220) | Page works but is **unreachable for first generation** (see 3.2) |
| Portfolio period reports (admin) | /app/admin/reports (App.tsx:253) | Generation runs; JSON succeeds; **PDF upload fails for everyone** (3.1) |
| Consolidated workspace ASC 842 PDF | button on /app/reports/disclosure (DisclosureReportLibrary.tsx:175) | **Works** — server returns sections, client renders + downloads locally (no storage write, so it dodges the broken storage policy) |
| Audit log | /app/reports/audit-log, admin-gated (App.tsx:406) | Works; filter + pagination + CSV (CSV is page-limited, see 4.2) |
| Data quality | /app/reports/data-quality | **Dev-only**; production silently redirects to dashboard (App.tsx:394-402) while the Reports hub still shows the card (5.1) |
| Lease Analysis "summary" PDF | Documents tab (LeaseDocumentsTab.tsx:255-261, leaseAnalysisProse.ts) | Works, fully client-side, deterministic prose |
| Public financial summary | /share/:token (App.tsx:140, PublicSummaryPage.tsx) | Works; token minted/revoked via generate-summary-token |
| Import history | /app/imports (App.tsx:312) | Works; retry + hard-delete (disposable imports only) + archive steering |

### Solid pieces worth noting
- src/lib/csv.ts:15-27 — escapeCsvCell correctly handles both RFC-4180 quoting and spreadsheet formula injection (= + - @ tab CR prefixes). Used by both CSV exporters.
- The Node/Deno ASC-842 mirror (src/lib/asc842Report.ts vs supabase/functions/_shared/asc842_report.ts) is behavior-identical — full diff shows only comment differences.
- cleanup-expired-reports/index.ts:106-156 nulls storage paths atomically with the status flip, closing the orphan-blob read hole (P2-06 pattern), and preserves the row as audit anchor.
- Every report generation path is authenticated + role-checked server-side (generate-lease-report:371-402, generate-portfolio-report:380-418, generate-workspace-asc842-report:310-339) and rate-limited per workspace (30/hr, 10/hr, 10/hr).
- Error paths consistently mark the lease_reports row failed with error_message and (single-lease) write report_generation_failed activity (generate-lease-report:649-666; generate-portfolio-report:711-722); the detail page surfaces error_message (LeaseReportDetail.tsx:290-299).
- Portfolio report has a 500-lease soft cap with an honest 422 (generate-portfolio-report:522-546).
- generate-summary-token gates minting on lifecycle state (71-80), owner/admin only (84-108), blocks minting on non-live workspaces while allowing revoke (110-136), escapes user HTML in email (220-225).

---

## 2. The ASC 842 tension vs CLAUDE.md Hard Rule #1 — precise statement

**Hard Rule #1 (CLAUDE.md):** "LeaseIO is NOT a compliance tool. Never add ASC 842 compliance features, journal-entry generation, or ROU asset calculations. Never position copy as 'compliance-ready.'"

What the report does **NOT** do (the defensible side):
- No journal entries are generated anywhere.
- No ROU **asset** value is calculated — TI/IDC/incentives/prepaid rent are captured as *inputs* with basis text (asc842Report.ts:98-141) and flagged for the CPA, not computed into an asset.
- Every artifact carries not_a_financial_statement: true, a liability disclaimer, and a "Not a Financial Statement" banner/watermark (asc842Report.ts:38-42, LeaseReportDetail.tsx:229-240, JSON at asc842Report.ts:755-757).

What it **DOES** do (the side that collides with the rule as written):
- Emits **PV of lease liability**, **straight-line monthly expense**, and **cash-vs-P&L delta** — ASC 842 *measurements*, computed by LeaseIO from its own discount-rate machinery and stored in calc_pv_liability / calc_straight_line_exp / calc_cash_pl_delta (read at generate-lease-report:574-577, rendered in the PDF as "ASC 842 Measurement Inputs" — leaseDisclosureSections.tsx:242-280; portfolio totals sum total_pv_liability — asc842Report.ts:945-954).
- Ships an **operating/finance classification workflow** including the five ASC 842-10-25-2 finance-lease tests as first-class captured fields (asc842Report.ts:118-127, Asc842InputsTab.tsx) and preparer flags citing specific codification sections (842-20-25-1, 842-20-30-5, 842-20-50 — asc842Report.ts:590, 598, 682).
- Uses **compliance positioning in user-facing copy**: "ASC 842 Disclosure Report" page title (LeaseReportDetail.tsx:200), "ASC 842 disclosure reports generated for this workspace" (DisclosureReportLibrary.tsx:163), "PV Liability (ASC 842)" (FinancialReview.tsx:459), locale string (en/common.json:1194). A code comment reads "ASC 842 compliance: prefer the per-lease IBR override" (generate-lease-report:444).
- A code comment directly contradicts the strategy doc: "ASC 842 disclosure reports … they're the primary deliverable customers buy LeaseIO for" (Reports.tsx:125-127), vs CLAUDE.md "What LeaseIO Is": *not* a lease accounting tool.

**The docs are internally inconsistent about this.** CLAUDE.md itself lists Phase 8 (closed) as "ASC 842 disclosure reports", and describes the 2026-06-24 Portfolio recomposition as removing PV/ASC-842 "realigning with Hard Rule #1" (calling portfolioAnalytics.ts dead) — while the Reports surface continues to ship the same PV numbers through a very-much-alive code path (asc842Report.ts, 1052 lines + three edge functions + three PDF renderers). Either Hard Rule #1 means "no journal entries / no ROU asset / not positioned compliance-*ready*" (then the rule text and Portfolio-recomposition rationale need rewording and "compliance" comments scrubbed), or it means what it says (then Phase 8's measurement columns and copy are a standing violation). Needs a product-owner ruling recorded in PRODUCT_STRATEGY.md; code and docs currently point in opposite directions **about the same metric** depending on which page renders it.

---

## 3. Broken / unreachable core flows

### 3.1 CRITICAL — report PDF upload is blocked by a broken storage RLS policy (KNOWN_ISSUES #18, filed, never fixed)

The "report owners insert lease-reports" / "report owners update lease-reports" policies compare lr.id::text = (storage.foldername(w.name))[2] where w is public.workspaces — foldername() of the workspace **display name**, not the storage object path. For any workspace name without slashes, foldername() returns an empty array, [1]/[2] are NULL, the predicate is never true, and the policy is effectively WITH CHECK (false).

- Live/deployed shape (baseline dump deparsed by Postgres — proof of how "name" was bound): supabase/migrations/20260516120001_storage_policies.sql:83-94.
- Root cause: _archive/20260515030000_lease_reports_storage_finalization_guard.sql:52-53 used unqualified "name" inside an EXISTS whose FROM includes workspaces w (which has a name column); Postgres bound it to w.name instead of the outer storage.objects.name.
- Affected client paths: useGenerateLeaseReport.tsx:110-121 and useGeneratePortfolioReport.tsx:101-113 both storage.from('lease-reports').upload(...) under the user session → RLS rejection → "PDF upload failed", flow dies at the uploading stage.

**Consequences today:**
1. "Generate Portfolio Report" (/app/admin/reports) fails visibly at the third stage for every user, every time. The JSON is uploaded server-side and the row flips to ready, so the library accumulates ready rows whose PDF button is permanently disabled (DisclosureReportLibrary.tsx:263) — and the user is told generation *failed*.
2. LeaseReportDetail shows status ready with PDF "Pending…" forever (isProcessing derives from !pdf_storage_path, LeaseReportDetail.tsx:194-195); the only affordance, "Regenerate", creates *another* row that fails the same way.
3. finalize-report-pdf is never reached, so report_generation_completed (finalized) activity is never written.

Filed as **KNOWN_ISSUES #18 (High)** with a correct stub fix (KNOWN_ISSUES.md:586-650) — status "filed not fixed". Nothing after the baseline touches these policies (verified by grep). Given the product bills the disclosure PDF as the deliverable, this should be P0: apply the stub migration (qualify objects.name) and end-to-end verify as a non-admin editor.

### 3.2 HIGH — single-lease disclosure report has no entry point; the spec says the button was built

useGenerateLeaseReport (the only caller of the 667-line generate-lease-report function) is imported exactly once — by the **Regenerate** button on LeaseReportDetail.tsx:21,64 — a page only reachable at /app/leases/:leaseId/reports/:reportId, i.e. with an *already-existing* report. Grep of all of src/ finds no other invocation and no "Generate Report" button anywhere (only PortfolioReportsAdmin's card title matches). LeaseDocumentsTab.tsx generates only the separate "Lease Summary" analysis PDF (255-261). LockedLeaseDetail.tsx has no report affordance either.

- docs/PHASE_8_BUILD_SPEC.md:487: "On the lease detail page, when model_locked = true, a new 'Generate Report' button appears in the action cluster." Line 578 and the C4 commit table (line 720: "frontend wiring (button, hooks, 3 pages, settings tab, hub entry)") claim it shipped. It no longer exists — presumably removed in a later LeaseReview redesign — with no as-built amendment and no replacement.
- Two live UI strings direct users to the nonexistent affordance: DisclosureReportLibrary.tsx:214-219 ("Generate from a lease's Documents tab") and PortfolioReportsAdmin.tsx:310-312.

Net: the single-lease disclosure report — backend, hook, PDF renderer, detail page, activity logging — is a fully-built feature with **no way to use it**. You can only regenerate a report you can't create.

### 3.3 HIGH — soft-deleted leases still flow into disclosure artifacts and public links

The 2026-06-25 retention design hides soft-deleted leases behind restrictive RLS (leases_hide_soft_deleted, migration 20260625130000:62-67); CLAUDE.md enumerates "the 4 service-role read sites" that re-apply .is('deleted_at', null) manually. The report/summary functions were missed — none filters deleted_at (verified by grep over all four files):

- generate-workspace-asc842-report/index.ts:357-363 — selects **all** model_locked, archived=false leases via service role → a soft-deleted lease is *included in the consolidated ASC 842 PDF* handed to a CPA.
- generate-portfolio-report/index.ts:487-492 — selects all workspace leases; the partition (asc842Report.ts:1003-1052) checks only model_locked/active/overlap/verification, all of which a soft-deleted active lease still passes → included in portfolio totals.
- generate-lease-report/index.ts:346-352 — loads by id with no filter (lower exposure; UI can't see the id, but the API accepts it).
- get-summary-by-token/index.ts:39-53 — token lookup has no deleted_at filter, **and** delete-lease/index.ts:135-142 sets only the four retention columns (no token revocation — grep for summary_share_token in delete-lease returns nothing; lifecycle_status untouched so the state gate at get-summary-by-token:75-83 still passes). An admin who "deletes permanently" a lease leaves its **public, no-login financial summary link live for the entire 14-day window**.

Fix: add .is('deleted_at', null) to the three report queries; have delete-lease null summary_share_token/expiry (or filter in get-summary-by-token). Update the CLAUDE.md "4 sites" list.

---

## 4. Audit trail — can an auditor reconstruct who did what?

### 4.1 MEDIUM-HIGH — deleting a lease makes its history vanish from the Audit Log UI

AuditLog.tsx:145 joins leases!inner, and the client query runs under leases_hide_soft_deleted — so **every activity row for a soft-deleted lease (including the lease_soft_deleted event itself) disappears from the audit log** for the 14-day retention window. After purge, lease_activity_log rows are CASCADE-deleted (baseline_schema.sql:3249); the forensic snapshot goes to deleted_leases (service-role-only, no UI). From the auditor's chair: an admin deletes a lease → the trail is gone. Recommendation: drop the inner-join dependency for display (fall back to lease_id), or surface deleted_leases in an admin view; at minimum disclose the behavior the way the #76 gap notice does.

### 4.2 MEDIUM — Audit Log CSV export is silently page-limited and omits the actor

exportToCSV (AuditLog.tsx:181-213) maps over entries — the current page, capped at 20 rows by .range() (AuditLog.tsx:61,159). "Export CSV" on a 2,000-row log hands the auditor 20 rows with no truncation indicator. The CSV also has **no Actor column** (headers at 182-189) even though the on-screen table shows actor email — so the export cannot answer "who did what" at all. (Good: the #76 evidence-gap notice travels with the export, 203-205.) Fix: re-query without range and add the actor column.

### 4.3 MEDIUM — filter/label coverage: ~60 of ~110 event types are second-class

The current activity_type CHECK allows ~110 values (migration 20260625130000:169-215). ACTIVITY_LABELS (AuditLog.tsx:63-105) covers ~44. Everything else — all chain_* step decisions, report_generation_*, discount_rate_set, asc842_inputs_updated, lease_archived/restored, lease_soft_deleted/purged, signator_attestation_recorded, fully_executed_recorded, source_document_replaced, extraction_timed_out, all firm_*, change_set_*, risk_*, unlock_requested — renders as raw snake_case (fallback at 362) and **cannot be selected in the filter dropdown** (dropdown iterates ACTIVITY_LABELS only, 286-289). Conversely, several labels (model_locked, classification_resolved, manager_approved, financial_*, resubmitted, executed_terms_edited) are *not* in the CHECK — legacy-only values presented as filterable options.

### 4.4 MEDIUM — no details column: the "why" is invisible

The table shows type/transition/actor but never renders details — rejection reasons, comment text, report ids, reroute causes are captured but unreadable in UI or CSV. An auditor can see *that* a rejection happened, not why. Also low: the lease filter is a raw-UUID text input (AuditLog.tsx:263-270).

### 4.5 Smaller audit-trail gaps
- **Artifact downloads are never logged.** report_downloaded is in the CHECK, the Phase 8 spec (PHASE_8_BUILD_SPEC.md:233), and the SQL test — but no code writes it (grep: only a comment at finalize-report-pdf:17 and the cron's report_expired). Downloads happen via client-side createSignedUrl with no logging (DisclosureReportLibrary.tsx:140-157, LeaseReportDetail.tsx:131-148). report_deleted likewise has a DELETE policy (baseline:3953) but no writer and no UI.
- **Public-link mint/revoke is not in the audit trail.** generate-summary-token writes no lease_activity_log row for mint or revoke; neither does SummaryShareControls.tsx. Publishing a no-login financial link is exactly what an audit-defensible product should record.
- **The consolidated workspace report leaves no trace at all** — by design it writes no row, no storage object, no activity (useGenerateWorkspaceAsc842Report.tsx:1-5, generate-workspace-asc842-report:7-12). An all-lease financial disclosure PDF can be exported with zero record it happened.
- **PDF artifact integrity rests on client honesty**: the PDF is rendered in the browser and uploaded by the client; finalize-report-pdf validates only the path, not the content (150-162), and never checks the object exists before stamping pdf_storage_path (206-209). The P1-06 storage policy was supposed to bound *who* can upload — and it's the policy that's currently broken (3.1). The JSON is server-authoritative; the PDF (what a CPA reads) is client-produced. Server-side rendering is already tracked as KNOWN_ISSUES #13.
- Cron-written rows (report_expired) have user_id: null → Actor "—" (cleanup-expired-reports:166; part of the #90-NULL theme).

### 4.6 Public summary token — security assessment (mostly good)
- Entropy: 48 hex chars from two crypto.randomUUID()s (generate-summary-token:147-149) ≈ 190+ bits — unguessable.
- Expiry: 30 days, enforced at read (get-summary-by-token:65-71); expired == unknown (404, deliberate).
- Revocation: nulling the token kills the link immediately (generate-summary-token:111-124); revoke allowed even for non-live workspaces (correct direction).
- Scope: response builder whitelists fields, no ids/paths (get-summary-by-token:139-184). It does expose PV liability/classification/discount-rate provenance publicly — consistent with the section-2 tension.
- Gaps: no rate limiting on the public endpoint (brute force infeasible at this entropy — low); Access-Control-Allow-Origin: * is intentional and documented (get-summary-by-token:4-17); **the soft-delete leak in 3.3 is the one real hole**; summary_views records viewer IPs but only a count surfaces to admins.

---

## 5. Reports hub & export fidelity

### 5.1 Dead controls and a production dead-end on the paid Reports page
- **"Export all" does nothing**: Reports.tsx:182-186 renders the header button with disabled={!canExport} and **no onClick** — for an admin it is enabled and inert.
- **Per-card download icon buttons do nothing**: Reports.tsx:225-227, no onClick.
- **Data-quality card is a silent redirect in production**: the card is shown to editors/admins (Reports.tsx:65, filter at 199) but the route is import.meta.env.DEV-gated and production Navigates to the dashboard (App.tsx:390-404). A paying admin clicks "View report" and lands on the dashboard with no explanation. Either DEV-gate the card too or ship the page.
- Four report cards (portfolio/renewals/escalations/projections) remain unbuilt and are hidden per resolved KNOWN_ISSUES #44 (Reports.tsx:195-197) — correct handling, listed for completeness.

### 5.2 Rent roll CSV (RentRollExport.tsx) — fidelity good, two nits
- Scope defensible and documented: workspace-scoped, lifecycle_status IN (executed, fully_executed, pending_counter_signature, active), archived=false (70-78); rent via the canonical executed→current→base chain (#126 fix, 94/111); every cell escaped (137-139). Soft-deleted rows excluded by RLS (client query).
- Nit 1: formatCurrency returns '' for 0 (line 23 "if (!amount) return ''") — a genuine $0 rent exports as blank, indistinguishable from missing.
- Nit 2: amounts export as locale-formatted currency strings ($1,234.56) rather than numbers; summary rows mix labels into data columns (131-135). Spreadsheet users must clean before summing.

### 5.3 Audit CSV — see 4.2 (page-limited, no actor).

### 5.4 Disclosure JSON/PDF fidelity
- **Three date fields fabricated from one column**: execution_date, commencement_date, rent_commencement_date are all set to leases.lease_start (generate-lease-report:562-564; generate-workspace-asc842-report:423-425; generate-portfolio-report:617-619). The PDF/JSON present them as three distinct captured facts (asc842Report.ts:397-404). In a CPA-facing artifact this is misleading — rent commencement routinely differs from execution.
- **Raw UUIDs where labels are promised**: model_locked_by_user_label, classification_set_by_user_label, corrected_by_user_label populated straight from UUID columns (generate-lease-report:569,585; v_lease_verification_audit emits raw fc.corrected_by, baseline_schema.sql:1948). The "who verified this" section of the deliverable shows a UUID instead of a name.
- **Mirror drift in per-function shaping**: shapeRentSchedule in generate-lease-report defaults a missing annual_amount to monthly*12 (index.ts:186) while generate-workspace-asc842-report leaves it null (index.ts:74, violating RentPeriod.annual_amount: number) — the same lease can show different schedule annuals/totals in the single-lease vs consolidated artifact when calc_total_commitment is null.
- Portfolio inputs pass field_citations: {} (generate-portfolio-report:641) — citations silently absent from portfolio JSON; acceptable but undocumented.

---

## 6. ImportHistory
- Hard-delete correctly restricted to disposable imports (isCommittedLease steering to Archive, ImportHistory.tsx:353-380; DB trigger backstop surfaced verbatim, 210-217). Storage cleanup best-effort against the leases bucket (exists — storage_policies.sql:21-32).
- Client-side risks + lease delete is not transactional (188-202): a failure after risks-delete leaves a partially stripped lease; low impact since only disposable drafts qualify.
- Polling effect re-creates a 3s interval on every state change and only re-fetches while something is Processing (109-123) — works, mildly wasteful.

---

## 7. Docs drift summary (docs vs code)

1. **Hard Rule #1 vs Phase 8** — see section 2. The rule, the Portfolio-recomposition rationale, and the shipped Reports surface contradict each other; needs a ratified ruling.
2. **CLAUDE.md file map omits the whole disclosure surface** — "Reports & Audit" lists only Reports.tsx, AuditLog, ExtractionAnalytics, RentRollExport. Nothing about DisclosureReportLibrary, LeaseReportDetail, PortfolioReportsAdmin, src/lib/asc842Report.ts, src/lib/reports/, or the 5 report edge functions.
3. **PHASE_8_BUILD_SPEC claims a Generate Report button that no longer exists** (spec:487, 578, 618, 720) — no as-built amendment; two live UI strings still point at it (3.2).
4. **JSON_REPORT_SCHEMA.md is stale and violates its own stability rule**: code emits asc842_per_lease_inputs (asc842Report.ts:770) and ~10 additional conditional preparer-note rules (asc842Report.ts:572-685, comment: "the always-on TI/IDC flag from schema 1.0.0 becomes CONDITIONAL"), but REPORT_SCHEMA_VERSION is still 1.0.0 and the doc changelog stops at the initial release ("MINOR bump when fields are added" — JSON_REPORT_SCHEMA.md:18-22, 334).
5. **CLAUDE.md's "4 service-role sites filter deleted_at" claim is incomplete** — the three report generators and get-summary-by-token also bypass the RLS and don't filter (3.3).
6. **lease_reports RLS predates Phase 9 firm-awareness** — policies use raw workspace_members/owner subqueries (baseline:4654-4661) rather than firm-aware is_workspace_member(), so firm-derived members can't see the report library even though they can see the leases. Same for the storage SELECT policy (storage_policies.sql:101-107). Low today, inconsistent with the Phase 9 access model.

---

## 8. Recommended priority order

1. **Fix the lease-reports storage policy (#18)** — apply the stub migration from KNOWN_ISSUES qualifying objects.name; verify PDF upload as a non-admin editor end-to-end. Everything else about the disclosure feature is moot until this lands.
2. **Restore a Generate Report entry point** for single-lease disclosure (locked-lease detail or Documents tab) and fix the two empty-state strings; or, if the feature is being killed per Hard Rule #1, delete the orphaned surface and say so in the spec.
3. **Close the soft-delete leaks**: .is('deleted_at', null) in the three generators; revoke summary_share_token in delete-lease.
4. **Audit log export**: full-dataset export + actor column; decide on a details/reason column; extend labels/filter to the full CHECK list; decide how deleted-lease history should read (disclose like #76 at minimum).
5. **Resolve the ASC 842 positioning contradiction** in PRODUCT_STRATEGY/CLAUDE.md and align copy either direction.
6. Wire or remove the dead "Export all"/per-card download buttons; DEV-gate the data-quality card; fix the three-dates-from-one-column and UUID-as-label fidelity issues; log report_downloaded and share-link mint/revoke; bump the JSON schema version and doc.

**Rebuild vs fix:** fix. The architecture is sound (pure section builders, mirrored Node/Deno logic, forensic snapshots, honest error rows); the failures are wiring: one wrong identifier in an RLS policy, one removed button, missing filters, and doc drift.
