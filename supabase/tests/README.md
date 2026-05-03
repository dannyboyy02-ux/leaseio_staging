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

## Frontend tests

Pure unit tests, run via `npm test` (vitest):

- **Phase 1 validation rules** — `src/pages/settings/__tests__/approvalPolicyValidation.test.ts` (18 tests over the policy-editor save validation).
- **Phase 2 chain logic** — `src/lib/__tests__/approvalChainLogic.test.ts` (21 tests over the pure helpers shared between the Deno edge functions and Node mirror).

Combined frontend suite: 142+ tests, last green count documented in commit
history.
