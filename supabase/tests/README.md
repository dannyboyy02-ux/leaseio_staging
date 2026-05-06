# Supabase tests

SQL test files that exercise database constraints, RLS policies, and RPCs.
Each file is a standalone script that prints `PASS` / `FAIL <reason>` lines for
every assertion.

## How to run

These tests **MUST NOT** be run against the main production project. They
create transient workspaces, users, and policies, and they synthesize JWT
claims via `set_config('request.jwt.claims', ...)` to simulate auth contexts.

Recommended path:

1. Spin up an isolated test database — either:
   - A **Supabase branch** of the prod project (`mcp__claude_ai_Supabase__create_branch` or via Studio → Branches; **Pro plan required**), OR
   - A **local Supabase Docker stack** (`supabase start`), OR
   - A **dedicated staging Supabase project** (separate `project_id`).
2. Apply the same migrations to it (the `supabase/migrations/` folder is the source of truth).
3. Run the test file you need:
   ```bash
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase1_approval_policies.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase2_lease_approval_chain.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase3_lifecycle_expansion.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/owner_workspace_mgmt.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase4_lease_documents.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase5_signator_activation.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase6_chain_rerouting.test.sql
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase7_delegation_override.test.sql
   ```
   …or paste into the Studio SQL editor for that environment.
4. Search the output for `FAIL` — empty result means everything passed.

**Status (2026-05-03):** the live project is on the free tier, so branch creation
requires a Pro upgrade. Both test files are committed and ready; first execution
will land whenever a non-prod environment is available (Phase 3 setup, on-demand
upgrade, or local Docker run).

## What each file covers

### `phase1_approval_policies.test.sql`

14 tests for the Phase 1 approval-policies schema:

| # | Test | Checks |
|---|---|---|
| 1 | Idempotency | Re-running the migration is a no-op (`IF NOT EXISTS`, `DROP IF EXISTS`, `OR REPLACE` clauses do their job) |
| 2 | Dual-default rejection | Inserting two `is_default_fallback = true` in the same workspace fails (partial unique index) |
| 3 | Default toggle | Deactivating one default and activating another succeeds |
| 4 | `cost_range_valid` CHECK | Rejects min > max |
| 5 | `one_assignee_method` (both) | Rejects step with both `approver_user_id` and `approver_role` set |
| 6 | `one_assignee_method` (neither) | Rejects step with neither set |
| 7 | `preview_policy_resolution` no-match | Returns `matched: false` with helpful error when no policies + no fallback |
| 8 | `preview_policy_resolution` fallback | Returns the default fallback when nothing specific matches; warning included |
| 9 | `preview_policy_resolution` priority | Highest priority wins among multiple matches |
| 10 | `preview_policy_resolution` chain order | Chain returned ordered by stage, then step_order, then parallel_group |
| 11 | `apply_policy_steps` atomic | Replaces all steps in one shot |
| 12 | `apply_policy_steps` unauthorized | Outsider gets `Forbidden` |
| 13 | RLS cross-workspace | Outsider cannot read or write another workspace's policies |
| 14 | RLS member read-only | Non-admin member can read but not write |

### `phase2_lease_approval_chain.test.sql`

21 tests for the Phase 2 chain table, RLS, edge-function-equivalent SQL behavior,
and the Lifecycle Transition Convention:

| # | Test | Checks |
|---|---|---|
| 1 | `chain_assignee_present` user-only | INSERT with only `approver_user_id` set succeeds |
| 2 | `chain_assignee_present` role-only | INSERT with only `approver_role` set succeeds |
| 3 | `chain_assignee_present` neither | INSERT with neither set rejected |
| 4 | `stage` CHECK | `concept` and `signator` accepted; bogus value rejected |
| 5 | `status` CHECK | All 7 enum values accepted; bogus value rejected |
| 6 | RLS member read | Workspace member sees chain rows for own workspace |
| 7 | RLS cross-workspace blocked | Outsider sees zero rows |
| 8 | RLS assignee acts on own pending | Outsider blocked, assignee succeeds |
| 9 | RLS WITH CHECK blocks assignee writing `superseded` | Only the service role / edge function may write that status |
| 10 | RLS admin update any | Workspace admin can update any chain row in workspace |
| 11 | resolve: single match | One matching policy → all policy steps inserted as chain rows with snapshotted `policy_id` + `policy_version` |
| 12 | resolve: ambiguous match | Two policies tied at top priority → caller produces zero chain rows |
| 13 | resolve: no_match_no_fallback | Workspace has policies but none match and no default fallback → caller produces zero chain rows |
| 14 | resolve: fallback | No specific match + active default fallback → fallback policy wins |
| 15 | resolve: separation_violation | Same user in two user-based steps with SoD effective → caller produces zero chain rows |
| 16 | resolve: legacyFallback | Workspace has zero policies → resolver returns `legacyFallback: true` |
| 17 | resolve: idempotent | initialResolution=true with chain already present → second call is a no-op |
| 18 | act approve + stage complete + Lifecycle Transition Convention | Approving the only required concept step flips lifecycle submitted→under_review, bumps `status_changed_at`, writes a `status_change` log row with both `from_status`/`to_status` columns AND nested `from`/`to` inside `details`, plus `routing_path:'chain'` |
| 19 | act reject + supersede remaining | Reject flips lifecycle to rejected and supersedes all remaining pending chain steps |
| 20 | act send_back + scoped supersede | Send_back flips lifecycle to submitted and supersedes ONLY current-stage pending steps; other-stage pending steps remain |
| 21 | Phase 2 activity_type values | All 6 chain_* values accepted by `lease_activity_log_activity_type_check` |

The "edge-function-equivalent" tests (11-20) reproduce the SQL the edge functions
issue (resolve-approval-chain's transactional chain INSERT, act-on-chain-step's
`updateLifecycle` and `logStatusChange` helpers) inside the SQL test file, so
the data-layer behavior is verified end-to-end without spinning up the Deno
runtime. Function-level tests (CORS, auth gates, rate limit) are exercised
via curl smoke tests in the deployed app.

### `owner_workspace_mgmt.test.sql`

5 tests covering the Owner Workspace Management feature:

| # | Test | Checks |
|---|---|---|
| 1 | `deleted_workspaces` accepts service-role insert with full audit shape (10-column row landed) |
| 2 | RLS scoping — owner sees own audit row; outsider sees zero (simulated via `set_config('request.jwt.claims', ...)`) |
| 3 | `DELETE FROM leases` cascades to lease-child tables (verified on `lease_activity_log`) |
| 4 | End-to-end edge-function-equivalent sequence: delete leases → delete workspace → insert audit. Zero orphans across `workspaces`, `leases`, `workspace_members`, `workspace_roles`, `invite_tokens`, `approval_policies`, `lease_activity_log`, `lease_approval_chain` (both via lease_id and via workspace_id) |
| 5 | Confirms the FK trap the edge function defeats: deleting the workspace WITHOUT deleting leases first leaves a `workspace_id = NULL` orphan (the lease survives, hidden by RLS but still in the DB consuming storage) — proves why the explicit-leases-first ordering matters |

### `phase4_lease_documents.test.sql`

9 tests covering the Phase 4 negotiation document tracking schema + trigger + storage RLS:

| # | Test | Checks |
|---|---|---|
| 1 | document_type CHECK accepts all 11 spec values | concept_attachment, loi, draft, redline, counter_redline, final_negotiated, our_signed, fully_executed_counterparty_returned, amendment, side_letter, other |
| 2 | document_type CHECK rejects unknowns | uppercase, invented values, empty string |
| 3 | is_current_latest unique partial index prevents two latest | UPDATE attempt to set old row latest while newer is latest fails with unique_violation |
| 4 | lease-documents storage bucket exists | private + 50MB limit confirmed |
| 5 | AFTER INSERT trigger promotes new row + demotes prior latest | inserts 3 rows; row1 demoted by row2, row2 demoted by row3, row3 latest with null superseded_by/at |
| 6 | Exactly one is_current_latest row per lease at all times | 5 sequential inserts → exactly 1 latest count |
| 7 | activity_type CHECK accepts the 5 Phase 4 values + preserves all 36 prior values | regression check covering pre-Phase-2 + Phase 2 + Phase 3 |
| 8 | Storage RLS uses path-prefix workspace check | introspection of storage.foldername in upload/read/delete policies (post-fix migration) |
| 9 | lease_documents RLS scoping | owner sees own; outsider workspace member sees zero (simulated via set_config request.jwt.claims) |

### `phase7_delegation_override.test.sql`

6 tests covering the Phase 7 delegation, override, and exception schema deltas:

| # | Test | Checks |
|---|---|---|
| 1 | Schema shape | 3 new tables (`user_out_of_office`, `chain_step_overrides`, `chain_step_voluntary_delegations`); 4 new chain columns (`pending_since`, `delegate_activated_at`, `effective_assignee_user_id`, `assignee_resolution_source`); 4 new CHECK constraints; OOO updated_at trigger present |
| 2 | OOO CHECK constraints | `ooo_valid_window` rejects starts >= ends; `ooo_no_self_delegation` rejects user_id == delegate_user_id; valid distinct-window OOO accepted |
| 3 | chain_step_overrides CHECKs | `length(trim(reason)) >= 20` enforced (rejects 9 chars, accepts 20 boundary, rejects whitespace-padded short); 5 valid override_action enum values accepted; bogus action rejected |
| 4 | Voluntary delegation + assignee source | `vd_no_self_delegation` rejects same delegated_by/delegated_to; valid distinct vd accepted; 6 valid assignee_resolution_source values accepted; NULL accepted (pre-Phase-7 rows); bogus source rejected |
| 5 | Phase 7 activity types + cross-phase regression | All 13 Phase 7 values accepted; 17 representative prior values from legacy / Phases 2-6 still accepted |
| 6 | Migration idempotency sentinel | `ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` re-runs are no-ops |

### `phase6_chain_rerouting.test.sql`

6 tests covering the Phase 6 chain rerouting schema, trigger, and activity-type vocabulary:

| # | Test | Checks |
|---|---|---|
| 1 | Schema shape | `leases.reroute_evaluation_pending` column (boolean NOT NULL DEFAULT false); `lease_attribute_snapshots` and `lease_reroute_events` tables exist; 3 new indexes present (snapshots chronological, reroute events chronological, reroute events partial-index for `resulted_in_chain_violation`); `detect_lease_attribute_change` function + `leases_detect_attribute_change` trigger present |
| 2 | Trigger semantics | Chain-driven non-terminal lease + policy-attribute change → flag=true + `attribute_change_detected` audit row written; legacy lease (no chain rows) → flag stays false, no audit row; terminal-state lease (rejected) → flag stays false, no audit row |
| 3 | Trigger ignores non-policy attribute changes | Updating `notes` (not in the 5 policy-triggering attributes) on a chain-driven lease leaves flag=false, no audit row |
| 4 | `detection_mode` CHECK | Accepts the 3 valid values (auto, manual_admin, manual_audit); rejects bogus values |
| 5 | Phase 6 activity types + cross-phase regression | All 9 Phase 6 activity types accepted (attribute_change_detected, chain_rerouted, chain_reroute_skipped_no_match, chain_violation_entered, chain_violation_resolved, reroute_audit_run, manual_reroute_requested, manual_reroute_approved, manual_reroute_rejected); 16 representative prior values from legacy + Phases 2-5 still accepted |
| 6 | Migration idempotency sentinel | `ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` re-runs are no-ops |

### `phase5_signator_activation.test.sql`

6 tests covering the Phase 5 signator activation + counter-signature schema deltas:

| # | Test | Checks |
|---|---|---|
| 1 | New lease columns shape | `signator_attestation` (text), `counter_signature_due_date` (date), `counter_signature_reminder_count` (integer NOT NULL DEFAULT 0) |
| 2 | `counter_signature_default_due_days` default + bounds | Default = 21; CHECK accepts 1, 21, 365; rejects 0, 366, -1 |
| 3 | `leases_signator_attestation_required` row-level CHECK | Both NULL accepted; both populated accepted; approved_at + NULL/empty/whitespace attestation rejected; NULL approved_at + populated attestation accepted (constraint is one-directional) |
| 4 | Phase 5 activity types accepted + prior values regression | 7 Phase 5 values + representative prior values (legacy, Phase 2, Phase 3, Phase 4) all pass |
| 5 | `counter_signature_reminder_count` defaults + NOT NULL | Default = 0; updates stick; NULL rejected |
| 6 | Migration idempotency sentinel | `ADD COLUMN IF NOT EXISTS` re-runs are no-ops on lease + workspace columns |

### `phase3_lifecycle_expansion.test.sql`

6 tests covering the Phase 3 lifecycle vocabulary expansion + new lease columns:

| # | Test | Checks |
|---|---|---|
| 1 | `lifecycle_status` accepts all 16 values | 9 legacy + 7 chain values all pass the CHECK constraint |
| 2 | `lifecycle_status` rejects unknown values | `needs_review`, `failed`, casing variants, empty string all rejected |
| 3 | 5 new lease columns (`concept_approved_at`, `signator_approved_at`, `counter_signed_at`, `fully_executed_at`, `execution_owner_id`) accept null and valid values; `execution_owner_id` enforces the `auth.users` FK |
| 4 | 6 Phase 3 `activity_type` values accepted (`concept_stage_entered`, `concept_stage_completed`, `negotiation_stage_entered`, `final_review_stage_entered`, `pending_counter_signature_started`, `fully_executed_recorded`) |
| 5 | All 30 pre-existing `activity_type` values still accepted (24 pre-Phase-2 + 6 Phase 2) — guards against regression of downstream writers |
| 6 | All 9 legacy `lifecycle_status` values still accepted — guards against regression of legacy paths |

## Frontend tests

Pure unit tests, run via `npm test` (vitest):

- **Phase 1 validation rules** — `src/pages/settings/__tests__/approvalPolicyValidation.test.ts` (18 tests over the policy-editor save validation).
- **Phase 2 chain logic** — `src/lib/__tests__/approvalChainLogic.test.ts` (21 tests over the pure helpers shared between the Deno edge functions and Node mirror).
- **Phase 3 lifecycle states** — `src/lib/__tests__/lifecycleStates.test.ts` (26 tests over `displayLabel`/`groupOf`/`isEquivalent`/`canTransition`/transition-graph lock).
- **Phase 3 submission decision** — `src/lib/__tests__/leaseSubmissionDecision.test.ts` (16 tests over the pure helper that decides post-resolution flip; covers the 4 LeaseRequestForm scenarios: chain success, legacy fallback, ambiguous match, network error).

Combined frontend suite: 184 tests as of Phase 3 closeout.
