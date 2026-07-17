# End-to-end plan deploy runbook — Phase 0 + Phase 1 (2026-07-16)

> **EXECUTED 2026-07-16 (same day, owner present — "im in").** Steps 1–3 are DONE:
> all 6 migrations applied via MCP `apply_migration` (verified object-by-object,
> incl. the FK self-verify), types regenerated + committed, and **64 functions**
> deployed via the linked CLI (the 17 below + every frontend-invoked function,
> because `_shared/cors.ts` gained `localhost:8080/:8081` and deployed copies
> bundle a frozen snapshot). Step 4 is HALF done: the cron IS scheduled
> (fail-closed) but the permission classifier blocked `supabase secrets set` —
> **owner still owes** `AUTO_NUDGE_CRON_SECRET` (edge secret + matching
> `private.cron_secrets` row `id='auto_nudge'`). Step 5 (frontend merge) executed
> immediately after. Step 6's approval-path smoke was run as a FULL LIVE
> SIMULATION: a real lease was driven submit → concept ×2 → negotiate (doc
> upload) → advance → sign (attestation) → counter-sign → **Finalize & activate**
> (real Opus abstraction; every extracted term correct; all 7 lifecycle
> transitions logged `routing_path: chain`). Evidence in the session transcript
> and `docs/KNOWN_ISSUES.md` ("Live end-to-end chain simulation 2026-07-16").

The whole ratified plan (Phase 0 safety/money + Phase 1 approval "seven wires")
is committed to branch `claude/leaseio-end-to-end-review-163v6w`, pushed, and
**green** (1519 tests, `npm run typecheck` clean). It is **NOT merged to `main`**
on purpose: the frontend calls new RPCs / edge-fn modes, so **order matters** —
migrations first, then edge-fn redeploys, then the frontend merge. Merging first
would break live onboarding + finalize. Everything below is inert on live until
this runbook is run from a machine with the Supabase CLI linked to
`wwkwoxxcprnjjufkbzac`.

Supersedes `PHASE0_DEPLOY_CHECKLIST_2026-07-16.md` (which covered only Phase 0).

---

## 1 — Apply migrations FIRST (`supabase db push`)

New this session (all idempotent; migration-replay CI-validated):
- `20260716120000_fix_lease_reports_storage_rls.sql` — #18 lease-reports storage RLS captured into the repo (live already correct).
- `20260716130000_workspaces_first_workspace_only_insert.sql` — closes the free-workspace hole: client `workspaces` INSERT → `WITH CHECK(false)` + the advisory-locked `create_first_workspace()` RPC (onboarding calls it).
- `20260716140000_leases_user_id_set_null_on_profile_delete.sql` — `leases.user_id` FK CASCADE→SET NULL (**cross-tenant data-loss fix** — must precede the delete-account redeploy).
- `20260716150000_relax_actor_fks_set_null.sql` — 51 actor/attribution `auth.users` FKs → SET NULL so account deletion completes (**15 columns made nullable** — review the replay result before prod).
- `20260716160000_workspaces_created_at_immutable.sql` — `created_at` immutable for non-service writers (grandfather-key for the monetization gate).
- `20260716170000_schedule_auto_nudge_cron.sql` — schedules the day-2/5/10 auto-nudge (fail-closed until the secret + `private.cron_secrets` row exist — see step 4).

## 2 — Regenerate types (after migrations apply)

```
supabase gen types typescript --project-id wwkwoxxcprnjjufkbzac > src/integrations/supabase/types.ts
```
(15 columns are now nullable + `create_first_workspace` is new — regenerate and commit.)

## 3 — Redeploy the touched edge functions

```
supabase functions deploy \
  delete-lease restore-lease process-lease-retention \
  get-summary-by-token generate-summary-token \
  generate-lease-report generate-portfolio-report generate-workspace-asc842-report \
  process_lease retry_lease \
  act-on-chain-step advance-to-final-review \
  dispatch-notifications send-nudge \
  transfer-workspace-ownership delete-account \
  auto-nudge-approvers
```
Per-cluster reason:
- **Phase 0:** delete-lease/restore-lease/process-lease-retention (#164 liveness + Vault-preserve); get-summary-by-token + the 3 report gens + generate-summary-token (#165 deleted-lease exposure); process_lease (P0-g + P0-h monetization gate via `_shared/monetization.ts` + #161 resolver); retry_lease (P0-h gate); transfer-workspace-ownership (P0-e billing guard); delete-account (P0-d rebuild — **needs migrations 140000+150000 applied first**).
- **Phase 1:** act-on-chain-step (signator gate + backward-arrow + F-2/F-4 notifications), advance-to-final-review (signator reactivation), process_lease (again — **finalize mode**, P1-5), dispatch-notifications + send-nudge (bundle the changed `_shared/notify_dispatch.ts` — signator deep-link + concept-cleared copy), **auto-nudge-approvers (NEW, P1-6)**.
- process_lease + retry_lease both bundle `_shared/monetization.ts`; deploy together so the never-subscribed gate stays in lockstep.

## 4 — New operator secret (P1-6 auto-nudge)

```
supabase secrets set AUTO_NUDGE_CRON_SECRET=<32+ char random>
```
```sql
INSERT INTO private.cron_secrets (id, value) VALUES ('auto_nudge', '<same value>')
  ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
```
Fail-closed: until BOTH exist, the scheduled POST carries a NULL header and the function 401s — nothing runs (no risk, just no auto-nudge).

## 5 — Frontend (merge branch → `main`)

Auto-deploys Vercel. Only AFTER steps 1–3 (the frontend calls
`create_first_workspace`, the finalize mode, the nudge, the truthful preview
RPC, etc. — all of which need the migrations + edge fns live). Open the app in a
fresh Incognito tab post-deploy to confirm first-visit load (stale-chunk check).

## 6 — Verify (smoke)

- Onboard a fresh account → first workspace created (RPC) → routed to checkout + 7-day trial. A 2nd browser-console `workspaces` insert is rejected.
- A never-subscribed workspace's upload shows the start-trial panel (not a generic error); after checkout, upload + retry succeed.
- Delete a throwaway account that owns a workspace AND is a member elsewhere → succeeds; the other workspace's leases survive with a cleared uploader.
- Report PDF upload works; a browser PATCH of `workspaces.created_at` is rejected.
- (Approval path) drive one chain lease submit → concept approve (requestor gets "cleared concept approval") → negotiate → advance → sign (queue "Review & Sign" → attestation) → counter-sign → **Finalize & activate** (lease abstracts + goes active). Nudge a stalled approver from the request/lease view.

---

## Still owner-owed beyond this runbook (pre-existing / unchanged)

- Stripe live-mode webhook destination + signing secret (OPERATOR_PLAYBOOK STOP 3), annual Price IDs (STOP 7), Vault Product/Price + `STRIPE_PRICE_VAULT_ANNUAL` + `VAULT_RENEWAL_CRON_SECRET` (STOP 10). All fail closed until done.
- Every money/billing surface still owes a real Stripe test transaction (incl. a Link/wallet method) before "done" per the CLAUDE.md Definition-of-Done gate.
- Rendered persona walkthroughs (the plan's DoD) for the Phase-1 surfaces need a logged-in session — I could not run them (no credentials; never authenticate). They're the last verification lane before you rely on these in front of a customer.
