# Phase 7 Build Spec — Delegation, Override, and Exception Handling

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1` through `PHASE_6` build specs (with their As-built notes appendices), `docs/PRODUCT_STRATEGY.md`, `docs/CLAUDE.md`
**Phase scope:** Activate the delegation infrastructure (`delegate_user_id`, `delegate_after_days`) that has been latent since Phase 1. Add admin override flows with required reasons and full audit trail. Surface exceptions (broken policies, deactivated approvers, stuck chains) to admins for proactive handling. Close the loop on edge cases that were deferred from Phases 2-6.
**Out of scope for Phase 7:** ASC 842 report generation (Phase 8), firm layer (Phase 9+), AI-driven approval suggestions, automatic delegation discovery (e.g., "your manager seems to be on vacation, suggest delegating to X").

After Phase 6, the chain workflow handles the happy path, the negotiation path, the rerouting path, and the chain violation path. What it doesn't handle yet: an approver going on vacation, an approver leaving the company, an admin needing to push a stuck lease through, or any of the dozens of small operational edge cases that real businesses hit weekly.

Phase 7 is the operational maturity phase. Less new architecture, more closing of gaps and ensuring the system gracefully handles the messiness of real human workflows.

---

## Goals of this phase

1. The delegate infrastructure latent since Phase 1 is activated. When an approver doesn't act within their `delegate_after_days` window, the delegate is notified and can act in their place.
2. Admins can manually override any chain step with a required reason. The override is logged with full audit detail.
3. Approvers can voluntarily delegate a specific pending step to another user (e.g., "I'm out next week, my colleague will handle this one").
4. Workspace-level out-of-office settings let approvers declare a delegate window in advance, automatically routing all incoming approvals to a designated delegate.
5. The system detects "stuck chains" — leases where a step has been pending without action for an unusual length of time — and surfaces them to admins for triage.
6. Deactivated users are handled gracefully. A deactivated approver who has pending steps gets reassigned (via delegate or admin override).
7. Every override and delegation event is captured in the audit trail with sufficient detail that an auditor can reconstruct who acted on whose behalf and why.

---

## Database migrations

Create one migration file: `<timestamp>_phase7_delegation_override.sql`.

### `user_out_of_office` table

Workspace-scoped out-of-office declarations:

```sql
CREATE TABLE public.user_out_of_office (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  delegate_user_id    uuid NOT NULL REFERENCES auth.users(id),
  reason              text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ooo_valid_window CHECK (starts_at < ends_at),
  CONSTRAINT ooo_no_self_delegation CHECK (user_id <> delegate_user_id)
);

CREATE INDEX idx_user_ooo_active_window
  ON public.user_out_of_office(user_id, workspace_id, starts_at, ends_at)
  WHERE is_active = true;

CREATE TRIGGER user_out_of_office_updated_at
  BEFORE UPDATE ON public.user_out_of_office
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

When a chain step is created or revisited and the resolved approver has an active OOO record covering today's date, the step is automatically delegated to the OOO record's `delegate_user_id`. The OOO delegate takes precedence over the policy-step `delegate_user_id` because it's user-declared current intent versus policy-time defaults.

### `chain_step_overrides` table

Captures explicit admin overrides:

```sql
CREATE TABLE public.chain_step_overrides (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_step_id               uuid NOT NULL REFERENCES public.lease_approval_chain(id) ON DELETE CASCADE,
  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  override_action             text NOT NULL CHECK (override_action IN ('approve', 'reject', 'send_back', 'reassign', 'cancel_step')),
  override_by                 uuid NOT NULL REFERENCES auth.users(id),
  override_reason             text NOT NULL CHECK (length(trim(override_reason)) >= 20),
  override_at                 timestamptz NOT NULL DEFAULT now(),
  reassigned_to_user_id       uuid REFERENCES auth.users(id),
  prior_assignee_user_id      uuid REFERENCES auth.users(id),
  prior_assignee_role         text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chain_step_overrides_lease
  ON public.chain_step_overrides(lease_id, override_at DESC);

CREATE INDEX idx_chain_step_overrides_workspace_recent
  ON public.chain_step_overrides(workspace_id, override_at DESC);
```

A 20-character minimum on the reason is the deliberate friction. Drive-by overrides without a real explanation are not helpful for audit trails.

### `chain_step_voluntary_delegations` table

Captures user-initiated delegations on a specific pending step:

```sql
CREATE TABLE public.chain_step_voluntary_delegations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_step_id            uuid NOT NULL REFERENCES public.lease_approval_chain(id) ON DELETE CASCADE,
  lease_id                 uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id             uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  delegated_by             uuid NOT NULL REFERENCES auth.users(id),
  delegated_to             uuid NOT NULL REFERENCES auth.users(id),
  delegated_at             timestamptz NOT NULL DEFAULT now(),
  reason                   text,
  CONSTRAINT vd_no_self_delegation CHECK (delegated_by <> delegated_to)
);

CREATE INDEX idx_voluntary_delegations_step
  ON public.chain_step_voluntary_delegations(chain_step_id);
```

### `chain_step` activation timestamps

Add columns to `lease_approval_chain` to support stuck-chain detection and delegate timer logic:

```sql
ALTER TABLE public.lease_approval_chain
  ADD COLUMN IF NOT EXISTS pending_since        timestamptz,
  ADD COLUMN IF NOT EXISTS delegate_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS effective_assignee_user_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS assignee_resolution_source text CHECK (
    assignee_resolution_source IS NULL OR
    assignee_resolution_source IN ('policy_user', 'policy_role', 'policy_delegate', 'ooo_delegate', 'voluntary_delegate', 'admin_reassign')
  );
```

- `pending_since` is set when a step becomes the active "what we're waiting on" — that is, when a stage's prior steps complete and this step is what the lease is now blocked on. Used to compute time-pending for stuck-chain detection and delegate-timer activation.
- `delegate_activated_at` is set when the policy delegate becomes the effective assignee due to time-out.
- `effective_assignee_user_id` is the user who can currently act on the step. Computed at any moment as: voluntary delegate > OOO delegate > policy delegate (if activated) > original assignee. This is denormalized for query performance but always consistent with the source rows.
- `assignee_resolution_source` documents how `effective_assignee_user_id` was determined.

### Activity log additions

```sql
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- All prior values preserved (Legacy + Phases 2-6) ...
    -- Phase 7 additions
    'step_pending_started',
    'delegate_timer_started',
    'delegate_activated',
    'voluntary_delegation_created',
    'voluntary_delegation_revoked',
    'admin_override_executed',
    'ooo_declared',
    'ooo_revoked',
    'ooo_routed_step',
    'stuck_chain_detected',
    'stuck_chain_resolved',
    'deactivated_approver_reassigned',
    'policy_assignee_validation_failed'
  ));
```

---

## Code changes

### Update `act-on-chain-step` to recognize delegate authority

When a user attempts to act on a step:

1. The user is authorized if any of:
   - They are the `effective_assignee_user_id` (which already accounts for delegations)
   - They are listed in `chain_step_voluntary_delegations.delegated_to` for this step
   - They are an admin (override path — but they must use the override flow, not act-on-chain-step directly)

2. The act includes a "delegated_action" indicator if the actor is not the original `approver_user_id`:
   - The activity log entry includes `acted_as_delegate: true` and `delegate_resolution: <source>` so the audit trail is unambiguous.

### New edge function: `voluntary-delegate-step`

A user with a pending step can delegate it to another user.

1. Verify the actor is the original assignee (or the current effective assignee) of the step.
2. Verify the delegate is a workspace member.
3. Verify the delegate has the necessary permissions for the stage (e.g., the policy might restrict signator delegation to other signators).
4. Insert a `chain_step_voluntary_delegations` row.
5. Update `lease_approval_chain` row: `effective_assignee_user_id = delegate_id`, `assignee_resolution_source = 'voluntary_delegate'`.
6. Insert activity log: `voluntary_delegation_created` with reason.
7. Notify the new delegate and the original assignee.

### New edge function: `revoke-voluntary-delegation`

The original assignee can revoke a voluntary delegation if the delegate hasn't acted yet.

1. Verify the actor is the original assignee.
2. Verify the step is still pending.
3. Mark the voluntary delegation row as revoked (soft delete via additional columns: `revoked_at`, `revoked_by`).
4. Recompute `effective_assignee_user_id` based on remaining sources (OOO, policy delegate, original).
5. Insert activity log.

### New edge function: `admin-override-step`

Admins can override any chain step regardless of who's assigned.

1. Verify the actor is a workspace admin.
2. Verify the step is pending or sent_back.
3. Validate `override_action` and `override_reason` (≥ 20 chars).
4. Insert `chain_step_overrides` row.
5. Apply the action:
   - `approve`, `reject`, `send_back` → call into the existing `act-on-chain-step` logic with the override flag set, action_by = admin
   - `reassign` → set `effective_assignee_user_id` to the new target
   - `cancel_step` → mark step as `superseded` with override note (used when a step was incorrectly required and shouldn't be acted on)
6. Insert activity log: `admin_override_executed` with full detail.
7. Notify the original assignee and the submitter.

### New edge function: `declare-out-of-office`

A user declares an OOO window with a designated delegate.

1. Verify the actor is the user themselves (or an admin acting on their behalf).
2. Validate window dates and delegate.
3. Insert `user_out_of_office` row.
4. For any currently-pending steps assigned to this user that fall within the OOO window:
   - Update `effective_assignee_user_id` to the OOO delegate
   - Set `assignee_resolution_source = 'ooo_delegate'`
   - Insert `ooo_routed_step` activity log per affected step
   - Notify the OOO delegate of each routed step
5. Insert global activity log: `ooo_declared`.

### New edge function: `revoke-out-of-office`

User cancels their OOO declaration before it expires.

1. Verify actor.
2. Mark the OOO row inactive.
3. For steps that were OOO-routed but haven't been acted on: revert `effective_assignee_user_id` to the original.
4. Insert activity log entries.

### New edge function: `process-delegate-timers`

Scheduled function (cron-style) that runs hourly and activates policy delegates for steps that have exceeded their `delegate_after_days` window.

Logic:
1. Query `lease_approval_chain` rows where:
   - `status = 'pending'`
   - `delegate_user_id IS NOT NULL`
   - `delegate_after_days IS NOT NULL`
   - `delegate_activated_at IS NULL`
   - `pending_since + delegate_after_days * INTERVAL '1 day' <= now()`
2. For each:
   - If a voluntary delegation or OOO delegate is already in effect (`assignee_resolution_source` is `voluntary_delegate` or `ooo_delegate`), skip — the step is already routed and the policy delegate doesn't need to activate.
   - Otherwise: set `delegate_activated_at = now()`, update `effective_assignee_user_id = delegate_user_id`, set `assignee_resolution_source = 'policy_delegate'`.
   - Insert `delegate_activated` activity log entry.
   - Notify the delegate.
3. Idempotent — running multiple times in a window doesn't double-activate.

### New edge function: `detect-stuck-chains`

Scheduled function that runs daily and surfaces chains stuck without action.

Logic:
1. Query pending steps where `pending_since + 7 days <= now()` and the step has not been delegated, overridden, or otherwise advanced.
2. Group by lease.
3. For each stuck lease:
   - If it's the first time stuck is detected (no prior `stuck_chain_detected` activity in the last 14 days), insert one and notify workspace admins.
   - Otherwise (stuck and previously notified), do nothing — admins already know.
4. Surface stuck leases on a new admin dashboard panel.

### New edge function: `handle-deactivated-approver`

Triggered when a user is deactivated (or marked inactive in workspace_members or workspace_roles).

1. Find all pending chain steps assigned to the deactivated user.
2. For each, attempt automatic resolution in priority order:
   - If the step has a policy `delegate_user_id` and that user is active → activate the delegate immediately
   - Otherwise → notify workspace admins that manual reassignment is needed
3. Insert `deactivated_approver_reassigned` or `policy_assignee_validation_failed` activity log entries.
4. Surface on the admin dashboard.

This function is called explicitly when a user is deactivated. The deactivation flow itself (admin marking a user inactive) is out of scope for Phase 7 — assume it exists or is being added by parallel UI work.

### Pure helpers — extend `src/lib/lifecycleStates.ts` and Deno mirror

Add helpers for assignee resolution logic:

```typescript
export type AssigneeResolutionSource =
  | 'policy_user'
  | 'policy_role'
  | 'policy_delegate'
  | 'ooo_delegate'
  | 'voluntary_delegate'
  | 'admin_reassign';

export type AssigneeContext = {
  policy_user_id: string | null;
  policy_role: string | null;
  policy_delegate_user_id: string | null;
  policy_delegate_after_days: number | null;
  voluntary_delegate_user_id: string | null;  // if active
  ooo_delegate_user_id: string | null;        // if active for the assignee
  admin_reassigned_user_id: string | null;    // if admin override applied
  pending_since: Date | null;
};

// Computes the effective assignee at a given moment.
// Priority order: admin reassign > voluntary delegate > OOO delegate > policy delegate (if activated) > policy user > policy role
export function resolveEffectiveAssignee(
  ctx: AssigneeContext,
  now: Date = new Date(),
): { user_id: string | null; role: string | null; source: AssigneeResolutionSource } {
  // ... implementation
}

// Returns true if the policy delegate would activate given current time and pending_since.
export function shouldActivatePolicyDelegate(
  pending_since: Date | null,
  delegate_after_days: number | null,
  delegate_user_id: string | null,
  now: Date = new Date(),
): boolean {
  // ... implementation
}

// Returns true if a step is "stuck" — pending without action longer than the threshold.
export function isStepStuck(
  pending_since: Date | null,
  threshold_days: number = 7,
  now: Date = new Date(),
): boolean {
  // ... implementation
}
```

These helpers are pure (no I/O) and unit-tested in vitest. The edge functions consume them.

### Frontend — voluntary delegation UI

On the approval queue and lease detail pages, when the current user has a pending step assigned to them, add a "Delegate to..." button alongside the existing approve/reject/send-back actions.

Clicking opens a modal:
- User picker (workspace members only)
- Optional reason field
- Submit → calls `voluntary-delegate-step`

After successful delegation, the step disappears from the user's queue and appears in the delegate's queue.

The original assignee can also see "Steps I've delegated" in a small section showing delegations they've made and their status. They can revoke any not-yet-acted-on delegation.

### Frontend — out-of-office settings

A new section in user account settings: "Out of Office."

- Date range picker (start, end)
- Delegate user picker
- Optional reason
- Submit → calls `declare-out-of-office`

Shows current and upcoming OOO declarations with a "Cancel" button per row.

A small banner on the workspace header indicates "You are currently out of office until {date}, approvals are routed to {delegate name}" when active.

### Frontend — admin override surface

On the lease detail page, admins see an additional "Admin Override" button next to chain steps.

Clicking opens a modal:
- Action picker: Approve / Reject / Send Back / Reassign / Cancel Step
- If reassign: target user picker
- Required reason field (≥ 20 chars, with character counter and explicit warning text: "This override will be visible in the audit trail and the workspace's Admin Override report")
- Submit → calls `admin-override-step`

The admin override modal has stronger visual styling (red border, warning icon) to signal the gravity of the action.

### Frontend — admin dashboard additions

A new section on the admin dashboard at `/app/admin/exceptions`:

- Stuck chains panel: leases with steps stuck for 7+ days
- Deactivated approver alerts: leases where a deactivated user has pending steps that need reassignment
- Recent overrides panel: last 30 days of admin overrides with reason and outcome
- Out-of-office active list: currently-active OOO declarations and their delegations

Each list links to the lease detail page or the relevant admin action.

### Frontend — chain step row enrichment

On the approval queue and lease detail page, chain step rows show additional context:
- "Delegated to you by [Original Assignee]" badge if the current user is acting via voluntary delegation
- "Acting for [Original Assignee] (out of office)" badge for OOO routes
- "Delegate active (original assignee did not respond within {N} days)" badge for policy delegates
- "Pending {N} days" indicator if a step has been pending longer than 3 days

These badges make it obvious at a glance why a particular user is being asked to act.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- Tables, columns, indexes created correctly.
- OOO record cannot have starts_at >= ends_at.
- OOO record cannot have user_id == delegate_user_id.
- Chain step override reason must be ≥ 20 characters.
- Voluntary delegation cannot self-delegate.
- New activity types accepted.

### Pure logic (vitest)

- `resolveEffectiveAssignee` returns correct user/source for every combination of (policy user, policy role, policy delegate, OOO, voluntary, admin reassign).
- Priority order respected: admin reassign beats voluntary, voluntary beats OOO, OOO beats policy delegate, etc.
- `shouldActivatePolicyDelegate` returns true only when pending_since + delegate_after_days has elapsed AND a delegate is configured.
- `isStepStuck` returns true beyond threshold.
- All helpers identical between Node and Deno mirrors.

### Edge functions

`voluntary-delegate-step`:
- Original assignee can delegate.
- Non-assignee gets 403.
- Self-delegation rejected.
- Non-workspace-member as delegate rejected.
- After delegation, effective assignee updated correctly.

`revoke-voluntary-delegation`:
- Original assignee can revoke before delegate acts.
- After delegate already acted, revoke returns clear error.
- Effective assignee correctly reverts after revoke.

`admin-override-step`:
- Admin can approve, reject, send back, reassign, cancel.
- Non-admin gets 403.
- Reason < 20 chars rejected.
- Reassign requires target user; missing target returns clear error.
- Override on already-acted step returns error.
- Activity log captured.

`declare-out-of-office`:
- User can declare with valid window.
- Invalid window (start >= end) rejected.
- Self-as-delegate rejected.
- Affected pending steps automatically routed to delegate.

`process-delegate-timers`:
- Activates delegate when pending_since + delegate_after_days elapsed.
- Skips if voluntary or OOO delegate already in effect.
- Idempotent.

`detect-stuck-chains`:
- Identifies steps pending > 7 days.
- Doesn't re-notify within 14 days of last detection.

`handle-deactivated-approver`:
- Reassigns to policy delegate when configured and active.
- Surfaces to admins when no clean automatic path.

### Frontend (vitest)

- Voluntary delegation modal validates required fields.
- OOO settings UI validates date range.
- Admin override modal enforces 20-char reason.
- Chain step rows show correct badges based on resolution source.
- Admin dashboard surfaces stuck chains correctly.

---

## Edge cases the architecture handles

**Approver A goes OOO, designates B as delegate. While A is out, B also goes OOO designating C.**
The chain looks at the "effective assignee" at action time. When the OOO routing fires, it routes to B. When B's OOO is active, B's OOO delegation is independent — but the chain step doesn't follow chained OOO unless explicitly designed to. Phase 7 ships with single-hop OOO only: if B is OOO when the step is routed to them, the system surfaces the step as needing admin attention rather than chaining to C. Multi-hop OOO is a future enhancement.

**Admin overrides a step but the chain is now in chain_violation due to Phase 6 reroute.**
Admin override works regardless of chain_violation status. The override is recorded with elevated audit weight (the override row's reason is mandatory and the activity log includes the chain_violation context).

**User declares OOO covering a date already past.**
Rejected at the API level — `ends_at` must be in the future at declaration time.

**Voluntary delegation and policy delegation collide.**
Voluntary delegation always wins (it's the most current expression of intent). The policy delegate's timer is not stopped, but `process-delegate-timers` checks for voluntary delegate before activating policy delegate.

**Admin overrides their own pending step.**
Allowed, but logged with full audit detail. The 20-char reason requirement still applies.

**Submitter tries to use admin override.**
Rejected — only workspace admins can override.

**Delegate themselves leaves the company.**
When the delegate is deactivated, `handle-deactivated-approver` runs for any steps where they're the effective assignee. The cascade is: revert to original assignee if active, or surface to admin.

**OOO and voluntary delegation both target the same user.**
Allowed — the user receives the step regardless of source. The activity log records both triggers but the step is only assigned once.

**Stuck chain detected, admin overrides to push it through, original approver finally responds.**
The original approver's response is rejected at API level — the step is no longer pending (it's `approved` or whatever the override resolved it to).

---

## Out of scope for Phase 7 — explicit list

Do NOT build any of these in Phase 7.

- Multi-hop OOO chains (A delegates to B, B delegates to C, etc.). Single-hop only.
- Bulk override actions (override 10 leases at once). Defer.
- AI-suggested delegations ("based on usage patterns, you might want to delegate to..."). Defer.
- Automatic OOO detection from external calendar integration. Defer.
- Custom approval policies that exclude voluntary delegation (e.g., "signator approvals cannot be voluntarily delegated"). Could be added as a per-policy flag in a future phase.
- ASC 842 report integration. Phase 8.
- Firm-layer cross-workspace OOO. Phase 9+.
- Mobile push notifications for delegate activations. Defer.
- Workflow analytics ("our average step pending time is X"). Defer.

---

## Definition of done for Phase 7

1. Migration applied cleanly. All schema, constraint, RLS tests pass. Mirror committed.
2. Pure helpers extended in `lifecycleStates.ts` and Deno mirror. All vitest tests pass.
3. Six new edge functions deployed: `voluntary-delegate-step`, `revoke-voluntary-delegation`, `admin-override-step`, `declare-out-of-office`, `revoke-out-of-office`, `process-delegate-timers`, `detect-stuck-chains`, `handle-deactivated-approver`. Updates to `act-on-chain-step` to recognize delegate authority. All sources verified.
4. Frontend voluntary delegation, OOO settings, admin override, admin exceptions dashboard, and chain step badges all implemented.
5. Manual smoke covering:
   - Submit a chain-driven lease, advance to a step with a known assignee
   - Voluntarily delegate the step to another user; verify it disappears from original's queue and appears in delegate's queue
   - Revoke the voluntary delegation; verify it reverts
   - Declare OOO for the assignee with a different delegate; verify the step routes to OOO delegate
   - Cancel OOO; verify it reverts
   - For a step with a policy delegate configured (e.g., 2 days), set the database `pending_since` back 3 days, run `process-delegate-timers` manually, verify policy delegate activates
   - Admin override: open the override modal, try to submit with 5-character reason (rejected), submit with 25-character reason (accepted), verify activity log
   - Admin override with reassign: assign to a different user, verify they get the notification
   - Test admin override with cancel_step on an erroneously-required step
   - Set `pending_since` 8 days back on a step, run `detect-stuck-chains`, verify admin gets notified
   - Deactivate a user with pending steps, run `handle-deactivated-approver`, verify reassignment cascade
   - Verify chain step rows show correct badges in all delegation scenarios
6. Activity log captures every delegation, OOO event, override, and exception with proper actor and target identity.
7. Scheduled functions configured (or documented for manual triggering pending pg_cron setup).
8. As-built notes appendix on this spec captures any deltas discovered during implementation.
9. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
10. KNOWN_ISSUES.md updated.

---

## Notes for Claude Code

- Phase 7 is structurally the largest phase (8 new edge functions + significant frontend) but architecturally shallowest (no novel patterns; just activation of existing infrastructure and admin tooling). Plan more time for Checkpoint 4 (frontend) than for Checkpoint 3 (backend).
- The `effective_assignee_user_id` column is denormalized for performance. Keep it consistent with the source rows by always updating it whenever any source changes (new voluntary delegation, OOO declared/revoked, policy delegate activated, admin reassign). Consider a database trigger to recompute it, but evaluate whether the trigger logic is simpler than application-side updates first.
- The pure `resolveEffectiveAssignee` helper is the source of truth for who can act. The denormalized column should always match what this helper returns. Add a vitest assertion that proves consistency: for every chain step in the test fixtures, the column value equals what the pure helper returns.
- The `pending_since` column is only set when a step is the active "what we're waiting on." Steps in stages that haven't started yet have `pending_since = NULL`. Update `pending_since` when a stage advances to a new step_order and the prior steps are complete.
- Override and OOO declarations create audit-heavy activity log entries. Don't summarize — log every change with actor, target, reason, before/after.
- Reuse the same checkpoint cadence as Phase 6:
  - Checkpoint 1: Migration + types regen + audit
  - Checkpoint 2: Pure helpers + Deno mirror + vitest
  - Checkpoint 3: Edge functions + smoke
  - Checkpoint 4: Frontend (multiple new surfaces)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke
- Apply the Lifecycle Transition Convention to any transition triggered by override (an override that approves or rejects causes a status_change).
- Apply the Permissions Gating Convention rigorously — admin-only flows must use isAdminOrOwner consistently.
- Apply the Schema Change Rule.
- Reference `docs/PRODUCT_STRATEGY.md` — Phase 7 features are part of Pro tier (and inherited by Business via firm-aware RLS in Phase 9). Plus tier customers get a simplified subset (admin override only, no delegation).
- Do not introduce new dependencies.
- Be especially careful with the OOO activation logic. When a user declares OOO, the system must atomically: insert the OOO row, find affected steps, update each step's effective_assignee, log activity entries, and notify delegates. If any of these fails partway, the system can end up in a confusing state. Wrap in a transaction at the database level via an RPC if needed.
- The `process-delegate-timers` and `detect-stuck-chains` cron functions are similar to the Phase 5 reminder function pattern. Reuse the scheduling infrastructure. Document any new cron schedules in the same place as Phase 5's.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 5 close, citing this spec doc by SHA per the audit-doc inheritance rule.
