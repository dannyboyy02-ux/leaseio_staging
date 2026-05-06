# Phase 5 Build Spec — Signator Stage Activation and Counter-Signature

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1_BUILD_SPEC.md`, `PHASE_2_BUILD_SPEC.md`, `PHASE_3_BUILD_SPEC.md`, `PHASE_4_BUILD_SPEC.md`, `docs/PRODUCT_STRATEGY.md`, `docs/CLAUDE.md`
**Phase scope:** Activate the signator stage so the signator can review and approve a lease at `final_review`. Build the `pending_counter_signature` workflow for chasing counterparty signatures. Wire the transition to `fully_executed` when the counter-signed document arrives. Hand off cleanly to the existing executed → active flow.
**Out of scope for Phase 5:** Rerouting on attribute changes (Phase 6), delegation activation (Phase 7), ASC 842 report generation (Phase 8), e-signature integrations (deferred), firm layer (Phase 9+).

After Phase 4, a lease can reach `final_review` via the `advance-to-final-review` edge function, but nothing happens there. The signator's chain rows have been inserted since Phase 2, but Phase 2 deferred their consumption. Phase 5 closes that loop and carries the lease through the final two operational stages — signator authorization and counter-signature receipt — to a fully executed contract.

This is the highest-stakes phase yet. The signator's approval is the moment the company is legally committed. Mistakes here aren't just data quality issues — they're contract liability. The phase emphasizes audit trail completeness, explicit re-confirmation, and protection against accidental advancement.

---

## Goals of this phase

1. The signator stage chain rows (already being inserted by `resolve-approval-chain`) are now consumed. The signator can approve, reject, or send back from a dedicated UI.
2. A new `pending_counter_signature` workflow surfaces in the dashboard and approvals page with reminders for chasing counter-execution.
3. An execution owner is explicitly assigned at the moment the lease enters `pending_counter_signature` — they're responsible for chasing the counter-signed document.
4. When the counter-signed document is uploaded, the lease moves to `fully_executed` and the existing extraction → active flow takes over.
5. A new "intent to bind" attestation step is required at signator approval — the signator explicitly confirms they're committing the company before the lease advances. This is the contract-liability protection layer.
6. Every transition follows the Lifecycle Transition Convention exactly. Every action by the signator or execution owner is logged with their identity, timestamp, and any reason or note provided.

---

## Database migrations

Create one migration file: `<timestamp>_phase5_signator_activation.sql`.

### New columns on `leases`

The Phase 3 migration already added `signator_approved_at`, `counter_signed_at`, `fully_executed_at`, and `execution_owner_id` as nullable columns. Phase 5 adds two more:

```sql
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS signator_attestation       text,
  ADD COLUMN IF NOT EXISTS counter_signature_due_date date,
  ADD COLUMN IF NOT EXISTS counter_signature_reminder_count integer NOT NULL DEFAULT 0;
```

- `signator_attestation` stores the text the signator typed when approving (e.g., "I confirm this commits Acme Corp to the terms in document v4-final"). Required, captured at the moment of signator approval. Becomes part of the audit trail.
- `counter_signature_due_date` is set when the lease enters `pending_counter_signature` — typically 14-30 days out, configurable per workspace. Drives the reminder cadence.
- `counter_signature_reminder_count` increments each time a reminder fires; used by the reminder scheduler to back off and surface to admins after repeated overdue states.

### Workspace-level setting

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS counter_signature_default_due_days integer NOT NULL DEFAULT 21
  CHECK (counter_signature_default_due_days BETWEEN 1 AND 365);
```

This is the default number of days from signator approval until the counter-signature is expected. Workspace admins can configure this via the workspace settings page.

### Activity log additions

```sql
-- Snapshot existing values via pg_get_constraintdef before extending. Standard practice.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- All prior values preserved (Legacy + Phases 2-4)
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'model_locked',
    'unlock_requested', 'unlock_approved', 'unlock_rejected',
    'change_submitted', 'change_approved', 'change_rejected', 'change_canceled',
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    'document_iteration_uploaded', 'document_iteration_superseded',
    'negotiation_escalated_to_concept', 'document_marked_final_negotiated',
    'document_lineage_corrected',
    -- Phase 5 additions
    'signator_attestation_recorded',
    'counter_signature_reminder_sent',
    'counter_signature_overdue',
    'counter_signature_received',
    'execution_owner_assigned',
    'execution_owner_reassigned',
    'final_review_returned_to_negotiation'
  ));
```

### Row-level constraint: signator approval requires attestation

```sql
-- Ensures signator_approved_at is only set when signator_attestation is also set.
-- Prevents accidental signator approval without explicit attestation.

ALTER TABLE public.leases
  ADD CONSTRAINT leases_signator_attestation_required
  CHECK (
    signator_approved_at IS NULL
    OR (signator_approved_at IS NOT NULL AND signator_attestation IS NOT NULL AND length(trim(signator_attestation)) > 0)
  );
```

---

## Code changes

### Update `act-on-chain-step` to consume signator stage

The Phase 2 implementation has stub handling at the signator stage (line 482 area). Phase 5 activates it.

When a signator step is acted on:

**Approve:**
1. Verify the actor is the assigned `approver_user_id` or holds the `approver_role` in `workspace_roles`.
2. Verify the request payload includes a non-empty `attestation` string (this is the new required field).
3. Verify the lease is currently in `final_review`.
4. Update the chain step row: `status = 'approved'`, `action_at = now()`, `action_by = auth.uid()`, `comment = attestation`.
5. Update the lease: `signator_approved_at = now()`, `signator_attestation = attestation`, `lifecycle_status = 'pending_counter_signature'` per the Lifecycle Transition Convention.
6. Compute `counter_signature_due_date = current_date + workspace.counter_signature_default_due_days`.
7. Compute the default `execution_owner_id` (the submitter, unless the workspace has a designated execution owner).
8. Insert activity log entries: `chain_step_approved`, `signator_attestation_recorded`, `chain_stage_completed` (signator stage), `pending_counter_signature_started`, `execution_owner_assigned`, `status_change`.
9. Notify the execution owner that they're now responsible for chasing the counter-signature.

**Reject:**
1. Move lease to `rejected`.
2. Mark all pending chain rows as superseded.
3. Activity log entries as today.
4. No counter-signature workflow — the lease is dead.

**Send back:**
1. Move lease to `in_negotiation` (not `submitted` — the signator's send-back loops back to negotiation, not to concept stage).
2. Insert activity log entry `final_review_returned_to_negotiation` with the signator's reason.
3. Mark the signator chain row as `sent_back`.
4. The submitter and concept-stage approvers are notified that the signator returned the lease for revisions.
5. New chain rows are NOT inserted — the existing signator step row stays in `sent_back` state until either the lease re-advances (a new `final_review_stage_entered` activity logs and a new `pending` signator row is inserted by `advance-to-final-review`'s next call) or the lease is cancelled.

### New edge function: `assign-execution-owner`

When the lease enters `pending_counter_signature`, the system assigns an execution owner automatically. The submitter or admin can change it via this function.

1. Verify the actor is the submitter, the current execution owner, or an admin.
2. Verify the lease is in `pending_counter_signature`.
3. Verify the new owner is a member of the workspace.
4. Update `leases.execution_owner_id`.
5. Insert `execution_owner_reassigned` activity log entry with the prior owner, new owner, and reason.

### New edge function: `record-counter-signature`

When the counter-signed document is uploaded and confirmed, this function moves the lease forward.

1. Verify the actor is the execution owner or an admin.
2. Verify the lease is in `pending_counter_signature`.
3. Verify a `lease_documents` row of type `fully_executed_counterparty_returned` exists for this lease (uploaded via Phase 4's `upload-lease-document`).
4. Update the lease: `counter_signed_at = now()`, `fully_executed_at = now()`, `lifecycle_status = 'fully_executed'` per the Lifecycle Transition Convention.
5. Insert activity log entries: `counter_signature_received`, `fully_executed_recorded`, `status_change`.
6. Notify the submitter, signator, and workspace admins.

The lease is now in `fully_executed`. The existing flow (Phase 0 / pre-chain) handles the transition to `active` after the executed document is processed by `process_lease`. Phase 5 does NOT modify that handoff — it just lands the lease in `fully_executed` and lets existing code take over.

### New edge function: `send-counter-signature-reminder`

Scheduled (cron-style) edge function that runs daily and sends reminders for leases in `pending_counter_signature`.

Logic:
1. Query leases where `lifecycle_status = 'pending_counter_signature'`.
2. For each, check `counter_signature_due_date`:
   - 7 days before due: send a notification to the execution owner.
   - On due date: send a notification to execution owner + submitter.
   - 7 days overdue: send a notification to execution owner + submitter + workspace admins. Insert `counter_signature_overdue` activity log.
   - 14 days overdue, 28 days overdue: repeated notifications with escalating tone.
3. Increment `counter_signature_reminder_count` each time a notification is sent.
4. Insert `counter_signature_reminder_sent` activity log entry per send.

This function is scheduled via `pg_cron` or a similar mechanism. The schedule is daily at a configurable workspace-friendly hour (e.g., 9 AM in the workspace's timezone, but for v1, just a single global schedule like 14:00 UTC).

If `pg_cron` is not available in the environment, this function can be triggered by an external cron service (e.g., a GitHub Action) or invoked manually for testing. The implementation should be idempotent — running it twice on the same day must not double-send reminders. Idempotency is enforced by checking the `counter_signature_reminder_count` against the expected count for the lease's days-since-approval.

### Pure helpers — extend `src/lib/lifecycleStates.ts` and Deno mirror

Add a helper for counter-signature urgency:

```typescript
export type CounterSignatureUrgency =
  | 'on_track'           // Due date is more than 7 days away
  | 'approaching'        // Within 7 days of due date
  | 'due_today'          // Due today
  | 'overdue'            // Past due date
  | 'critically_overdue' // 14+ days past due
  | 'no_due_date';       // Defensive fallback

export function counterSignatureUrgency(
  dueDate: Date | string | null,
  today: Date = new Date(),
): CounterSignatureUrgency {
  if (!dueDate) return 'no_due_date';
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  const daysUntil = Math.floor((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntil > 7) return 'on_track';
  if (daysUntil > 0) return 'approaching';
  if (daysUntil === 0) return 'due_today';
  if (daysUntil > -14) return 'overdue';
  return 'critically_overdue';
}
```

The corresponding display helper:

```typescript
export function counterSignatureUrgencyLabel(urgency: CounterSignatureUrgency): string {
  const labels: Record<CounterSignatureUrgency, string> = {
    on_track: 'On Track',
    approaching: 'Approaching Due Date',
    due_today: 'Due Today',
    overdue: 'Overdue',
    critically_overdue: 'Critically Overdue',
    no_due_date: 'No Due Date Set',
  };
  return labels[urgency];
}
```

### Frontend — signator approval UI

When a user with the signator role lands on the approval queue and there's a lease assigned to them at `final_review`, they see a special-treatment row: a different visual style (e.g., red border, "Signator Authorization" header) that emphasizes the gravity of the action.

Clicking the row navigates to a dedicated signator page at `/app/leases/{id}/signator-review` with:

- Full lease summary (key terms, financial impact, parties, document timeline)
- The most recent `final_negotiated` document rendered inline (PDF viewer)
- A "Documents Reviewed" checklist the signator must tick before approval becomes available
- An attestation text field with placeholder text: "I confirm this lease commits {workspace_name} to the terms in {final_negotiated document filename, version vN}, and I have authority to bind the company."
- Three action buttons: Approve (disabled until checklist is complete and attestation field has at least 30 characters), Send Back to Negotiation, Reject
- Send Back and Reject require a reason text field (no attestation required)

The Approve button calls `act-on-chain-step` with the signator step ID, action `approve`, and the attestation as the `comment` field of the request.

### Frontend — pending counter-signature workflow

A new section appears on the lease detail page when the lease is in `pending_counter_signature`:

- A prominent banner showing the urgency status (computed via `counterSignatureUrgency`)
- The execution owner with their name and a "Reassign" button (visible to submitter, current owner, admins)
- The due date with a "Change Due Date" button (admin only)
- An "Upload Counter-Signed Document" button that opens the existing Phase 4 upload modal pre-filtered to type `fully_executed_counterparty_returned`
- After upload, the user is presented with a "Confirm Counter-Signature Received" button that calls `record-counter-signature`

The dashboard surfaces leases in `pending_counter_signature` in a dedicated card showing all open ones with their urgency status, sortable.

The merged inbox in `ApprovalQueue.tsx` adds a tab or section for `pending_counter_signature` items assigned to the current user as execution owner.

### Frontend — workspace settings: counter-signature defaults

A new section in the workspace settings page (under existing tabs):

- "Default counter-signature window" numeric input (1-365 days, default 21)
- A small explainer: "When a lease enters pending counter-signature, this is the default number of days until the counter-signed document is expected. Reminders fire 7 days before, on the due date, and at 7 / 14 / 28 days overdue."

Save updates `workspaces.counter_signature_default_due_days`.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- The signator attestation row-level check rejects rows with `signator_approved_at` set but `signator_attestation` null.
- The check accepts rows with both null.
- The check accepts rows with both populated.
- New activity types and columns exist.
- `counter_signature_default_due_days` workspace column has correct default and bounds.

### Pure logic (vitest)

- `counterSignatureUrgency` returns correct value for: 30 days out, 5 days out, 0 days, -1 day, -10 days, -20 days, null.
- `counterSignatureUrgencyLabel` returns non-empty label for every urgency value.
- Identical behavior between Node and Deno copies.

### Edge functions

`act-on-chain-step` (signator stage):
- Approve with valid attestation — lease moves to `pending_counter_signature`, attestation stored, due date computed, execution owner assigned, all activity logs written.
- Approve without attestation — rejected with clear error, lease stays in `final_review`.
- Approve with empty/whitespace attestation — rejected.
- Reject — lease moves to `rejected`, all pending chain rows superseded.
- Send back — lease moves to `in_negotiation`, signator step marked sent_back, reason logged.
- Non-signator user attempts approval — 403.
- Lease not in `final_review` — rejected with clear error.

`assign-execution-owner`:
- Submitter reassigns to another user — succeeds, activity log written.
- Non-authorized user attempts — 403.
- New owner is not a workspace member — rejected.
- Lease not in `pending_counter_signature` — rejected.

`record-counter-signature`:
- Lease in `pending_counter_signature` with a `fully_executed_counterparty_returned` document — moves to `fully_executed`, all timestamps populated, notifications sent.
- Lease without the required document — rejected with clear error.
- Non-execution-owner, non-admin user attempts — 403.

`send-counter-signature-reminder`:
- 7-day-before reminder fires correctly.
- Due-day reminder fires correctly.
- Overdue reminder fires correctly with escalation.
- Idempotent: running twice on the same day doesn't double-send.
- Reminder count increments correctly.

### Frontend (vitest)

- Signator review page: Approve button disabled until checklist complete and attestation length ≥ 30.
- Pending counter-signature banner shows correct urgency styling for each urgency value.
- Reassign execution owner button visible only to submitter, owner, admins.
- Counter-signed upload flow: upload modal pre-filtered to correct document type.

---

## Out of scope for Phase 5 — explicit list

Do NOT build any of these in Phase 5.

- Rerouting on attribute changes during signator review. If a lease's attributes change (e.g., dollar amount increases) while in `final_review`, Phase 5 does NOT re-run policy resolution. Phase 6 owns that.
- Delegation activation. If the signator is on vacation, Phase 5 does NOT auto-route to a delegate. The chain row's `delegate_user_id` and `delegate_after_days` are still recorded but no logic acts on them. Phase 7 owns delegation.
- E-signature integration (DocuSign, Adobe Sign, etc.). Phase 5's `our_signed` document type exists in the schema (Phase 4) but the signing happens out-of-band and the user uploads the result. E-signature integration is a future enhancement.
- ASC 842 report generation. The lease reaching `fully_executed` then `active` triggers existing extraction flows; Phase 8 owns the structured ASC 842 output.
- Firm-layer cross-workspace signator views. Phase 9+.
- Bulk signator actions (approve multiple leases at once). Defer.
- Mobile-optimized signator UI. Phase 5 ships desktop-first; mobile is a future consideration.
- Custom attestation text templates per workspace. v1 uses a single placeholder; per-workspace templates can be added later.
- Workflow automation around overdue counter-signatures (e.g., automatically cancelling the lease after N days overdue). Phase 5 only sends reminders; cancellation remains a manual decision.

---

## Definition of done for Phase 5

1. Migration applied cleanly. All schema and RLS tests pass. Mirror committed.
2. `lifecycleStates.ts` extensions and Deno mirror match. Vitest tests pass.
3. Three edge functions deployed: `assign-execution-owner`, `record-counter-signature`, `send-counter-signature-reminder`. Source verified. The signator handling is added to `act-on-chain-step` (now v5+).
4. Signator review page exists at `/app/leases/{id}/signator-review`, gated to signator role.
5. Pending counter-signature workflow visible on dashboard and lease detail pages.
6. Workspace settings page has the counter-signature defaults section.
7. Manual smoke covering:
   - Submit chain-driven lease, advance through concept stage to `in_negotiation`
   - Upload required documents, advance to `final_review`
   - Sign in as signator, navigate to signator review page
   - Test required-attestation gate (try to approve with empty attestation — blocked)
   - Approve with valid attestation — verify lease moves to `pending_counter_signature`, due date populated, execution owner assigned
   - Verify dashboard surfaces the lease with correct urgency
   - Manually adjust due date to test reminder logic (set to 1 day from now, run reminder function manually, verify notifications fire)
   - Upload a `fully_executed_counterparty_returned` document
   - Click "Confirm Counter-Signature Received" — verify lease moves to `fully_executed`
   - Verify existing extraction flow takes over and lease eventually reaches `active`
8. Send-back from signator stage tested end-to-end (lease goes back to `in_negotiation`, can be re-advanced via Phase 4's `advance-to-final-review`).
9. Reject from signator stage tested (lease moves to `rejected` cleanly).
10. Non-signator users cannot access the signator review page (route guard).
11. Non-execution-owner cannot record counter-signature.
12. Reminder function smoke-tested on at least two leases at different urgency stages.
13. As-built notes appendix on this spec captures any deltas discovered during implementation.
14. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
15. KNOWN_ISSUES.md updated if any items resolved or any new ones emerged.

---

## Notes for Claude Code

- This is the highest-stakes phase yet. Default to extra care, more activity log entries, more explicit attestation, more "are you sure" gates. The user-facing cost of an extra confirmation click is trivial; the cost of an accidental signator approval is severe.
- The signator attestation requirement (≥30 character text + checklist completion before approve enables) is intentional friction. Do not optimize it away.
- The `fully_executed` → `active` handoff goes through existing code (`process_lease`, executed-extraction). Phase 5 stops at `fully_executed`. Verify in smoke testing that the existing flow correctly continues after Phase 5 lands the lease in `fully_executed`.
- The reminder edge function is the first scheduled function in the codebase. If `pg_cron` is not configured in your Supabase project, document this in the README and provide manual-trigger instructions for staging tests. Schedule wiring in production is part of the deployment checklist.
- The signator role is now active in `workspace_roles`. Workspaces that don't have a designated signator user assigned to that role will fail to advance leases past `final_review` — call this out clearly in error messages so admins know what to fix.
- Reuse the same checkpoint cadence as Phase 4:
  - Checkpoint 1: Migration + types regen + audit
  - Checkpoint 2: Pure helpers + Deno mirror + vitest
  - Checkpoint 3: Edge function updates (act-on-chain-step signator handling, three new functions) + smoke
  - Checkpoint 4: Frontend (signator review page, counter-signature workflow UI, workspace settings)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke
- Apply the Lifecycle Transition Convention from CLAUDE.md to every new transition introduced (`final_review` → `pending_counter_signature`, `pending_counter_signature` → `fully_executed`, signator send-back to `in_negotiation`).
- Apply the Permissions Gating Convention to every gate, especially the signator review page route guard.
- Apply the Schema Change Rule.
- Reference `docs/PRODUCT_STRATEGY.md` for tier boundaries — Phase 5 features are part of Pro tier (and inherited by Business via firm-aware RLS in Phase 9).
- Do not introduce new dependencies.
- The `lease_change_governance` migration's existing patterns for unlock requests and change sets are the closest precedent for the explicit-attestation flow; reference it for the audit trail shape.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 5 close, citing this spec doc by SHA per the audit-doc inheritance rule.

---

## Tracking

Spec ratified 2026-05-05. Phase 4 closed before this spec opened. Phase 6 (rerouting on attribute changes) opens after this phase closes.
