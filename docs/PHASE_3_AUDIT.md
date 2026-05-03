# Phase 3 Audit — `lifecycle_status` Consumer Inventory

**Status:** Hard prerequisite for Checkpoint 4 (frontend consumer sweep) per `docs/PHASE_3_BUILD_SPEC.md`. User must review and approve this document before any consumer code changes land.

**Surveyed:** 2026-05-03. 208 occurrences of `lifecycle_status` / `lifecycleStatus` across 46 files (37 frontend, 9 edge functions). Auto-generated `src/integrations/supabase/types.ts` excluded.

## Migration approach legend

- **A — `displayLabel(status)`**: occurrence is purely UI text rendering of the status. Replace literal text or per-state if/switch with a single `displayLabel(status)` call. Chain and legacy values render identical user-facing labels.
- **B — `groupOf(status) === '<group>'` or `isEquivalent(a, b)`**: grouping/filter logic. Replace literal status comparisons with semantic group checks so both vocabularies bucket identically.
- **C — `normalizeToChainStates(status)`**: routing/decision logic that needs a unified vocabulary. Use this when downstream code branches on canonical chain states only.
- **No-Op** (with sub-types):
  - **W (write)**: code WRITES a `lifecycle_status` value. Stays as-is — chain functions (Phase 2/3) handle chain values; legacy paths keep using legacy values.
  - **R (passthrough)**: reads into a typed field, props, or state, no comparison or rendering. No change needed.
  - **T (type/interface)**: column/type-only declaration. Updated in Checkpoint 2 when the canonical type union expands.
  - **Q (query)**: Supabase `.select(col)` listing the column name only. No behavior decision involved.
  - **X (test)**: existing test file. New chain-state cases added in Checkpoint 5.
  - **Notes**: comment-only mention.

---

## Frontend (`src/`, 37 files, 185 occurrences)

### `src/components/lifecycle/LifecycleStatusBadge.tsx` — CRITICAL (canonical badge)

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 17 | `const config = LIFECYCLE_STATUS_CONFIG[status];` | A | Reads from config table — extending the config in `src/types/lifecycle.ts` to include 7 chain states is the canonical Approach A migration. |

### `src/types/lifecycle.ts` — type/config hub

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 3-11 | `type LifecycleStatus = 'submitted' \| 'under_review' \| ...` | T | Type union — replaced/extended in Checkpoint 2 by `src/lib/lifecycleStates.ts` |
| 60 | `lifecycleStatus: LifecycleStatus;` | T | Interface field |
| 153-162 | `LIFECYCLE_TRANSITIONS: Record<...>` | T | State-machine map — extend with chain transitions |
| 165-228 | `LIFECYCLE_STATUS_CONFIG` | A | Display config table — must include all 16 states (extends in Checkpoint 2) |

### `src/hooks/useNeedsAction.ts` — approval inbox source

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 47 | `.select('...lifecycle_status...')` | Q | |
| 50 | `.in('lifecycle_status', ['under_review', 'executed', 'submitted'])` | B | Pending items across stages — multiple semantic groups |
| 53 | `.select('...lifecycle_status...leases!inner(...)` | Q | |
| 55 | `.eq('leases.lifecycle_status', 'active')` | B | `active` group (same in both vocabularies) |
| 65 | `.filter((l) => l.lifecycle_status === 'submitted' && ...)` | B | `awaiting_concept_approval` group |
| 73 | `.filter((l) => l.lifecycle_status === 'under_review')` | B | `in_concept_review` group |
| 99 | `if (l.lifecycle_status !== 'under_review') return false;` | B | `in_concept_review` group |
| 108 | `inLifecycle = l.lifecycle_status === 'submitted' \|\| ... === 'under_review'` | B | Union of awaiting + in_concept |
| 117 | `(l) => l.lifecycle_status === 'executed' && !l.executed_document_url` | B | `executed_pre_active` group |

### `src/hooks/useLifecycleWorkflow.ts` — legacy state-machine implementation

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 119 | `lifecycle_status: initialStatus,` | W | Legacy intake path |
| 200 | `lifecycle_status: 'submitted',` | W | Legacy transition |
| 260 | `.select('lifecycle_status')` | Q | |
| 266 | `const currentStatus = lease.lifecycle_status as LifecycleStatus;` | R | Read into local variable |
| 269-279 | State machine branching | C | If chain states ever flow through this hook in future, normalize first; for Phase 3 the legacy hook never sees chain states (chain leases use act-on-chain-step), so today this is a no-op concern |
| 295 | `lifecycle_status: newStatus,` | W | |
| 468 | `lifecycle_status: 'approved',` | W | |

### `src/contexts/AppContext.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 189 | Comment about `lifecycle_status='active'` | Notes | Implementation note |
| 195 | `.eq("lifecycle_status", "active")` | B | `active` group |

### `src/components/layout/AppSidebar.tsx` — inbox counts

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 85 | `.eq('lifecycle_status', 'submitted')` | B | `awaiting_concept_approval` group |
| 95 | `.eq('lifecycle_status', 'under_review')` | B | `in_concept_review` group |

### `src/components/summary/SummaryShareControls.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 10 | `lifecycleStatus: string;` | R | Prop |
| 15 | `lifecycleStatus }` | R | Destructure |
| 23 | `const canShare = SHAREABLE_STATUSES.has(lifecycleStatus);` | B | Check against shareable groups (post-approval / executed / active) |

### `src/components/summary/FinancialImpactSummary.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 26 | `lifecycleStatus: string;` | R | Prop |
| 68 | `const isApproved = APPROVED_STATUSES.includes(data.lifecycleStatus);` | B | `post_concept_pre_signator` and downstream groups |
| 243 | `titleCase(data.lifecycleStatus)` | A | Replace string manipulation with `displayLabel()` |

### `src/components/leases/AmendmentsList.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 14 | `lifecycle_status: string \| null;` | R | Interface |
| 32 | `.select('...lifecycle_status...')` | Q | |
| 45 | `const displayStatus = lifecycleStatus \|\| status;` | R | Fallback read |
| 111 | `getStatusBadge(amendment.status, amendment.lifecycle_status)` | A | Routes through display helper |

### `src/components/dashboard/EscalationReviewPanel.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 47 | `.in('lifecycle_status', ['submitted', 'under_review', 'approved', 'executed', 'active'])` | B | All in-flight + active — multiple groups; preserve semantics by including chain equivalents |

### `src/components/dashboard/FinancialSummary.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 63 | `.in('lifecycle_status', ['submitted', 'under_review', 'approved'])` | B | In-progress (concept phase). Chain equivalents: concept_submitted, concept_under_review, in_negotiation |
| 96 | `.in('lifecycle_status', ['executed', 'active'])` | B | Portfolio. Chain equivalents: fully_executed, active |

### `src/components/dashboard/LeasePipeline.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 67 | `.select('lifecycle_status, monthly_payment, activated_at')` | Q | |
| 73 | `if (l.lifecycle_status !== stage.key) return false;` | B | Compares against pipeline stage key — needs to match across vocabularies via `isEquivalent` or pre-normalize |

### `src/components/workflow/ParentLeaseCombobox.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 48 | `.eq('lifecycle_status', 'active')` | B | `active` group |

### `src/components/workflow/LeaseRequestForm.tsx` — Phase 2 owns the chain flip

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 288 | `lifecycle_status: 'draft',` | W | Insert-as-draft (Phase 2 contract) |
| 380 | `.update({ lifecycle_status: finalStatus, ... })` | W | Legacy fallback flip — `finalStatus` is `submitted`/`under_review`/`approved` |
| 408 | `.update({ lifecycle_status: finalStatus, ... })` | W | Chain path flip — **MUST CHANGE in Checkpoint 3:** `finalStatus = 'concept_submitted'` instead of `'submitted'` for chain-driven leases (per Phase 3 spec) |

### `src/pages/app/ApprovalQueue.tsx` — primary inbox (21 occurrences)

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 46 | `lifecycle_status: string;` | R | |
| 77-81 | Status label switch (5 lines) | A | Replace `if status === 'submitted' ? 'Awaiting Manager Review'` cascade with `displayLabel(status)` |
| 85 | `lease.lifecycle_status === 'submitted'` | B | `awaiting_concept_approval` group |
| 87 | `lease.lifecycle_status === 'under_review'` | B | `in_concept_review` group |
| 502 | `.select('...lifecycle_status...')` | Q | |
| 513 | `.eq('lifecycle_status', 'submitted')` | B | Manager queue |
| 521 | `.eq('lifecycle_status', 'under_review')` | B | Financial queue |
| 533 | `.in('lifecycle_status', ['submitted', 'under_review'])` | B | All pending |
| 538 | `.not('lifecycle_status', 'in', '(submitted,under_review)')` | B | Reviewed |
| 791 | `const isManager = lease.lifecycle_status === 'submitted';` | B | |
| 798 | `lifecycle_status: 'under_review',` | W | Manager approval (legacy path) |
| 836 | `lifecycle_status: 'approved',` | W | Financial approval (legacy path) |
| 870, 877, 895 | Reject writes | W | |
| 989 | `l.lifecycle_status === 'under_review'` | B | Count display |

### `src/components/dashboard/PendingApprovalsSection.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 30 | `.select('id, filename, lifecycle_status, uploaded_at')` | Q | |
| 32 | `.in('lifecycle_status', ['submitted', 'under_review', 'approved', 'executed'])` | B | Action-required filter |
| 48, 59, 70, 81 | Per-status if-branches | A/B | Display labels via `displayLabel`; filtering via `groupOf` |

### `src/components/dashboard/UpcomingRisks.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 56 | `.in('lifecycle_status', ['active', 'executed'])` | B | `active` + `executed_pre_active` |

### `src/components/dashboard/RecentActivity.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 17 | `lifecycle_status: string \| null;` | R | |
| 42 | `getActivityLabel(activityType, lifecycleStatus?)` | A | Helper signature |
| 46-47 | `LIFECYCLE_LABELS[lifecycleStatus]` | A | Local lookup table — extend or replace with `displayLabel()` |
| 55 | `getDotColor(lifecycleStatus)` | A | Switch on status |
| 56 | `switch (lifecycleStatus)` | A | Add chain-state cases |
| 95 | `.select('...lifecycle_status...')` | Q | |
| 151-152 | Use helpers | A | Update helpers, callers unchanged |

### `src/components/dashboard/UpcomingEvents.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 118 | `.in('lifecycle_status', ['executed', 'active'])` | B | |

### `src/components/dashboard/PipelineByDepartment.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 10 | `lifecycle_status: string \| null;` | R | |
| 48 | `if (l.lifecycle_status === 'active')` | B | `active` group |
| 51 | `IN_PROGRESS_STATUSES.includes(...)` | B | Use group semantics — local constant should be replaced with helper |
| 78 | `.select('...lifecycle_status...')` | Q | |

### `src/components/dashboard/SummaryStrip.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 62 | `.select('id, lifecycle_status, ...')` | Q | |
| 79 | `(l) => l.lifecycle_status === 'active' \|\| ... === 'executed'` | B | Portfolio union |
| 101-102 | Two filter chains | B | Needs-action union |
| 108 | `l.lifecycle_status === 'under_review'` | B | `in_concept_review` |
| 115, 124 | `expiringStatuses.includes(...)` | B | `['active', 'executed']` array |

### `src/pages/app/FinancialReview.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 61 | `lifecycle_status: string;` | R | |
| 132 | `.select('...lifecycle_status...')` | Q | |
| 187 | `.in('lifecycle_status', ['approved', 'executed', 'active'])` | B | Post-approval queue |
| 224 | `lifecycle_status: 'approved',` | W | Legacy write |
| 279 | `lifecycle_status: 'submitted',` | W | Legacy write (send-back) |
| 310 | `lifecycle_status: 'rejected',` | W | Legacy write |
| 361 | `canAct = isFinancialApprover && lease.lifecycle_status === 'under_review'` | B | `in_concept_review` group |
| 379 | `lease.lifecycle_status.replace('_', ' ')` | A | Replace string manipulation with `displayLabel()` |

### `src/pages/Leases.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 42 | `lifecycle_status: string \| null;` | R | |
| 110 | `.select('...lifecycle_status...')` | Q | |
| 115 | `.in('lifecycle_status', [..., 'expired'])` | B | All non-terminal-negative |
| 231 | `.filter((l) => l.lifecycle_status === 'active' \|\| ... === 'executed')` | B | Portfolio |
| 236 | `IN_FLIGHT_STATUSES.has(...)` | B | In-progress |
| 464 | `<LeaseStatusBadge status={lease.lifecycle_status \|\| lease.status} />` | A | Routes through badge |

### `src/pages/app/LeaseReview.tsx` — largest file (46 occurrences)

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 286 | `const lifecycleStatus = lease?.lifecycle_status;` | R | |
| 287 | `isIntakeStage = lifecycleStatus === 'submitted' \|\| ... === 'under_review' \|\| ... === 'approved'` | B | Union of awaiting + in_concept + post_concept |
| 290 | `isReviewRequired = lifecycleStatus === 'under_review'` | B | `in_concept_review` |
| 293 | `isPosted = lifecycleStatus === 'active'` | B | `active` |
| 302 | `showPdfPanel = lifecycleStatus !== 'active' \|\| !lease?.model_locked` | B | Negation of `active` |
| 398 | `lifecycle_status: newStatus,` | W | |
| 415 | `lifecycle_status: newStatus` | W | |
| 428 | `const previousStatus = lease.lifecycle_status;` | R | |
| 432 | `.update({ lifecycle_status: newStatus, ... })` | W | |
| 452 | `lifecycle_status: newStatus` | W | |
| 601 | `stage: lease.lifecycle_status` | R | |
| 802 | `.select("status, lifecycle_status")` | Q | |
| 873 | Comment about `lifecycle_status=active` | Notes | |
| 978 | `const fromStatus = lease.lifecycle_status ?? 'executed';` | R | |
| 985 | `lifecycle_status: 'active',` | W | |
| 1352 | `lifecycle_status: 'active',` | W | |
| 1658 | `['approved', 'executed', 'active'].includes(...)` | B | Post-approval gate |
| 1662-1674 | Conditional rendering | A | If/else on status — use `displayLabel()` or group helpers |

### `src/components/leases/LeaseExports.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 24 | `lifecycle_status: string \| null;` | R | |
| 54 | `lifecycle_status: lease.lifecycle_status,` | R | Passes through to export shape |

### `src/components/leases/LeaseUploadModal.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 82 | `.eq('lifecycle_status', 'active')` | B | `active` group |

### `src/components/leases/locked/LockedLeaseDetail.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 461 | `lifecycleStatus={lease.lifecycle_status ?? null}` | R | Pass to child |
| 500 | `lifecycleStatus={lease.lifecycle_status ?? ''}` | R | Pass to child |

### `src/components/leases/locked/LockedHeader.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 19 | `lifecycleStatus: string \| null;` | R | |
| 36 | `lifecycleStatus,` | R | |
| 69 | `lifecycleStatus as any` | R | Pass to LifecycleStatusBadge — typing tightens up automatically once the type union expands |

### `src/pages/app/Portfolio.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 42 | `.in('lifecycle_status', ['executed', 'active'])` | B | |

### `src/components/leases/ModelLockConfirmation.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 35 | `.update({ ..., lifecycle_status: 'active', ... })` | W | Lock-confirm transition (legacy path) |

### `src/lib/leaseLifecycle.ts`

No `lifecycle_status` references — file is permission/role helpers only. (Original Grep count of 6 was for adjacent terms.)

### `src/pages/Reports.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 79 | `.select('lifecycle_status, calc_total_commitment')` | Q | |
| 81 | `.filter('lifecycle_status', 'not.is', 'null')` | Q | |
| 94 | `const s = l.lifecycle_status ?? 'unknown';` | R | Safe fallback grouping key |

### `src/components/leases/UploadExecutedDocumentDialog.tsx`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 61 | `.update({ lifecycle_status: 'executed' })` | W | Legacy executed transition |

### `src/lib/__tests__/lockedLeaseLayout.test.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| various | Test fixtures | X | Add chain-state cases in Checkpoint 5 |

### Already-correct files (Phase 2)

- `src/lib/approvalChainLogic.ts` — Phase 2 helper, already correct
- `src/lib/approvalRouting.ts` — initial-status helper, returns legacy values; chain code overrides

---

## Edge functions (`supabase/functions/`, 9 files, 23 occurrences)

### `supabase/functions/process_lease/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 1237 | `.select('...lifecycle_status...')` | Q | |
| 1491 | `.select('...lifecycle_status, extracted_json')` | Q | |
| 1510 | `(parentLease as any).lifecycle_status !== 'active'` | B | `active` group |
| 1643 | `lifecycle_status: 'executed',` | W | Amendment processing (legacy executed) — leave as-is for legacy amendments |

### `supabase/functions/ai-assistant/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 27 | `['active', 'executed', 'needs_review', 'draft'].includes(l.lifecycle_status)` | B | Filter for AI context — note `'needs_review'` is NOT a recognized state in either vocabulary; flag as data-shape question for the implementer |
| 64 | `` `Status: ${lease.lifecycle_status}` `` | A | Use `displayLabel()` so the AI prompt sees consistent vocabulary |
| 209 | `.select('...lifecycle_status...')` | Q | |
| 217 | `.not('lifecycle_status', 'in', '("failed","cancelled")')` | Q | Note: `'failed'` is not a recognized state either; flag for implementer |

### `supabase/functions/lease-governance-action/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 257, 330 | `.select("...lifecycle_status...")` | Q | |
| 261 | `(lease as any).lifecycle_status !== "active"` | B | `active` group |
| 337 | `(lease as any).lifecycle_status !== "active"` | B | `active` group |

### `supabase/functions/generate-summary-token/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 57 | `.select('...lifecycle_status...')` | Q | |
| 69 | `if (!allowedLifecycleStates.has(lease.lifecycle_status))` | B | Shareable gate — extend the set with chain equivalents |

### `supabase/functions/get-summary-by-token/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 43 | `.select('...lifecycle_status...')` | Q | |
| 70 | `if (!['approved', 'executed', 'active'].includes(...))` | B | Shareable gate |
| 155 | `lifecycleStatus: lease.lifecycle_status \|\| ''` | R | Pass through |

### `supabase/functions/act-on-chain-step/index.ts` — Phase 2/3 owner

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 117 | Convention comment | Notes | |
| 130 | `lifecycle_status: newStatus,` | W | **Checkpoint 3 changes this:** for chain leases, `newStatus` becomes `concept_under_review` / `in_negotiation` instead of `under_review` / `approved`. Determined by `getLifecycleMode()` helper — chain mode iff `lease_approval_chain` rows exist for the lease. |

### `supabase/functions/request-lease-unlock/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 49 | `.select('...lifecycle_status')` | Q | |
| 86 | `(lease as any).lifecycle_status !== 'active'` | B | `active` group |

### `supabase/functions/audit-session/index.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 270 | `lifecycle_status: "active",` | W | Audit-only seed value |

### `supabase/functions/_shared/approval_chain.ts`

| Line | Snippet | Cat | Notes |
|------|---------|-----|-------|
| 21 | Convention comment | Notes | |

---

## Summary by category

| Category | Count | Description |
|---|---|---|
| **A — `displayLabel()`** | ~22 | UI text rendering across 8 files; mostly resolves via extending `LIFECYCLE_STATUS_CONFIG` once and routing through `LifecycleStatusBadge` / `displayLabel()` |
| **B — `groupOf` / `isEquivalent`** | ~78 | Filter and comparison logic across 20+ files; the bulk of Checkpoint 4's work |
| **C — `normalizeToChainStates`** | 0 | None identified — legacy hooks/code never receive chain values today; if rerouting (Phase 6) ever pumps chain leases through legacy hooks, normalize then |
| **No-Op** | ~108 | W: 23 writes; R: 36 passthrough; T: 12 type/interface; Q: 31 query; X: 2 test; Notes: 4 |
| **Total** | 208 | |

---

## Critical gaps + flags

### Type/config foundation (Checkpoint 2 unlocks the rest)

Until `src/lib/lifecycleStates.ts`, the Deno mirror, and the extended `LIFECYCLE_STATUS_CONFIG` exist, no consumer migration can proceed. Checkpoint 2 is the gate.

### Mandatory write-path change (Checkpoint 3)

Two writes must change to honor the Phase 3 vocabulary split:

1. **`src/components/workflow/LeaseRequestForm.tsx:408`** — chain-path post-resolution flip from `'submitted'` → `'concept_submitted'`.
2. **`supabase/functions/act-on-chain-step/index.ts:~130`** (and helpers) — chain leases transition `concept_submitted` → `concept_under_review` → `in_negotiation` (was: `submitted` → `under_review` → `approved`). Branch on `getLifecycleMode()` per spec; legacy-fallback leases keep using legacy values.

### Unrecognized state values discovered in edge functions

`supabase/functions/ai-assistant/index.ts` references two values that aren't in either vocabulary:
- Line 27: `'needs_review'` (in an `.includes` filter) — likely dead/legacy. Flag for implementer; harmless to leave but worth confirming intent.
- Line 217: `'failed'` (in a `.not in` filter) — same.

These are NOT in the `lifecycle_status` CHECK constraint and never have been in the live data per the Phase 1+2 verifications. Likely defensive code from an older draft of the schema. Recommendation: keep the filters as-is (Phase 3 doesn't touch them) but flag for a follow-up cleanup.

### Local constants that should consolidate to helpers

Multiple files have local arrays/sets that duplicate group semantics:

- `IN_PROGRESS_STATUSES` in `PipelineByDepartment.tsx` and `Leases.tsx`
- `SHAREABLE_STATUSES` in `SummaryShareControls.tsx`
- `APPROVED_STATUSES` in `FinancialImpactSummary.tsx`
- `IN_FLIGHT_STATUSES` in `Leases.tsx`
- `LIFECYCLE_LABELS` in `RecentActivity.tsx`
- `expiringStatuses` in `SummaryStrip.tsx`

In Checkpoint 4, ideally each of these collapses to a `groupOf()` check or pulls its membership list from `STATE_GROUPS`. If the user prefers minimal disruption, extend each constant in place to include chain equivalents (less elegant but smaller diff). The plan's "additive default" guidance suggests extending in place is acceptable when refactoring would otherwise force a structural change.

---

## Implementation order recommended for Checkpoint 4

1. **Extend type/config foundation** (already covered by Checkpoint 2): `src/types/lifecycle.ts` `LIFECYCLE_STATUS_CONFIG`, `LIFECYCLE_TRANSITIONS`, `LifecycleStatus` union.
2. **Critical-path consumers** with the highest concentration of B-category logic:
   - `src/hooks/useNeedsAction.ts` (8 B's)
   - `src/pages/app/ApprovalQueue.tsx` (11 B's + 5 A's)
   - `src/pages/app/LeaseReview.tsx` (9 B's + 3 A's)
3. **Display config consumers** (A's):
   - `src/components/dashboard/RecentActivity.tsx` (extend or remove `LIFECYCLE_LABELS` local table)
   - `src/pages/app/FinancialReview.tsx:379` (string-manipulation → helper)
   - `src/components/summary/FinancialImpactSummary.tsx:243` (`titleCase` → helper)
   - `supabase/functions/ai-assistant/index.ts:64` (Deno helper)
4. **Filter chains** (B batch):
   - All dashboard panels with `.in()` calls (PendingApprovalsSection, EscalationReviewPanel, FinancialSummary, LeasePipeline, UpcomingRisks, UpcomingEvents, SummaryStrip, PipelineByDepartment)
   - Edge function gates (process_lease, lease-governance-action, generate-summary-token, get-summary-by-token, request-lease-unlock)
5. **Locked-view passthroughs**: zero changes needed beyond letting the badge component pick up the new config.
6. **No-Op writes**: leave alone; they're correct as-is.

---

## Validation checklist before signing off Checkpoint 4

- [ ] All A-category occurrences route through `displayLabel()` (or via `LifecycleStatusBadge`)
- [ ] All B-category occurrences use `groupOf()` / `isEquivalent()` / a `STATE_GROUPS`-derived list — no remaining literal status comparisons in branching logic
- [ ] No untouched local-constant arrays still hardcode legacy-only state lists
- [ ] `LeaseRequestForm.tsx:408` flips chain leases to `concept_submitted` (not `submitted`)
- [ ] `act-on-chain-step` chain mode uses chain vocabulary; legacy mode uses legacy vocabulary
- [ ] `supabase/functions/ai-assistant/index.ts:64` uses `displayLabel()` from the Deno helper
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` 142+ tests passing, 0 regressions
