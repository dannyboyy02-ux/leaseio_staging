# Phase 0 deploy checklist — 2026-07-16

The Phase-0 safety/money fixes are committed to `claude/leaseio-end-to-end-review-163v6w`
but stay **inert on the live system** until the migrations are applied and the touched
edge functions redeployed. Everything here is code-committed + CI-validated
(migration-replay + tests). Apply in this order from a machine with the Supabase CLI
linked to project `wwkwoxxcprnjjufkbzac`.

## 1 — Apply migrations (order matters)

```
supabase db push
```

New migrations (all idempotent):
- `20260716120000_fix_lease_reports_storage_rls.sql` — #18 capture (lease-reports storage RLS; live already correct, this makes the repo faithful).
- `20260716130000_workspaces_first_workspace_only_insert.sql` — closes the free-workspace hole: client INSERT → `WITH CHECK (false)`; adds the advisory-locked `create_first_workspace()` RPC.
- `20260716140000_leases_user_id_set_null_on_profile_delete.sql` — `leases.user_id` FK CASCADE→SET NULL (+ nullable). **Cross-tenant data-loss fix.**
- `20260716150000_relax_actor_fks_set_null.sql` — relaxes ~51 actor/attribution `auth.users` FKs to SET NULL so account deletion completes. **Large: makes 15 columns nullable.** Review the migration-replay CI result before applying to prod.

## 2 — Regenerate types (after migrations apply)

```
supabase gen types typescript --project-id wwkwoxxcprnjjufkbzac > src/integrations/supabase/types.ts
```
(15 columns are now nullable + the `create_first_workspace` RPC is new — the generated types currently lie; regenerate and commit.)

## 3 — Redeploy the touched edge functions

```
supabase functions deploy \
  delete-lease restore-lease process-lease-retention \
  get-summary-by-token generate-summary-token \
  generate-lease-report generate-portfolio-report generate-workspace-asc842-report \
  process_lease \
  transfer-workspace-ownership \
  delete-account
```

Per-function reason:
- **delete-lease / restore-lease / process-lease-retention** — #164 liveness gates + Vault-preserve.
- **get-summary-by-token / generate-summary-token / generate-{lease,portfolio,workspace-asc842}-report** — #165 deleted-lease exposure.
- **process_lease** — P0-g (undefined jsonResponse, fail-closed quota, dead OpenAI removed). Also carries the #161 method-agnostic resolver (owed since 07-16) — same file.
- **transfer-workspace-ownership** — P0-e billing guard.
- **delete-account** — P0-d rebuild (needs migrations 140000 + 150000 applied FIRST).

## 4 — Frontend

Merging the branch to `main` auto-deploys the Vercel frontend (Onboarding RPC call,
TransferOwnershipDialog error surfacing, #161 dialogs). No manual step beyond the merge.

## 5 — Verify

- Onboarding a fresh account still creates the first workspace (now via the RPC).
- A 2nd browser-console `workspaces` insert is rejected (WITH CHECK false).
- Report PDF upload works (storage RLS).
- Delete a throwaway account that owns a workspace AND is a member elsewhere → succeeds, the other workspace's leases survive with a cleared uploader.

---
_Also still owed from earlier: the #161 redeploys (get-billing-summary, create-workspace, manage-document-pack) + the Stripe sandbox pack/annual/Vault prices (runbook Steps 3–5)._
