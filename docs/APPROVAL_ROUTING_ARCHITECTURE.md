# LeaseIO — Configurable Approval Routing Architecture

**Status:** Architecture defined. Implementation in phases.
**Owner:** Daniel
**Audience:** Claude Code, future contributors

This document explains the full architecture for LeaseIO's lease approval workflow. It is the source of truth for the design — phase-specific build specs reference this document for context.

---

## Why this exists

The original LeaseIO approval model used fixed roles (`manager_approver`, `financial_approver`) and notified everyone in those roles in parallel when a lease request was submitted. That model breaks for any organization where the right approver depends on the lease itself — its asset type, the requesting department, the dollar amount, the region, or some combination.

A single request might need:
- Department head approval for any concept under $50K
- Department head AND finance director for $50K–$500K
- Department head, finance director, AND legal for over $500K
- A CFO signator under $1M, a CEO signator above $1M

These rules are workspace-specific. They cannot be hardcoded. They must be admin-configurable and they must resolve dynamically at submission time.

---

## Core concepts

### Approval policies, not approval roles

Workspace admins define **policies**. Each policy has matching criteria (asset type, department, dollar threshold, region, etc.) and a chain of required approval steps. When a lease request is submitted, the system evaluates the request against the policies and resolves the most specific matching policy into a concrete approval chain for that lease.

### Two-stage approval gate

Every lease request passes through two distinct approval stages:

1. **Concept approval** — should we pursue this lease at all? Approver(s) review the request before any document exists. May require multiple parallel or sequential approvers.
2. **Signator approval** — final binding approval. The signator is the person with authority to commit the company. Different criteria, different artifacts (the negotiated document), different person.

Between these two stages is a **negotiation loop** where documents flow back and forth between the submitter and the counterparty. After signator approval comes a **pending counter-execution** stage, then **fully executed**, then **active**.

### Chains resolve at submission, reroute on material change

When a request is submitted, the system snapshots which policy applies and writes the resolved chain to the database. The chain is not re-evaluated unless a **policy-triggering attribute** changes. If, during negotiation, the negotiated annual cost crosses a threshold that triggers a different policy, the chain is rerouted.

Rerouting can:
- Add new approvers who must now approve
- Roll the lease back to the earliest stage where a newly-required approver hadn't yet signed off
- Preserve prior approvals where they still apply
- Generate audit trail entries showing exactly what changed and why

### Admin-controlled separation of duties

Whether a single user can fill multiple roles in a chain (e.g., concept approver + signator) is an admin decision, not a system rule.

- **Workspace default** — boolean setting. Default is "require distinct users."
- **Per-policy override** — each policy can override the workspace default for its specific case.

This gives admins room for nuance: allow combined roles for low-dollar leases where one person handles everything, but force separation on high-dollar leases regardless of the workspace default.

---

## Lifecycle states

The full lifecycle the data model must support:

```
draft
  ↓
concept_submitted
  ↓
concept_under_review
  ↓ (approve)        ↓ (reject)         ↓ (send_back)
in_negotiation       concept_rejected   concept_submitted
  ↓                  (terminal/revise)  (revise concept)
  ↓ (loop with documents — multiple passes possible)
  ↓ (submitter advances)
final_review
  ↓ (approve)         ↓ (reject)         ↓ (send_back)
pending_counter_signature  final_rejected  in_negotiation
  ↓ (counter-signed)  (terminal/revise)   (renegotiate)
fully_executed
  ↓ (verification)
active (model_locked)
  ↓ (post-active governance handles changes from here)
```

Additional terminal/exception states:
- `cancelled` — submitter or admin cancels at any stage
- `expired` — active lease past its end date
- `chain_violation` — post-execution rerouting detected a gap; requires retroactive approval

---

## The negotiation loop

The negotiation stage (`in_negotiation`) is the most loosely structured but the most active. The submitter is going back and forth with the counterparty. Documents fly. Versions multiply.

What the system must capture:

- Every document exchanged, with version number, iteration number, document type (LOI, draft, redline, counter, final_negotiated, our_signed, fully_executed), and who uploaded it when.
- The submitter's ability to escalate back to a concept approver if material terms have shifted from the original ask. This is a manual decision by the submitter, not automatic — though policy rerouting (above) can also force it.
- The submitter's eventual decision that "we're ready" — which moves the lease to `final_review` and pushes it to the signator.

There is no system-imposed limit on the number of negotiation passes.

---

## Roles and assignments

Existing functional roles in `workspace_roles`:
- `submitter`
- `manager_approver` (legacy — to be deprecated as policies replace fixed-role notification)
- `financial_approver` (legacy — same)
- `admin`

New role to add:
- `signator` — distinct from financial approver. The person whose signature legally binds the company.

New per-lease assignment field:
- `execution_owner_id` — the person responsible for chasing counter-signature and uploading the fully-executed document. May be the submitter, may be someone else assigned at the start of the `pending_counter_signature` stage.

---

## Schema overview

This is the architectural picture. Phase-specific specs cover the actual migration files.

### `approval_policies`
- `id` (uuid)
- `workspace_id` (fk)
- `name` (text — admin-friendly label)
- `description` (text — admin notes)
- `priority` (int — higher wins when multiple policies match)
- `match_asset_types` (text[] — empty = any)
- `match_departments` (text[] — empty = any)
- `match_min_annual_cost` (numeric — null = no min)
- `match_max_annual_cost` (numeric — null = no max)
- `match_regions` (text[] — empty = any)
- `match_lease_types` (text[] — empty = any)
- `separation_of_duties_override` (boolean nullable — null = inherit workspace default)
- `is_default_fallback` (boolean — exactly one per workspace)
- `version` (int — incremented on every edit; used for snapshotting)
- `is_active` (boolean)
- `created_at`, `updated_at`, `created_by`, `updated_by`

### `approval_chain_steps`
- `id` (uuid)
- `policy_id` (fk)
- `stage` (enum — `concept` | `signator`)
- `step_order` (int — 1, 2, 3 for sequential)
- `parallel_group` (int — same group within same step_order = parallel)
- `approver_user_id` (fk to auth.users — specific user)
- `approver_role` (text — alternative: any user with this functional role qualifies)
- `delegate_user_id` (fk to auth.users — backup approver)
- `delegate_after_days` (int — null = no auto-delegate)
- `is_required` (boolean)

Either `approver_user_id` OR `approver_role` is set, not both.

### `lease_approval_chain`
- `id` (uuid)
- `lease_id` (fk)
- `policy_id` (fk to approval_policies)
- `policy_version` (int — snapshot)
- `stage` (enum)
- `step_order` (int)
- `parallel_group` (int)
- `approver_user_id` (fk — concrete user resolved from the policy step)
- `delegate_user_id` (fk — concrete delegate if any)
- `status` (enum — `pending` | `approved` | `rejected` | `sent_back` | `superseded` | `delegated`)
- `action_at` (timestamptz)
- `action_by` (fk — who actually took the action; may differ from approver_user_id if delegate acted)
- `comment` (text)
- `rerouted_from_chain_id` (uuid nullable — references prior chain when rerouting occurs)
- `created_at`

### `lease_documents`
- `id` (uuid)
- `lease_id` (fk)
- `document_type` (enum — `concept_attachment` | `loi` | `draft` | `redline` | `counter_redline` | `final_negotiated` | `our_signed` | `fully_executed`)
- `version_number` (int — sequential per lease)
- `iteration_number` (int — sequential per negotiation pass)
- `storage_path` (text)
- `filename` (text)
- `mime_type` (text)
- `uploaded_by` (fk)
- `uploaded_at` (timestamptz)
- `notes` (text)

### Workspace-level addition
- `workspaces.separation_of_duties_default` (boolean, default true)

### Lease-level additions
- `leases.execution_owner_id` (fk to auth.users)
- `leases.concept_approved_at` (timestamptz)
- `leases.signator_approved_at` (timestamptz)
- `leases.counter_signed_at` (timestamptz)
- `leases.fully_executed_at` (timestamptz)

### Activity log additions

New activity types in the existing `lease_activity_log.activity_type` check constraint:
- `concept_approved`, `concept_rejected`, `concept_sent_back`
- `negotiation_document_uploaded`
- `negotiation_escalated_to_concept`
- `submitted_for_signator`
- `signator_approved`, `signator_rejected`, `signator_sent_back`
- `pending_counter_signature_started`
- `counter_signed_uploaded`
- `chain_rerouted`
- `chain_violation_detected`
- `policy_override`

---

## Resolution logic

When a request is submitted (or a policy-triggering attribute changes on a lease), the resolution function runs:

1. Query `approval_policies` for the workspace where `is_active = true`
2. Filter to policies whose match criteria are satisfied by the current lease attributes
3. Sort matched policies by `priority` descending
4. If multiple policies tie at top priority → error: admin must disambiguate
5. If no policy matches → use the workspace's `is_default_fallback = true` policy
6. If still no match → block submission with a clear error
7. Resolve the chain:
   - For each `approval_chain_steps` row of the selected policy
   - If `approver_user_id` is set, use that user
   - If `approver_role` is set, the chain is resolved at action time (anyone with that role can act) — but a specific assignee may still be picked at submission for notification
8. Check separation of duties:
   - Determine effective rule: policy override > workspace default
   - If "require distinct users" and the resolved chain has duplicates → error to admin
9. Snapshot the policy version into `lease_approval_chain.policy_version`
10. Insert one row per resolved step into `lease_approval_chain` with status `pending`
11. Notify the appropriate approvers for the first active step

When rerouting:
1. Re-run resolution
2. Compare new chain against existing chain
3. Mark superseded rows as `superseded` (don't delete — preserve history)
4. Insert new rows for the new chain, with `rerouted_from_chain_id` pointing to the prior chain_id
5. Determine the earliest stage requiring action under the new chain
6. Roll lifecycle status back to that stage if necessary
7. Log `chain_rerouted` activity with full diff

---

## Edge cases the architecture handles

**Approver leaves the company.** The user record stays but is deactivated. Admin must update affected policies. A nightly check surfaces broken policies (referencing deactivated users) to admins.

**Approver is on vacation.** Each chain step can have a `delegate_user_id` and `delegate_after_days`. After N days of inaction by the primary, the delegate is notified and can act in their place.

**Policy edited mid-flight.** Existing chains snapshot the policy version at resolution time. Edits to the policy don't affect in-flight leases unless a triggering attribute change forces re-resolution.

**Admin override.** An admin can force-approve any step by manually transitioning the lease. This generates a `policy_override` activity log entry with the admin's ID and a required override reason. These are visible on the audit trail and on the final ASC 842 report.

**Post-execution discovery of chain violation.** If rerouting after execution detects a gap, the lease enters `chain_violation` status. The missing approvers must approve retroactively. The violation is logged and surfaces on the ASC 842 report.

**Submitter underestimates cost to get lighter approval.** Reroute kicks in when corrected. Admins get a metric: estimate-vs-final variance by submitter. Transparency, not punishment.

**Signator and concept approver are the same person.** Allowed only if separation of duties is permitted (workspace default or policy override). Otherwise blocked at policy save time and at chain resolution time.

---

## What gets built when

**Phase 1 — Policy editor UI** (see `PHASE_1_BUILD_SPEC.md`) — **CLOSED.**
Admin-facing UI for creating, editing, deleting, and previewing policies. No runtime integration. Purely the data model and the admin tool to populate it.

**Phase 2 — Resolution engine and chain table** (see `PHASE_2_BUILD_SPEC.md`) — **CLOSED 2026-05-03.**
The `resolve-approval-chain` and `act-on-chain-step` edge functions. The `lease_approval_chain` table. Triggered on lease request submission. Notifies resolved approvers via the unified inbox in `ApprovalQueue.tsx`. Workspaces without policies fall back to the legacy parallel-notify flow. Lifecycle transitions enforce the Lifecycle Transition Convention (see `CLAUDE.md`). See the spec's As-Built Notes for implementation deltas (insert-as-draft-first, lifted `notifyRoleHolders`, etc.).

**Phase 3 — Lifecycle expansion**
New lifecycle states (`concept_submitted`, `concept_under_review`, `in_negotiation`, `final_review`, `pending_counter_signature`, `fully_executed`). Migration of existing data. Updated transition logic.

**Phase 4 — Negotiation loop**
The `lease_documents` table. UI for uploading, versioning, and tracking documents during negotiation. Submitter-driven escalation to concept approver.

**Phase 5 — Signator stage**
New `signator` role. Final review UI. Pending counter-signature handling. Execution owner assignment. Counter-signed document upload.

**Phase 6 — Rerouting**
Material attribute change detection. Re-resolution. Chain supersession. Rollback logic. Full audit trail.

**Phase 7 — Delegation, override, and exception handling**
Delegate timing and notifications. Admin override flow. `chain_violation` detection and resolution.

**Phase 8 — ASC 842 report integration**
Surface chain history, overrides, and violations on the report deliverable.

---

## Principles to preserve through implementation

1. **The user is in the loop.** Every material decision has a human attestation logged.
2. **Liability stays with the user.** LeaseIO produces data, not financial outputs. Audit trails prove who confirmed what when.
3. **Admins control the rules.** No hardcoded approval logic. Everything routes through policies.
4. **History is never destroyed.** Superseded chains, prior policy versions, and overridden actions are preserved for audit, not deleted.
5. **Errors surface fast.** Policy gaps, broken assignees, and ambiguous matches throw at the earliest possible moment, not silently at runtime.
