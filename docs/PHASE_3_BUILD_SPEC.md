# Phase 3 Build Spec — Lifecycle Expansion

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1_BUILD_SPEC.md`, `PHASE_2_BUILD_SPEC.md`
**Phase scope:** Introduce the new lifecycle states the architecture defines. Migrate every consumer to handle them. Preserve legacy state names as backward-compat aliases.
**Out of scope for Phase 3:** The negotiation documents table (Phase 4), signator stage activation (Phase 5), rerouting (Phase 6), delegation (Phase 7), report (Phase 8). Phase 3 is purely about adding the states to the enum and wiring every consumer to the new vocabulary.

This phase is the riskiest yet — `lifecycle_status` is referenced in over 125 places in the frontend and 23 in edge functions. Every read, write, filter, badge, and routing decision in the application looks at this column. Phase 3 expands the value space without breaking any of those consumers.

---

## Goals of this phase

1. The `lifecycle_status` CHECK constraint accepts the new state values from the architecture document: `concept_submitted`, `concept_under_review`, `in_negotiation`, `final_review`, `pending_counter_signature`, `fully_executed`. Existing values are preserved.
2. Every consumer in the frontend and edge functions reads and writes new states correctly. No regressions.
3. The chain workflow (Phase 2) starts using the new states for chain-driven leases. The legacy fallback path keeps using the old states.
4. A documented mapping exists for old → new state semantics so future code knows which is which and consumers can be progressively migrated to new-only handling.
5. The Lifecycle Transition Convention from `CLAUDE.md` is followed by every code path that transitions a lease — `status_changed_at` updated, `from_status` / `to_status` written both as columns and inside `details`, `routing_path` populated.

---

## The state model after Phase 3

Two parallel groups of states co-exist:

**Legacy states (kept for backward compatibility):**
- `draft` — pre-submission
- `submitted` — submitted, awaiting first approval
- `under_review` — at least one approver has acted
- `approved` — all approvers signed off, before execution
- `executed` — executed document uploaded
- `active` — fully active, post-extraction
- `expired` — past lease end date
- `rejected` — terminal, rejected
- `cancelled` — terminal, cancelled

**New states (introduced in Phase 3, used only by chain-driven leases initially):**
- `concept_submitted` — request submitted, before any approver acts
- `concept_under_review` — at least one chain approver has acted at concept stage
- `in_negotiation` — concept approved, document negotiation in progress (Phase 4 will populate documents)
- `final_review` — at signator stage (Phase 5 will activate signator behavior)
- `pending_counter_signature` — signator approved, awaiting counter-party signature
- `fully_executed` — both parties signed; replaces legacy `executed`
- `chain_violation` — post-execution rerouting detected a gap (Phase 6 owns this)

Same terminal states apply to both groups: `active`, `expired`, `rejected`, `cancelled`.

---

## State mapping (semantic equivalence)

These are the loose equivalences between legacy and new. Used by display helpers and migration code:

| Legacy            | New                           | Notes                                                                 |
|-------------------|-------------------------------|-----------------------------------------------------------------------|
| draft             | draft                         | Same in both                                                          |
| submitted         | concept_submitted             | A "submission" in the chain world means concept-stage submission      |
| under_review      | concept_under_review          | Maps cleanly — at least one approver has acted                        |
| approved          | in_negotiation                | Chain "approved at concept" is conceptually "now negotiate the doc"   |
| (no equivalent)   | final_review                  | New — happens when the negotiated doc is sent to the signator         |
| (no equivalent)   | pending_counter_signature     | New — we signed, awaiting counter-party                               |
| executed          | fully_executed                | Both parties signed                                                   |
| active            | active                        | Same in both                                                          |
| expired           | expired                       | Same                                                                  |
| rejected          | rejected                      | Same                                                                  |
| cancelled         | cancelled                     | Same                                                                  |
| (no equivalent)   | chain_violation               | New — reserved for Phase 6                                            |

This mapping lives in code in `src/lib/lifecycleStates.ts` (new file). Edge functions get a Deno mirror in `supabase/functions/_shared/lifecycle.ts`.

---

## Database migrations

Create one migration file: `<timestamp>_phase3_lifecycle_expansion.sql`.

### Constraint expansion

```sql
ALTER TABLE public.leases
  DROP CONSTRAINT IF EXISTS leases_lifecycle_status_check;

ALTER TABLE public.leases
  ADD CONSTRAINT leases_lifecycle_status_check
  CHECK (lifecycle_status IN (
    -- Legacy states (preserved verbatim)
    'draft',
    'submitted',
    'under_review',
    'approved',
    'executed',
    'active',
    'expired',
    'rejected',
    'cancelled',
    -- Phase 3 new states
    'concept_submitted',
    'concept_under_review',
    'in_negotiation',
    'final_review',
    'pending_counter_signature',
    'fully_executed',
    'chain_violation'
  ));
```

### State transition log columns (additive)

The architecture document calls for stage-specific timestamps on the leases table. Add them now even though Phase 5 and beyond will be the primary writers:

```sql
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS concept_approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS signator_approved_at     timestamptz,
  ADD COLUMN IF NOT EXISTS counter_signed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS fully_executed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS execution_owner_id       uuid REFERENCES auth.users(id);
```

These are nullable. They get populated as a lease progresses through the new chain-driven lifecycle.

### Activity log: additional activity types for Phase 3 transitions

Extend the `lease_activity_log_activity_type_check` constraint to add Phase 3 transition activities:

```sql
-- Run a query first to capture the current constraint values verbatim. Preserve
-- ALL existing values when extending. The list below is the union after Phase 3.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Legacy types (preserve verbatim from current constraint state)
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'model_locked',
    'unlock_requested', 'unlock_approved', 'unlock_rejected',
    'change_submitted', 'change_approved', 'change_rejected', 'change_canceled',
    -- Phase 2 types
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    -- Phase 3 types
    'concept_stage_entered',
    'concept_stage_completed',
    'negotiation_stage_entered',
    'final_review_stage_entered',
    'pending_counter_signature_started',
    'fully_executed_recorded'
  ));
```

The migration MUST query the current constraint definition first via `pg_get_constraintdef` and snapshot the existing values into a comment so the test file can verify nothing was dropped. Standard practice — already established in Phase 2.

---

## Code changes

### New file: `src/lib/lifecycleStates.ts`

Single source of truth for state vocabulary, mapping, transition rules, and display helpers. Pure functions only — Node-importable for vitest.

```typescript
// Stay in sync with supabase/functions/_shared/lifecycle.ts.
// Both files contain identical pure logic. Edge functions import from _shared
// (Deno-style URLs); vitest tests and frontend code import from this file (Node).
// See CLAUDE.md "Lifecycle Transition Convention" for required transition behavior.

export type LegacyLifecycleStatus =
  | 'draft' | 'submitted' | 'under_review' | 'approved'
  | 'executed' | 'active' | 'expired' | 'rejected' | 'cancelled';

export type ChainLifecycleStatus =
  | 'draft' | 'concept_submitted' | 'concept_under_review'
  | 'in_negotiation' | 'final_review' | 'pending_counter_signature'
  | 'fully_executed' | 'active' | 'expired' | 'rejected' | 'cancelled'
  | 'chain_violation';

export type LifecycleStatus = LegacyLifecycleStatus | ChainLifecycleStatus;

// Maps a state to its semantic group. Used by display helpers and routing decisions.
export const STATE_GROUPS = {
  pre_submission: ['draft'],
  awaiting_concept_approval: ['submitted', 'concept_submitted'],
  in_concept_review: ['under_review', 'concept_under_review'],
  post_concept_pre_signator: ['approved', 'in_negotiation'],
  signator_review: ['final_review'],
  awaiting_counter_signature: ['pending_counter_signature'],
  executed_pre_active: ['executed', 'fully_executed'],
  active: ['active'],
  terminal_negative: ['rejected', 'cancelled'],
  terminal_neutral: ['expired'],
  exception: ['chain_violation'],
} as const;

// Returns the semantic group of a state.
export function groupOf(status: LifecycleStatus): keyof typeof STATE_GROUPS | null {
  for (const [group, members] of Object.entries(STATE_GROUPS)) {
    if ((members as readonly string[]).includes(status)) return group as keyof typeof STATE_GROUPS;
  }
  return null;
}

// Whether two states belong to the same semantic group.
export function isEquivalent(a: LifecycleStatus, b: LifecycleStatus): boolean {
  const ga = groupOf(a);
  return ga !== null && ga === groupOf(b);
}

// Normalizes legacy → new for routing decisions where chain-driven leases need a unified view.
export function normalizeToChainStates(status: LifecycleStatus): ChainLifecycleStatus | null {
  const map: Record<LegacyLifecycleStatus, ChainLifecycleStatus | null> = {
    draft: 'draft',
    submitted: 'concept_submitted',
    under_review: 'concept_under_review',
    approved: 'in_negotiation',
    executed: 'fully_executed',
    active: 'active',
    expired: 'expired',
    rejected: 'rejected',
    cancelled: 'cancelled',
  };
  if (status in map) return map[status as LegacyLifecycleStatus];
  return status as ChainLifecycleStatus;
}

// Display label for UI. Short, human-readable, no jargon.
export function displayLabel(status: LifecycleStatus): string {
  const labels: Record<LifecycleStatus, string> = {
    draft: 'Draft',
    submitted: 'Submitted',
    under_review: 'Under Review',
    approved: 'Approved',
    executed: 'Executed',
    active: 'Active',
    expired: 'Expired',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    concept_submitted: 'Submitted',
    concept_under_review: 'Under Review',
    in_negotiation: 'In Negotiation',
    final_review: 'Final Review',
    pending_counter_signature: 'Awaiting Counter-Signature',
    fully_executed: 'Fully Executed',
    chain_violation: 'Chain Violation',
  };
  return labels[status] ?? status;
}

// Defines what transitions are valid from each state. Used to guard manual transitions
// in the UI and to validate state changes in edge functions. Phase 3 includes both
// legacy and chain transitions; rerouting (Phase 6) will introduce more.
export const VALID_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  // Legacy
  draft: ['submitted', 'concept_submitted', 'cancelled'],
  submitted: ['under_review', 'approved', 'rejected', 'cancelled'],
  under_review: ['approved', 'rejected', 'submitted', 'cancelled'],
  approved: ['executed', 'rejected', 'cancelled'],
  executed: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: [],
  rejected: [],
  cancelled: [],
  // Chain
  concept_submitted: ['concept_under_review', 'in_negotiation', 'rejected', 'cancelled'],
  concept_under_review: ['in_negotiation', 'rejected', 'concept_submitted', 'cancelled'],
  in_negotiation: ['final_review', 'rejected', 'cancelled'],
  final_review: ['pending_counter_signature', 'in_negotiation', 'rejected', 'cancelled'],
  pending_counter_signature: ['fully_executed', 'cancelled'],
  fully_executed: ['active', 'chain_violation', 'cancelled'],
  chain_violation: ['active', 'cancelled'],
};

export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
```

### Mirror file: `supabase/functions/_shared/lifecycle.ts`

Identical pure logic, Deno-style imports.

### Wire the chain functions to use new states

`act-on-chain-step` and `resolve-approval-chain` get updated to write the new state values when handling chain-driven leases.

The current Phase 2 code uses `submitted` and `under_review` for backward compatibility. Phase 3 introduces a chain-mode flag inferred from `lease_approval_chain` rows existing for the lease:

In `act-on-chain-step`, when transitioning lifecycle states:
- If lease has chain rows → use new states (`concept_submitted` → `concept_under_review` → `in_negotiation`)
- If lease has no chain rows (legacy fallback path) → keep using legacy states (`submitted` → `under_review` → `approved`)

The chain-mode determination happens once per request, not per-transition, to avoid race conditions:

```typescript
async function getLifecycleMode(leaseId: string, supabaseAdmin: SupabaseClient): Promise<'legacy' | 'chain'> {
  const { count } = await supabaseAdmin
    .from('lease_approval_chain')
    .select('id', { count: 'exact', head: true })
    .eq('lease_id', leaseId);
  return (count ?? 0) > 0 ? 'chain' : 'legacy';
}
```

In `resolve-approval-chain`, when the legacy fallback path is taken, the lease stays in `submitted` (current Phase 2 behavior). When a policy resolves successfully, the lease moves from `draft` to `concept_submitted` (new Phase 3 behavior).

Update the `LeaseRequestForm.tsx` post-resolution flip accordingly:
- `legacyFallback: true` → flip to `submitted`
- `legacyFallback: false` (policy matched) → flip to `concept_submitted`

### Frontend reader updates — the bulk of the work

Every place in the frontend that reads `lifecycle_status` needs to be aware that `concept_submitted` and `submitted` are equivalent for display, that `concept_under_review` and `under_review` are equivalent, and so on.

Three approaches the codebase should use, in priority order:

**Approach A — use `displayLabel()` for any UI text rendering a status.**
Replace all literal status comparisons that are purely for display with calls to `displayLabel(status)`. This makes the UI text-aware of both vocabularies without manual mapping in each component.

**Approach B — use `groupOf()` for grouping logic.**
Replace literal status comparisons used to group leases into buckets (dashboards, filters, "in progress" indicators) with `groupOf(status) === 'in_concept_review'` or similar. This insulates the UI from the legacy/new split.

**Approach C — use `normalizeToChainStates()` for routing decisions.**
For code that needs a unified vocabulary (e.g., the merged inbox in `ApprovalQueue.tsx`), normalize all incoming statuses to the chain vocabulary before branching.

The audit list — every file with `lifecycle_status` references — must be reviewed and each occurrence categorized A, B, or C. A separate file `docs/PHASE_3_AUDIT.md` should document each occurrence and the chosen approach. This audit is a hard requirement before any code changes; it's how we avoid missing a consumer.

### Files known to require updates (non-exhaustive — full list comes from the audit)

- `src/pages/app/Dashboard.tsx`
- `src/pages/app/Leases.tsx`
- `src/pages/app/LeaseDetail.tsx`
- `src/pages/app/LeaseReview.tsx`
- `src/pages/app/ApprovalQueue.tsx` — the merged inbox
- `src/pages/app/Approvals.tsx`
- `src/pages/app/Portfolio.tsx`
- `src/components/leases/StatusBadge.tsx` (or equivalent — uses `displayLabel()`)
- `src/components/leases/locked/LockedLeaseDetail.tsx`
- `src/components/workflow/LeaseRequestForm.tsx` — the draft → submitted/concept_submitted flip
- `src/hooks/useLifecycleWorkflow.ts`
- All edge functions in `supabase/functions/` that read or write `lifecycle_status` (23 references found in the survey)

### TypeScript type regeneration

After the migration, run Supabase type regeneration so `lease_governance_status` and any related enum exports include the new values. If `lifecycle_status` is typed as a check constraint (string with literal union), the type generator will pick up the new constraint values automatically. Verify this by typechecking against the new state names.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- Constraint accepts all new values: insert leases with each of `concept_submitted`, `concept_under_review`, `in_negotiation`, `final_review`, `pending_counter_signature`, `fully_executed`, `chain_violation`.
- Constraint accepts all legacy values still.
- Constraint rejects unknown values.
- New `concept_approved_at`, `signator_approved_at`, `counter_signed_at`, `fully_executed_at`, `execution_owner_id` columns exist and accept null and valid values.

### Pure logic (vitest)

For both `src/lib/lifecycleStates.ts` and the Deno mirror:

- `groupOf` returns correct group for every state.
- `isEquivalent` returns true for legacy/chain pairs in same group, false otherwise.
- `normalizeToChainStates` maps every legacy state correctly.
- `displayLabel` returns a non-empty label for every state.
- `canTransition` returns true for every entry in `VALID_TRANSITIONS`.
- `canTransition` returns false for transitions not in `VALID_TRANSITIONS`.
- Identical behavior between Node and Deno copies (same input → same output).

### Edge function

`act-on-chain-step`:
- Lease with chain rows transitioning concept stage → moves to `concept_under_review` (not `under_review`)
- Lease with chain rows completing concept stage → moves to `in_negotiation` (not `approved`)
- Legacy fallback lease (no chain rows) → continues to use legacy states
- Activity log entries `concept_stage_entered`, `concept_stage_completed`, `negotiation_stage_entered` are written at the correct transitions
- All transitions follow the Lifecycle Transition Convention (status_changed_at bumped, from_status/to_status both as columns and inside details, routing_path written)

`resolve-approval-chain`:
- Successful policy match → lease flips from `draft` to `concept_submitted`
- Legacy fallback → lease flips from `draft` to `submitted` (unchanged from Phase 2)

### Frontend (vitest)

- `displayLabel` rendering: legacy `submitted` and chain `concept_submitted` both render as "Submitted"
- `groupOf` grouping: any UI that buckets leases by status correctly buckets both legacy and chain states into the same groups
- The merged inbox in `ApprovalQueue.tsx` shows leases regardless of which vocabulary they use

---

## Migration strategy for in-flight legacy leases

Any leases currently in `submitted`, `under_review`, `approved`, or `executed` stay in those values. They are not retroactively migrated to chain vocabulary. They continue through the legacy code path until they reach a terminal state.

This dual-mode operation is permanent until a future cleanup phase decides to either:
- Migrate all legacy leases to chain vocabulary (one-shot conversion migration), OR
- Delete the legacy vocabulary entirely once all legacy leases have aged out

Phase 3 does not make this decision. It just ensures both vocabularies coexist correctly.

---

## Out of scope for Phase 3 — explicit list

Do NOT build any of these in Phase 3.

- The `lease_documents` table for tracking negotiation document iterations (Phase 4)
- Any UI for uploading documents during the `in_negotiation` stage (Phase 4)
- Activation of the signator stage with chain step consumption at `final_review` (Phase 5)
- The `pending_counter_signature` stage's reminder/nudge system for chasing counter-signatures (Phase 5)
- Rerouting on attribute changes (Phase 6)
- `chain_violation` state usage — only its existence in the constraint matters for Phase 3
- Delegation activation (Phase 7)
- Data migration of legacy leases to new vocabulary

---

## Definition of done for Phase 3

1. Migration applied cleanly to staging. All migration tests pass. Mirror committed to `supabase/migrations/`.
2. `src/lib/lifecycleStates.ts` and `supabase/functions/_shared/lifecycle.ts` exist with identical pure logic. Both have the "stay in sync" header. All vitest tests pass.
3. `docs/PHASE_3_AUDIT.md` exists and lists every `lifecycle_status` consumer in frontend and edge functions, with the chosen migration approach for each.
4. Every consumer in the audit is updated. Full vitest suite green. Typecheck clean.
5. Edge function smoke (Pro upgrade or local Docker if available; deferred otherwise per the established Phase 1 / Phase 2 pattern).
6. Manual smoke: submit a lease via legacy fallback path → verify lease moves through `submitted` → `under_review` → `approved` exactly as today. Submit a second lease via chain path (with a policy configured) → verify lease moves through `concept_submitted` → `concept_under_review` → `in_negotiation`. Both display correctly in dashboards and the merged inbox.
7. No regression in the existing test suite.
8. CLAUDE.md and the architecture document updated only if any decisions changed during implementation.

---

## Notes for Claude Code

- This phase has the largest blast radius of any phase yet. Default to additive changes. If a literal status comparison can be replaced with a helper function (`groupOf`, `displayLabel`, `normalizeToChainStates`), do that. Do not attempt to "clean up" surrounding code.
- The audit document in `docs/PHASE_3_AUDIT.md` is a hard prerequisite. Do not start updating consumers until the audit is committed and the user has reviewed it. The audit catches things spec writers miss.
- The Phase 2 spec gates were per-checkpoint with explicit user confirmation. Use the same cadence for Phase 3:
  - Checkpoint 1: Migration + types regeneration + audit document
  - Checkpoint 2: lifecycleStates.ts + Deno mirror + vitest tests for pure logic
  - Checkpoint 3: Edge function updates (act-on-chain-step, resolve-approval-chain)
  - Checkpoint 4: Frontend consumer updates per the audit
  - Checkpoint 5: Tests + docs + closeout
- Reuse the existing patterns from Phase 1 and Phase 2: schema-change rule, deployed-source-matches-committed-source, ECONNRESET-recovery survey before resuming.
- Do not introduce new dependencies. Stick to what is already in `package.json`.
- The `displayLabel` for chain states uses identical user-facing text as legacy states ("Submitted" for both `submitted` and `concept_submitted`). This is intentional — the UI should not surface internal vocabulary differences to the user. If you find yourself wanting to expose them, stop and propose first.
