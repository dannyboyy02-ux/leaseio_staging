# LeaseIO Platform Hygiene + Security Posture + Docs Drift — Audit Report

Reviewer lane: platform hygiene / security posture / docs drift.
Repo: `/home/user/leaseio_staging`, branch `claude/leaseio-end-to-end-review-163v6w` (HEAD `fd31dfe`). Date: 2026-07-03.
Method: code-first. Every claim carries file:line evidence; where something could not be verified from the repo (live DB / deployed-function / GitHub-secrets state), that is said explicitly.

---

## 1. KNOWN_ISSUES.md triage (docs/KNOWN_ISSUES.md, 2,766 lines)

### 1.1 Counts

The tracker holds **148 numbered `### Item #N` sections** (#12–#159), plus **11 legacy `## N.` items** (#1–#11), plus **13 lettered cluster items** (A1–A11, B1–B2) — ~172 tracked items total.

- **Numbered items containing a RESOLVED/WONTFIX stamp: 56 of 148** (script-classified; several are only *partially* resolved — #45, #103, #105, #111, #125, #126, #147 have explicit open halves).
- **Numbered items with no RESOLVED mention: 92 of 148** — the honest "open" ledger, though at least two of those (#16, #17) were actually closed by committed migrations and never stamped (see §1.3 and Docs Drift D5).
- Legacy #1–#6, #9, #10 resolved in reconciliation blocks (KNOWN_ISSUES.md:75–125, :319–345); #7, #8, #11 still open (low).
- Cluster A: A1–A6, A11 resolved (some **pending live edge deploy**, KNOWN_ISSUES.md:12); A7 (Medium), A8, A9, A10 open (KNOWN_ISSUES.md:16,31–34). Cluster B: B1/B2 resolved in code, **deploy/secret still owed** (KNOWN_ISSUES.md:42–48).

Net: **~95–100 genuinely open items**, the large majority Low/Medium polish or deferred-by-design. What matters is the small set below.

### 1.2 Top 12 open items by real risk (my own severity re-assessment)

| # | Item | Filed sev | My sev | Why |
|---|---|---|---|---|
| 1 | **Operator deploy gap: `resolve-approval-chain` redeploy (= #84 + #111-C1 + Cluster A #A1/#A4)** | High | **CRITICAL (unverified live)** | The repo's function does the server-side Path-1 lifecycle flip + Phase-7 columns (`supabase/functions/resolve-approval-chain/index.ts`, 4 refs to `effective_assignee_user_id`); the client no longer flips (`LeaseRequestForm.tsx` writes only the `created` row per KNOWN_ISSUES.md:12). `docs/DEPLOY_RUNBOOK_2026-06-18.md:40-50` marks the redeploy "⏳ NOT DONE" and no later doc records it done. If the merged frontend has deployed (Vercel CI/CD from main) while the deployed function is still the pre-#84 snapshot, **every new Path-1 submission strands in `draft`** — the exact bug Cluster A fixed. Must be verified against the live project first. |
| 2 | **#18 — lease-reports storage RLS uses `foldername(w.name)`** (KNOWN_ISSUES.md:586-650) | High | **HIGH** | The INSERT/UPDATE storage policies compare against the workspace *display name*, so they effectively `WITH CHECK (false)` for client uploads. Open since 2026-05-16 with an explicit unresolved either/or: report generation silently failing for all users, or storage RLS being bypassed. Neither branch is acceptable; needs the 10-minute live verification the item itself prescribes. No fixing migration exists in `supabase/migrations/` (verified: no later policy touches `lease-reports`). |
| 3 | **B1/Phase-3 redeploys owed: `process_lease` + `retry_lease` + `vendor-health-check`** | — | **HIGH** | `docs/LEASES_REDESIGN_DEPLOY_2026-06-25.md:23-24,86-88` marks them "STILL OWED via CLI". The repo copies filter soft-deleted leases from the active-cap count (`process_lease/index.ts:1085`) and stamp `processing_started_at`; the deployed copies (per the doc) do neither, so deleted leases don't free slots and the B2 retry-race fix is inert for new retries. |
| 4 | **Cron secrets unset — 4 deployed safety nets fail-closed** | — | **HIGH (aggregate)** | `RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET` (KNOWN_ISSUES.md:48 — zombie 60-day "Processing" leases never reclaimed), `LEASE_RETENTION_CRON_SECRET` (LEASES_REDESIGN_DEPLOY:29-31 — purge inert), `NOTIFICATION_DISPATCH_CRON_SECRET` (#109, KNOWN_ISSUES.md:2099 — **approval/nudge emails still deliver nothing in prod**), `FIRM_BILLING_CRON_SECRET` (#107, KNOWN_ISSUES.md:2052). All fail closed (good), but the features they activate are the ones users already reported broken. |
| 5 | **#65 + #138 — doc-pack webhook drops a paid grant on missing `workspace_id` metadata; no paid-event reconcile sweep** (KNOWN_ISSUES.md:1502-1523) | Low/– | **MED-HIGH (money)** | Partially mitigated by billing dead-letters (`20260622000000/…010000/…020000`); the #138 reconciliation half is open — a paid Stripe event that dead-letters still requires a human to notice. |
| 6 | **#86 — stripe-webhook trusts frozen `metadata.plan_id` over the live price** (KNOWN_ISSUES.md:1777-1786) | Medium | **MEDIUM** | Entitlement drift if a sub's price is changed in the Stripe dashboard; billing boundary. |
| 7 | **#61 — create-checkout resolves the Stripe customer by caller email** (KNOWN_ISSUES.md:1450-1463) | Medium | **MEDIUM** | The P2-07 class re-surfacing; can attach a checkout to the wrong customer for shared/recycled emails. |
| 8 | **#35 + #36 + #67 — extraction pipeline: non-atomic rent-schedule rebuild; TOCTOU quota COUNT; retry has no quota gate** (KNOWN_ISSUES.md:1057-1084, 1538-1546) | Medium | **MEDIUM** | #35 can wipe a confirmed rent schedule on partial failure (data loss on the system-of-record surface); #36/#67 are bounded cost-bypass races. |
| 9 | **Audit-attribution cluster: #90-NULL residual, #95 (no smoke key for the activity-log INSERT policy), #96 (`transitioned_by` NULL for all service-role flips)** (KNOWN_ISSUES.md:1819-1832, 1881-1898) | Medium | **MEDIUM** | For a product whose premise is "audit-defensible repository," forgeable NULL-attributed comment rows + a secondary audit table with no actor on every server flip is a coherence gap. |
| 10 | **#159 + #28 — `lease_change_sets` INSERT RLS open to any member** (KNOWN_ISSUES.md:2756-2765, 822-842; policy at `20260516120000_baseline_schema.sql:4534` — verified) | Medium | **MEDIUM** | Direct PostgREST insert bypasses `createDraftChangeSet` → no `change_set_created` audit row. #158's unique index closed the duplicate-set symptom but not the unaudited path. |
| 11 | **#14 — `reroute-audit-sweep` + `process-pending-reroute-evaluations` never scheduled** (KNOWN_ISSUES.md:436-478) | Med-deferred | **MEDIUM** | Verified: the only `cron.schedule` calls in migrations are cancellation-lifecycle, dispatch-notifications, reclaim-stuck-extractions, lease-retention (`grep cron.schedule supabase/migrations/`). Phase-6 pending reroute evaluations sit unprocessed unless manually invoked. Open since 2026-05-07. |
| 12 | **#157 + #145 — LeaseReview `h-screen` shell clipped under any banner; no mobile sidebar collapse** (KNOWN_ISSUES.md:2726-2737, 2558-2570) | High/High | **HIGH (UX)** | #157 hits exactly quota-warned paying users and Vault owners; #145 makes the app unusable <640px. Both pre-existing, both filed honestly, neither scheduled. |

Honorable mentions: **#98** (CI actions pinned to Node 20 — GitHub forced Node 24 default started **2026-06-16**, removal 2026-09-16; ci.yml:30,33,96 still on @v4/@v1 with `node-version: 20` — this is now a live time-bomb, not a future one), **#102** (verified still present — see §2), **#116-family DF2** (#117: executed-upload variance has no server-side materiality gate — a hard-rule-#2 tension), **#107 remaining operator half**.

### 1.3 Tracker hygiene findings

- **#16 and #17 read as open Criticals but are fixed.** Their sections still say "Decision: Filed not fixed" (KNOWN_ISSUES.md:558-560, 584) with Critical severity, yet `supabase/migrations/20260516130000_restore_governance_hardening.sql:44-67` restores exactly the two policies (`governance audit is service role append only`; draft-only change-set UPDATE), and the follow-up header (KNOWN_ISSUES.md:653-657) says "The current beat closes #16 + #17." Anyone triaging the file cold re-investigates two closed Criticals. Stamp them.
- **#97 no longer reproduces.** Filed as "tests fail on Node ≥22" (KNOWN_ISSUES.md:1901-1907). I ran the full suite on Node 22.22.2: **88 files / 1,357 tests, all pass** (see §4). Stamp or re-verify.
- Several "RESOLVED in code — pending merge" stamps (#108, #110, #111, #112, #114, #118, #121) date from 2026-06-18 branches that per `docs/DEPLOY_RUNBOOK_2026-06-18.md:7` all merged 2026-06-19 — the "delete this item on merge" instructions were never executed. Cosmetic but adds ~600 lines of noise to a file the team must triage repeatedly.

---

## 2. Edge-function convention audit

Inventory: **80 functions** in `supabase/functions/`; `scripts/check-edge-function-config.mjs` passes ("All 80 edge functions have matching config.toml stanzas") — the config-completeness gate is real and green.

### 2.1 verify_jwt posture (supabase/config.toml)

- `verify_jwt = true` for the interactive surface (approval chain, reports, billing, firm admin, delete-lease/restore-lease, ai-assistant…). Spot-checked gating: `get-billing-summary/index.ts:61-84` (owner-OR-admin), `delete-lease/index.ts:16-45` (server-side admin/owner re-check on a service-role writer — correct model).
- `verify_jwt = false` set falls into legitimate classes, each spot-checked for internal auth:
  - **Crons** (send-lease-notifications, cleanup-expired-reports, process-delegate-timers, detect-stuck-chains, vendor-health-check, reclaim-stuck-extractions, process-cancellation-lifecycle, vault-renewal-reminder, dispatch-notifications, firm-billing-reconcile, sweep-pending-workspaces, process-lease-retention, process-alerts) — x-cron-secret, fail-closed.
  - **stripe-webhook** — signature-verified (`stripe-webhook/index.ts:122,135` `constructEventAsync`).
  - **Bearer-checked despite verify_jwt=false**: `process_lease/index.ts:1661-1674`, `retry_lease/index.ts:458-472`, `lease-governance-action/index.ts:98`, `request-lease-unlock/index.ts:19-31`, `send-firm-invitation/index.ts:79-81`, `accept-firm-invitation/index.ts:24-26`, `create-firm-subscription/index.ts:34-36`, `create-firm-checkout/index.ts:32-34`, `audit-session/index.ts:71`. No unauthenticated mutating function found in the spot-check.
  - `handle-unlock-action` is a deliberate 410 tombstone (`handle-unlock-action/index.ts:17-21`) — fine.

### 2.2 Raw-error leaks (structured-error convention violations) — confirmed live in repo

1. **`add-firm-member/index.ts:65`** — `return json({ error: insErr.message, reason: "insert_failed" }, 400)` and the outer catch (`:75-79`) returns the raw message at 500. This is the documented #102 holdout — **confirmed still present**.
2. **`retry_lease/index.ts:909-916`** — top-level catch returns `error.message` to the client (can carry Anthropic/Azure vendor error strings). #140 — confirmed still present.
3. **`process_lease/index.ts:2721-2726`** — same pattern: top-level catch returns raw `error.message`. #140's "audit process_lease's outer catch for the same habit" was never done — **this one is not tracked as its own confirmed instance anywhere; it should be**.

By contrast the Phase-10 firm functions use structured `reason` codes throughout; `create-checkout/index.ts:133`, `customer-portal/index.ts:68`, `manage-document-pack/index.ts:209` all carry the `firm_managed` 403 guard — the #103 server-side lockdown claim is **verified true** (line numbers drifted a few lines from the docs; content matches).

### 2.3 CORS

`_shared/cors.ts` does strict exact-origin + hostname-suffix matching (`cors.ts:29-35`): production domains (`theleaseio.com`, `www.`, `app.`), `.lovableproject.com`, `.lovable.app`, **`.vercel.app`** (:19), localhost dev. The two inline-CORS functions are **in parity**: `send-invite/index.ts:71-75` and `resend-invite/index.ts:67-76` carry the identical origin list + suffix set. No drift found. Residual (already filed as #127, Low): CORS resolution never *rejects* — a non-browser `Origin: https://evil.com` still lands in Stripe `success_url` via `create-checkout`/`create-firm-checkout` (self-redirect only; low).

### 2.4 Dead vendor code in the core extraction file

`process_lease/index.ts:1242-1655` contains a ~400-line `_extractLeaseDataWithOpenAI_DEPRECATED` function ("retained for reference, not called" — :1241) that calls `https://api.openai.com/v1/chat/completions` (:1594) using **`OPENAI_API_KEY`, an identifier declared nowhere in the file** (grep: only usage at :1596/:1598/:1604 — it would `ReferenceError` if ever invoked). Live extraction is genuinely Claude (`claude-haiku-4-5-20251001` at :712/:773, `claude-opus-4-6` at :1203/:1228 via api.anthropic.com :372). Not a runtime violation of Hard Rule #3, but 400 lines of dead OpenAI code inside the single most critical file contradicts the stated architecture, inflates review surface, and is a foot-gun (any future `deno check`/tree-wide lint will trip on it). Delete it.

---

## 3. RLS spot-check (from migrations; live DB not reachable from this session)

Layered model confirmed: baseline permissive policies (`20260516120000_baseline_schema.sql`) + additive RESTRICTIVE liveness layer (`20260613000000`) + soft-delete hiding (`20260625130000`) + initplan rewrap (`20260623140000`) + permissive-policy consolidation (`20260623160000`).

- **leases** — SELECT `leases_select_own_or_workspace` (baseline:4210, owner-or-member); INSERT membership-checked (:3845); UPDATE `leases_update_own_or_workspace_editor` (:4214); DELETE `leases_delete_own_or_workspace_admin` (:4206) — the broad DELETE is now backstopped by the `prevent_committed_lease_hard_delete` BEFORE DELETE trigger (`20260618140000`, #116) and the RESTRICTIVE `leases_hide_soft_deleted` (`20260625130000:63-64`, `deleted_at IS NULL` for all authenticated SELECTs). Service-role bypass sites correctly re-filter: `process_lease/index.ts:530,1085`, `ai-assistant/index.ts:327`, `_shared/monitoring/workspace_quotas.ts:86,95`. **No obvious bypass**; the known residual is the editor-breadth of UPDATE (accepted, #134) — the real write control is the trigger stack (`prevent_unauthorized_lease_workflow_edits`, `prevent_locked_lease_edits`, `enforce_lease_retention_columns`, disjoint columns).
- **lease_activity_log** — INSERT tightened by `20260613050000` to a 19-type client allowlist; the policy comment (:71-72) is explicit that `user_id` stays NULL-able → **forgeable "system" attribution residual (#90-NULL) confirmed by reading the policy**, and #95 (no live smoke key for this policy) means Studio drift here would be invisible.
- **lease_approval_chain** — "assignee acts on own pending step" (baseline:4036) is well-shaped: USING pins `status='pending'` + assignee-or-role match, WITH CHECK forces `action_by = auth.uid()` and status ∈ {approved,rejected,sent_back}. Admin UPDATE workspace-scoped (:3973). Consolidation migration preserved shape.
- **approval_policies** — consolidation (`20260623160000:110-125`) split the ALL policy into per-command admin-write + member-read; workspace-scoped both directions. Sound.
- **workspaces** — UPDATE broadened owner→owner+accepted-admin (`20260613060000:51`) with the WITH CHECK deliberately dropped and `enforce_workspace_owner_immutable` trigger (:88) blocking owner_id handoff — the migration documents why (:38-44), and the entitlement guard (`20260522000000`, restored #29) plus the firm-binding guards (`20260615172439`) keep plan/limits service-role-only. Client DELETE blocked (#83, `20260613030000` destruction guards). Sound.

One structural note: the tenancy helper `is_workspace_member()` silently became firm-aware in Phase 9 (third EXISTS; `20260615172439`) — every workspace-scoped policy inherits firm-derived access. That is documented and deliberate, but it means **any** future policy review must reason about firm membership too; the owner-privileged Phase-10 inbox view ([D1]) exists precisely because two tables don't.

---

## 4. Test suite state (executed, not asserted)

- `npm ci` clean; `npm test` (vitest 4.1.5, Node 22.22.2): **88 test files, 1,357 tests, 1,357 passed, 0 failed, ~15s**.
- `npm run typecheck` — clean. `npm run check:supabase-types` — passes. `npm run check:mirror-parity` — passes, **but note it verifies only 2 mirror pairs** (`firmAccess`⇄`firm_access`, `approvalRouting`⇄`approval_routing`); the other documented Node⇄Deno mirrors (lifecycleStates, approvalChainLogic⇄approval_chain, pricing⇄document_packs) are NOT parity-gated — drift there would pass CI. `npm run check:edge-function-config` — passes (80/80).
- Character of the suite: heavily static/`readFileSync` migration-pinning tests plus pure-logic units. Known limitation (honestly documented in-repo): **no edge-function runtime tests, no `deno check` in CI** (#125 open half, KNOWN_ISSUES.md:2338), and the live smoke layer (`scripts/smoke-audit-hardening.mjs`) only runs when SUPABASE_* secrets are configured.
- Contradiction worth stamping: issue #97's "fails on Node ≥22" did not reproduce (full pass on 22.22.2).

## 5. CI workflow health (.github/workflows/ci.yml — the only workflow)

- Jobs: `test-and-build` (types/typecheck/mirror-parity/config-check/test/build + conditional security smoke), `migration-replay` (`supabase start` replays the full chain on clean Postgres — a genuinely strong gate), `deno-lint` (PR-only, changed edge files). Structure is good and the secrets-in-`if:` landmine is correctly avoided (ci.yml:13-26 hoists to job env).
- **Main-push smoke enforcement is a hidden hard dependency**: ci.yml:63-77 *fails any main push* if the four SUPABASE_* smoke secrets are missing. I cannot verify GitHub secret state from this session; either the secrets are configured (contradicting KNOWN_ISSUES #26's "not blocking today because the secrets aren't configured", which then needs a stamp), or every push to main since that step landed has failed CI. One of the two is true — verify which.
- **Deprecated action runtimes (#98) are now past the first deadline**: `actions/checkout@v4` (:30,:93), `actions/setup-node@v4` with `node-version: 20` (:33-35), `supabase/setup-cli@v1` (:96). GitHub's forced-Node-24 default began 2026-06-16 (already past); Node 20 runner removal 2026-09-16. Bump to checkout@v5 / setup-node@v5 (node 22 or 24) / setup-cli@v2 soon, and reconcile with #97 (local suite already passes on 22).
- `deno-lint` gate excludes `no-import-prefix` + `no-control-regex` repo-wide (`deno.lint.json`, #142 — accepted decision) and lints changed files only, so the 22 pre-existing lint problems in legacy functions (9 in `process_lease`) persist until touched.

## 6. Consolidated operator-owed / fail-closed ledger (single list)

Everything below is built and committed but **inert or wrong in the live environment until an operator acts**. Sources: `docs/DEPLOY_RUNBOOK_2026-06-18.md`, `docs/LEASES_REDESIGN_DEPLOY_2026-06-25.md`, `docs/ops/OPERATOR_PLAYBOOK.md`, KNOWN_ISSUES, `.env.example`.

**Edge-function redeploys (order matters; migrations already applied per docs):**
1. `resolve-approval-chain` — the #84/#111-C1/#A1/#A4 redeploy. Highest stakes (see §1.2 item 1).
2. `process_lease` — B1 retry/backstop hardening + `deleted_at` cap filter + `processing_started_at` stamping (LEASES_REDESIGN_DEPLOY:23).
3. `retry_lease` — B1 zero-byte/PDF-magic guard (KNOWN_ISSUES.md:44-45).
4. `vendor-health-check` — `deleted_at` quota-snapshot filter (cosmetic) (LEASES_REDESIGN_DEPLOY:24).

**Secrets (each fail-closed until set):**
5. `RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET` (+ `private.cron_secrets` row) — zombie-lease reclaim inert (KNOWN_ISSUES.md:48).
6. `LEASE_RETENTION_CRON_SECRET` (+ cron_secrets row) — 14-day purge inert (LEASES_REDESIGN_DEPLOY:89-95).
7. `NOTIFICATION_DISPATCH_CRON_SECRET` — approval/nudge email delivery inert (#109; cron itself scheduled by `20260619000000`).
8. `FIRM_BILLING_CRON_SECRET` + schedule `firm-billing-reconcile` (#107).
9. `STRIPE_PRICE_STARTER_ANNUAL` / `STRIPE_PRICE_BUSINESS_ANNUAL` — annual checkout 503 `annual_not_configured` (STOP 7; .env.example:62-67).
10. `STRIPE_PRICE_VAULT_ANNUAL` + Vault Product/Price + `VAULT_RENEWAL_CRON_SECRET` + schedule `vault-renewal-reminder` — Vault conversion 503 (STOP 10).
11. `STRIPE_PRICE_PACK_{10,20,50}` — pack purchase `pack_not_configured` if unset (.env.example:73-78).
12. **STOP 3** — live-mode Stripe webhook endpoint + `STRIPE_WEBHOOK_SECRET` (live ≠ sandbox endpoint; OPERATOR_PLAYBOOK:91).
13. GitHub Actions SUPABASE_* smoke secrets — see §5 (either owed, or KNOWN_ISSUES #26 needs a resolve stamp).
14. Crons never scheduled at all: `reroute-audit-sweep`, `process-pending-reroute-evaluations` (#14, open since 2026-05-07).
15. Frontend deploy verification — LEASES_REDESIGN_DEPLOY:32 lists the Vercel deploy as part of the activation step; PR #74 is merged, so confirm the deployed frontend and function set are consistent (this is the same consistency question as item 1).

**The pattern to name:** the team's build-side discipline is real (fail-closed defaults everywhere), but the repo has accumulated a **two-week-old queue of "operator step still owed" items across four separate documents** with no single checklist and no verification that any of them happened. Several of them (items 1, 2, 7) gate features users already reported broken. Recommendation: one canonical `docs/ops/PENDING_DEPLOYS.md` (or close the runbooks), and a nightly `deployed-vs-repo` drift check for edge functions — the "AI operator" role that CLAUDE.md itself says is NOT YET BUILT.

## 7. Docs drift (code vs docs contradictions)

1. **CLAUDE.md says #94 is open; it was resolved 2026-06-14.** CLAUDE.md banner + "Shipped 2026-06-13" section list "#94 (executed-upload lifecycle convention)" as an open follow-up; KNOWN_ISSUES.md:1877 stamps it RESOLVED (PR #41, process_lease v101 deployed), and the code agrees — `UploadExecutedDocumentDialog.tsx:60` comments the server-side flip; no client `lifecycle_status` write exists in the file.
2. **CLAUDE.md: "`workspace_approvers` table exists but has no read/write path in the frontend."** False for reads: `src/pages/app/LeaseReview.tsx:1060` queries `.from('workspace_approvers')` and `src/lib/approverCandidates.ts:5,29` composes candidates from it. True only for writes (no UI populates it). The doc claim would misdirect a fix.
3. **.env.example:47-50: "Azure Document Intelligence (current OCR pipeline for process_lease)"** — `process_lease/index.ts` contains no AZURE_DI reference (grep); Azure appears only in `retry_lease/index.ts`. Also :44-45 "ANTHROPIC_API_KEY … used by ai-assistant + *future* Phase 8 extraction" — extraction is Claude-based today in process_lease/retry_lease/audit-session. Both comments describe a pipeline two generations old.
4. **.env.example:170-173 sanity check tells the operator to curl `functions/v1/check-subscription`** — that function does not exist in the repo (KNOWN_ISSUES #30 filed the same ghost in CLAUDE.md but .env.example was never swept).
5. **KNOWN_ISSUES #16/#17 present two fixed Criticals as open** ("Decision: Filed not fixed", KNOWN_ISSUES.md:558,584) despite `20260516130000_restore_governance_hardening.sql:44-67` shipping exactly those policies. Same class: #97 (contradicted by a passing Node-22 run), and seven "delete this item on merge" stamps never executed after the 2026-06-19 merges.
6. **CLAUDE.md structure: Phase 9 "MERGED to main" and Phase 10 "SUBSTANTIALLY COMPLETE" both sit under "Active Priorities → Open / unstarted."** Also the Leases redesign/soft-delete is described as "on branch `claude/relaxed-clarke-oksfz4`" though PR #74 is merged (git log `1e70355`). The stale-branch framing directly contradicts CLAUDE.md's own Documentation & Completion Discipline rule.
7. **Stale resume banner**: CLAUDE.md's top banner still directs readers to the 2026-06-13 session handoff for branch `claude/dazzling-franklin-klts6u` and says to delete it "once that work is merged/closed" — that work (Vault V1–V4) shipped into main weeks ago; half the banner's "what's left" list (#94) is wrong (see drift 1).
8. **Hard Rule #3 ("No OpenAI") vs `process_lease/index.ts:1242-1655`** — dead but committed OpenAI extraction implementation with an undeclared `OPENAI_API_KEY` identifier (§2.4). Docs say the architecture never had OpenAI in it; the code carries a full retired implementation.

## 8. Concrete recommendations (ranked)

1. **Verify the live function/frontend consistency TODAY** (resolve-approval-chain, process_lease, retry_lease vs deployed frontend). This is the one item where the docs' own record implies a possibly-broken core Path-1 in production.
2. Execute and then retire the deploy-runbook queue (§6); create one canonical pending-deploys ledger.
3. Run the #18 live verification (report upload as non-admin) and ship the prepared foldername fix either way.
4. Set the four cron secrets (§6 items 5–8) — each is a one-liner activating an already-reviewed safety net.
5. Stamp KNOWN_ISSUES #16/#17/#97 and execute the stale "delete on merge" stamps; fix CLAUDE.md drifts 1/2/6/7 in one reconciliation commit (the project's own discipline section mandates exactly this).
6. Delete `_extractLeaseDataWithOpenAI_DEPRECATED` and fix the two remaining raw-error catches (`retry_lease:909`, `process_lease:2721`, `add-firm-member:65`).
7. Bump CI action versions (checkout@v5, setup-node@v5 + node 22/24, setup-cli@v2) before the September Node-20 runner removal; decide the smoke-secrets question (§5).
8. Extend `check-mirror-parity.mjs` to cover all documented Node⇄Deno mirror pairs, not just two.
9. Schedule the #14 crons or explicitly WONTFIX them with the monitoring-spec "out of scope" rationale (hard rule #9's own framework).
