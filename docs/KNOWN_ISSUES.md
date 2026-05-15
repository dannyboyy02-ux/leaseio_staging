# Known Issues — Open Backlog

Tracked here so they survive across sessions. When fixing, remove from this
list and reference it in the commit message.

**Status reconciliation (Phase 3 close, 2026-05-05):**
- Items 1-7 (pre-Phase-3 backlog) all still open. Phase 3 did not touch them.
- Three new items added (8, 9, 10) from the Phase 3 smoke run.
- One item resolved DURING Phase 3 closeout and NOT filed here: the P0
  cross-workspace data leak (UI was missing workspace_id filtering on the
  leases list — RLS allowed multi-membership reads to surface mixed data).
  Fixed in commit `9b46dca`. Permanent regression test belongs in the future
  Owner Workspace Management spec rather than as a sticky issue here.

**Status reconciliation (Owner Workspace Management close, 2026-05-05):**
- Item #8 (duplicate workspace creation): orphan `440d279f-a781-450a-863a-73b51780becd`
  was successfully deleted via the new feature during Checkpoint 3 smoke,
  which validated the delete-workspace edge function's cascade end-to-end.
  The underlying duplicate-creation bug at signup/onboarding remains open
  — a separate ticket fixes that surface; OWM only provided the cleanup tool.
- Item #9 (creator-membership timestamps) NOT addressed by OWM. Still open.
- No new items surfaced during OWM smoke.

**Status reconciliation (Phase 4 close, 2026-05-05):**
- Items 1-9 (pre-Phase-4 backlog) all still open. Phase 4 did not touch them.
- One new item added (#11) for the lease-documents storage cleanup
  in delete-workspace — small follow-up; no security implication.

**Status reconciliation (proactive sweep, 2026-05-07):**
- Item #1 (profiles 400) — RESOLVED. Root cause was missing
  `notify_abstraction_complete` column on `public.profiles` referenced
  by `AccountSettings.tsx`. Added in migration
  `20260507100000_profiles_notify_abstraction_complete.sql`.
- Item #2 (CSP missing wss + WASM blockers) — RESOLVED. Updated CSP
  in `vercel.json` (commit `c2f6276`): added `wss://*.supabase.co` for
  Realtime; added `'wasm-unsafe-eval'` for `@react-pdf/renderer`'s
  yoga-layout WASM; added `data:` and `blob:` to connect-src; added
  `worker-src 'self' blob:` and `frame-src 'self' blob:`.
- Item #5 (WorkspaceSettings owner gating) — RESOLVED. Replaced
  literal `userRole === 'admin'` with `canEditWorkspaceSettings(userRole)`
  on line 164 (previously line 161 per the original report).

**Status reconciliation (Tier 2 build close, 2026-05-08):**
- Item #4 (CSS MIME type error on `theleaseio.com`) — RESOLVED.
  Verified live with curl: `https://theleaseio.com/assets/index-*.css`
  returns `Content-Type: text/css; charset=utf-8`; the JS bundle
  returns `application/javascript; charset=utf-8`; root HTML returns
  `text/html`. All asset MIME types are correct in the current
  deployment. The original failure mode (catch-all serving `text/html`
  for asset paths) is no longer present — likely fixed by a Vercel
  domain config change since 2026-05-03 when the issue was filed.
  Browser-side `strict MIME checking` error described in the issue
  is not reproducible.

**Status reconciliation (P2 batch, 2026-05-07):**
- Item #3 (password DOM warnings) — RESOLVED. Wrapped the password
  card in `<form>` with hidden `autocomplete="username"` shadow input
  and added `autocomplete="current-password"` / `autocomplete="new-password"`
  to the three password Inputs in `src/pages/settings/AccountSettings.tsx`.
  Form's onSubmit calls `handleChangePassword`. Chrome heuristic now
  satisfied; password managers can autofill.
- Item #6 (`ai-assistant` dead filter values) — RESOLVED. Dropped the
  stale `'needs_review'` from the `buildLeaseContext` includes() filter
  and dropped `'failed'` from the `.not('lifecycle_status', 'in', ...)`
  query in `supabase/functions/ai-assistant/index.ts`. Behavior
  unchanged (both values were dead — the constraints never accepted
  them). Redeployed as ai-assistant v3
  (ezbr e74d4c34a441fa2eb0b74ba26ae5529463778d513a7e05648fc54ea2f858dcba).
- Item #9 (creator-membership `invited_at`/`accepted_at` NULL) —
  RESOLVED. `src/pages/app/Onboarding.tsx` now sets both timestamps
  to `now()` when inserting the owner's own `workspace_members` row.
  Behavior unchanged for invitees; just the owner's audit-trail trail
  is now consistent with everyone else's. Existing rows with NULL
  timestamps remain NULL — a one-shot backfill UPDATE could be filed
  if forensics need them, but the live-data effect is cosmetic only.
- Items 4, 7, 8, 10, 11, 12, 13 — still open / deferred / pattern
  notes per their original entries below.

---

## 3. Password field DOM warnings on `/app/settings/account`

**Symptom (browser console):**
```
[DOM] Password field is not contained in a form: ...
[DOM] Input elements should have autocomplete attributes (suggested: "current-password")
```

**Hypothesis:** Chrome heuristic for password manager / autofill. The password
inputs on the account-settings page aren't wrapped in a `<form>` and/or lack
`autocomplete="current-password"` / `autocomplete="new-password"` attributes.

**Where to look:** `src/pages/settings/AccountSettings.tsx`. Wrap password
fields in a `<form>` and add the appropriate `autocomplete` attribute per
input.

**Severity:** Cosmetic — Chrome warning only. Password manager UX may be
slightly degraded.

---

## 4. CSS MIME type error on `theleaseio.com` custom domain

**Symptom (browser console on prod custom domain):**
```
Refused to apply style from '...' because its MIME type ('text/html') is
not a supported stylesheet MIME type, and strict MIME checking is enabled.
```

**Hypothesis:** the request for a CSS asset is returning HTML — typically
because the asset path is wrong and the host's catch-all returns the SPA
`index.html`. Likely an asset-path / base-URL config mismatch between the
`theleaseio.com` apex and the Vercel/Lovable subdomain that the build was
configured for.

**Where to look:** `vite.config.ts` (`base` setting), Vercel project domain
settings, and any environment-specific asset path config. Compare
`https://theleaseio.com` → asset request paths vs the Vercel subdomain.

**Severity:** Medium-High on `theleaseio.com` (style breakage); zero impact on
the Lovable / Vercel subdomain where the smoke is being run.

---

## 6. `ai-assistant/index.ts` filters reference impossible `lifecycle_status` values

**Symptom (audit-time investigation, 2026-05-03):** During the Phase 3
audit, two filters in `supabase/functions/ai-assistant/index.ts` were found
to reference `lifecycle_status` values that have never been part of the live
CHECK constraint:

- **Line 27** (inside `buildLeaseContext`):
  ```ts
  const activeLeases = leases.filter(l =>
    ['active', 'executed', 'needs_review', 'draft'].includes(l.lifecycle_status)
  );
  ```
  `'needs_review'` is not a valid `lifecycle_status`. The `.includes()` for
  it always returns false; harmless dead value.
- **Line 217** (lease query):
  ```ts
  .not('lifecycle_status', 'in', '("failed","cancelled")')
  ```
  `'failed'` is not a valid `lifecycle_status`. The NOT IN clause excludes
  only `'cancelled'` in practice; harmless dead value.

**Root cause:** Likely artifacts from an earlier draft of the schema where
`'needs_review'` and `'failed'` may have been considered for what is now
the separate `status` column (which carries the AI-processing state, not
the lifecycle state). Both columns coexist on `leases`; the dead values
look plausible at first glance.

**Severity:** Cosmetic — no functional bug today. The filters do exactly
what the surrounding code intends; they just carry useless predicates.
Worth cleaning up to prevent future confusion.

**Where to look:** `supabase/functions/ai-assistant/index.ts` lines 27 and
217. Recommended fix:
- Line 27: `['active', 'executed', 'draft'].includes(l.lifecycle_status)` (drop `'needs_review'`).
- Line 217: `.not('lifecycle_status', 'in', '("cancelled")')` (drop `'failed'`); or — better — add the new Phase 3 chain-vocabulary `'cancelled'`-equivalent if/when one exists, and consider whether the AI assistant should also exclude `'rejected'`.

**Decision:** Filed as KNOWN_ISSUES rather than fixed in Phase 3 per user
direction. Phase 3 touches `ai-assistant/index.ts` only at line 64
(`displayLabel()` migration), not the filters.

---

## 7. State-helper consolidation refactor (post-Phase-3)

**Symptom:** Six local constants across the codebase encode the same
semantic groupings as the `STATE_GROUPS` map in `src/lib/lifecycleStates.ts`
(introduced in Phase 3 Checkpoint 2):

- `IN_PROGRESS_STATUSES` in `src/components/dashboard/PipelineByDepartment.tsx`
- `IN_FLIGHT_STATUSES` in `src/pages/Leases.tsx`
- `SHAREABLE_STATUSES` in `src/components/summary/SummaryShareControls.tsx`
- `APPROVED_STATUSES` in `src/components/summary/FinancialImpactSummary.tsx`
- `LIFECYCLE_LABELS` in `src/components/dashboard/RecentActivity.tsx`
- `expiringStatuses` in `src/components/dashboard/SummaryStrip.tsx`

Phase 3's "extend in place" approach (per user direction) keeps each of
these local but extends their lists to include chain-vocabulary
equivalents. This is correct for Phase 3's risk profile but leaves the
lists duplicated across files.

**Recommended fix (dedicated future phase):** consolidate each constant
into a `STATE_GROUPS`-derived helper. For example:

```ts
// Replaces SHAREABLE_STATUSES.has(status):
isInGroups(status, ['post_concept_pre_signator', 'executed_pre_active', 'active'])
```

Surface area: 6 files, six constants, all read-only consumers. Behavior
must remain identical. Add vitest cases that pin each consolidated
predicate's truth table against the previous local-constant behavior.

**Decision:** Filed as KNOWN_ISSUES rather than mixed into Phase 3.
Vocabulary expansion (Phase 3) and constant consolidation are separate
concerns and conflating them would inflate Phase 3's blast radius and
make rollback harder. Re-evaluate after Phase 3 closes.

---

## 8. Duplicate workspace creation on signup / onboarding

**Symptom (database forensics, 2026-05-05):** During the Phase 3 closeout
investigation of "where did Labs Analytix's workspaces come from?", the
`workspaces` table revealed two rows named `"My Workspace"` owned by the
same user, created **13 seconds apart** (2026-01-14 03:35:04 and 03:35:17).
One of the two has zero members and zero leases (orphaned).

```
| id            | name         | created_at                  | members | leases |
|---------------|--------------|----------------------------:|--------:|-------:|
| 440d279f...   | My Workspace | 2026-01-14 03:35:04         |       0 |      0 |
| b0f3c7a0...   | My Workspace | 2026-01-14 03:35:17 (+13s)  |       2 |      2 |
```

**Hypothesis:** A double-fire in the signup → onboarding workspace-creation
flow. Possibly a React StrictMode double-effect, a race between Signup.tsx
and Onboarding.tsx both calling create-workspace, or a retry on a slow
first response that succeeded after the user clicked again.

**Where to look:** `src/pages/Signup.tsx`, `src/pages/app/Onboarding.tsx`,
and any edge function that auto-creates a workspace on first sign-in. Add
an idempotency guard (e.g., "if user already owns a workspace, no-op")
before any new workspace insert.

**Severity:** Medium-Low — orphaned workspaces are invisible due to
empty member/lease state, but they pollute the workspace switcher and
inflate any "active workspaces" count.

**Update 2026-05-05:** The orphan `440d279f-a781-450a-863a-73b51780becd`
was deleted via the new Owner Workspace Management feature during its
Checkpoint 3 smoke (post-delete DB verification: zero orphan rows across
every dependent table; audit row populated correctly). The
duplicate-creation bug itself is still open — preventing future
duplicates is a separate Signup/Onboarding ticket and is NOT addressed
by Owner Workspace Management.

---

## 9. Creator-membership row missing `invited_at` / `accepted_at`

**Symptom (database forensics, 2026-05-05):** Workspace owners' own
`workspace_members` rows have NULL `invited_at` and NULL `accepted_at`.
Members added via the legitimate invite flow have both populated. The
asymmetry breaks audit-trail clarity:

```sql
-- Owner's own admin row (created by the workspace-creation handler):
{ workspace_id: c9dad4c7..., user_id: c2dbf842..., role: 'admin',
  invited_at: NULL, accepted_at: NULL, created_at: 2026-01-07 ... }

-- Invitee row (created by accept-invite edge function):
{ workspace_id: c9dad4c7..., user_id: 3d5d40ec..., role: 'admin',
  invited_at: 2026-04-22 21:22:22.801+00,
  accepted_at: 2026-04-22 21:22:22.801+00, created_at: 2026-04-22 ... }
```

**Where to look:** the workspace-creation handler that auto-inserts the
creator into `workspace_members`. Set `invited_at = accepted_at = now()`
for the creator's own row so every membership has a populated timestamp
trail.

**Severity:** Low — purely a forensics-clarity issue. No user-visible
behavior. Worth tightening before Phase 9 (firm layer) when audit trails
become more important for cross-workspace member visibility.

---

## 10. Phase 3 audit miss: `LeaseStatusBadge.tsx`

**Symptom (Phase 3 smoke, 2026-05-05):** The Phase 3 audit
(`docs/PHASE_3_AUDIT.md`, committed as `49e1ab7`) traced
`LifecycleStatusBadge.tsx` (the canonical chain-aware badge in
`src/components/lifecycle/`) but **missed `LeaseStatusBadge.tsx`** — a
separate badge in `src/components/leases/` used by `Leases.tsx` and
`ImportHistory.tsx`. The two filenames differ by only the substring
"cycle" and the audit grep didn't catch the second.

The smoke surfaced this when a chain lease at `concept_submitted` rendered
its raw enum text in the leases queue view while the lease detail page
(which uses the canonical badge) correctly showed "Submitted".

**Status:** Fixed in commit `aaa5ab3` (`LeaseStatusBadge.tsx` now routes
every label through `displayLabel()`). Filed here NOT as an open issue
but as a pattern note for future audits:

**Pattern for Phase 4+ audits:** when grepping for badge / display
components, do not rely on substring matching. Walk the imports of every
status-rendering site and trace each transitive component, even if the
filename is a near-twin of an already-audited component. The Phase 3
audit doc template at the top of `docs/PHASE_3_AUDIT.md` should be
updated to call this out — done as part of the Phase 3 closeout.

---

## 11. `delete-workspace` edge function does not purge `lease-documents` bucket

**Symptom (Phase 4 close-out audit, 2026-05-05):** The
`delete-workspace` edge function from Owner Workspace Management
explicitly purges storage objects from the `leases` and
`executed-leases` buckets when a workspace is deleted (per its
`storageTargets` set + bucket loop). Phase 4 added a third bucket,
`lease-documents`, but the edge function was not updated to include
it. When a workspace is deleted:

- The `lease_documents` rows cascade away via `lease_id` and
  `workspace_id` ON DELETE CASCADE FKs (correct).
- The storage objects under `lease-documents/{workspace_id}/...`
  remain in storage (orphaned).

**Severity:** Low. The orphan storage is invisible to all users —
the path-prefix RLS rejects reads since the `workspace_id` no longer
exists in `workspace_members` or `workspaces`. Pure billing /
storage hygiene; no security implication.

**Where to look:** `supabase/functions/delete-workspace/index.ts`,
specifically the `for (const bucket of ["leases", "executed-leases"])`
loop. Add `"lease-documents"` to the array. The path-prefix
convention `{workspace_id}/{lease_id}/{uuid}_{filename}` means the
existing list-then-remove pattern works without modification.

**Decision:** Filed as KNOWN_ISSUES rather than fixed inline during
Phase 4 because (a) it's a one-line edit in a different feature's
edge function and (b) the orphan storage is invisible to all users.
Tracked here for the next time `delete-workspace` is touched.

---

## Phase 8 C1 additions (2026-05-06)

### Item #12: lease_reports artifact cleanup job — RESOLVED 2026-05-07

Shipped `supabase/functions/cleanup-expired-reports/index.ts` and
production cron wiring at
`supabase/migrations/20260507210000_cleanup_expired_reports_cron.sql`.

Daily 08:30 UTC schedule via `pg_cron` + `pg_net`, mirroring the
audit-remediated `send-lease-notifications-daily` pattern (migration
`20260426000003`). Edge function uses `verify_jwt = false` and
authenticates via an `x-cron-secret` header read from
`CLEANUP_EXPIRED_REPORTS_CRON_SECRET`; pg_cron forwards the same value
sourced from `current_setting('app.cleanup_expired_reports_cron_secret', true)`.
The Bearer-JWT pattern was abandoned mid-implementation when the
existing wired-cron precedent was found — kept the existing audit-
remediated pattern for consistency.

Behavior: selects `lease_reports` where `expires_at <= now() AND
status != 'expired'`, batches storage removes against the
`lease-reports` bucket in chunks of 100 across both `pdf_storage_path`
and `json_storage_path`, marks each row `status = 'expired'` (row
preserved as audit anchor), and writes a `report_expired` activity
row for single-lease reports. Portfolio reports skip the activity log
per Phase 8 As-built A6 (lease_id is NULL; lease_activity_log.lease_id
is NOT NULL).

**Operator deployment steps** (one-time, both must use the same value):
  1. `supabase secrets set CLEANUP_EXPIRED_REPORTS_CRON_SECRET='<value>'`
  2. `ALTER DATABASE postgres SET app.cleanup_expired_reports_cron_secret = '<value>';`

If either step is missed the function fails closed (401); pg_cron
still fires and the rejection shows up in `net._http_response`. No
data loss either way.

### Item #13: Synchronous PDF generation soft cap — RESOLVED 2026-05-07

`generate-portfolio-report` now enforces a `PORTFOLIO_LEASE_CAP = 500`
guardrail. Workspaces whose eligible-lease count for the requested
period exceeds the cap get a 422 with
`reason: 'portfolio_too_large'`, the row is marked `status='failed'`
with a descriptive `error_message`, and the frontend hook
(`useGeneratePortfolioReport`) surfaces the message directly to the
user. Cap is a single constant; raising it requires moving to
background-queue generation (still deferred until real-world usage
demands it).

The architecture remains forward-compatible: `lease_reports.status`
already supports `pending | generating | ready | failed | expired`
and the frontend polls — switching to a background queue requires no
schema change. The "punted heavy fix" stays punted; this is the
minimal guardrail the original entry recommended.

---

## Cron-wiring follow-ups (2026-05-07)

### Item #14: reroute-audit-sweep + process-pending-reroute-evaluations are not yet on cron

When wiring the rest of the scheduled functions in
`20260507220000_phase567_crons.sql`, three leaf crons shipped
(`send-counter-signature-reminder`, `process-delegate-timers`,
`detect-stuck-chains`). The two reroute-related crons were NOT wired
in the same pass because both forward the inbound `Authorization`
header to `resolve-approval-chain` (1054-line sibling function in
`supabase/functions/resolve-approval-chain/index.ts`).

`resolve-approval-chain` uses `user.id` in five places (lines 169,
205, 272, 277-279, 723) — workspace-membership authorization gates
plus `triggered_by` attribution on the audit log. Switching the two
reroute crons to the `x-cron-secret` pattern leaves no JWT to
forward, which means safely wiring them requires a service-context
invocation path in `resolve-approval-chain`.

**Severity:** Medium-deferred. The two crons run fine on manual
invocation today; the auto-detection of attribute changes that should
trigger rerouting is currently caught by the BEFORE UPDATE trigger
on `leases` (see Phase 6 spec) — the `process-pending-reroute-evaluations`
poller is a backstop. The daily `reroute-audit-sweep` is a
defense-in-depth scan that detects but does not act, so leaving it
manual reduces only the catch-rate of stale-policy drift.

**Where to look:**
  1. `supabase/functions/resolve-approval-chain/index.ts` — extend the
     auth block to recognize an `x-internal-cron` header (or similar),
     and skip user-membership checks + null out `triggered_by` when
     called via that path.
  2. `supabase/functions/reroute-audit-sweep/index.ts` and
     `supabase/functions/process-pending-reroute-evaluations/index.ts`
     — swap Bearer JWT for `x-cron-secret` (per
     `cleanup-expired-reports`), forward the new internal header to
     `resolve-approval-chain` instead of `Authorization`.
  3. `supabase/migrations/<new>_reroute_crons.sql` — add the two
     schedules.

Both crons need to keep their existing manual-invocation paths usable
during testing (real users may want to dry-run a reroute audit sweep).

---

## P2-01 cron / secret hygiene (2026-05-15)

### Item #15: `process-alerts-daily` cron is orphaned — no source in repo, no auth header

Surfaced during P2-01 (audit P2-01 in `docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md`) on 2026-05-15 while sweeping cron-secret mechanism drift.

**State as of 2026-05-15:**
- `cron.job` has a row named `process-alerts-daily` (schedule `30 8 * * *`).
- The cron's HTTP POST has only `Content-Type: application/json` — no `x-cron-secret`, no `Authorization: Bearer`. Other crons all pass `x-cron-secret` from `private.cron_secrets`.
- The target function `process-alerts` IS deployed (verify_jwt=false, version 18, last update ~2026-04-22) but **has no source in `supabase/functions/`**. Likely a legacy notification job from the original Phase-5 alert work that was never carried into the repo.
- The migration that scheduled it (`phase5_process_alerts_cron`) is on the remote-only list per `docs/MIGRATION_DRIFT_REMEDIATION.md`.

**Risk:** If the function ever processes data with side effects, it's running unaudited (no source review possible) and unauthenticated (no cron-secret gate). If it's idempotent and dead, it's still daily noise in `cron.job_run_details`.

**Recommended action:**
1. Pull the deployed function source: `supabase functions download process-alerts --project-ref <ref>`.
2. Review what it does.
3. Either: commit source + add `x-cron-secret` auth (treat as a real job), OR delete it: `SELECT cron.unschedule('process-alerts-daily')` + delete the edge function via dashboard.
4. Update `docs/ops/OPERATOR_PLAYBOOK.md` cron-verification table accordingly.

Cross-reference: this is part of the broader migration-drift remediation in `docs/MIGRATION_DRIFT_REMEDIATION.md` (P1-10 in the same audit). When the operator runs `supabase db pull` with Docker, the phantom cron schedule will surface in the baseline; this entry can close once that's reconciled.

---

## Tracking

Surfaced 2026-05-03 during Phase 2 Path A smoke (items 1-4), Phase 2 Path A
follow-up (item 5), Phase 3 audit (items 6-7), Phase 3 close-out
forensics + smoke (items 8-10), Phase 4 close-out audit (item 11),
Phase 8 C1 (items 12-13), and audit P2-01 (item 15).
Filed by Claude per user direction. Each item should get its own commit
when fixed; reference this file in the message and remove the entry once
green.
