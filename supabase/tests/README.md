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
   - A **Supabase branch** of the prod project (`mcp__claude_ai_Supabase__create_branch` or via Studio → Branches), OR
   - A **local Supabase docker stack** (`supabase start`).
2. Apply the same migrations to it (the `supabase/migrations/` folder is the source of truth).
3. Run the test file:
   ```bash
   psql "$TEST_DATABASE_URL" -f supabase/tests/phase1_approval_policies.test.sql
   ```
   …or paste it into the Studio SQL editor for that environment.
4. Search the output for `FAIL` — empty result means everything passed.

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

## Frontend tests

For the **frontend** Phase 1 test cases (validation rules in the policy editor),
see `src/pages/settings/__tests__/approvalPolicyValidation.test.ts`. Run with
`npm test`.
