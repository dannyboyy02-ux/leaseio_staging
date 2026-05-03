# Phase 2 Build Spec — Resolution Engine and Chain Table

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1_BUILD_SPEC.md`
**Phase scope:** Wire policies into actual lease submissions. Build the chain table, the resolution edge function, and replace the legacy parallel-approver notification path.
**Out of scope for Phase 2:** New lifecycle statuses, the documents table, rerouting on attribute changes, delegation activation, signator stage logic, override flow, ASC 842 report. Those are Phase 3+.

After Phase 1, admins can configure policies but lease submissions still use the legacy `getApprovalRequirements` / `notifyRoleHolders` flow. Phase 2 is where policies actually start controlling who approves a lease — but only at the **concept stage**, only on the **happy path**, and the lifecycle stays exactly as it is today.

---

## Goals of this phase

1. When a new lease request is submitted, the system resolves the matching approval policy and creates a concrete approval chain in `lease_approval_chain`.
2. The resolved chain drives notifications instead of the blanket `manager_approver` / `financial_approver` role lookup.
3. Approvers act on their assigned chain step, and the lease advances when all required parallel steps in the current sequential level are complete.
4. The `LeaseRequestForm` continues to work with the same UX. Submitter does not see the chain machinery — they fill the same form, the routing happens server-side.
5. The legacy `getApprovalRequirements` flow is preserved as a fallback path for workspaces with no policies configured. Phase 2 does not break existing customers.

---

## Database migrations

Create one migration file: `<timestamp>_phase2_lease_approval_chain.sql`.

### `lease_approval_chain` table

```sql
CREATE TABLE public.lease_approval_chain (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id             uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  policy_id                uuid REFERENCES public.approval_policies(id),
  policy_version           integer,
  stage                    text NOT NULL CHECK (stage IN ('concept', 'signator')),
  step_order               integer NOT NULL,
  parallel_group           integer NOT NULL DEFAULT 1,
  approver_user_id         uuid REFERENCES auth.users(id),
  approver_role            text,
  delegate_user_id         uuid REFERENCES auth.users(id),
  delegate_after_days      integer,
  is_required              boolean NOT NULL DEFAULT true,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'sent_back', 'superseded', 'delegated', 'skipped')),
  action_at                timestamptz,
  action_by                uuid REFERENCES auth.users(id),
  comment                  text,
  rerouted_from_chain_id   uuid REFERENCES public.lease_approval_chain(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_assignee_present CHECK (
    approver_user_id IS NOT NULL OR approver_role IS NOT NULL
  )
);

CREATE INDEX idx_lease_approval_chain_lease
  ON public.lease_approval_chain(lease_id, stage, step_order);

CREATE INDEX idx_lease_approval_chain_assignee_pending
  ON public.lease_approval_chain(approver_user_id, status)
  WHERE status = 'pending';

CREATE INDEX idx_lease_approval_chain_workspace_pending
  ON public.lease_approval_chain(workspace_id, status)
  WHERE status = 'pending';
```

Notes on schema choices:

- `policy_id` is nullable so legacy leases (created before Phase 2 or in workspaces without policies) can still have an empty chain row inserted by the fallback path if needed. In practice the resolution function only inserts rows when a policy is matched; legacy fallback leaves this table empty.
- `status = 'skipped'` is reserved for Phase 6 (rerouting can mark optional steps as skipped). Phase 2 only writes `pending`, `approved`, `rejected`, `sent_back`.
- `rerouted_from_chain_id` stays nullable in Phase 2 — never populated until Phase 6 builds rerouting.
- `delegate_user_id` and `delegate_after_days` are written on insert from the policy step but no behavior consumes them yet — that's Phase 7.

### Row Level Security

```sql
ALTER TABLE public.lease_approval_chain ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members read chain"
  ON public.lease_approval_chain FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- Only the resolve-approval-chain edge function (service role) inserts rows.
-- No INSERT policy for authenticated — service role bypasses RLS.

-- Approvers update only their own pending row, and only to approved/rejected/sent_back.
CREATE POLICY "assignee acts on own pending step"
  ON public.lease_approval_chain FOR UPDATE
  USING (
    status = 'pending'
    AND (
      approver_user_id = auth.uid()
      OR (
        approver_role IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.workspace_roles wr
          WHERE wr.workspace_id = lease_approval_chain.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role = lease_approval_chain.approver_role
        )
      )
    )
  )
  WITH CHECK (
    -- Action_by must equal the acting user (no impersonation)
    action_by = auth.uid()
    -- Status must transition to a valid action terminal
    AND status IN ('approved', 'rejected', 'sent_back')
  );

-- Admins can update any row in their workspace (for override and rerouting in later phases).
CREATE POLICY "admins update chain in workspace"
  ON public.lease_approval_chain FOR UPDATE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
```

### Activity log additions

Extend the existing `lease_activity_log.activity_type` check constraint to add the Phase 2 activity types. The current pattern (drop and re-add the constraint) is established in `lease_change_governance` migration:

```sql
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Existing values (preserve all from prior migrations)
    'status_change',
    'approval',
    'rejection',
    'send_back',
    'pause',
    'nudge_sent',
    'document_upload',
    'created',
    'comment',
    'executed_uploaded',
    'executed_terms_extracted',
    'model_locked',
    'unlock_requested',
    'unlock_approved',
    'unlock_rejected',
    'change_submitted',
    'change_approved',
    'change_rejected',
    'change_canceled',
    -- Phase 2 additions
    'chain_resolved',
    'chain_step_approved',
    'chain_step_rejected',
    'chain_step_sent_back',
    'chain_stage_completed',
    'chain_resolution_failed'
  ));
```

If any of those existing values are missing in the actual current constraint, preserve whatever is there and add the Phase 2 ones. Run a query first to confirm the current constraint definition before editing.

---

## Edge function: `resolve-approval-chain`

New edge function at `supabase/functions/resolve-approval-chain/index.ts`.

### Purpose

Called by the `LeaseRequestForm` submission flow (and by Phase 6 rerouting later). Takes a lease ID and resolves the policy chain, writing rows into `lease_approval_chain`.

### Request shape

```typescript
type ResolveChainRequest = {
  leaseId: string;
  // When called from initial submission, this is true.
  // Phase 6 rerouting will pass false to allow re-resolving an already-resolved lease.
  initialResolution: boolean;
};
```

### Response shape

```typescript
type ResolveChainResponse =
  | {
      ok: true;
      policyId: string;
      policyVersion: number;
      policyName: string;
      stepsCreated: number;
      firstStepAssignees: { userId: string | null; role: string | null }[];
      // Used legacy fallback path because no policies are configured
      legacyFallback: false;
    }
  | {
      ok: true;
      legacyFallback: true;
      message: string;
    }
  | {
      ok: false;
      error: string;
      reason: 'no_match_no_fallback' | 'ambiguous_match' | 'forbidden' | 'invalid_lease' | 'separation_violation';
      details?: unknown;
    };
```

### Logic

1. Auth: extract bearer token, resolve user via `supabaseAdmin.auth.getUser(token)`. Fail with `forbidden` if invalid.
2. Load the lease by `leaseId`. Verify the user is a member of the lease's workspace. Fail with `invalid_lease` otherwise.
3. If `initialResolution = true` and the lease already has any `lease_approval_chain` rows, return success without doing anything (idempotent — the form may retry on flaky network).
4. Extract policy-triggering attributes from the lease:
   - `assetType` → `lease_type` column (real_estate / equipment / vehicle / other) — note the column may be `asset_type` or `lease_type` depending on which the submission set; use whichever is non-null
   - `department` → `requesting_department`
   - `annualCost` → derived from `monthly_payment * 12` if present, else `0`
   - `region` → `region`
   - `leaseType` → `lease_type` (the same field the existing code uses)
5. Run the same matching logic as the Phase 1 `preview_policy_resolution` RPC, but in TypeScript so the edge function controls the full transaction:
   - Find all active policies in the workspace that match all criteria
   - Sort by priority desc, created_at asc
   - Take the top one
   - If multiple tie at top priority → return `ambiguous_match` error with the IDs of the tied policies
   - If none match → look for `is_default_fallback = true` active policy in the workspace
   - If still no match AND the workspace has no policies at all → return `legacyFallback: true` so the caller falls back to existing logic
   - If the workspace has policies but no fallback → return `no_match_no_fallback`
6. Load the chosen policy's chain steps (ordered by stage, step_order, parallel_group).
7. Resolve `approver_user_id` for any step that uses `approver_role`:
   - If the step has `approver_user_id`, use it directly.
   - If the step has `approver_role` only, look up active users in `workspace_roles` for that role. Phase 2 just writes the role into the chain row and leaves `approver_user_id` null — the `assignee acts on own pending step` RLS policy already handles role-based action authorization. Notifications go to all users with that role.
8. Check separation of duties:
   - Determine effective rule: `policy.separation_of_duties_override` if non-null, else `workspace.separation_of_duties_default`.
   - If the rule is "require distinct users," scan all resolved `approver_user_id` values across the chain. If any user appears twice, return `separation_violation`.
9. Insert the chain rows in a single transaction. Each row gets `policy_id`, `policy_version` (snapshot from the policy), `stage`, `step_order`, `parallel_group`, `approver_user_id` (or null), `approver_role`, `delegate_user_id`, `delegate_after_days`, `is_required`, status `'pending'`.
10. Insert `chain_resolved` activity log entry on the lease with details about which policy was used and the count of steps created.
11. Return success with metadata for the caller's notification step.

### Auth and rate limit

- Require authenticated bearer token (same pattern as `lease-governance-action`).
- Apply the existing `enforceWorkspaceRateLimit` from `_shared/audit.ts` for the function name `resolve-approval-chain` with limit 60 (chain resolution is cheap and may run multiple times during request flow).

### CORS

Use `getCorsHeaders` from `_shared/cors.ts` exactly as other edge functions do.

### Error handling on resolution failure

If resolution returns an error (no_match_no_fallback, ambiguous_match, separation_violation), the lease is left in `draft` status and the caller receives the error. The caller (form submission) shows the user a clear message and surfaces the issue. A `chain_resolution_failed` activity log entry is written with the error reason.

The lease is NOT left in a half-resolved state — the chain insert is wrapped in a transaction.

---

## Edge function: `act-on-chain-step`

New edge function at `supabase/functions/act-on-chain-step/index.ts`.

### Purpose

Called when an approver clicks Approve / Reject / Send Back on their assigned chain step. Updates the step row, runs stage-completion logic, and advances the lease lifecycle when appropriate.

### Request shape

```typescript
type ActOnChainStepRequest = {
  chainStepId: string;
  action: 'approve' | 'reject' | 'send_back';
  comment?: string;
};
```

### Logic

1. Auth: bearer token, resolve user.
2. Load the chain step by id. Verify status is `pending`. Fail otherwise.
3. Verify the user is authorized to act on this step:
   - If step has `approver_user_id`, user must match it (or be the listed delegate after `delegate_after_days` — Phase 7, skip in Phase 2).
   - If step has `approver_role`, user must have that role in `workspace_roles` for this workspace.
   - Workspace admins can always act (override path — log as policy_override in Phase 7, but Phase 2 just allows it silently).
4. Update the step row: set status to the action's terminal value, set `action_at = now()`, `action_by = auth.uid()`, `comment` if provided.
5. Insert activity log entry: `chain_step_approved` / `chain_step_rejected` / `chain_step_sent_back` with details (chain_step_id, stage, step_order, comment).
6. Run stage advancement logic:
   - If action was `reject` → set lease lifecycle to `rejected`. Mark all remaining `pending` steps in the chain as `superseded`. Insert `status_change` activity log.
   - If action was `send_back` → set lease lifecycle to `submitted` (the existing send-back behavior). Mark all `pending` steps in the current stage as `superseded` (the submitter will resubmit). Insert `status_change`. Phase 2 keeps the legacy resubmit flow — when the lease moves back to `submitted`, the resubmit handler will call `resolve-approval-chain` again with `initialResolution = false` to re-resolve from scratch (Phase 6 will refine this).
   - If action was `approve` → check whether the current step's stage is now complete:
     - A stage is complete when all `is_required` steps in that stage have status `approved`, AND for any sequential step ordering, all earlier `step_order` values are complete before any later ones can be considered.
     - Specifically: find the lowest `step_order` in the stage that has any `pending` required steps. If the action just resolved the last pending step at that order, advance. If there are still pending parallel steps at the same order, do not advance.
     - If the stage is `concept` and now complete → for Phase 2, set lease lifecycle to `under_review` (matching the existing legacy behavior so the rest of the app keeps working). Insert `chain_stage_completed` activity. Phase 3 will introduce the `in_negotiation` status.
     - If the stage is `signator` → for Phase 2, signator-stage logic does not yet activate (Phase 5 owns it). Phase 2 chains will only have concept-stage rows actually consumed; signator rows are inserted but the legacy lifecycle handles execution.
7. Notify the next assignees if a stage advances (call the same notification helper as the form does).

### Auth and rate limit

Same pattern as `resolve-approval-chain`. Limit 30/hour per workspace.

---

## Frontend changes

### `LeaseRequestForm.tsx` — submission flow

Replace the existing approval routing block in the `submit` function. The current code does:

```ts
const { requiresManagerApproval, requiresFinancialApproval } = getApprovalRequirements(...);
const initialStatus = getInitialStatusAfterSubmission(...);
// ... insert lease ...
if (requiresManagerApproval) await notifyRoleHolders(lease.id, 'manager_approver', ...);
if (requiresFinancialApproval) await notifyRoleHolders(lease.id, 'financial_approver', ...);
```

New flow:

```ts
// 1. Insert the lease in 'submitted' status (unchanged)
const { data: lease, error } = await supabase.from('leases').insert({...}).select().single();

// 2. Call resolve-approval-chain
const { data: chainResult, error: chainError } = await supabase.functions.invoke('resolve-approval-chain', {
  body: { leaseId: lease.id, initialResolution: true }
});

if (chainError || !chainResult?.ok) {
  // Resolution failed. Show user the error. Lease is in draft.
  // Allow them to retry or contact admin.
  toast.error(chainResult?.error ?? 'Could not route this request for approval. Contact your admin.');
  return;
}

if (chainResult.legacyFallback) {
  // No policies configured — use the existing legacy flow exactly as today.
  const { requiresManagerApproval, requiresFinancialApproval } = getApprovalRequirements(...);
  if (requiresManagerApproval) await notifyRoleHolders(lease.id, 'manager_approver', ...);
  if (requiresFinancialApproval) await notifyRoleHolders(lease.id, 'financial_approver', ...);
} else {
  // Policy-driven chain. Notify the first stage's assignees.
  for (const assignee of chainResult.firstStepAssignees) {
    if (assignee.userId) {
      // Direct user notification
      await createLeaseNotification({ leaseId: lease.id, userId: assignee.userId, ... });
    } else if (assignee.role) {
      // Role-based notification — use the existing notifyRoleHolders helper
      await notifyRoleHolders(lease.id, assignee.role, `New lease request requires your approval`);
    }
  }
}
```

The form UI itself does not change. The submitter sees the same fields and the same submission experience.

### Approval action UI

Existing Approvals page (`/app/approvals` or wherever `ApprovalsPage.tsx` lives) needs to be updated to surface chain steps in addition to legacy approval rows.

Phase 2 minimum:

- Query both legacy approval state (`manager_approved_by`, `financial_approved_by` columns) and the new `lease_approval_chain` table.
- Show pending chain steps assigned to the current user (where `approver_user_id = me` OR `approver_role` matches a role I hold).
- Each chain step row has Approve / Reject / Send Back buttons that call `act-on-chain-step`.
- Comment field is required for reject and send_back, optional for approve (existing UX pattern).
- After action, refresh the queue.

The existing legacy approval action handlers stay intact for leases that used the legacy fallback path.

### A unified approver inbox

To avoid two separate "what needs my approval" surfaces, the Approvals page should show a single merged list that includes:

- Legacy: leases where I am a `manager_approver` or `financial_approver` and the lease is `submitted` or `under_review` and I haven't acted yet.
- Policy-driven: chain steps where `status = 'pending'` and the step is assigned to me directly OR to a role I hold.

The list is sorted by created_at desc. Each row shows the lease context and clearly labels the action source (e.g., a small "Manager review" / "Concept approver" / "Finance approver" / etc. tag).

---

## Tests to add in this phase

### Migration / RLS

- Migration applies cleanly. Idempotent.
- Inserting a chain row with neither `approver_user_id` nor `approver_role` rejects.
- RLS: workspace member can read chain rows for their workspace; not for other workspaces.
- RLS: assignee can update their own pending step.
- RLS: non-assignee cannot update someone else's step.
- RLS: admin can update any chain row in their workspace.
- RLS: status transitions to invalid values rejected by check constraint.

### `resolve-approval-chain` edge function

- Workspace with one matching policy → chain resolved with all policy steps.
- Workspace with multiple matching policies at different priorities → highest priority wins.
- Workspace with multiple matching policies at the same priority → returns `ambiguous_match`.
- Workspace with no matching policies but a default fallback → uses fallback.
- Workspace with no policies at all → returns `legacyFallback: true`.
- Workspace with policies but no fallback and no match → returns `no_match_no_fallback`.
- Separation of duties enforced: chain with same user in two steps → `separation_violation`.
- Separation of duties allowed (workspace default OFF, no policy override) → same user in two steps allowed.
- Separation of duties allowed at workspace level but policy override forces require-distinct → enforced.
- Idempotent: calling resolve a second time on a lease that already has a chain returns success without inserting duplicates.
- Activity log: `chain_resolved` entry written with policy id and step count.
- Activity log: `chain_resolution_failed` entry written on failure.

### `act-on-chain-step` edge function

- Approver acts on their own pending step → status updated, action_at and action_by set, activity logged.
- Non-approver tries to act on someone else's step → 403.
- User with role tries to act on role-based step → allowed.
- User without role tries to act on role-based step → 403.
- Approve a parallel step when other parallel siblings still pending → stage does NOT advance.
- Approve the last parallel step at a step_order → stage advances if no later step_orders have pending required steps.
- Approve a sequential step → unblocks the next step_order.
- Reject any step → lease moves to `rejected`, all pending siblings marked `superseded`.
- Send back any step → lease moves to `submitted`, all pending steps in current stage marked `superseded`.
- Activity log entries created for each action.

### Submission flow integration

- Submitting a request in a workspace with no policies → uses legacy notify path; existing tests still pass.
- Submitting a request in a workspace with a matching policy → chain rows created; first stage assignees receive notifications.
- Submitting a request that fails resolution (ambiguous match) → user sees error, lease stays in draft, can be retried after admin fixes policies.

---

## Migration of existing data

Existing in-flight leases (status `submitted`, `under_review`) created before Phase 2:

- Do not retroactively create chain rows for them.
- They continue to use the legacy `manager_approved_by` / `financial_approved_by` flow until they exit those states.
- The Approvals page query must accommodate both modes (see "A unified approver inbox" above).

This dual-mode operation is expected and intentional. Once all pre-Phase-2 leases exit the submission stages (approve, reject, or cancel), the legacy code paths become quiet but stay in place — Phase 8 or a future cleanup phase decides when to remove them.

---

## Out of scope for Phase 2 — explicit list

Do NOT build any of these in Phase 2. Each is owned by a later phase.

- New lifecycle statuses (`concept_submitted`, `concept_under_review`, `in_negotiation`, `final_review`, `pending_counter_signature`, `fully_executed`). Phase 2 reuses existing `submitted` / `under_review` / `approved` / `rejected` / `executed` / `active` so the rest of the app keeps working unchanged.
- The signator stage activation. Chain steps for the `signator` stage are inserted but Phase 2 does NOT consume them. The lease still flows through legacy execution post-`approved`.
- Rerouting on attribute changes. The schema supports it (`rerouted_from_chain_id`, status `superseded`) but Phase 2 only writes `superseded` on reject and send_back. No re-resolution on lease attribute changes.
- Delegation activation. `delegate_user_id` and `delegate_after_days` are written but no logic acts on them.
- `lease_documents` table for negotiation pass tracking.
- Override flow with required reason and `policy_override` activity type.
- ASC 842 report integration with chain history.
- Migration of legacy in-flight leases into chain rows.

---

## Definition of done for Phase 2

1. Migration applied cleanly to staging database. All schema/RLS tests pass.
2. `resolve-approval-chain` deployed and callable. All resolution tests pass.
3. `act-on-chain-step` deployed and callable. All action tests pass.
4. `LeaseRequestForm` submits successfully in three scenarios:
   - Workspace with no policies → legacy fallback works exactly as before.
   - Workspace with one matching policy → chain created, first assignees notified.
   - Workspace with ambiguous policies → user sees clear error, lease stays in draft.
5. Approvals page shows a merged inbox for legacy and chain-based approvals, and approvers can take action successfully.
6. Activity log entries appear correctly for all chain events.
7. No regression in any existing test from prior phases.
8. The architecture document is updated only if any decisions changed during implementation; otherwise leave it untouched.

---

## Notes for Claude Code

- Reuse the same Edge Function patterns as `lease-governance-action`: CORS, auth, rate limit, jsonResponse helpers, activity logging.
- The `resolve-approval-chain` and `act-on-chain-step` functions should share a small helper file at `_shared/approval_chain.ts` for stage-completion logic and assignee resolution. Don't duplicate that logic in two places.
- Reuse the existing `getApprovalRequirements` and `notifyRoleHolders` for the legacy fallback. Do not delete or modify them.
- Match existing UI conventions on the Approvals page. Use shadcn/ui components, lucide-react icons, Tailwind utility classes only.
- Regenerate Supabase types after the migration so `src/integrations/supabase/types.ts` includes `lease_approval_chain`.
- Confirm before running: query the current `lease_activity_log_activity_type_check` constraint definition and preserve every existing value when extending it. The list in this spec is the union of values from prior migrations but the actual current state in the database is the source of truth.
- Do not introduce new dependencies. Stick to what is already in `package.json`.
- When the chain step status transitions to `approved` or `rejected`, the constraint allows `superseded` but the assignee RLS check policy explicitly excludes it. Only the service role (edge function) writes `superseded`. This is intentional and the function should use the admin client for those writes.

---

## As-built notes (post-implementation, 2026-05-03)

**Phase 2 status: CLOSED.** Delivered end-to-end with both legacy fallback and policy-driven chain paths verified live. The following deviations from the pre-coding spec were applied during the build and are now the source-of-truth implementation. Future phases should inherit these.

### Submission flow — insert as `draft` first, flip after resolve

The original spec showed `LeaseRequestForm` inserting the lease in its final lifecycle status (`submitted`/`under_review`/`approved`) and THEN calling resolve-approval-chain. That created a half-state failure mode: if resolution failed (ambiguous match, separation violation, network error) the lease was already in `submitted` with no resolved approvers wired up.

The shipped behavior:

1. Insert the lease in `lifecycle_status: 'draft'`.
2. Call `resolve-approval-chain`.
3. On `legacyFallback: true` → flip to legacy `getInitialStatusAfterSubmission` value + run legacy `notifyRoleHolders`.
4. On policy match → flip to `submitted` + call `notifyChainAssignees`.
5. On any error → leave the lease in `draft` and surface the toast. The resolver is idempotent (`initialResolution=true` returns `alreadyResolved` if any chain rows exist) so retry is safe.

Phase 6 rerouting and Phase 3+ lifecycle changes should preserve this draft-first pattern for any new submission triggers.

### `notifyRoleHolders` was inline, now lifted

The pre-coding spec referred to `notifyRoleHolders` as if it were a reusable helper. It actually existed only as a closure inside `LeaseRequestForm.tsx:213`. We extracted it to `src/lib/leaseNotifications.ts` (signature `notifyRoleHolders(client, leaseId, workspaceId, role, message)`) with body unchanged, and added a sibling `notifyChainAssignees(client, leaseId, workspaceId, assignees, message)`.

`notifyChainAssignees` semantics:
- **Direct-user assignees** (chain row has `approver_user_id` set): one `lease_activity_log` entry, `activity_type='comment'`, `details.notification_type='notify_chain_step_users'`, `details.recipient_ids=[<user ids>]`.
- **Role-based assignees** (chain row has `approver_role` set): fan out via `notifyRoleHolders` per unique role. This produces an entry with `details.notification_type='notify_<role>'` — the same shape the legacy path uses. The unambiguous source-of-truth marker for "was this transition chain-driven?" is the `status_change` activity log row's `details.routing_path` (see Lifecycle Transition Convention below), not the notification's `notification_type`.

### Approvals page is `ApprovalQueue.tsx`

The pre-coding spec said "ApprovalsPage.tsx (or wherever it lives)". The actual file is `src/pages/app/ApprovalQueue.tsx`. Phase 2 extended it purely additively — no refactor of existing legacy approval rendering. New code: `PendingChainStep` type, `ChainStepCard` component, parallel chain-step query inside `fetchLeases`, and `renderUnifiedMyReview()` for the "Needs My Review" tab. Existing `renderList()` still drives "All Pending" and "Reviewed" unchanged.

### Lifecycle Transition Convention

Surfaced during Path B verification: chain-driven `status_change` activity log rows had `from_status`/`to_status` only inside `details`, with the columns null. The form path wrote them as columns. Two write shapes meant downstream consumers had to handle both.

Convention now documented in `CLAUDE.md` → **Lifecycle Transition Convention**. Briefly: every code path that transitions `leases.lifecycle_status` MUST (1) bump `leases.status_changed_at` in the same UPDATE statement, (2) write `status_change` activity log rows with both the top-level `from_status`/`to_status` columns AND the equivalent inside `details`, and (3) include `details.routing_path` (`'legacy'` or `'chain'`).

`act-on-chain-step` enforces this via two helpers: `updateLifecycle(leaseId, newStatus)` and `logStatusChange(leaseId, fromStatus, toStatus, extra)`. Phase 3+ transition triggers (lifecycle expansion, rerouting) must follow the convention.

### Activity type values — live constraint is truth

The pre-coding spec listed an example set of pre-existing `activity_type` values for the CHECK constraint extension. The live constraint contained a different set (24 values, missing `model_locked`/`unlock_rejected` from the spec listing, with `change_set_*` and `risk_*` not in the spec). The migration captured the live constraint as truth and appended only the 6 Phase 2 additions (`chain_resolved`, `chain_step_approved`, `chain_step_rejected`, `chain_step_sent_back`, `chain_stage_completed`, `chain_resolution_failed`).

The on-disk migration mirror (`supabase/migrations/20260502170000_phase2_lease_approval_chain.sql`) is the source of truth for the final value list.

### Deploy path

Edge functions deployed via the MCP `mcp__claude_ai_Supabase__deploy_edge_function` tool, not the Supabase CLI (the CLI isn't installed in the dev environment). Source-of-truth files committed to `supabase/functions/<name>/index.ts` per the project-config rule. After every deploy, `mcp__claude_ai_Supabase__get_edge_function` is used to confirm deployed source matches local.

Final deployed versions at Phase 2 close:
- `resolve-approval-chain` v2 (v1 = initial deploy; v2 brought bundled `_shared/approval_chain.ts` in sync with the LIFECYCLE TRANSITION CONVENTION header comment).
- `act-on-chain-step` v3 (v1 = initial; v2 = lifecycle convention fix; v3 = same shared bundle sync).
