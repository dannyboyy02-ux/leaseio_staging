# Phase 6 Build Spec — Rerouting on Material Attribute Changes

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1_BUILD_SPEC.md`, `PHASE_2_BUILD_SPEC.md`, `PHASE_3_BUILD_SPEC.md`, `PHASE_4_BUILD_SPEC.md`, `PHASE_5_BUILD_SPEC.md`, `docs/PRODUCT_STRATEGY.md`, `docs/CLAUDE.md`
**Phase scope:** Detect material attribute changes on a lease and reroute the approval chain when a new policy now matches. Roll lifecycle back to the earliest unsatisfied stage. Preserve full chain history. Detect and surface chain violations (post-execution attribute changes that revealed gaps).
**Out of scope for Phase 6:** Delegation activation (Phase 7), ASC 842 report (Phase 8), firm layer (Phase 9+), automatic policy editing based on observed reroute patterns.

After Phase 5, the chain workflow is functionally complete from `concept_submitted` through `fully_executed` and into `active`. But there's a hidden assumption underneath every prior phase: **the lease's policy-triggering attributes never change after submission.** Phase 6 removes that assumption.

In practice, attributes change all the time. A submitter estimates $40K/year; the negotiated deal lands at $75K. A submitter says the lease is for the Operations department; halfway through negotiation it becomes a shared facility for Operations and IT. A region gets reassigned. A lease type gets reclassified.

When that happens today, the lease keeps its original chain — even if a different (stricter) policy would now match. That's a governance gap. Phase 6 closes it.

---

## Goals of this phase

1. The system detects when a policy-triggering attribute on a lease has changed in a way that would alter policy matching.
2. When a change is detected, `resolve-approval-chain` re-runs in "reroute mode" — comparing the new chain to the existing one and reconciling differences.
3. New approvers required by the new chain are added; existing approvers who already approved are preserved; approvers no longer needed are marked superseded but their action history remains queryable.
4. The lease's lifecycle rolls back to the earliest stage where a now-required approver hasn't yet acted.
5. If a reroute is detected after the lease has already executed (in `fully_executed` or `active`), the lease enters `chain_violation` status and surfaces to admins for retroactive resolution.
6. Every reroute is logged in full detail — what triggered it, which policy was active before, which policy is active now, what changed in the chain, who is now required, who was lost.
7. The submitter and affected approvers are notified clearly when a reroute happens, so they understand why the lease's status moved backward.

---

## Database migrations

Create one migration file: `<timestamp>_phase6_chain_rerouting.sql`.

### `lease_attribute_snapshots` table

We need a way to detect "material change." The naive approach is to store every attribute write to an audit log and diff. The cleaner approach is to snapshot the policy-relevant attributes at chain resolution time and compare current values to that snapshot.

```sql
CREATE TABLE public.lease_attribute_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  chain_resolution_at         timestamptz NOT NULL DEFAULT now(),
  policy_id                   uuid REFERENCES public.approval_policies(id),
  policy_version              integer,
  asset_type                  text,
  lease_type                  text,
  requesting_department       text,
  region                      text,
  monthly_payment             numeric,
  annual_cost_at_snapshot     numeric,
  raw_attributes              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lease_attribute_snapshots_lease_chronological
  ON public.lease_attribute_snapshots(lease_id, chain_resolution_at DESC);
```

A snapshot is taken every time `resolve-approval-chain` resolves successfully — both on initial submission and on rerouting. The most recent snapshot is the source of truth for "what attributes were these when the chain was last resolved."

`raw_attributes` stores the full attribute payload as JSON for forward compatibility. If Phase 7+ adds new policy-triggering attributes, the resolver can fall back to checking `raw_attributes` for older snapshots that were taken before those attributes existed.

### Reroute event log

```sql
CREATE TABLE public.lease_reroute_events (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                      uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  triggered_by                  uuid REFERENCES auth.users(id),
  triggered_at                  timestamptz NOT NULL DEFAULT now(),
  trigger_reason                text NOT NULL,
  prior_policy_id               uuid REFERENCES public.approval_policies(id),
  prior_policy_version          integer,
  new_policy_id                 uuid REFERENCES public.approval_policies(id),
  new_policy_version            integer,
  changed_attributes            jsonb NOT NULL,
  prior_lifecycle_status        text NOT NULL,
  new_lifecycle_status          text NOT NULL,
  steps_added_count             integer NOT NULL DEFAULT 0,
  steps_superseded_count        integer NOT NULL DEFAULT 0,
  steps_preserved_count         integer NOT NULL DEFAULT 0,
  detection_mode                text NOT NULL CHECK (detection_mode IN ('auto', 'manual_admin', 'manual_audit')),
  resulted_in_chain_violation   boolean NOT NULL DEFAULT false,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lease_reroute_events_lease_chronological
  ON public.lease_reroute_events(lease_id, triggered_at DESC);

CREATE INDEX idx_lease_reroute_events_workspace_chain_violations
  ON public.lease_reroute_events(workspace_id, triggered_at)
  WHERE resulted_in_chain_violation = true;
```

`changed_attributes` is JSON of the form:
```json
{
  "monthly_payment": { "from": 4000, "to": 7000 },
  "requesting_department": { "from": "Operations", "to": "Operations,IT" }
}
```

`detection_mode` distinguishes:
- `auto` — automatic detection on attribute write (the normal case)
- `manual_admin` — admin-triggered reroute via the admin UI
- `manual_audit` — surfaced by the periodic audit job (Phase 6 introduces this — see below)

### Activity log additions

```sql
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- All prior values preserved (Legacy + Phases 2-5)
    -- ... [snapshot from current state] ...
    -- Phase 6 additions
    'attribute_change_detected',
    'chain_rerouted',
    'chain_reroute_skipped_no_match',
    'chain_violation_entered',
    'chain_violation_resolved',
    'reroute_audit_run',
    'manual_reroute_requested',
    'manual_reroute_approved',
    'manual_reroute_rejected'
  ));
```

### Trigger to detect attribute changes

```sql
CREATE OR REPLACE FUNCTION public.detect_lease_attribute_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  -- Only fire for chain-driven leases (those with chain rows). Legacy leases
  -- are not subject to rerouting.
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_approval_chain WHERE lease_id = NEW.id LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  -- Only fire if the lease has not yet reached a terminal state
  IF NEW.lifecycle_status IN ('rejected', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  -- Compare each policy-triggering attribute
  IF OLD.asset_type IS DISTINCT FROM NEW.asset_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('asset_type',
      jsonb_build_object('from', OLD.asset_type, 'to', NEW.asset_type));
  END IF;
  IF OLD.lease_type IS DISTINCT FROM NEW.lease_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('lease_type',
      jsonb_build_object('from', OLD.lease_type, 'to', NEW.lease_type));
  END IF;
  IF OLD.requesting_department IS DISTINCT FROM NEW.requesting_department THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('requesting_department',
      jsonb_build_object('from', OLD.requesting_department, 'to', NEW.requesting_department));
  END IF;
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('region',
      jsonb_build_object('from', OLD.region, 'to', NEW.region));
  END IF;
  IF OLD.monthly_payment IS DISTINCT FROM NEW.monthly_payment THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('monthly_payment',
      jsonb_build_object('from', OLD.monthly_payment, 'to', NEW.monthly_payment));
  END IF;

  IF v_changed THEN
    -- Insert an activity log entry but do NOT call the resolver inline.
    -- Inline resolver calls in triggers risk transactional issues. Instead,
    -- we set a flag column and let the application layer call the
    -- reroute-approval-chain edge function asynchronously.
    INSERT INTO public.lease_activity_log (
      lease_id, user_id, activity_type, from_status, to_status, details
    ) VALUES (
      NEW.id,
      NULL,
      'attribute_change_detected',
      NEW.lifecycle_status,
      NEW.lifecycle_status,
      jsonb_build_object(
        'changed_attributes', v_changes,
        'reroute_pending', true
      )
    );

    -- Mark the lease as needing reroute evaluation. The flag is consumed by
    -- the application layer and cleared after evaluation completes.
    NEW.reroute_evaluation_pending = true;
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS reroute_evaluation_pending boolean NOT NULL DEFAULT false;

CREATE TRIGGER leases_detect_attribute_change
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.detect_lease_attribute_change();
```

The trigger sets a flag rather than running the resolver inline. The frontend (or a poller) sees the flag and triggers the reroute edge function, which clears the flag on completion. This decouples detection from resolution and avoids edge-function-from-trigger architectural problems.

---

## Code changes

### Update `resolve-approval-chain` to support reroute mode

The Phase 2 implementation already accepts `initialResolution: boolean` in its request shape but its only meaningful behavior is idempotency on initial submission. Phase 6 introduces real reroute behavior when `initialResolution: false`.

When called with `initialResolution: false`:

1. Verify the lease exists and the user has access. (For automated reroutes, the request is signed with the service role key.)
2. Load the most recent `lease_attribute_snapshots` row for the lease.
3. Read the current attributes from the lease.
4. Compare attributes — if no policy-triggering attribute differs from the snapshot, return `{ ok: true, no_reroute_needed: true }` and exit.
5. If attributes differ, resolve the new policy:
   - Run the same matching logic as initial resolution
   - If a different policy matches (different `policy_id`), proceed with reroute
   - If the same policy matches but with a different `policy_version`, proceed with reroute
   - If the same policy_id and policy_version match (e.g., the change wasn't material to policy matching), insert an activity log `chain_reroute_skipped_no_match` and return `{ ok: true, no_reroute_needed: true, attribute_change_immaterial: true }`
6. Compare the new chain composition to the existing chain:
   - For each step in the new chain, check if there's a matching step in the existing chain (same `approver_user_id` or `approver_role`, same `stage`)
   - If the matching step in the existing chain has `status = 'approved'`, preserve it (don't insert a duplicate)
   - If the matching step is `pending`, preserve it (the same approver is still required)
   - If a new step exists in the new chain that has no equivalent in the existing chain, insert a new `pending` row for it
7. For each step in the existing chain that has no equivalent in the new chain, mark it `superseded` (regardless of its current status):
   - If it was `pending`, the approver is no longer required
   - If it was `approved`, the prior approval is preserved in the audit trail but no longer counts toward stage completion under the new chain
8. Determine the new lifecycle status:
   - Find the earliest stage in the new chain that has `pending` required steps under the new chain composition
   - If the lease was past that stage, roll lifecycle back to it
   - If the lease has already executed (`fully_executed`, `active`), this is a chain violation — set `lifecycle_status = 'chain_violation'`, set `resulted_in_chain_violation = true` on the reroute event, and notify admins
9. Insert a new `lease_attribute_snapshots` row reflecting the post-reroute state.
10. Insert the `lease_reroute_events` row with full diff details.
11. Insert activity log: `chain_rerouted` with full details, possibly followed by `chain_violation_entered`.
12. Clear the `reroute_evaluation_pending` flag.
13. Notify all affected parties:
    - Submitter (always)
    - Newly required approvers (they're now on the hook)
    - Previously required approvers who are no longer needed (informational)
    - Workspace admins (if chain violation)

Return shape:
```typescript
{
  ok: true,
  rerouted: true,
  reroute_event_id: string,
  prior_policy_id: string,
  new_policy_id: string,
  changed_attributes: object,
  steps_added: number,
  steps_superseded: number,
  steps_preserved: number,
  prior_lifecycle_status: string,
  new_lifecycle_status: string,
  resulted_in_chain_violation: boolean,
}
```

### New edge function: `process-pending-reroute-evaluations`

A scheduled (cron) function that polls for leases with `reroute_evaluation_pending = true` and calls `resolve-approval-chain` with `initialResolution: false` for each.

This function exists to handle the gap between "the trigger flagged the lease" and "the resolver actually evaluated." Most reroutes happen in real-time because the frontend (after a UI write that updated lease attributes) calls `resolve-approval-chain` directly. But for backend or batch attribute changes (e.g., admin imports, scheduled adjustments), the flag-and-poll pattern catches them.

Frequency: every 5 minutes. Idempotent — if a lease's flag has already been cleared by a real-time call, the function skips it.

### New edge function: `reroute-audit-sweep`

A scheduled function that runs daily and re-evaluates every active chain-driven lease against current policy state. This catches:

- Policies that were edited by admins after a lease's chain was resolved (the lease's snapshot is stale)
- Workspace-level changes that affect attribute interpretation
- Bug-induced state where a lease's chain is silently misaligned with current policy state

Logic:
1. Query all leases in non-terminal states (`concept_submitted` through `fully_executed` and `active`) that are chain-driven (have chain rows).
2. For each, run `resolve-approval-chain` with `initialResolution: false` and `audit_mode: true` (a new request flag).
3. In audit mode, the resolver does not actually reroute — it just reports whether a reroute would have been triggered.
4. Aggregate results into a workspace-level audit report.
5. Surface findings to admins via a new dashboard panel.

This is conservative — the audit detects but doesn't act. Acting requires explicit admin approval via the next function.

### New edge function: `admin-trigger-manual-reroute`

Admins can explicitly trigger a reroute for a lease, even if the trigger didn't catch it (e.g., the audit sweep found it).

1. Verify the actor is a workspace admin.
2. Take a reason (required, ≥ 20 characters).
3. Run `resolve-approval-chain` with `initialResolution: false`, `detection_mode: 'manual_admin'`.
4. Insert `manual_reroute_requested` activity log.
5. Return the reroute outcome.

### Pure helpers — extend `src/lib/lifecycleStates.ts` and Deno mirror

Add helpers for chain reconciliation:

```typescript
export type ChainStepCompare = {
  step: ChainStepRow;
  matchInOther: ChainStepRow | null;
  matchKind: 'same_user' | 'same_role' | 'same_user_and_role' | null;
};

// Compares two chains (existing vs new) by step identity. A step is "the same"
// if it has the same approver_user_id (when set) or the same approver_role
// (when set), AND the same stage, AND the same step_order. Step ordering can
// shift between chains; identity is by who and what role.
export function reconcileChainSteps(
  existing: ChainStepRow[],
  newChain: ChainStepRow[],
): {
  preserved: ChainStepRow[];     // exists in both
  superseded: ChainStepRow[];    // in existing but not in new
  added: ChainStepRow[];         // in new but not in existing
} {
  // Implementation maps stages -> approver identity -> step
  // Returns three disjoint lists summing to existing.length + added.length
  // ...
}

// Determines the earliest lifecycle stage where a now-required approver has
// not yet acted. Used to compute the lifecycle rollback target.
export function rollbackTargetForNewChain(
  newChain: ChainStepRow[],
  reconciled: { preserved: ChainStepRow[]; added: ChainStepRow[] },
): 'concept_submitted' | 'concept_under_review' | 'in_negotiation' | 'final_review' | 'no_rollback_needed' {
  // If no new steps added, no rollback needed
  // If a new concept step is added, rollback to concept_under_review
  // If a new signator step is added (and no concept changes), rollback to final_review
  // ...
}
```

These pure helpers are tested in vitest and used by both the resolver and any future tooling that needs to reason about chain comparisons.

### Frontend — chain history surface

The lease detail page gets a new section: "Chain Reroute History."

- Lists every `lease_reroute_events` row for the lease, chronologically
- Each row shows: triggered at, triggered by, prior policy → new policy, diff of changed attributes, steps added/superseded/preserved counts, whether it caused a chain violation
- Expandable detail showing the full chain composition before/after

The activity log timeline already shows the inline `chain_rerouted` events; this is a structured view for admins and auditors.

### Frontend — chain violation alert

When a lease enters `chain_violation`:

- A prominent banner appears on the lease detail page in red
- Banner text: "This lease's policy-required approvers were not all consulted before execution. Required approvers must retroactively approve before the lease returns to active status."
- Lists the required approvers who haven't yet acted
- Each approver gets a notification with a "Retroactively approve" or "Reject" action
- Once all required retroactive approvals are recorded, the lease moves back to `active` and the chain violation is resolved
- Admins can also manually mark the violation resolved via an "Acknowledge and Override" button (logged as `chain_violation_resolved` with override flag)

### Frontend — admin reroute audit dashboard

A new admin page at `/app/admin/reroute-audit`:

- Shows the most recent `reroute-audit-sweep` results
- Lists leases where the audit found a misalignment but no reroute has been triggered
- For each, admin can review the misalignment and click "Trigger Manual Reroute" (calls `admin-trigger-manual-reroute`)
- Or click "Mark as Acceptable" (logs that the admin reviewed and chose not to reroute, with reason)

### Frontend — submitter reroute notification

When a reroute happens that affects the submitter (e.g., their lease rolled back to concept stage):

- An in-app notification is created
- A modal appears the next time they view the lease, explaining what changed and why
- The modal links to the chain reroute history for full transparency

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- New tables (`lease_attribute_snapshots`, `lease_reroute_events`) created with correct columns and indexes.
- New `reroute_evaluation_pending` column added to leases with default false.
- Trigger fires on UPDATE that changes policy-triggering attributes.
- Trigger does NOT fire for terminal-state leases (rejected, cancelled, expired).
- Trigger does NOT fire for leases without chain rows (legacy leases).
- New activity types accepted.

### Pure logic (vitest)

- `reconcileChainSteps` correctly identifies preserved/superseded/added for a variety of chain shapes.
- `rollbackTargetForNewChain` returns correct rollback target for each combination of stage/added scenarios.
- Identical behavior between Node and Deno copies.

### Edge functions

`resolve-approval-chain` (reroute mode):
- Lease with no attribute change since last snapshot — returns `no_reroute_needed: true`.
- Lease with attribute change but same policy still matches at same version — returns `no_reroute_needed: true, attribute_change_immaterial: true`.
- Lease with attribute change that triggers different policy match — fully reroutes:
  - New steps added
  - Superseded steps marked
  - Preserved steps remain
  - Snapshot updated
  - Reroute event logged
  - Activity log entry written
  - Lifecycle rolls back if needed
- Lease in `fully_executed` with reroute trigger — enters `chain_violation` correctly.
- Lease in `active` with reroute trigger — enters `chain_violation` correctly.
- Lease in `rejected` — trigger doesn't fire, no reroute.

`process-pending-reroute-evaluations`:
- Picks up leases with the flag set.
- Calls resolver correctly.
- Clears flag on success.
- Idempotent.

`reroute-audit-sweep`:
- Finds misaligned leases.
- Does not act, only reports.
- Does not flag leases that are correctly aligned.

`admin-trigger-manual-reroute`:
- Admin can trigger reroute.
- Non-admin gets 403.
- Reason field required and validated.

### Frontend (vitest)

- Chain reroute history section renders rows correctly.
- Chain violation banner appears for `chain_violation` lifecycle.
- Reroute audit dashboard fetches and renders correctly.
- Admin-only access to manual reroute trigger.
- Submitter notification modal appears once and not repeatedly.

---

## Edge cases the architecture handles

**Submitter underestimates cost to game the system.** Submitter enters $40K/year to get the light approval chain. Once approved by manager, they "discover" the actual $75K cost during negotiation. They update the lease attribute. The trigger fires. Reroute detects the new threshold. The financial director (now required at the higher threshold) is notified and must approve. The lease rolls back to `concept_under_review` until they act.

**Policy edited mid-flight.** Admin edits a policy after a lease's chain was resolved. The lease's chain is now stale relative to the new policy. The daily audit sweep catches it; admin sees it on the dashboard; admin decides whether to trigger a manual reroute or accept the existing chain.

**Attribute change crosses a threshold but the new approver is the same person.** The new policy requires "department head approval over $50K" but the department head was already a concept approver under the old policy. Reconciliation preserves the existing approval; no new step is needed; no rollback occurs. The activity log notes the attribute change and the snapshot is refreshed, but the lease keeps moving.

**Attribute change after execution.** Lease is `active`. Submitter (or admin) corrects an attribute that turns out to have been wrong (e.g., the original lease was misclassified). The trigger fires. The new chain requires additional approvers who were never consulted. Lease moves to `chain_violation`. The required approvers retroactively approve (or reject). Once resolved, the lease returns to `active`.

**Reroute would require approver who has left the company.** The new chain references a deactivated user. The resolver catches this in the assignee resolution step and returns an error. The reroute event records the failure. Admins are notified to update the policy before the reroute can complete. The lease stays in its current state with the `reroute_evaluation_pending` flag set until the policy is fixed.

**Multiple rapid attribute changes.** Submitter is editing the lease and saves three times in quick succession, each changing a different attribute. The trigger fires three times. The flag is set. The resolver runs once (because it polls and clears the flag) and uses the most recent snapshot. The result: one reroute event, not three.

**Submitter intentionally wants to trigger reroute for legitimate reasons.** Submitter realizes they should have entered a different department from the start. They update the field. The trigger fires. Reroute happens. This is legitimate use of the system — the submitter is correcting a mistake and the chain adjusts accordingly.

---

## Out of scope for Phase 6 — explicit list

Do NOT build any of these in Phase 6.

- Automatic policy editing based on observed reroute patterns. Phase 6 detects that policies might be wrong; humans edit them.
- Reroute prediction in the request form. The submitter doesn't see "this might trigger a reroute later" warnings. Could be added in a future enhancement.
- Reroute simulation as a what-if tool for admins. Useful but not core; defer.
- Automatic conflict resolution when reroute fails (e.g., automatically reassigning to a delegate). Phase 7 owns delegation.
- Cross-workspace reroute coordination. The firm layer (Phase 9) might introduce parent-policy concepts where a parent firm's policy overrides a child workspace's. Defer.
- Time-based reroute triggers (e.g., re-evaluate every 90 days regardless of attribute change). The audit sweep is daily and catches stale chains; explicit time-based triggers add complexity without clear benefit.
- ML-driven detection of "should this attribute change have triggered a reroute" for cases where the trigger logic is too narrow. Defer.

---

## Definition of done for Phase 6

1. Migration applied cleanly. All schema, trigger, and RLS tests pass. Mirror committed.
2. `lifecycleStates.ts` and Deno mirror have the new helpers. All vitest tests pass.
3. Three new edge functions deployed: `process-pending-reroute-evaluations`, `reroute-audit-sweep`, `admin-trigger-manual-reroute`. Source verified. The reroute mode added to `resolve-approval-chain` (now v4+).
4. Chain reroute history surface visible on the lease detail page.
5. Chain violation banner functional with retroactive approval flow.
6. Admin reroute audit dashboard at `/app/admin/reroute-audit` exists and renders sweep results.
7. Submitter notification flow tested end-to-end.
8. Manual smoke covering:
   - Submit chain-driven lease, advance through concept stage to `in_negotiation`
   - Update `monthly_payment` to a value that crosses a policy threshold
   - Verify trigger fires, `reroute_evaluation_pending = true`
   - Verify the resolver runs and reroutes
   - Verify lease rolls back to `concept_under_review` with the new approver required
   - Verify chain reroute history shows the event
   - Verify submitter sees the notification modal
   - Approve the new chain step and re-advance the lease
   - Repeat the test post-execution: advance the lease all the way to `active`, then change an attribute, verify it enters `chain_violation`
   - Resolve the chain violation via retroactive approvals; verify lease returns to `active`
   - Test the audit sweep: edit a policy, run the sweep, verify the affected lease appears on the dashboard
   - Test the admin manual reroute trigger
9. Scheduled functions configured (or documented for manual triggering pending pg_cron setup).
10. As-built notes appendix on this spec captures any deltas discovered during implementation.
11. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
12. KNOWN_ISSUES.md updated.

---

## Notes for Claude Code

- This is the most architecturally novel phase. The trigger-driven flag-and-poll pattern is new to this codebase. Document it clearly in CLAUDE.md so future contributors understand why it exists.
- The reroute mode in `resolve-approval-chain` is significantly more complex than initial resolution. Default to extra logging, especially around the reconciliation step. If a reroute decision feels wrong, the activity log should be detailed enough to reconstruct what happened.
- The chain violation flow is the safety net for the entire system. It must be impossible to silently lose a required approver. Every code path that could prevent a chain_violation event from firing should be reviewed twice.
- The retroactive approval flow for chain violations reuses the existing `act-on-chain-step` edge function with no special handling — a chain step is a chain step, regardless of whether the lease is currently mid-stream or in chain violation. This keeps the codebase simple but means careful testing is needed to ensure act-on-chain-step handles the chain violation case gracefully.
- Reuse the same checkpoint cadence as Phase 5:
  - Checkpoint 1: Migration + types regen + trigger + audit
  - Checkpoint 2: Pure helpers + Deno mirror + vitest
  - Checkpoint 3: Resolver reroute mode + new edge functions + smoke
  - Checkpoint 4: Frontend (chain reroute history, chain violation banner, admin audit dashboard, notifications)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke
- Apply the Lifecycle Transition Convention to every reroute-induced rollback transition.
- Apply the Permissions Gating Convention to the admin audit dashboard and manual reroute trigger.
- Apply the Schema Change Rule.
- Reference `docs/PRODUCT_STRATEGY.md` for tier boundaries — Phase 6 features are part of Pro tier.
- Do not introduce new dependencies.
- Pay particular attention to performance: the daily audit sweep runs against every active chain-driven lease in every workspace. If a workspace has 1000 active leases, the sweep must complete in reasonable time. Add appropriate batching, indexes, and timeouts.
- The trigger writes to `lease_activity_log` from within a SECURITY DEFINER function. Verify this works correctly under the existing RLS policies — the function bypasses RLS by design but the logged user_id is NULL for system-initiated entries, which is consistent with prior conventions.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 5 close, citing this spec doc by SHA per the audit-doc inheritance rule.
