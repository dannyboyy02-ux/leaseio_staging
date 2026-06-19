# LeaseIO — Project Audit Findings (2026-06-17)

> **Scope:** a six-sweep, project-wide defect + UX audit run 2026-06-15→17. Each finding carries a `file:line` and a **verification status** — every load-bearing claim was confirmed first-hand against the code, and sub-agent overstatement was corrected repeatedly (noted inline). **No application code, migration, edge function, or config was changed** producing this audit.
>
> **Confirmed defects are filed in `docs/KNOWN_ISSUES.md` as #108–#119**; this document is the full evidence + remediation behind them. Sweeps: (1) Approval workflow, (2) Workspace/firm isolation, (3) AI extraction, (4) Billing/Stripe, (5) Data-fidelity/audit-trail, (6) Reports/exports.

## Context

This began as a higher-level UX audit (decision-first dashboard, Portfolio reimagining, settings IA — preserved in Appendix A). The product owner flagged that the first pass **scratched the surface**: it never caught that the approval queue shows users a meaningless tag — **"Concept approver: role manager_approver"** — nor that this is one symptom of a whole *class* of concrete defects. The sweeps below are the deeper pass.

**The through-line:** LeaseIO is architecturally sound and the security-critical surfaces (tenant isolation, billing integrity, audit immutability, the not-a-compliance-tool line) hold up well. The defects are concentrated **at the edges** — de-jargoning, notifications, and the Phase-7 delegation/SLA layer each got built in one place and left unwired in others; a few export/calc surfaces diverged from the canonical ones. Several are correctness/governance gaps, not polish.

---

## DEFECT CLASS 1 — Internal jargon leaks into user-facing UI (the "concept approver" bug)

### Root cause (verified)
The team **set the standard and met it for lifecycle *statuses*** but never did the equivalent for chain-step **stages** and **roles**:
- `src/lib/lifecycleStates.ts:114-137` — `displayLabel()` exists, with the explicit comment *"Short, human-readable, no jargon … the UI should not surface internal vocabulary differences to the user."* It correctly maps `concept_submitted → "Submitted"`, `final_review → "Final Review"`, etc.
- **But there is no `stageLabel()` and no shared `roleLabel()`.** A role-label map *does* exist (`src/pages/settings/ChainDiagram.tsx:61-65`, `FUNCTIONAL_ROLE_OPTIONS`) but it is walled off inside the policy editor and still ships jargon (`signator → "Signator"`).
- So every other render site hand-rolls or raw-prints the internal vocabulary.

**What "concept" / "signator" mean** (from `STATE_GROUPS`, `lifecycleStates.ts:62-74`): **"concept" = the initial/request approval** (approving the *need* for the lease before it's negotiated); **"signator" = the final/signature approval** (approving the negotiated, ready-to-execute lease). Two real, distinct gates — but the names are internal deal-lifecycle metaphors that mean nothing to an SMB finance user.

### The leak register (verified `file:line`)

| # | File:line | User-visible string | Internal code leaked | Audience | Sev |
|---|---|---|---|---|---|
| 1 | `pages/app/ApprovalQueue.tsx:288-291` | "Concept approver: role manager_approver" | stage + raw snake_case role | Approvers (daily) | **HIGH** |
| 2 | `components/leases/ChainViolationBanner.tsx:243` | "concept" / "signator" | stage enum | All members | **HIGH** |
| 3 | `components/leases/ChainViolationBanner.tsx:250` | "(manager_approver)" | raw role | All members | **HIGH** |
| 4 | `components/leases/RerouteNotificationModal.tsx:151,153` | "concept_submitted → in_negotiation" | **raw status enums, bypassing `displayLabel()`** | Approvers (modal) | **HIGH** |
| 5 | `components/leases/RerouteHistorySection.tsx:203` | "concept_submitted → concept_under_review" | raw status enums | All members | **HIGH** |
| 6 | `pages/app/AuditLog.tsx:98` | "Escalated to concept approver" | "concept" jargon | All members | **HIGH** |
| 7 | `pages/app/SignatorReview.tsx:357,387` | page title **"Signator Review"** | "signator" jargon | Signatory | **HIGH** |
| 8 | `lib/reports/leaseDisclosureSections.tsx:451` | **"Signator Attestation"** in exported PDF | "signator" jargon | **Auditors / board (external!)** | **HIGH** |
| 9 | `pages/app/ExceptionsDashboard.tsx:269` | "5 days stuck on concept stage" | stage enum | Dashboard viewers | HIGH |
| 10 | `components/settings/ApprovalPolicyTestDialog.tsx:241` | "concept chain" / "signator chain" | stage enum | Admins | HIGH |
| 11 | `components/leases/LeaseAnalysisExport.tsx:226` | `asset_type.replace('_',' ')` hack | no label map | PDF viewers | MED |

The two worst are **#4** (raw DB enum codes shown in a modal popped at the approver — the one place `displayLabel()` was *built to prevent*) and **#8** (jargon printed into a disclosure PDF that can reach external auditors).

### Fix (one source, every site)
1. Add a shared `stageLabel(stage)` + `roleLabel(role)` to `src/lib/lifecycleStates.ts` (the existing home of `displayLabel()`), with **decided finance-English terms** — e.g. concept → **"Initial approval"**, signator → **"Final / signature approval"**; `manager_approver` → "Manager", `financial_approver` → "Finance", `signator` → "Signatory."
2. Route **all 11 sites** through `displayLabel()` / `stageLabel()` / `roleLabel()`. Delete the inline `step.stage === 'concept' ? …` at `ApprovalQueue.tsx:288` and the `.replace('_',' ')` / `.slice(0,2)` hacks.
3. Re-point `ChainDiagram`'s local map at the shared `roleLabel()` so there's one source of truth.
4. Keep `en`/`es` locale files in lockstep (these strings are user-facing copy).

---

## DEFECT CLASS 2 — Controls that claim an action they don't perform

| # | File:line | Appears to do | Actually does | Sev |
|---|---|---|---|---|
| 1 | `components/workflow/NudgeApproverButton.tsx:64-71` + `hooks/useLifecycleWorkflow.ts:372-387` | "Nudge sent to approver" | Writes `leases.last_nudged_at` **and** inserts a `lease_nudges` row (type/channel fields) — but **nothing reads `lease_nudges`**; no email, no in-app alert. Write-only table. | **HIGH** |
| 2 | `components/dashboard/IntakeTrend.tsx:36-37` | clickable drill-down tile | `void navigate; // future` — clicks nowhere | MED |
| 3 | `components/dashboard/PipelineByDepartment.tsx:80-81` | clickable department bars | `void navigate; // future` — clicks nowhere | MED |
| 4 | `pages/settings/AccountSettings.tsx:1389-1393` | "Submit a Privacy Rights Request" — promises a **30-day GDPR/CCPA response** | `mailto:privacy@…` link; manual email, no tracking/SLA | **MED-HIGH** |
| 5 | `pages/settings/AccountSettings.tsx:1362-1366` | "Request Data Export" | `mailto:` link; manual | MED |
| 6 | `components/CancellationBanner.tsx:154-157` | "Contact Support" to restore a deleted workspace | `mailto:` link; manual | MED |

**Rigor note (false positives the sweep cleared):** the report-download buttons correctly toast *"artifact not yet available"* (honest); the risk-watchlist and Tier-2 correction toasts are **truthful** — `process_lease/index.ts` really consumes `risk_templates` and `classification_corrections`. Those are not defects.

**Fix priority:** the nudge is the sharp one — it's a core approval action that silently does nothing. Wire `lease_nudges` to a real notification (email + in-app), with per-approver cooldown and a "delivered" signal back to the requester. The `mailto:` items are acceptable *only if* an operator genuinely processes them within SLA (hard rule #9 territory — they should be tracked, not fire-and-forget); the privacy-rights one carries legal exposure.

---

## DEFECT CLASS 3 — Approval-chain functional gaps (verified against the edge functions)

| # | Location | Defect | Consequence | Sev | Status |
|---|---|---|---|---|---|
| C1 | deployed `resolve-approval-chain` is **pre-Phase-7** (CLAUDE.md "deferred redeploy"; see also KNOWN_ISSUES #84); new chains insert NULL `effective_assignee_user_id` / `pending_since` | **cron-driven paths skip these rows** — policy-timeout auto-delegate (`process-delegate-timers/index.ts:64-72`) and stuck-chain/SLA detection never fire on a never-rerouted lease | Leases silently get **no auto-escalation and no stuck detection** until a reroute happens. (Manual delegation still works — corrected from the agent's overstatement.) | **HIGH** | verified |
| C2 | `act-on-chain-step/index.ts` sets `pending_since` only when an approval *crosses a sequential level* (~:612-640), never on the **first** concept approval | even after C1 is fixed, delegate timers / stuck-detection skip the **first** step in a stage | MED | verified (trace) |
| C3 | `voluntary-delegate-step/index.ts:187-189` sets `effective_assignee_user_id` but **never clears `approver_user_id`**; `act-on-chain-step:282-283` authorizes the **original** assignee *first* (effective is a `!authorized` fallback at :290) | delegation is **additive, not exclusive** — the delegator can still act on a step they handed off; queue may still show it to them | MED | **verified** — confirm if intended |
| C4 | `escalate-to-concept-approver/index.ts:325-376` **clones the prior concept rows verbatim** (carries old `policy_id`/`approver_user_id`); no policy re-match against current attributes (code comment admits it) | escalating back to concept **after a material change** re-runs review with the **original approver set** — a now-higher cost that *should* pull in legal/CFO doesn't | **MED-HIGH** | **verified** — see caveat |
| C5 | `resolve-approval-chain` reroute marks superseded rows, then inserts new rows as **two separate writes** (not atomic) | if the insert fails after the supersede, the lease is left with **zero active approvers** — stuck until the retry loop recovers | MED | verified (trace) |
| C6 | `components/leases/ChainStepBadges.tsx:103-116` flags "Pending N days" only ≥3 days (red ≥7); **no per-policy SLA**, no escalate action | aging is invisible for the first 3 days and carries no SLA context or action; the approver blocking an SLA never sees it (only the admin ExceptionsDashboard does) | MED | verified (round 1) |

**C4 caveat (documented honestly):** a *separate* attribute-change reroute trigger re-resolves the policy when a structured field (e.g. `monthly_payment`) is **updated**. So C4 only bites when negotiation changes terms that have **not yet been written to the structured field** at escalation time (common — terms often change "on paper" before the executed doc is processed). The fix is to make `escalate-to-concept` **re-resolve the policy** (or reuse the reroute path) instead of cloning, so the approver set always matches current terms.

**Plus the persona gaps from round 1 (still valid):** the **requester is blind** (no per-step "where is my lease" tracker/ETA); the queue never shows **"why is this mine?"** (the routing policy + matched criteria); there is no **policy simulator** ("where would THIS lease route?") and SoD is validated only at submission, not at policy-save.

---

## SWEEP 2 — Workspace tenant isolation & the firm parent→child model

**Headline: isolation is SOUND — no data leaks found.** Three sweeps (RLS coverage, parent-child mechanics, edge-fn authz + AI boundary) plus first-hand verification of the load-bearing pieces. The multi-tenant boundary holds; the real defects are in the parent→child *plumbing*, not in isolation.

### What's correctly locked down (verified)
- **`is_workspace_member()` firm-aware clause** (`migrations/20260615172439_…:348-370`) — the firm-derived grant requires *all* of: the workspace's own `firm_id IS NOT NULL`, `restrict_firm_access = false`, and `is_firm_member(w.firm_id, caller)`. No cross-firm over-grant; opt-out honored; `SECURITY DEFINER` + pinned `search_path`. **Verified first-hand.**
- **Owner-privileged inbox view `v_firm_user_pending_actions`** (`…20260616120000_…:249-337`) — the highest-risk surface (PLAIN view, no RLS backstop). `WHERE fm.user_id = auth.uid()` is **baked into the view** (not left to the caller); both branches join `w.firm_id = fm.firm_id AND restrict_firm_access = false`; the chain branch further restricts to the caller's own routed actions. Cross-user / cross-firm leak structurally impossible. **Verified first-hand.**
- **RLS coverage** — all ~36 workspace-scoped tables RLS-enabled, no `USING(true)`/broad policies; firm tables scoped by `is_firm_member`/`is_firm_admin`.
- **`restrict_firm_access` is triple-guarded** — RLS helper + service-role-only binding trigger (`prevent_firm_workspace_binding…:302`, blocks any authenticated UPDATE of the flag) + workspace-owner-only `set-firm-access:46`. A firm can't override a child's shield.
- **Firm edge-fn authz** — owner-only-mints-admins, bind dual-ownership, invite email-binding, join-request two-party consent + service-role-only transitions: enforced, no IDOR.
- **AI assistant (hard rule #8)** — `ai-assistant` requires direct membership or ownership, does NOT grant firm-derived access, queries only `eq('workspace_id', …)`. Stays single-workspace; never crosses a firm/sibling boundary.
- **Node⇄Deno `firmAccess` mirrors** — verified identical (precedence + firm_admin→admin / firm_member→editor).

> On terminology: the model is **one level** — a *firm* (parent) owns *child workspaces*. There is no "workspace-under-a-workspace" sub-space; "sub-spaces" = firm child workspaces, and they work as designed.

### Real defects (parent-child integrity — verified first-hand)

| # | Sev | Defect | Evidence | Consequence |
|---|---|---|---|---|
| W1 | **HIGH** (integrity/availability) | Firm child-counter **never decrements on workspace DELETE** | `maintain_firm_child_workspace_counter` (`…172439_…:133-189`) has no DELETE branch; its trigger (`:191-194`) is `BEFORE INSERT OR UPDATE OF firm_id` — DELETE excluded. `delete-workspace` deletes the row with **no `firm_id` release first**. | `firms.child_workspaces_used` drifts upward permanently → firm falsely hits `child_workspace_limit` and **can't bind new children**. |
| W2 | MED (latent) | Plan-lock trigger is **UPDATE-only** | `workspaces_plan_firm_lock` (`:219-222`) = `BEFORE UPDATE`; force-to-`business` can't fire on an INSERT that already carries `firm_id`. The counter trigger DOES handle INSERT — asymmetric. | A firm-bound workspace created via INSERT keeps a non-business plan. **Latent today**; **bites when self-serve firm-workspace creation (#105) ships.** |
| W3 | MED | `add-firm-member` echoes **raw DB constraint errors** (`add-firm-member:65`) | already tracked as **KNOWN_ISSUES #102** | constraint/index-name disclosure. **Not re-filed — it's #102.** |

*Cleared on inspection (not defects): the bind TOCTOU — the `FOR UPDATE` lock on the firms row serializes the counter correctly; `firm_activity_log` lacking a top-level `workspace_id` is a documented deferral.*

### Fixes
- **W1:** add a DELETE branch to `maintain_firm_child_workspace_counter` (decrement when `OLD.firm_id IS NOT NULL`) **and** add `DELETE` to the trigger event list — *or* make `delete-workspace` release (`firm_id → NULL`) before deleting. New migration; reconcile any drifted counters in the same migration. (See #112 — combined with the billing-resync gap B2.)
- **W2:** extend `workspaces_plan_firm_lock` to `BEFORE INSERT OR UPDATE`; force `plan='business'` when `NEW.firm_id IS NOT NULL` on INSERT — ship alongside the #105 path.

---

## SWEEP 3 — AI extraction pipeline (the AaaS core)

**Headline: well-guarded where it matters most (cost, isolation, secrecy, vendor-failure) — the gaps are in confidence *surfacing* and a few human-in-loop edges.** This sweep is where verification mattered most: the human-in-loop agent flagged 2 CRITICALs that didn't survive a read of the actual code.

### What's solid (verified / grep-backed)
- **Cost bounding** — Opus (`claude-opus-4-6`) receives only the Haiku-mapped page groups (`process_lease:1299-1306`, `buildPageGroups:846`), token-capped, quota checked *before* the expensive call; single-lease credit consumed atomically *after* Tier-2 confirms it's a lease. No unbounded path.
- **Vendor-failure surfacing (rule #9)** — Tier-1 (Opus) failure marks the lease `Failed` + surfaces the error; Tier-2 (Haiku) fails *open* + logs; Anthropic is in `vendor-health-check`.
- **Model-name secrecy (rule #3)** — model IDs hardcoded server-side + stored only in forensic `extracted_json._extraction_model`; **zero** frontend leaks (grep of `src/` = none).
- **Learning isolation (rule #8)** — `classification_corrections` + `risk_templates` both fetched with `.eq('workspace_id', …)`. No cross-workspace bleed.
- **The quality signal IS implemented** — Haiku-page-map vs Opus disagreement detected (`process_lease:1312-1323`) and surfaced (`LeaseReview:~3797`). `safeDate` rejects junk → null; CPI/index escalation **not** defaulted to 0 in extraction (flagged `needsEscalationReview`); Tier-2 hard-gates non-leases before Opus.

### Verified defects

| # | Sev | Defect | Status |
|---|---|---|---|
| E1 | **HIGH** | **`NeedsReviewBanner` low-confidence warnings are DEAD.** `process_lease` **never writes `leases.confidence_scores`** (grep = 0 writes); the banner (`NeedsReviewBanner.tsx:45-50`) reads `LeaseReview:330-332`'s memo built from that empty column → every score `undefined` → the list never fires. Inline amber/red borders still work (they read `extracted_json` via `getFieldConfidence`); `lease_field_confidence` table is populated — a precise dead-summary, not "confidence is broken." | **verified** |
| E2 | MED | **Per-entry confidence dropped on insert** — `rent_schedule`/`risks` arrays carry per-item confidence in the Opus JSON, but the INSERT payloads (`process_lease:~2740,~2758`) omit it. | reported |
| E3 | MED | **Server `model_lock` has no section-confirm gate** — `legacy-lease-action:347-357` gates only on financial role + not-already-locked; "all sections reviewed" is client-side only. | **verified** |
| E6 | MED | Amendment comparison covers a hardcoded ~12-field list (`COMPARABLE_FIELDS`, `process_lease:~2549`); clause fields (permitted_use, guarantees, the `rent_schedule` array) aren't diffed. Matches CLAUDE.md's "verify completeness." | verified |
| E7 | LOW | No AI-origin-vs-human marker on the `leases` row; attribution lives only in `field_corrections` + `lease_field_confidence`. | verified |

**Resolved threads:** **E4 (re-extraction clobbering approval) — REFUTED** (executed upload is `model_locked`-gated + writes a *separate* `executed_extracted_json`; pipeline always creates a new lease). **E5 (executed variance ungated) — CONFIRMED** (see DF2/#117).

### Fixes
- **E1:** feed `NeedsReviewBanner` from `extracted_json` via `getFieldConfidence` (like the inline borders), or write `confidence_scores` in the extraction UPDATE. **E2:** add `confidence` columns to `rent_schedules`/`risks`. **E6:** drive `COMPARABLE_FIELDS` from the full extracted field set.

---

## SWEEP 4 — Billing / Stripe integrity (the money path)

**Headline: the strongest-built surface in the audit. No confirmed revenue-loss, double-charge, or unpaid-access defect.** This sweep had the most agent overstatement — 2 CRITICALs + 2 HIGHs that didn't survive a code read.

### Verified solid
- **Webhook gateway** — fail-closed if any secret unset (`stripe-webhook:115`), signature verified on the **raw** body before use (`:131-142`). Recovery from past-due is **healed** via `customer.subscription.updated` (the `entitled` branch clears the whole cancellation lifecycle, `:231-235`); grace clock starts **only** on `status='canceled'` with a 7-day forward-notice floor.
- **Entitlement integrity** — entitlement columns service-role-only via `prevent_workspace_entitlement_edits` (#29); `addon_document_capacity` **recomputed as the SUM of live active packs** (`:411-458`, replay-safe); single-lease credits idempotent via `lease_credit_purchases` `UNIQUE(payment_intent_id)` + `consume_lease_credit()` atomic; **no auto-overage**.
- **Firm quantity sync** (`_shared/firm_billing.ts`, verified) — recomputed from live child count; `qty<1` cancels at period end (never quantity 0); **un-cancels on re-bind even when qty matches**; proration; `sync_failed` audit row (rule #9). Reconcile cron `x-cron-secret` fail-closed.
- **#103 firm-billing lockdown — RESOLVED server-side**: `create-checkout`/`customer-portal`/`manage-document-pack` all reject firm-bound workspaces with 403 `firm_managed` (updates CLAUDE.md's "incomplete" note + #103).

### Findings

| # | Sev | Item | Note |
|---|---|---|---|
| B1 | **DECISION (not a bug)** | Firm billing counts `restrict_firm_access=true` children (`firm_billing.ts:20-24`) | Consistent with "bill per bound Business child." Agent called this CRITICAL over-billing by conflating data-access exclusion with billing. **Confirm intent.** |
| B2 | MED (self-healing) | `delete-workspace` is firm-unaware → no billing resync (over-bills until the #107 reconcile cron) + no child-counter decrement (= **W1**) | Same root cause as W1 → filed jointly as **#112**. |
| B3 | LOW | `get-billing-summary` lacks the firm gate; returns silent `{card:null,invoices:[]}` instead of 403 `firm_managed` | #9-consistency; no money/leak risk. |
| B4 | LOW | No webhook event-id dedupe (`stripe-webhook:135`) | Mostly moot — writes idempotent, credit ledger UNIQUE, `plan_changed` audit only on actual change (`:287`). |
| B6 | MED (edge) | A workspace with **pre-existing** standalone pack subs that then binds to a firm keeps billing those packs to the original customer | New pack purchases are blocked (#103), but pre-bind packs aren't reconciled. |

*Downgraded from agent "CRITICAL/HIGH": no-event-idempotency, missing `invoice.paid` (recovery handled by `subscription.updated`), firm silent-fail on unknown firm_id (operator-edge, logged) — all real-but-minor.*

---

## SWEEP 5 — Lease data fidelity & audit trail (the integrity invariant)

**Headline: strong. The "stored faithfully, every change attributable" invariant holds at the DB level.** This sweep had the most agent over-alarming — corrected below.

### Verified solid (the reassuring core)
- **Locked-edit + workflow-column enforcement is at the DB, not just the UI** — `prevent_locked_lease_edits` blocks any authenticated UPDATE to a locked lease except whitelisted columns; `prevent_unauthorized_lease_workflow_edits` blocks authenticated writes to 12 workflow columns (`lifecycle_status`, `model_locked`, approvals). **A client cannot set `lifecycle_status` or edit a locked lease via PostgREST** — only service-role edge fns can.
- **Lifecycle Transition Convention: 100% adherence** — every transition site sets `status_changed_at` + writes a `status_change` row with from/to in both columns + `routing_path`. (And clients can't write `lifecycle_status` at all, so the only writers are these compliant edge fns.)
- **Audit logs are append-only** — `lease_activity_log`/`lease_governance_audit`/`field_corrections`/`workspace_activity_log`/`firm_activity_log` have only INSERT+SELECT policies; RLS-enabled + no UPDATE/DELETE policy = **deny by default**. *(The attribution agent rated this "VULNERABLE" — wrong; default-deny IS the protection.)*
- **Separation of duties** — unlock-request approval requires owner/admin (no self-approve); **change-set apply** is service-role-only, re-authorizes, audits per field, fails loud on unmapped fields.
- **Faithful storage** — E4 REFUTED; edit-save has no precision loss; amendment parentage immutable; **archive** is restorable soft-delete with a server-stamped attribution guard.

### Real residuals

| # | Sev | Item | Evidence |
|---|---|---|---|
| DF1 | **MED** | **Audit-trail destruction via lease hard-delete** — owner/admin can hard-delete *any* lease (incl. a `model_locked`/active one), cascading away its `lease_activity_log`/`lease_governance_audit` rows, with no archive-first + no forensic record | DELETE RLS `leases_delete_own_or_workspace_admin` (`baseline:4206`) + `ON DELETE CASCADE` on the audit FKs + the governance triggers are **`BEFORE UPDATE` only**. Analog of #83 (workspaces). |
| DF2 | MED | **Executed variance not gated (E5)** — executed upload flips lifecycle to `executed` + records variance, but no server-side materiality gate / re-approval | `process_lease:2069-2148`, flip at `:2106` (related #94) |
| DF3 | MED | **Concurrent-edit last-writer-wins** — no optimistic-concurrency check on the review save | `LeaseReview.tsx:1596-1599` |
| DF4 | LOW | Approval-revert unattributed — unchecking a confirmed tab strips `_approval` from `extracted_json` with no activity row | `LeaseReview.tsx:1314-1335` |
| DF5 | LOW | E3 — `model_lock` lacks a server-side `confirmed_sections` check | `legacy-lease-action:247-252` |
| DF6 | LOW | Rent-schedule re-generate appends instead of replaces | `LeaseReview.tsx:1478` |
| DF7 | LOW | E7 — no AI-origin-vs-human marker on the lease row | `field_corrections` + `lease_field_confidence` |

*Downgraded agent over-alarm: audit-log "DELETE unguarded" (default-deny IS the guard); client change-set mutation without audit (apply is service-role + the workflow trigger blocks the lease write); "convention not DB-enforced" (no client path can write `lifecycle_status`).*

---

## SWEEP 6 — Reports / exports & disclosure (output correctness)

**Headline: well-architected on the two things that matter most — the ASC-842 disclosure correctly holds the "not a compliance tool" line (rule #1), and report/token/audit isolation is sound. The real defects cluster in one diverged surface (`RentRollExport.tsx`) plus an index-lease calc inconsistency.**

### Verified solid
- **Rule #1 positioning HOLDS** — the disclosure report surfaces ASC-842 *inputs* (PV, straight-line, classification) but is explicitly framed as data: `LIABILITY_DISCLAIMER` ("…NOT a financial statement…LeaseIO produces structured data; the customer (or their CPA) produces the financial statement", `asc842_report.ts:38`) is **rendered on every PDF cover page + a "Not a Financial Statement" watermark on every page**; titles say "ASC 842 *Disclosure* Report"; preparer-notes flags tell the customer *they* do the accounting. No rule #1/#6 violation.
- **Calc fidelity (core)** — `calculateLease` PV/straight-line/commitment math correct; disclosure + portfolio reports pass through pre-computed `calc_*` columns (no recalc divergence); period-overlap + exclusion tracking correct.
- **Authz + isolation (no cross-tenant leak)** — report generation/download workspace-gated + rate-limited; storage RLS workspace-scoped, expiry-enforced, path-validated; the **shareable token summary** is a 96-bit token, single-lease, expiry + lifecycle gated, **PII-minimized**; the **free lease audit** isolates per session + 5-doc cap; cleanup cron nulls paths.

### Real defects (concentrated in one diverged export)

| # | Sev | Item | Evidence |
|---|---|---|---|
| R1 | **HIGH** | **CSV formula injection** — exported tenant/landlord/address execute as formulas in Excel/Sheets | `RentRollExport.tsx:135-141` — `escapeCSV` quotes only `,`/`"`/`\n`, not `=`/`+`/`-`/`@` (verified) |
| R2 | **HIGH** | **Wrong filter / completeness** — rent roll uses legacy `status` (+ no `archived` filter); includes draft/archived leases, misses some active ones | `RentRollExport.tsx:82` vs `Reports.tsx` (`lifecycle_status`) (verified) |
| R3 | MED (needs caller-trace) | **Index/CPI lease PV may be understated** — `calculateLease:66` coerces null escalation to **0%**; portfolio path excludes index leases, single-lease likely doesn't — inconsistent | verified math; caller alignment is the open part |
| R4 | LOW | "Total Annual Obligation" = `monthly × 12` (ignores escalations) — misleading label | `RentRollExport.tsx:93,123` |
| R5 | LOW | `generate-summary-token` lacks rate limiting (not exploitable — RLS-protected) | hardening |

*Carried over (already in Class 1): "Signator Attestation" (`leaseDisclosureSections.tsx:451`) + the asset_type `.replace('_',' ')` hack (`LeaseAnalysisExport.tsx:226`).*

---

## Remediation sequence (what to actually do)

**Wave 0 — the cheap, high-trust fixes (days):**
1. **(done)** Persist this audit to the repo + file confirmed defects into `docs/KNOWN_ISSUES.md` (#108–#119).
2. **Kill the jargon leak at the source** (#108) — shared `stageLabel()`/`roleLabel()` + route all 11 sites. One small, high-visibility win.
3. **Make the nudge real** (#109) — wire `lease_nudges` to notification + requester confirmation.

**Wave 1 — close the correctness gaps:**
4. **C1/C2** (#111 + #84) — apply the Phase-7 backfill SQL (`PHASE_7_BUILD_SPEC.md` A4) and redeploy `resolve-approval-chain`; set `pending_since` on first-step entry.
5. **C4** (#111) — make `escalate-to-concept` re-resolve the policy. Integrity-reviewer-gated.
6. **C3/C5** (#111) — delegation exclusivity decision; atomic reroute supersede+insert.
7. **W1 + B2** (#112) — `delete-workspace` releases `firm_id` (decrement counter) + billing resync, in one fix.
8. **E1** (#114) — revive the dead `NeedsReviewBanner`.
9. **DF1** (#116) — `BEFORE DELETE` guard on `leases` + forensic row on hard-delete.
10. **R1/R2** (#118) — CSV formula-injection escape + rent roll → `lifecycle_status` + `archived=false`.

**Wave 2 — finish the SLA/transparency layer:** per-policy SLAs (C6) → approver aging + requester ETA; requester "My submissions" tracker + "why is this mine?" chip; policy simulator + pre-save SoD; the `mailto:` flows → tracked requests (#110); DF2/DF3/R3 (#117/#119).

**Wave 3 — the strategic UX vision (Appendix A):** dashboard decision-first inversion, Portfolio 2.0 + the reserved Tier-3 Sonnet verdict, settings IA unification + 2FA, Lease Review workbench five-star pass, mobile-first approval, Leo as connective tissue.

---

## Verification (how we'd prove each fix)

- **#108 (jargon):** a static test asserting no raw `concept`/`signator`/`*_approver`/`*_submitted` string renders outside the label helpers (like `__tests__/chainDiagram.test.ts`); screen walk of queue / violation banner / reroute modal / audit log / SignatorReview / disclosure PDF; locale parity (`en`/`es`).
- **#109 (nudge):** integration test that a nudge produces a delivered notification row a consumer reads; manual e2e the approver receives it + the requester sees confirmation.
- **C1/C2 (#111):** after redeploy+backfill, submit a fresh lease and assert `effective_assignee_user_id`/`pending_since` non-NULL; let a delegate timer elapse and assert auto-activation; assert `detect-stuck-chains` surfaces it.
- **C4 (#111):** submit a lease matching policy A; change cost so policy B (extra required approver) applies but without triggering the structured-field reroute; escalate to concept; assert the new chain includes policy B's approver (today it won't).
- **DF1 (#116):** attempt a client hard-delete of a locked lease → assert blocked + forensic row written.
- **R1 (#118):** export a lease whose tenant name is `=HYPERLINK(...)` → assert the cell is neutralized.
- Each change routes through the mandated reviewers (auditor + security always; **integrity-reviewer** on the chain/audit/billing items; **product-polish** on Class 1/2), per CLAUDE.md.

---

## Appendix A — Strategic UX vision (round 1, preserved)

- **Dashboard:** invert to intent bands — a personalized **"Needs you"** hero + one-line health verdict, then "On the horizon" (deduplicated risk/events), then analytics below a divider; a real empty-workspace first-run state.
- **Portfolio 2.0:** from a thin static snapshot to **portfolio intelligence** — Band 1 a Tier-3 Sonnet **verdict** (Addepar "Addison" applied to leases), Band 2 deterministic decision surfaces (critical-dates timeline, cost/escalation exposure, concentration, data-quality), Band 3 the enriched register. Surfaces the **built-but-unused** Tier-3 reasoning.
- **Settings:** unify the 3+ fragmented entry points into one hub + breadcrumbs + role-gated tabs; calm the billing fire-hose; ship 2FA (Supabase MFA exists, unused), granular notifications, in-app audit-log + data export.
- **Approval workflow target state:** the five-star approver queue (ranked "awaiting you," at-stake + aging + "why mine" + what's-next, inline/bulk/keyboard approve, real OOO), the requester tracker, the admin policy simulator.
- **Cross-industry north star:** decision-first (Linear/Ramp/Mercury), close-the-loop transparency (GitHub/Ironclad), AI-speaks-first (Addepar/Stripe health line), calm density (Linear), one product/one language.

---

*Prepared as a no-edits findings audit (2026-06-17). Nothing in the codebase was modified. Confirmed defects filed as KNOWN_ISSUES #108–#119; the round-1 strategic vision (Appendix A) is directional and each surface warrants its own deep-dive before building.*
