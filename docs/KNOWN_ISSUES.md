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

### Item #15: `process-alerts-daily` cron orphan — RESOLVED 2026-05-15

Surfaced during P2-01 audit follow-up: the `process-alerts-daily` cron had no `x-cron-secret` header, the target function had no source in the repo, and the function did no auth check of its own.

**Triage executed 2026-05-15:**
1. Downloaded the deployed function source via `supabase functions download process-alerts` and committed it to `supabase/functions/process-alerts/index.ts`. The function is real and functional — it evaluates `alert_rules` (8 active rules across 2 workspaces) and inserts `notifications` rows for triggered conditions. Not dead code.
2. Rewrote the function to add the canonical `x-cron-secret` check (matching `cleanup-expired-reports`, `send-counter-signature-reminder`, etc.). Reads `PROCESS_ALERTS_CRON_SECRET` from edge env.
3. Added `[functions.process-alerts] verify_jwt = false` to `supabase/config.toml` so deployments pin the auth mode.
4. Migration `20260515040000_process_alerts_cron_secret.sql` unschedules + reschedules `process-alerts-daily` with `x-cron-secret` forwarded from `private.cron_secrets`. Applied to live.
5. Generated a 46-char secret, set as edge env via `supabase secrets set PROCESS_ALERTS_CRON_SECRET=...`, and inserted into `private.cron_secrets` under id `process_alerts`.
6. Redeployed the function. Smoke tested live:
   - No header → 401 ✅
   - Wrong secret → 401 ✅
   - Correct secret → 200 `{"processed":0,"timestamp":"..."}` ✅
7. Updated `docs/ops/OPERATOR_PLAYBOOK.md` cron-verification table to remove the orphan flag.

`{"processed":0,...}` indicates no leases currently trip the configured alert rules. That's a separate question — investigate alert_rules thresholds vs. actual lease data if alerts are expected to be firing — but the cron + auth chain is healthy end-to-end.

---

## P1-10 baseline-exposed hardening regressions (2026-05-16)

The P1-10 baseline squash (`supabase/migrations/20260516120000_baseline_schema.sql`)
captured live production state verbatim. Three hardening guards that were
supposed to be installed by archived migrations are missing from the live
schema — confirmed via direct `pg_policies` query on prod, not just dump
inspection. The baseline is faithful; production is the drift. Filed here
rather than fixed inline because each deserves its own scoped migration with
full reviewer routing.

Common root-cause hypothesis (unverified): either the relevant hardening
migration was never applied on prod despite being committed to repo, or it
was applied and silently reverted via Studio/MCP at some later point. The
`schema_migrations.created_by` audit trail was wiped during P1-10 reconcile,
so attribution is no longer queryable from the live DB — use
`docs/ops/schema_migrations_pre_baseline_2026-05-16.json` for historical
attribution lookups.

### Item #16: Governance audit INSERT policy reverted to pre-hardening state

**Symptom:** Hardening migration `_archive/20260426000003_audit_remediation.sql`
swaps `"workspace members can insert governance audit"` (any member can
INSERT) for `"governance audit is service role append only" WITH CHECK
(false)`. Live `pg_policies` shows the old permissive policy still active
and the hardened one missing. Any workspace member can fabricate
`lease_governance_audit` rows via direct PostgREST INSERT.

**Severity:** Critical. `lease_governance_audit` is the system of record
for unlock / change-set / relock events. Any tampering invalidates
audit-defensible attribution.

**Where to look:**
- Live state: `SELECT polname, with_check FROM pg_policies WHERE tablename = 'lease_governance_audit';`
- Hardened policy SQL: `supabase/migrations/_archive/20260426000003_audit_remediation.sql`
- `audit_rls_smoke_check()` checks for the hardened policy name and would
  return FALSE for the `governance_audit_append_only` key today — built-in
  detection has been silently failing because nothing calls the smoke check
  on a schedule. Consider wiring it as a cron with alerting.

**Stub follow-up migration (`<ts>_restore_governance_audit_hardening.sql`):**

```sql
DROP POLICY IF EXISTS "workspace members can insert governance audit" ON public.lease_governance_audit;
DROP POLICY IF EXISTS "governance audit is service role append only" ON public.lease_governance_audit;
CREATE POLICY "governance audit is service role append only"
  ON public.lease_governance_audit FOR INSERT TO authenticated
  WITH CHECK (false);
```

**Pre-apply checklist:**
- Verify all current writers to `lease_governance_audit` use service_role
  (edge functions, not browser code). If any browser path inserts directly,
  the hardening breaks it.
- Route through `lease-repository-integrity-reviewer` and `lease-test-author`
  (regression test asserting the hardened policy exists in production).
- Post-apply: confirm via `audit_rls_smoke_check()`.

**Decision:** Filed not fixed. P1-10 scope is migration-chain hygiene;
surfacing a Critical governance regression mid-squash conflates two
distinct workstreams.

### Item #17: Change-set UPDATE policy missing draft-only status guard

**Symptom:** Hardening migration `_archive/20260426000004_governance_rls_tighten.sql`
was supposed to restrict `lease_change_sets` UPDATE to drafts only — once
status flips to `pending_approval`, submitters should not be able to edit
proposed values. Live `pg_policies` shows the unrestricted policy
`"submitters and approvers can update change sets"` (no status check in
USING clause). A submitter can modify a change set after submitting it for
approval, altering values the approver may have already reviewed.

**Severity:** Critical. Defeats the staged-approval premise — what the
approver reads at decision time may not be what they were notified about.

**Where to look:**
- Live state: `SELECT polname, qual FROM pg_policies WHERE tablename = 'lease_change_sets' AND cmd = 'UPDATE';`
- Original hardened policy: `supabase/migrations/_archive/20260426000004_governance_rls_tighten.sql`

**Stub follow-up migration:** Add `AND status = 'draft'` to the USING
clause; mirror in WITH CHECK. Bundle with #16 into a single
`restore_governance_hardening` migration if scoped together. Same
root-cause investigation as #16.

**Decision:** Same as #16.

### Item #18: `lease-reports` storage RLS policies use `foldername(w.name)` instead of `foldername(objects.name)`

**Symptom:** The `"report owners insert lease-reports"` and
`"report owners update lease-reports"` RLS policies on `storage.objects`
reference `storage.foldername(w.name)` where `w` aliases `public.workspaces`.
`w.name` is the workspace's human-readable display name (e.g., "Labs
Analytix"), NOT the storage path. `storage.foldername("Labs Analytix")`
returns `['Labs Analytix']` (one element); `[2]` is NULL; comparison
always fails. The policies effectively `WITH CHECK (false)` for
client-side uploads.

**Severity:** High — with an unresolved practical-impact question.
Client-side PDF report uploads (`src/hooks/useGenerateLeaseReport.tsx:110-115`,
`src/hooks/useGeneratePortfolioReport.tsx:102-107`) call
`supabase.storage.from('lease-reports').upload(...)` which goes through
user-session RLS. **If RLS is being enforced as expected, every
authenticated user trying to generate a report should be hitting
"permission denied" today.** Two scenarios are possible:

1. **The feature is silently failing for everyone.** Would explain
   the absence of complaints if reports are rarely generated.
2. **Supabase storage has an additional access path bypassing Postgres
   RLS for some bucket configurations.** Possible if the storage
   container does its own auth check that short-circuits before falling
   through to Postgres RLS.

**Operational verification needed BEFORE writing the fix:** test report
generation as a non-admin authenticated user via the live app. If uploads
succeed, the broken policy is masked by an external bypass and the fix
is policy-correctness hygiene. If uploads fail, this is a P0 user-facing
bug.

**Where to look:**
- Live state: `SELECT policyname, qual FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname LIKE '%lease-reports%';`
- Companion file mirroring the bug:
  `supabase/migrations/20260516120001_storage_policies.sql` (this commit) —
  preserves prod state faithfully; not a regression introduced by P1-10.
- Original migration: `supabase/migrations/_archive/20260507000000_lease_reports_storage_insert.sql`
  — uses unqualified `name`, which in policy context
  (`FROM lease_reports lr LEFT JOIN workspaces w …`) is ambiguous between
  `objects.name` and `w.name`. `pg_dump` resolved it to `w.name`,
  suggesting Postgres resolves it the same way at policy-execution time.

**Stub follow-up migration:**

```sql
DROP POLICY IF EXISTS "report owners insert lease-reports" ON storage.objects;
CREATE POLICY "report owners insert lease-reports" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'lease-reports' AND EXISTS (
      SELECT 1 FROM lease_reports lr
      LEFT JOIN workspaces w ON w.id = lr.workspace_id
      LEFT JOIN workspace_members wm ON wm.workspace_id = lr.workspace_id AND wm.user_id = auth.uid()
      WHERE lr.id::text = (storage.foldername(objects.name))[2]
        AND lr.workspace_id::text = (storage.foldername(objects.name))[1]
        AND lr.pdf_storage_path IS NULL
        AND (lr.generated_by = auth.uid() OR w.owner_id = auth.uid() OR wm.role = 'admin')
    )
  );
-- mirror for UPDATE policy
```

**Decision:** Same as #16/#17 — filed not fixed. Fix needs operational
verification of the silent-failure-vs-bypass question first.

---

## Governance hardening follow-up review (2026-05-16, items #19-23)

Surfaced during reviewer pass on the second iteration of the governance
hardening migration (`20260517000000_governance_hardening_followup.sql`).
The current beat closes #16 + #17; these five are scope-adjacent findings
that surfaced during review but were deliberately not bundled. Each gets
its own scoped beat with its own reviewer routing.

### Item #19: `cancel_change_set` two-UPDATE sequence is non-atomic

**Symptom:** `supabase/functions/lease-governance-action/index.ts:748-758` (cancel_change_set action) performs two sequential UPDATEs: one on `lease_change_sets` (status → 'canceled'), then one on `leases` (re-lock). If the second UPDATE fails (network partition, transient DB error), the change set is canceled but the lease stays unlocked indefinitely. No compensating audit event is written. Pre-existing pattern not introduced by P1-10 or its follow-ups.

**Severity:** Medium. Customer-visible (lease stays in unlocked-but-canceled limbo) but rare (requires Supabase JS client second-update failure between two same-session calls). No data corruption, just orphan state.

**Where to look:**
- `supabase/functions/lease-governance-action/index.ts:748-758` — the unprotected two-UPDATE block.
- Same pattern likely exists in other state-transition actions in the same file (`submit_change_set`, `approve_change_set`, `reject_change_set`); audit for consistency.

**Stub follow-up migration / fix:** Either wrap both UPDATEs in a single Postgres RPC SECURITY DEFINER function called via `supabase.rpc()`, OR add explicit error-checking on the second UPDATE that emits a compensating audit event and 500-response on failure. Cleaner choice is RPC; rolls both into one transaction.

**Decision:** Filed not fixed. Pre-existing pattern, not in the named scope of #16/#17.

### Item #20: `audit_rls_smoke_check()` doesn't assert `relrowsecurity = true` on governance tables

**Symptom:** The smoke check function asserts policies EXIST but not that RLS is ENFORCED. If a Studio operator (or future ALTER TABLE) sets `relrowsecurity = false` on `lease_governance_audit`, `lease_change_sets`, or `lease_change_set_items`, all RLS policies become irrelevant and the smoke check would still return all keys = true.

**Severity:** Medium. Low probability (disabling RLS is an obvious destructive action) but completely defeats the hardening if it happens.

**Where to look:**
- `audit_rls_smoke_check()` function body in `supabase/migrations/20260517000000_governance_hardening_followup.sql`. Add assertions like:
```sql
'lease_governance_audit_rls_enabled', (
  SELECT relrowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'lease_governance_audit'
),
```
- Same for `lease_change_sets`, `lease_change_set_items`. Three keys total to add.

**Decision:** Filed not fixed. Additive defense-in-depth; not blocking the current beat's named scope.

### Item #21: `lease_unlock_requests` UPDATE policy is not asserted by smoke check; potential same-class gap as #17

**Symptom:** The smoke check asserts SELECT policy `'workspace access can view unlock requests'` exists on `lease_unlock_requests`, but does NOT assert that UPDATE is restricted to service_role or admin only. If an authenticated user can PATCH their own request's `status='approved'` via PostgREST, they bypass the admin-review approval gate.

**Severity:** Medium (pending live verification — may be High). Same attack class as #17 but on a different governance table.

**Where to look:**
- Live: `SELECT polname, cmd FROM pg_policies WHERE tablename = 'lease_unlock_requests';` — confirm whether an UPDATE policy exists and whether it gates writes to service_role/admin.
- If no UPDATE policy exists: implicit deny for non-service-role is the current posture — same condition as `lease_governance_audit` UPDATE. Worth documenting explicitly. If a permissive UPDATE policy exists: that's an active vulnerability — escalate to High.

**Stub follow-up:** Audit the table's policy surface first; if a gap is found, write a `restore_unlock_request_hardening` migration that adds the appropriate UPDATE policy AND extends `audit_rls_smoke_check()` with name-based + content-based assertions (same pattern as #16/#17).

**Decision:** Filed not fixed pending verification. Out of the current beat's named scope.

### Item #22: `audit_rls_smoke_check()` `GRANT EXECUTE TO authenticated` leaks security posture

**Symptom:** Function is granted to `authenticated`, meaning any workspace member can call `SELECT public.audit_rls_smoke_check()` and learn which RLS policies and security triggers are present or absent in production. The function returns boolean values only (not policy text), so the leak is structural ("these checks are in place" / "these are not") — useful reconnaissance for someone probing the security surface, not direct data exfiltration.

**Severity:** Low. Information-disclosure rather than authorization bypass. Originally flagged by security scanner as M2 during the first P1-10 review round; explicitly deferred in the follow-up scope per session decisions to avoid scope creep. Tracked here so the decision isn't held in conversational memory.

**Where to look:**
- `supabase/migrations/20260517000000_governance_hardening_followup.sql` line 470: `GRANT EXECUTE ON FUNCTION public.audit_rls_smoke_check() TO authenticated`.
- Caller analysis: `scripts/smoke-audit-hardening.mjs` runs as service_role (uses SERVICE_ROLE_KEY) and does not need the `authenticated` grant. No frontend code calls this function. Tightening to `service_role`-only would not break any current consumer.

**Stub follow-up migration:** `REVOKE EXECUTE ON FUNCTION public.audit_rls_smoke_check() FROM authenticated;` (the `TO service_role` grant from the follow-up migration remains).

**Decision:** Filed not fixed. Information-disclosure level; not blocking the current beat.

### Item #29: `enforce_workspace_entitlement_guard` trigger missing from prod — **RESOLVED 2026-05-23** (billing-bypass vector, severity High)

**RESOLVED 2026-05-23** — `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` was applied to the live production project (`wwkwoxxcprnjjufkbzac`) via `supabase db push` on 2026-05-23, closing the bypass.

The change was verified local-first before prod was touched. A clean `supabase start` replayed the full migration chain from scratch with no baseline errors; the four static verification queries passed 4/4 (trigger present, the UPDATE policy carries `WITH CHECK (owner_id = auth.uid())`, defaults corrected to `'starter'/15`, and the `workspace_entitlement_guard` smoke key true); and all five behavioral scenarios in `supabase/tests/workspace_entitlement.test.sql` passed 5/5 — billing UPDATE escalation blocked across all 9 guarded columns, a non-billing settings UPDATE allowed through, the INSERT baseline pin enforced, the service_role promotion path working, and ownership reassignment blocked.

Live pre-apply introspection (read-only) confirmed both that the target matched expectations and that the bug was real: all 9 guarded columns were present on `public.workspaces` with the expected types/nullability, the UPDATE policy `"Owners can update their workspaces"` was present by that exact name with a NULL `with_check` clause (the literal #29 gap), and `audit_rls_smoke_check()` returned `workspace_entitlement_guard: false`. `supabase db push --dry-run` then listed exactly one pending migration (`20260522000000`) — no drift to reconcile as a separate beat. The real `supabase db push` completed cleanly, emitting only the expected `NOTICE` on `DROP TRIGGER IF EXISTS` (the idempotency guard firing because the trigger did not pre-exist on prod).

Live post-apply verification confirmed the fix landed: the trigger `enforce_workspace_entitlement_guard` is now present alongside `update_workspaces_updated_at`, the UPDATE policy now carries `WITH CHECK (owner_id = auth.uid())`, the column defaults are now `'starter'/15`, and the `workspace_entitlement_guard` smoke key flipped false → true. As cross-validation, the unrelated governance keys (`governance_unlock_policy`, `governance_change_set_policy`) remained false on both local and live — confirming the migration was correctly scoped to `public.workspaces` and changed nothing outside it.

The bypass that was verified exploitable on 2026-05-17 is no longer exploitable as of 2026-05-23. PR #34.

**FIX READY 2026-05-22** — migration `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` written and reviewer-cleared (security / repository-integrity / test-author). NOT yet applied: the bypass remains live in prod until the migration runs and the smoke check confirms `workspace_entitlement_guard: true`. Promote to RESOLVED after prod apply.
- **Meta-question answered first (per the agenda below):** the archived migration was *committed but never applied* — not applied-then-reverted. Version `20260426000003` is absent from `docs/ops/schema_migrations_pre_baseline_2026-05-16.json`; the trigger is absent from the `20260516120000` baseline dump; the file was moved into `_archive/` (CLI-skipped) during the squash. Same class as #16/#17/#25, all remediated with new active-dir migrations. Conclusion: a standard new restoration migration suffices; no constraint/CI-tripwire required.
- **As-built (hardened scope, decisions ratified 2026-05-22):** (1) column defaults aligned `'pro'/3 → 'starter'/15` (pricing reconciliation + the Onboarding contract; required so the INSERT guard and the defaults agree, else onboarding INSERTs would be rejected); (2) `prevent_workspace_entitlement_edits()` BEFORE INSERT/UPDATE trigger restored with the canonical `COALESCE(auth.role(),'') = 'service_role'` carve-out, guarding **9** columns: plan, document_limit, documents_used, billing_interval, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_period_end, **max_archived_leases** (added in-beat per security-review finding M1 — a tier entitlement read DB-first in `AppContext.tsx:184`; verified no authenticated writer); (3) UPDATE policy re-created with `WITH CHECK (owner_id = auth.uid())`, closing the literal gap and blocking ownership reassignment. `intended_plan` intentionally left writable (abandoned-checkout recovery).
- **Tests:** static `src/lib/__tests__/workspaceEntitlementGuard.test.ts` (narrowed-window assertions) + behavioral `supabase/tests/workspace_entitlement.test.sql` (5 scenarios, staging-only). Full vitest suite 443/443. Stale `Onboarding.tsx` comment updated to reference 20260522000000.
- **Pre-push review:** routed through stand-in general-purpose agents in the security / repository-integrity / test-author charters (the named `lease-*` subagents referenced in CLAUDE.md are absent from the repo — flagged separately). Converged clean over two rounds; the one Medium (M1) was folded in; no Critical/High.
- **Smoke check:** no `audit_rls_smoke_check()` change — the `workspace_entitlement_guard` key (defined in 20260517000000) flips false→true on apply, which is the success signal.
- **Apply checklist (remaining):** staging apply → `audit_rls_smoke_check()` shows the key true (no other key regressed) → exploit re-test (authenticated PATCH plan='business' rejected) → onboarding + service-role-webhook regression → prod apply → re-run smoke on prod → then stamp RESOLVED.

**Symptom:** First post-apply run of `audit_rls_smoke_check()` after the governance hardening follow-up landed (commit `896f4ed`, 2026-05-16) returned `workspace_entitlement_guard: false`. The Category A key asserts a BEFORE-UPDATE trigger named `enforce_workspace_entitlement_guard` exists on `public.workspaces`. Live `pg_trigger` query (2026-05-17) confirms the trigger does not exist on prod. The trigger was defined in archived migration `_archive/20260426000003_audit_remediation.sql` which never applied to live — same silent-non-application pattern as #16, #17, and #25.

**Severity: High (verified exploitable 2026-05-17).** Initially filed as "Medium pending live verification — may be High." Live verification confirmed the exploit path is open: the only UPDATE policy on `public.workspaces` is `"Owners can update their workspaces"` with `USING (owner_id = auth.uid())` and **no WITH CHECK clause** — any authenticated workspace owner can PATCH any column on their own workspace row via PostgREST, including billing columns. Exploitable today by anyone with a workspace.

**Exploit chain:**
1. Workspace owner sends `PATCH /rest/v1/workspaces?id=eq.<their_id>` with body `{"plan": "business", "document_limit": 9999, "subscription_status": "active", "subscription_period_end": "2030-01-01"}`.
2. PostgREST RLS USING check passes (owner_id matches). No WITH CHECK gate. UPDATE succeeds.
3. Application now reads `plan='business'`. Business-tier features (per CLAUDE.md Strategic Rule 7: embedded AI assistant, portfolio intelligence, amendment comparison, custom approval playbook, audit package generator) all become accessible.
4. `document_limit` becomes effectively unlimited. Every lease upload triggers Claude Opus extraction (~$1-3 per document per CLAUDE.md cost model) at LeaseIO's cost.
5. Stripe webhook never sees the change — billing infrastructure is bypassed entirely.

**Billing columns currently exposed on `public.workspaces`** (no column-level grant restriction, no trigger guard):
- `plan` (text, NOT NULL, default 'pro')
- `document_limit` (integer, NOT NULL, default 3)
- `stripe_customer_id` (text, nullable)
- `stripe_subscription_id` (text, nullable)
- `subscription_status` (text, nullable)
- `subscription_period_end` (timestamptz, nullable)
- `intended_plan` (text, nullable)

**Where to look:**
- Live trigger absence: `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.workspaces'::regclass AND NOT tgisinternal;` returns only `update_workspaces_updated_at`.
- Live policy: `SELECT polname, qual::text, with_check::text FROM pg_policies WHERE tablename = 'workspaces' AND cmd IN ('UPDATE', 'ALL');` confirms permissive single policy.
- Archived intent: `_archive/20260426000003_audit_remediation.sql` for the original trigger + function definitions.

**Stub follow-up:** Restore the trigger + function from the archived definition under pre-push reviewer routing per the rule added to CLAUDE.md this session. Verify the archived version's column list matches the current schema (billing columns may have evolved). Optionally: add column-level REVOKE on the billing columns as defense-in-depth.

**Decision:** Filed not fixed in the originating beat (governance hardening completion), but **escalated immediately on live verification.** This is the next P0 beat — NOT bundled with #25 as previously suggested. The trigger-restoration scope is bigger and more urgent than the SELECT policy rename (#25), and warrants its own focused reviewer routing without being conflated with cosmetic cleanup.

**Surfaced by the smoke check at the exact moment the migration intended** — this is the design working as advertised. The fact that the smoke check was rebuilt to its full key set in commit `896f4ed` (after weeks of being shrunk to 4 keys by 20260516130000) is what made this visible. Concrete validation of the "Restoring a previously-shrunk drift-detection function will surface drift on its first run" lesson added to CLAUDE.md the same session.

---

#### Post-verification work done 2026-05-17 (so tomorrow's session inherits without re-investigation)

**Audit 1 — exploitation detection on live `public.workspaces`:** zero suspicious external rows. Three sub-queries run (status='active' AND no Stripe sub; paid plan AND no Stripe customer; high document_limit AND no Stripe). Two rows flagged, **both owned by `daniel.c.priest@gmail.com`** (auth.users id `c2dbf842-1021-4b1d-a59f-df2ecc575d8e`):
- **"Labs Analytix"** (`c9dad4c7-...`): plan=`business`, document_limit=50, no Stripe. Known-legitimate dev/test workspace — Daniel manually set business tier for access to business-tier code paths (embedded AI assistant, etc.) without paying his own Stripe account. Common project-owner-dev pattern; not exploitation.
- **"My Workspace"** (`b0f3c7a0-...`): plan=`pro`, document_limit=3. **False positive in the query** — `'pro'` is the column default (`column_default: 'pro'::text`) and `normalizePlanId` coerces to `'starter'` on read. Default-state workspace, not tampered.

**Verdict: exposure, not incident.** The bypass has been live since ~April 2026; zero customer exploitation observed. No emergency mitigation warranted.

**Audit 2 — legitimate authenticated writers on the 7 billing columns:** one only.
- `src/pages/app/Onboarding.tsx:83-91` writes `intended_plan: selectedPlan` on **INSERT** (not UPDATE). The code's own comment at lines 75-79: *"Always create the workspace at Starter defaults. The entitlement-guard trigger in migration 20260426000003 rejects any authenticated insert that diverges from those defaults, so we omit plan / document_limit and let the DB defaults apply. Stripe checkout + the signed webhook (service role, which bypasses the trigger) own the promotion to Business. intended_plan persists the user's declared choice so AccountSettings can recover an abandoned Business checkout."* The frontend was written **assuming the trigger exists** — i.e., the frontend already operates as if the missing protection were in place.
- No authenticated UPDATE writers on any of the 7 billing columns (`plan`, `document_limit`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_period_end`, `intended_plan`). All other `.from('workspaces').update(...)` call sites touch only `name`, `timezone`, `report_*`, `default_notification_days`, `counter_signature_default_due_days`, `separation_of_duties_default` — non-billing.

**Audit 3 — full inventory of `public.workspaces`:** clean except for the missing trigger. 4 policies + 1 trigger total:
- POLICY `Owners can delete their workspaces` — DELETE, `owner_id = auth.uid()`
- POLICY `Owners can update their workspaces` — UPDATE, `owner_id = auth.uid()`, **no WITH CHECK**
- POLICY `Users can create workspaces` — INSERT, `owner_id = auth.uid()`
- POLICY `Users can view workspaces they own or are members of` — SELECT
- TRIGGER `update_workspaces_updated_at` — BEFORE UPDATE, just the timestamp updater

No other drift. Mitigation scope is narrow: restore the one missing trigger.

#### Design points for the next-beat migration (carry into the entitlement-guard beat)

- **Trigger must be BEFORE INSERT OR UPDATE, not just UPDATE.** The archived version (`_archive/20260426000003_audit_remediation.sql`) was designed to cover both. Confirm by reading the archived definition.
- **`intended_plan` must remain authenticated-writable on INSERT** (Onboarding.tsx's legitimate path) while the entitlement-state columns (`plan`, `document_limit`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_period_end`) must reject authenticated divergence from defaults on INSERT and any change on UPDATE. Same service-role-carve-out pattern as the trigger shipped in 20260517000000 (`COALESCE(auth.role(), '') <> 'service_role'`).
- **Frontend changes likely unnecessary.** Onboarding.tsx is already written for the trigger's presence (omits plan/document_limit on INSERT, expects DB defaults). Stripe webhook (`supabase/functions/stripe-webhook/index.ts:109-111`) uses service_role and bypasses the trigger. No browser writers to break.
- **Smoke check key already exists** (`workspace_entitlement_guard` in `audit_rls_smoke_check()`), so no smoke check changes needed — the existing key flips from FALSE to TRUE post-apply, which is the success signal.
- **Pre-apply checklist (per the rule added to CLAUDE.md this session):** pull `pg_attribute` for live `workspaces` columns; categorize every column into universal-immutable / service-role-only / authenticated-mutable; surface ambiguities; derive trigger code from categorization. Workspaces table has more columns than `lease_change_sets` (report settings, discount rate, region/department options, etc.) — the categorization will be longer.

#### Meta-question — first agenda item for the next-beat session, BEFORE writing any SQL

`_archive/20260426000003_audit_remediation.sql` has now produced four distinct vulnerabilities (#16, #17, #25, #29) because it "never applied to prod." We don't actually know why. Possibilities:
- Migration was applied then Studio-reverted (someone clicked "drop policy" in Studio after)
- Migration was added to the repo but never run via `db push` (the apply step was skipped)
- Migration ran but failed mid-execution and rolled back without reaching the trigger/policy creates
- Migration ran on a different branch / staging env but not prod

Before restoring more pieces of this archived migration, the next session should investigate the mechanism. If the same thing that prevented original apply is still active, restoration migrations may face the same fate. Possible investigation paths:
- `git log --follow --diff-filter=A` on the archived file to see when it was first committed
- Check `docs/ops/schema_migrations_pre_baseline_2026-05-16.json` (the captured pre-reconcile state) — was the migration's version timestamp present? If yes, it was applied at some point. If no, it was committed but never applied.
- Studio audit log if accessible (may not be retained that long)
- Cross-reference with Daniel's calendar / Linear / Slack around the original commit date

**Do this investigation FIRST. If the migration was applied-then-reverted, the restoration needs an additional defense (e.g., constraint instead of trigger, or a CI check that detects re-removal). If it was simply never applied, the standard restoration is sufficient.**

---

### Item #28: `lease_change_sets` INSERT policy is permissive — submitters can craft `change_summary` at INSERT time

**Symptom:** Round 5 integrity reviewer surfaced that `prevent_change_set_field_tampering` is BEFORE UPDATE only — does not fire on INSERT. Live `pg_policies` confirms the INSERT policy `"workspace members can create change sets"` permits any workspace member to INSERT a `lease_change_sets` row directly via PostgREST with arbitrary column values, including a fabricated `change_summary`. The approver then sees a misleading summary on the pending_approval queue. Live grep of `src/` confirms zero browser-side `.insert()` calls to this table — every legitimate INSERT goes through `lease-governance-action/index.ts:192-200` using service_role, which bypasses RLS regardless.

**Severity:** Medium.

**Where to look:**
- Live: `SELECT polname, qual::text, with_check::text FROM pg_policies WHERE tablename = 'lease_change_sets' AND cmd = 'INSERT';` confirms the permissive policy.
- Edge function: `supabase/functions/lease-governance-action/index.ts:192-200` is the sole legitimate INSERT writer (service_role).
- Frontend grep: no `.from('lease_change_sets').insert(` calls in `src/` confirms no browser-side writer.

**Attribution asymmetry vs the UPDATE vector that #16/#17/the trigger closed:** the `prevent_change_set_field_tampering` trigger added in this beat makes `submitted_by` immutable post-INSERT. Even if an attacker exploits this INSERT vector to craft a misleading row, `submitted_by` is reliably the actual attacker's identity — they cannot hide behind a legitimate submitter's attribution. The UPDATE vector that #16/#17 closed was strictly more dangerous: it let attackers tamper with rows authored by other users, masking which user took which action. The INSERT vector here is "attacker can submit a misleading row under their own name" — still wrong, but the attacker's identity is captured truthfully in the audit chain. State this asymmetry explicitly so a future reader understands why #28 was filed-not-fixed despite being structurally similar to #21.

**Stub follow-up:** Audit the INSERT policy across all governance tables; if `lease_change_sets` and `lease_unlock_requests` (#21) both permit authenticated INSERTs where service_role is the only legitimate writer, write a `restore_governance_table_writers` migration that (a) drops the permissive INSERT/UPDATE policies, (b) optionally adds explicit service_role-only policies for clarity, and (c) extends `audit_rls_smoke_check()` with assertions per the parent's `change_set_only_one_update_policy` pattern.

**Decision:** Filed not fixed. Symmetric structural choice to #21 — pre-existing baseline permissiveness on a different write op (INSERT here, UPDATE on #21), same fix shape, same scope discipline. The "scope discipline" rule has to hold when bundling would be convenient, otherwise it's not a rule.

**Suggested next-beat bundling:** #21 and #28 are mechanically identical fixes — tighten policy to service_role-only writers, verify no browser path, add smoke check assertion. Both deserve to be bundled into a single "governance-table writers tightening" beat rather than fragmented across two beats. The next-beat planner should treat them as one workstream.

---

### Item #27: Static migration-file tests may have naive-`toContain` false-positive pattern

**Symptom:** Round 5 test-author surfaced that the Round 3 trigger-function test used `expect(migration).toContain('SECURITY DEFINER')` on the full migration file — which passed not because the trigger function had `SECURITY DEFINER` (it didn't, and shouldn't) but because `audit_rls_smoke_check()` (a separate function later in the same file) does. The test was providing false assurance that the trigger ran with elevated privileges; if SECURITY DEFINER had been added to the trigger by accident, the test would still have passed. Fixed in Round 5 by narrowing the assertion window to the function's declaration block.

**Severity:** Medium. This is a TEST-BUG class — tests pass for the wrong reason. The same pattern may exist elsewhere in `src/lib/__tests__/auditRemediation.test.ts`, `src/lib/__tests__/lockedLeaseLayout.test.ts`, or any other static-migration-file test that uses `toContain` on a full file with multiple functions/policies/triggers. Any assertion about a specific named function/policy/trigger is suspect if the search isn't narrowed to that named object's declaration block.

**Where to look:**
- All test files matching `src/**/__tests__/*.test.ts` that read migration files via `readFileSync` and assert via `toContain`.
- Particularly: anywhere a property is asserted of a specific named function/policy/trigger (e.g., "function X has SECURITY DEFINER", "policy Y uses WITH CHECK false", "trigger Z fires BEFORE UPDATE"). If the search isn't narrowed to that object's declaration via regex or substring extraction, the assertion may pass on an unrelated object with the same property.

**Stub fix pattern (already applied in Round 5 to one test):**

```typescript
// Narrow to the named function's declaration window before asserting.
const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.target_function_name()');
const fnEnd = migration.indexOf('AS $$', fnStart);
const declarationBlock = migration.slice(fnStart, fnEnd);
expect(declarationBlock).not.toContain('SECURITY DEFINER');
```

**Decision:** Filed not fixed. Auditing every static-migration-file test for this pattern is its own beat — needs systematic walkthrough of every `toContain` against multi-object migration files. The Round 5 fix to the specific finding is in place; broader sweep deferred to a focused test-hygiene beat. Bundling here would expand scope from "governance hardening complete" to "audit all static tests for assertion-narrowing."

---

### Item #26: `scripts/smoke-audit-hardening.mjs` fails CI on any false return, including documented Category A drift candidates

**Symptom:** The smoke script iterates every key returned by `audit_rls_smoke_check()` and exits 1 on any key that isn't true. Migration `20260517000000_governance_hardening_followup.sql` documents that `governance_unlock_policy` and `governance_change_set_policy` (Category A drift candidates) will return FALSE on first smoke run post-apply — the named SELECT policies were never applied to prod under those names (see #25). The script has no concept of "expected drift" — once the 4 SUPABASE_* GitHub Actions secrets are configured, the CI smoke step will fail-close immediately on every push until #25 is resolved.

**Severity:** Medium. Not blocking today because the secrets aren't configured (the smoke step is silently skipped at `.github/workflows/ci.yml`). Becomes blocking the moment secrets are wired AND #25 hasn't been resolved AND no expected-false allowlist has been added.

**Where to look:**
- `scripts/smoke-audit-hardening.mjs:52` — `const failedChecks = Object.entries(result).filter(([, passed]) => passed !== true);`. The filter has no notion of categories.
- `.github/workflows/ci.yml` lines 70-82 — the conditional skip on missing secrets.

**Two stub remediation options:**

(a) **Script-level allowlist (recommended, more durable):** add an `SMOKE_EXPECTED_FALSE` env var (comma-separated key names) that the script reads and excludes from the fail filter, logging them as "expected drift" rather than failures. Configured per-environment via CI secrets / dotenv.

(b) **CI workflow conditional (simpler, more coupling):** keep the smoke step skipped until #25 lands, add a comment in `ci.yml` referencing #25. Then unblock manually after the rename migration applies.

Pre-apply order matters: secrets wiring depends on knowing #25 + #26 are both green. If secrets get wired before either is resolved, the smoke step blocks all pushes to main.

**Decision:** Filed not fixed. The smoke script + CI wiring is its own workstream (the smoke-test-secrets configuration decision is also still open from the prior pre-launch checklist). Bundling here would expand this beat from "governance hardening complete" into the broader CI-integration territory.

**RESOLVED 2026-06-14** — closed differently than the two stub options. Live inspection found SIX false keys, not the two predicted — and they were **stale assertions, not "expected drift" to allowlist**: 4 because the Vault V1 read-only RESTRICTIVE policies tripped the `*_only_one_*_policy` duplicate-grant tripwires, 2 from the #25 name divergence. So the correct fix was the function, not an allowlist (option a) or a CI skip (option b). Migration `20260614000000_smoke_check_vault_restrictive_and_name_alignment.sql` adds `AND permissive = 'PERMISSIVE'` to the 5 `*_only_one_*_policy` checks (a RESTRICTIVE policy can only narrow access, never grant it, so it can't be a grant-bypass; an unexpected PERMISSIVE grant incl. FOR ALL still trips) and aligns the 2 governance_*_policy assertions to the live names (#25). Applied + verified live: **26/26 keys true**. All 4 `SUPABASE_*` Actions secrets wired (2 URLs + 2 service-role keys, repo Actions scope). **Green CI run confirmed end-to-end** (run 27520431813): "Verify smoke-test secrets on main" + "Security hardening smoke test" both pass — the governance net now actively guards every main push (previously silently skipped). Reviewers: security + integrity APPLY (no Critical/High/Medium). Test: `src/lib/__tests__/smokeCheckVaultRestrictive.test.ts`. PR #43.

---

### Item #25: SELECT policy rename on `lease_unlock_requests` + `lease_change_sets` was never applied to prod

**Symptom:** The archived migration `_archive/20260426000003_audit_remediation.sql` (lines ~200-220) intended to rename two SELECT policies from `"workspace members can view ..."` to `"workspace access can view ..."` — the latter name being more semantically accurate for the hardened workspace-membership-via-`is_workspace_member`-helper pattern. That archived migration never applied to prod (same silent-non-application class as #16 and #17). Live DB has the old `"workspace members can view"` names. Functionally equivalent — both grant SELECT to workspace members via the same predicate logic — but the smoke check function `audit_rls_smoke_check()` asserts the NEW names (`governance_unlock_policy` and `governance_change_set_policy` keys), so both return FALSE on every smoke run.

**Severity:** Low. The SELECT policies under the old names provide equivalent access control (workspace members can read). This is a name-divergence issue, not a vulnerability. The smoke check's two false returns are documented in the migration header (Category A — drift) so they don't trigger the "stop immediately" Category B procedure.

**Where to look:**
- Archive: `supabase/migrations/_archive/20260426000003_audit_remediation.sql` lines ~200-225 for the intended CREATE POLICY statements.
- Live state: `SELECT polname FROM pg_policies WHERE tablename IN ('lease_unlock_requests', 'lease_change_sets') AND cmd = 'SELECT';` shows the old names.
- Smoke check assertions in `supabase/migrations/20260517000000_governance_hardening_followup.sql` reference the new names; these are the FALSE keys.

**Stub follow-up migration (`<ts>_rename_governance_select_policies.sql`):**

```sql
-- Drop old names, recreate under hardened names. Predicates should match
-- the archived hardening intent (workspace_member via is_workspace_member
-- helper, NOT the older workspace_id IN (SELECT ...) pattern).
DROP POLICY IF EXISTS "workspace members can view unlock requests" ON public.lease_unlock_requests;
DROP POLICY IF EXISTS "workspace members can view change sets" ON public.lease_change_sets;

CREATE POLICY "workspace access can view unlock requests"
  ON public.lease_unlock_requests FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace access can view change sets"
  ON public.lease_change_sets FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));
```

**Pre-apply checklist:** verify the archived predicate against the live ones — if they actually differ (not just by name), this isn't a pure rename and the substance of the difference needs reviewer routing. After apply, move `governance_unlock_policy` and `governance_change_set_policy` from Category A → Category B in the smoke check function header to restore the "MUST return true" posture for those keys.

**Decision:** Filed not fixed. Rename is its own scoped beat. Bundling here would have required: (a) verifying the archived predicate matches the live one byte-for-byte (or surfacing the substance of any difference), (b) routing through reviewers for the substantive change, and (c) accepting that 2 of the 3 fixes in this beat are scope-adjacent rather than direct closures of #16/#17. Cleaner to file and address.

**RESOLVED 2026-06-14** — resolved by **aligning the smoke assertion to the live state rather than renaming the live policies** (lower risk; the never-applied `"workspace access can view ..."` rename is abandoned). The live `"workspace members can view ..."` SELECT policies grant identical workspace-member access via `is_workspace_member` — a name divergence, not a vulnerability — so migration `20260614000000` points `governance_unlock_policy` / `governance_change_set_policy` at the live names. Verified live: both policies present, both keys now true (part of the 26/26 in #26). Folded into the #26 fix + PR #43.

---

### Item #24: Governance hardening lacks behavioral SQL test (`supabase/tests/governance_hardening.test.sql`)

**Symptom:** The vitest static tests in `src/lib/__tests__/auditRemediation.test.ts` defend against in-repo migration-file drift (someone editing the file to remove a guard) — useful but not behavioral. The live-DB layer is covered by `scripts/smoke-audit-hardening.mjs` (`npm run smoke:security`) which calls `audit_rls_smoke_check()` and verifies all 23 assertion keys return true. **Neither layer actually exercises the trigger's RAISE EXCEPTION behavior** (insert row, attempt PATCH `workspace_id`, assert exception with expected ERRCODE) or the items policy's WITH CHECK rejection.

**Severity:** Medium. The trigger and items policies are correctly written and applied in production; behavioral verification is a defense-in-depth gap rather than a current vulnerability. The smoke check confirms the trigger EXISTS; it doesn't confirm Postgres ACTUALLY rejects the violating UPDATE.

**Where to look:**
- Add `supabase/tests/governance_hardening.test.sql` matching the pattern of `supabase/tests/phase8_disclosure_reports.test.sql` (typically 200-600 lines: setup → assertions → teardown). Cover:
  - Setup: workspace + lease + change set with non-NULL `submitted_by` and `workspace_id`.
  - Trigger test 1: `UPDATE lease_change_sets SET workspace_id = $other` → assert `RAISE EXCEPTION` with the documented message about workspace_id immutability.
  - Trigger test 2: `UPDATE lease_change_sets SET submitted_by = $other` (where OLD.submitted_by is non-NULL) → assert exception.
  - Trigger test 3: `UPDATE lease_change_sets SET change_summary = 'x'` (non-tampering field) → assert success (trigger doesn't fire on irrelevant columns).
  - Policy test 4: simulated authenticated submitter PATCH `status='pending_approval'` on own draft via `set_config('request.jwt.claims', ...)` → assert 0 rows updated (WITH CHECK rejects).
  - Items test 5: with parent set to `status='pending_approval'`, attempt `INSERT INTO lease_change_set_items (change_set_id, ...)` → assert WITH CHECK violation.
- Add to `supabase/tests/README.md` test matrix (alongside the existing 9 phase test files).

**Stub:** Pattern from `supabase/tests/phase8_disclosure_reports.test.sql:1-40` (header), `:50-150` (setup), `:200+` (DO blocks with `RAISE NOTICE 'PASS'`/`'FAIL <reason>'`). Run manually via `psql "$TEST_DATABASE_URL" -f supabase/tests/governance_hardening.test.sql` against a non-production database (local Supabase stack or staging branch).

**Decision:** Filed not fixed. The scope is genuinely separate: writing the full SQL test file requires 200-600 lines of new test infrastructure (setup/teardown/JWT-simulation fixtures matching the `supabase/tests/phaseN_*.test.sql` pattern) AND CI integration work that is itself blocked on resolving the "no non-prod environment available" status noted in `supabase/tests/README.md:7-27` (filed 2026-05-03 — pending a Pro plan upgrade or local Docker stack in CI). That's two distinct workstreams (test file authorship + test infrastructure wiring) on top of this beat's named security scope. Bundling would put migration review and test-infrastructure review on the same critical path — different review surfaces, different reviewer routing. Behavioral verification is the right call long-term and should land in a focused testing-infrastructure beat that owns both pieces.

---

### Item #23: Edge function audit-write helpers (`insertAudit`, `logActivity`) swallow errors silently

**Symptom:** `supabase/functions/lease-governance-action/index.ts:136-148` (`logActivity`) and `:150-157` (`insertAudit`) use `.then(({ error }) => { if (error) console.error(...) })` without propagating the error. If the audit INSERT fails (constraint violation, transient DB error, schema drift), the governance action still returns HTTP 200 to the caller. The state-change side of the operation (status flip, lease re-lock) succeeds; the audit row is silently missing. Pre-existing pattern.

**Severity:** Medium. The hardening migration tightens write policies on `lease_governance_audit` but does not close this application-layer fire-and-forget gap. An auditor asking "where's the approval record for change set X" can find nothing.

**Where to look:**
- `supabase/functions/lease-governance-action/index.ts:136-157` for the helper definitions.
- All callers of `insertAudit` and `logActivity` in the same file (search for the function names).
- Similar pattern likely exists in `request-lease-unlock/index.ts:138-146` per prior reviews; audit for consistency.

**Stub fix:** Promote audit-write failures to hard failures: `await` the insert and let the error propagate to the outer try/catch which returns 500 to the caller. OR (cleaner) wrap state-change and audit-write in a Postgres transaction via RPC so they succeed or fail atomically (same fix shape as #19).

**Decision:** Filed not fixed. Pre-existing pattern, not in the named scope of #16/#17. Worth bundling with #19 in a "edge function atomicity + error handling" beat.

---

### Item #30: `check-subscription/index.ts` referenced in CLAUDE.md file map but absent from repo

**Symptom:** CLAUDE.md's File-to-Feature Map ("Pricing & Billing") references `supabase/functions/{create-checkout,check-subscription,customer-portal}/index.ts`, and the #29 post-merge regression audit's Step 4 named `check-subscription` as the edge function that reads `plan`/`document_limit`. The file does not exist: `ls supabase/functions/check-subscription/index.ts` → No such file or directory; there is no `[functions.check-subscription]` stanza in `config.toml`; and `npm run check:edge-function-config` passes with 50 functions, none named `check-subscription`. Documentation/file-map drift, not a runtime bug — no code path imports or invokes it.

**Severity:** Low (documentation drift, not a runtime bug). No runtime impact: nothing depends on the missing function. Subscription state is written by `stripe-webhook` (service_role) and read client-side from the `workspaces` row.

**Where to look:**
- CLAUDE.md File-to-Feature Map, the "Pricing & Billing" line referencing `{create-checkout,check-subscription,customer-portal}`.
- `supabase/functions/` — `create-checkout` and `customer-portal` exist; `check-subscription` does not.
- `config.toml` — no `[functions.check-subscription]` stanza.

**Stub remediation:** Confirm whether `check-subscription` was removed intentionally. If so, update CLAUDE.md's file map to drop the reference (and sweep for any other stale mention). If it should exist (e.g., a planned subscription-status refresh endpoint), restore it under the Project Configuration Source-of-Truth rule.

**Decision:** Filed not fixed. Surfaced during the 2026-05-23 post-merge regression audit on the #29 fix (commits `66ac634` and `07eb2f7`) — pre-existing drift, NOT caused by either commit.

---

### Item #31: `documents_used` (workspaces quota counter) is a dead column; enforcement runs off live lease counts instead

**Symptom:** A full sweep (`grep -rni documents_used`, excluding `_archive`) finds zero code that increments or resets `workspaces.documents_used`. The only references are the column definition (`integer DEFAULT 0 NOT NULL` in the baseline), the #29 entitlement-guard's checks, and **reads** — `AppContext.tsx:215` exposes it as `documentsUsed`, surfaced in the UI (see Finding A). It is always `0`.

**Investigation (2026-05-24): the original "enforcement has no data source" premise was wrong.** Quota *enforcement* is wired — it just never used `documents_used`. Both the hard gate and the customer banner compute from **live `COUNT(leases)`**:
- Hard gate: `process_lease/index.ts:1051` `assertProcessingQuota()` (P1-03) blocks on `monthly_extractions` (leases with `uploaded_at` in trailing 30d + non-null `extracted_json`) and, for new leases, `active_leases` (`lifecycle_status='active' AND archived=false`). Rolling 30-day window ⇒ no calendar "monthly reset" needed either.
- Soft poller: `_shared/monitoring/workspace_quotas.ts:55` `pollWorkspaceQuotas()` computes the same counts → writes `workspace_quota_snapshots`.
- Banner: `QuotaWarningBanner.tsx:65` reads `workspace_quota_snapshots`, not the column.

So caps ARE enforced. The audit nonetheless surfaced two real, narrower residuals:

**Finding A — dead column drove a broken, always-zero usage meter (customer-facing, Medium). RESOLVED 2026-06-11.** `AppContext.tsx` read `documents_used` → `documentsUsed`; `AccountSettings.tsx` rendered it as a usage meter (`{documentsUsed} / {documentLimit}` + progress bar + 0.75/0.9 color thresholds). Because nothing writes the column, the meter always showed `0 / <limit>` — a customer at 14/15 abstractions saw "0 / 15". **As-built fix (deviation from the originally-suggested approach):** rather than repointing at `workspace_quota_snapshots`, `AppContext` now computes `documentsUsed` as a **live trailing-30-day count** (leases with `uploaded_at >= now-30d AND extracted_json NOT NULL`), exactly mirroring `process_lease`'s `assertProcessingQuota` window — so the customer meter and the server's hard gate can never disagree (no snapshot-staleness window). The dead `documents_used` was also removed from the AppContext select string + `WorkspaceRow` type (the DB column still exists, guarded by the #29 entitlement trigger; only the unused frontend fetch was dropped). Meter relabeled "AI Abstractions" with a rolling-window note. Reviewer-cleared (auditor/security/polish/test-author), 570 tests. The dead-column note above and Finding B below remain open.

**Finding B — overage *billing* is unimplemented (product/revenue gap, needs a product call).** `overagePerDoc` ($12/$10) exists only as display config in `pricing.ts:40,67`. No code reports metered usage to Stripe; the gate **hard-blocks at the included cap** with `reason: 'quota_exceeded'` → upgrade prompt, rather than metering-and-charging per-doc above the cap. Possibly intentional — block-at-cap protects the 75% margin floor — so this is a revenue-opportunity decision, not a bug. Scope as its own downstream beat if meter-and-charge is desired.

**Severity:** Low for the column itself (dead, harmless — quota enforcement does not depend on it). Medium for Finding A (misleading customer-facing meter, no money lost / usage blocked). Finding B is a product decision, not a defect.

**Note for any future real counter:** the #29 guard now actively *blocks* non-`service_role` writes to `documents_used`, so any increment/reset must run as `service_role` (or under `DISABLE TRIGGER`). But given enforcement already works off live counts, a dedicated counter column may be unnecessary — prefer fixing the meter (Finding A) over reviving the column.

**Decision:** Filed not fixed. Surfaced during the 2026-05-23 post-merge regression audit on the #29 fix (commits `66ac634`/`07eb2f7`); investigation completed 2026-05-24. Pre-existing, NOT caused by either commit. Findings A and B are independent follow-ups, neither blocking.

---

### Item #32: `LeaseReview.tsx` post/approve actions bypass the canonical audit trail — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — `handlePostLease` now sets `status_changed_at` in the same UPDATE and emits a `status_change` row to `lease_activity_log` with top-level `from_status`/`to_status`, mirrored shape inside `details`, and `routing_path: 'legacy'`. `handleApproveLease` now writes a first-class `approval` activity row alongside the existing `extracted_json._approval` write (so attribution is no longer overwritable by re-extraction). Verified via vitest (443 tests passing) and TypeScript typecheck.

**Symptom:** Two legacy direct-write actions on the lease-review workbench violate the Lifecycle Transition Convention. `handlePostLease` (`src/pages/app/LeaseReview.tsx:1373`) is the terminal "post to repository" action: it sets `lifecycle_status: 'active'` in the UPDATE but omits `status_changed_at`, and writes no `lease_activity_log` `status_change` row (only an inline `audit_log` JSON column on the lease). `handleApproveLease` (`src/pages/app/LeaseReview.tsx:1396`) persists approval only by spreading `_approval` into `extracted_json` — no activity-log row, and the sub-key is overwritable by the next extraction write.

**Severity:** High. The most audit-critical transition (lease going live) is invisible to the canonical audit log (the `AuditLog` page, stuck-lease detection, and dashboards key off `lease_activity_log` + `status_changed_at`), and `status_changed_at` goes stale. Directly undermines the "every change is attributable" promise. (Audit pass rated `handlePostLease` Critical; calibrated to High here — integrity/attribution gap, not data loss or security.) Verified 2026-05-24.

**Where to look:**
- `src/pages/app/LeaseReview.tsx:1373` (`handlePostLease`) and `:1396` (`handleApproveLease`).
- Convention reference: CLAUDE.md "Lifecycle Transition Convention"; compliant exemplars are the form-path writer (`LeaseRequestForm.tsx`) and the edge writer (`act-on-chain-step/index.ts` → `updateLifecycle()` + `logStatusChange()`).

**Stub remediation:** Add `status_changed_at: now()` to the post UPDATE and insert a `status_change` `lease_activity_log` row (top-level `from_status`/`to_status` + nested `details` + `routing_path: 'legacy'`). For approve, write a first-class `approval` activity row (user_id + timestamp) instead of burying it in `extracted_json`.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass). Pre-existing; not tied to a recent commit.

---

### Item #33: `process_lease` extraction flips `lifecycle_status → executed` without `status_changed_at` / status_change log — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — The post-extraction UPDATE at `supabase/functions/process_lease/index.ts` now (1) reads the prior `lifecycle_status` from the lease via a single targeted select before the UPDATE, (2) sets `status_changed_at` on the same UPDATE (reused for `processed_at` so both reflect the same transition instant), and (3) emits a `status_change` row to `lease_activity_log` with top-level `from_status`/`to_status`, mirrored shape inside `details`, and `routing_path: 'extraction'`. Verified via mirror-parity + edge-function-config drift checks + vitest.

**Symptom:** The new-upload completion UPDATE in `supabase/functions/process_lease/index.ts:2444` sets `lifecycle_status: 'executed'` but never bumps `status_changed_at` and never emits a `status_change` `lease_activity_log` row (it logs domain events like `executed_terms_extracted`, but not the lifecycle transition per convention).

**Severity:** High. Same class as #32 on the extraction path — lease enters `executed` with no attributable status_change record and a stale `status_changed_at`, breaking downstream consumers keyed on those fields.

**Where to look:**
- `supabase/functions/process_lease/index.ts:2444` (and audit any sibling lifecycle write in `retry_lease`).
- Use the `updateLifecycle()` + `logStatusChange()` helper pattern from `act-on-chain-step` if a Deno-side equivalent exists; otherwise inline both shapes per convention with `routing_path` (e.g. `'extraction'`).

**Stub remediation:** Add `status_changed_at` to the UPDATE and emit a `status_change` row (prior status → `executed`).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass). Pre-existing.

---

### Item #34: `useLifecycleWorkflow.ts` unused transition paths violate the convention (latent)

**Symptom:** `submitForApproval` (`src/hooks/useLifecycleWorkflow.ts:200`), `takeApprovalAction` (`:293-314`), and `submitForExecutionApproval` (`:467`) UPDATE `lifecycle_status` without `status_changed_at`; the `status_change` rows they write (`:221`, `:486`) omit `from_status` and `routing_path` (`:221` also omits the nested `details.from/to`). Per the audit, only `createDraftLease` from this hook is actually wired (via `NewLease.tsx`); the three offending functions appear to be dead code.

**Severity:** Latent (dead code today). Would be High if any path becomes live without remediation.

**Where to look:** `src/hooks/useLifecycleWorkflow.ts:200,221,293-314,467,486`; confirm wiring via grep before acting.

**Stub remediation:** Either delete the unused functions (preferred if confirmed dead) or bring them to convention before any caller is added.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #35: `process_lease`/`retry_lease` rent-schedule rebuild is non-atomic (can wipe a confirmed schedule)

**Symptom:** The rent-schedule rebuild does `rent_schedules.delete().eq(lease_id)` then re-inserts from fresh extraction (`supabase/functions/process_lease/index.ts:2540`, mirrored in `retry_lease`). The insert error is logged, not thrown (`:2557` `console.error`), so a partial failure leaves the prior schedule deleted with no rollback. Re-running extraction/retry on an already-reviewed lease silently replaces user-facing rent rows. Note `model_locked` only guards the executed-upload path, not retry.

**Severity:** Medium. Possible loss of confirmed rent-schedule rows on partial failure; overwrite-on-re-extract is partly by-design but unguarded on the retry path.

**Where to look:** `supabase/functions/process_lease/index.ts:2540-2557`; the equivalent block in `retry_lease/index.ts`.

**Stub remediation:** Insert-then-swap, or wrap delete+insert in a transactional RPC; treat insert error as fatal; consider extending the `model_locked` guard to the retry path.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #36: `process_lease` quota gate is a TOCTOU-racy `COUNT` (cap bypass under concurrency)

**Symptom:** `assertProcessingQuota` (`supabase/functions/process_lease/index.ts:1069`) enforces the monthly-extraction and active-lease caps via read-only `COUNT(leases) >= limit` then proceeds. Concurrent uploads each observe the pre-increment count and all pass; the count-error path fails open (`:1080`), compounding it.

**Severity:** Medium (low real-world frequency). Caps can be exceeded under concurrency → unbilled Opus spend. Distinct from #31 (that is the dead `documents_used` column; this is a race on the live count).

**Where to look:** `supabase/functions/process_lease/index.ts:1069-1083` (monthly) and `:1104` (active-lease).

**Stub remediation:** Atomic reserve (advisory lock, or `INSERT ... RETURNING` against a usage-reservation row) instead of count-then-go. Coordinate with any future #31 counter work — must run service_role per the #29 guard.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #37: `profiles_insert_self` RLS policy uses `WITH CHECK (true)`, defeating the correct same-table policy — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — `supabase/migrations/20260524000000_drop_profiles_insert_self_policy.sql` (a single idempotent `DROP POLICY IF EXISTS "profiles_insert_self" ON public.profiles;`) was applied to the live LeaseIO project (`wwkwoxxcprnjjufkbzac`) via the Supabase MCP `apply_migration` tool on 2026-06-02. Server-side `schema_migrations` recorded the apply as version `20260602141557` — a cosmetic drift from the in-repo filename timestamp, harmless because the SQL is `IF EXISTS`-idempotent on any replay (re-running the file via `supabase db push` from a fresh checkout will no-op the DROP and insert a second `schema_migrations` row at the filename version; the live policy state remains correct).

Verified via `pg_policy` query immediately post-apply: the only INSERT policy on `public.profiles` is now `profiles_insert_own (WITH CHECK (id = auth.uid()))`. The bypass vector is closed.

**Symptom:** `public.profiles` has two permissive INSERT policies. The correct one, `profiles_insert_own` (`WITH CHECK (id = auth.uid())`, `supabase/migrations/20260516120000_baseline_schema.sql:4330`), is nullified because `profiles_insert_self` (`WITH CHECK (true)`, `:4334`) is OR'd in. An authenticated user could INSERT a profile row keyed to another real, not-yet-onboarded `auth.users` id, setting attacker-controlled `email`/`current_workspace_id`. Verified 2026-05-24: both policies present, not dropped by any later migration.

**Severity:** Medium. Real RLS gap, but exploitability is limited — the PK blocks overwriting an existing profile, and the target UUID must be a real, profile-less `auth.users` id (profiles are normally auto-created at signup).

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql:4330,4334`.

**Stub remediation:** New migration: `DROP POLICY "profiles_insert_self" ON public.profiles;` (keep only `profiles_insert_own`). Per the Schema Change Rule, write the `.sql` file first; confirm no legitimate writer relies on the permissive policy.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (backend-security pass).

---

### Item #38: `send-invite` accepts `role` from the request body without a whitelist

**Symptom:** `supabase/functions/send-invite/index.ts:133` writes the invited `role` verbatim to `invite_tokens.role` / `workspace_members.role`. The DB enum/FK is the only guard.

**Severity:** Low. The caller is already an authorized admin/owner and the DB enum likely rejects garbage, so blast radius is small.

**Where to look:** `supabase/functions/send-invite/index.ts:133`.

**Stub remediation:** Whitelist `role` against allowed values before insert.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (backend-security pass).

---

### Item #39: Member-management UI exposes controls broader than the owner-only RLS

**Symptom:** `MemberRoleSelect.tsx` (`:34`) and `MembersPanel.tsx` (`:116`) show role-change/remove controls to any admin (`canManageWorkspaceMembers`), but the `workspace_members` UPDATE/DELETE RLS policies require `is_workspace_owner(...)` (`baseline_schema.sql:3787,3791`). A non-owner admin sees the controls but the write is rejected by RLS.

**Severity:** Low. Broken-feature / confusing-error, NOT a privilege escalation (server is stricter than the UI).

**Where to look:** `src/components/workspace/MemberRoleSelect.tsx:34`, `MembersPanel.tsx:116`; RLS at `baseline_schema.sql:3787,3791`.

**Stub remediation:** Pick one model and align: hide the controls for non-owners, or relax the RLS to admins if admin-managed membership is intended.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (frontend-security pass).

---

### Item #40: `OperationsPage` renders DB-sourced URLs as `href` without scheme validation

**Symptom:** `src/pages/app/OperationsPage.tsx:308,349` renders `account_url` / `upgrade_url` (from `vendor_renewal_calendar` / `vendor_alert_log`) directly as anchor `href`. A `javascript:` URL would execute on click. Both tables are operator/cron-populated and ops-admin-only (`rel="noreferrer" target="_blank"` already present).

**Severity:** Low. Near-zero practical exposure (trusted, operator-only data path).

**Where to look:** `src/pages/app/OperationsPage.tsx:308,349`.

**Stub remediation:** Validate the scheme is `https:` before rendering the anchor.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (frontend-security pass).

---

### Item #41: `check-mirror-parity.mjs` strips all `//` lines, weakening Node↔Deno drift detection

**Symptom:** `scripts/check-mirror-parity.mjs:88` `normalize()` filters every line matching `/^\s*\/\//`, broader than its stated "header docstring only" contract. A behavioral divergence expressed as a commented/uncommented line in one mirror could be masked. The two target pairs are currently byte-identical in body, so no live drift today.

**Severity:** Low. Reduced confidence in the CI parity gate, not an active bug.

**Where to look:** `scripts/check-mirror-parity.mjs:88` (`normalize`) vs `stripLeadingComment`.

**Stub remediation:** Strip only the leading block comment (via `stripLeadingComment`); drop the per-line `//` filter in `normalize`.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (data-integrity pass).

---

### Item #42: Orphaned/unwired components ship in no bundle but clutter the tree

**Symptom:** Four components have zero references anywhere: `src/components/workflow/AdminOverrideModal.tsx` (admin-override goes through `ChainViolationBanner` + `admin-override-step` instead), `src/components/dashboard/PendingApprovalsSection.tsx`, `src/components/dashboard/FinancialSummary.tsx`, and `src/components/dashboard/CommitmentHistory.tsx` (Dashboard.tsx imports a different set).

**Severity:** Low/Medium. Dead files — harmless to runtime, misleading to readers and to the CLAUDE.md File-Map (see #43).

**Where to look:** the four files above; confirm zero importers via grep before deleting.

**Stub remediation:** Delete after confirming truly unused (or wire them if intended).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #43: CLAUDE.md File-to-Feature Map has drifted from the tree — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — Reconciled CLAUDE.md against the live tree: (a) **Lease Review** group now drops the deleted `ModelLockConfirmation.tsx`; (b) **Approval Queue** group now drops the orphaned `PendingApprovalsSection.tsx` (still flagged by #42); (c) **Dashboard** group now lists the 11 components Dashboard.tsx actually imports (`OnboardingChecklist, SummaryStrip, NeedsAction, LeasePipeline, UpcomingRisks, RecentActivity, PipelineByDepartment, IntakeTrend, UpcomingEvents, EscalationReviewPanel, PendingCounterSignatureCard`) instead of the prior 6 entries (3 of which were orphaned); (d) **Portfolio** group now reflects reality (the page is built — `Portfolio.tsx` + `src/lib/portfolioAnalytics.ts`, PV liability + asset/escalation mix + lease register + index-lease disclosure) with a forward-pointer to KNOWN_ISSUES #46 for the tier-gating gap that surfaced during this reconciliation; (e) **Active Priorities** drops the "Portfolio intelligence dashboard — replace `Portfolio.tsx` stub with real analytics" line (priority functionally satisfied; the tier-gating residual is filed as #46). Related-but-out-of-scope-for-this-pass: line 138 still lists "Amendment comparison intelligence in `process_lease`" as open even though `process_lease/index.ts:2416` already writes `_amendment_changes` — flagged for a future audit beat, not bundled here.

**Symptom:** Multiple stale entries in CLAUDE.md's File-to-Feature Map: `Portfolio.tsx` is labeled "STUB — placeholder, needs build" (Active Priorities + File-Map) but is actually built (~332 lines, real `useQuery` + `computePortfolioMetrics`); `ModelLockConfirmation.tsx` is listed (Lease Review group) but has been deleted; the Dashboard group lists `FinancialSummary, PendingApprovalsSection, CommitmentHistory` (all orphaned per #42) while omitting the 8 components Dashboard.tsx actually imports (`SummaryStrip, NeedsAction, LeasePipeline, UpcomingRisks, RecentActivity, PipelineByDepartment, IntakeTrend, PendingCounterSignatureCard`). Related to already-filed #30 (`check-subscription`).

**Severity:** Medium (documentation integrity). Misleads file-scoping and the completion picture (Portfolio appears already built).

**Where to look:** CLAUDE.md File-to-Feature Map (Dashboard, Lease Review, Portfolio groups) and Active Priorities (Portfolio intelligence line).

**Stub remediation:** Reconcile the File-Map against the tree: drop deleted/orphaned entries, add the real Dashboard components, and re-classify `Portfolio.tsx` (and confirm whether the "portfolio intelligence dashboard" priority is now closed). Sweep for other stale references in the same pass.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #44: `Reports.tsx` renders user-reachable "Coming soon" report cards — **RESOLVED 2026-05-24**

**RESOLVED 2026-05-24** — Added a `if (!r.href) return false;` predicate to the existing report-card filter chain in `src/pages/Reports.tsx`, so the four unbuilt cards (`portfolio`, `renewals`, `escalations`, `projections`) are no longer rendered. The legacy `report.href ? <Link/> : <span>Coming soon</span>` fallback is left in place as defense-in-depth (and as a clear signal to any future addition). When those reports ship and get an `href`, the filter will let them through automatically.

**Symptom:** On the routed `/app/reports` page, 4 of 7 report cards (`portfolio`, `renewals`, `escalations`, `projections`) lack an `href` and render a visible "Coming soon" (`src/pages/Reports.tsx:198`). The three with hrefs route to real pages.

**Severity:** Low/Medium. Real user-reachable dead-end UI; matters for launch polish.

**Where to look:** `src/pages/Reports.tsx:198` (the card definitions / "Coming soon" branch).

**Stub remediation:** Either wire the four reports, or hide the unbuilt cards until shipped (avoid surfacing "Coming soon" to paying users).

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #45: ~18 of 97 `src/lib` exports are unused — **i18n.ts portion RESOLVED 2026-06-21**

**Symptom:** A grep sweep found ~19% of `src/lib` exports with no importer. Original worst offenders: ~~8 unused formatters in `src/lib/i18n.ts`~~ (now deleted — see resolution), 4 in `src/lib/dateFormatters.ts`, 5 `canAccess*` helpers in `src/lib/authorization.ts`, and `severityColor` in `reportGeneration.ts`.

**Severity:** Low. Clutter. The unused `canAccess*` authorization helpers are a mild correctness smell (intended guards never called) — worth confirming nothing should be calling them.

**RESOLVED 2026-06-21 (i18n.ts portion only):** `src/lib/i18n.ts` was entirely dead (0 importers; the i18next init at `src/i18n.ts` is a different file) and was **deleted** in the formatting-consistency sweep (commit `5b5853f`). Its 8 unused formatters are gone. The canonical money/date/number module is now `src/lib/dateFormatters.ts`. Remaining open: the `dateFormatters.ts` exports (the sweep's later parts add callers — e.g. `formatLocalizedPercent`), the `canAccess*` helpers, and `severityColor`.

**Where to look (remaining):** `src/lib/dateFormatters.ts`, `src/lib/authorization.ts`, `src/lib/reportGeneration.ts`. Verify each via grep (some may be reached by dynamic/string paths — none found, but confirm before deleting).

**Stub remediation:** Delete confirmed-dead exports; for the `canAccess*` helpers, first confirm no surface *should* be calling them.

**Decision:** Filed not fixed (i18n.ts portion now resolved). Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

---

### Item #46: `Portfolio.tsx` is not Business-tier gated despite Portfolio Intelligence being a Business-tier feature — **RESOLVED 2026-06-02**

**RESOLVED 2026-06-02** — Decision: **gate the page** (keep Portfolio Intelligence Business-tier per the existing pricing model, consistent with the AI Assistant and Reports gating). Two changes: (1) `src/components/layout/AppSidebar.tsx` Portfolio nav item now carries `requiresBusiness: true`, so Starter workspaces see the lock icon + disabled link via the existing `renderNavItem` mechanism (Business workspaces see the "Business" badge); (2) `src/pages/app/Portfolio.tsx` now reads `canAccessFeature('business')`, disables the data `useQuery` (`enabled: !!workspace?.id && hasBusinessAccess`) so no leases are fetched for Starter, and early-returns an upgrade card (Lock icon + Business badge + CTA to `/app/upgrade?feature=portfolio`) mirroring the `Reports.tsx` gate. The gate is UI-side by necessity — `leases` RLS is workspace-scoped, not tier-scoped, so there is no backend tier enforcement to rely on (same as the AI Assistant, which additionally re-checks tier in its edge function; Portfolio has no dedicated edge function, it reads `leases` directly, so the client gate is the enforcement point). Verified via typecheck + 443 passing tests.

**Residual (not blocking):** `Portfolio.tsx` is not internationalized — the whole page (including the new gate copy) uses hardcoded English, unlike the i18n'd `Reports.tsx` gate. This is pre-existing page-level i18n debt, not introduced by this fix; the gate was written in the page's existing hardcoded-English style for internal consistency rather than half-i18n-ing the file. Folding Portfolio into i18n is a separate cleanup beat.

**Symptom:** The pricing model (CLAUDE.md Pricing table) classes "Portfolio Intelligence" as Business-tier only ("No" on Starter, "Yes" on Business). The implementation has no tier gate: the `/app/portfolio` route in `src/App.tsx` is wrapped only in `<ProtectedRoute>` (auth-only), the `AppSidebar.tsx` nav entry at line 60 omits `requiresBusiness: true` (so the lock icon at `:152` is never shown), and `Portfolio.tsx` itself does not call `canAccessFeature('business')`. Starter-tier workspaces can use the full Portfolio dashboard for free, undercutting the Business-tier positioning. Surfaced during the 2026-06-02 #43 File-Map reconciliation (the audit missed this because it focused on the "is the page built?" question, not the tier surface).

**Severity:** Medium. Revenue-positioning gap, not a security or correctness bug. Concretely: a Starter customer on $249/mo gets one of the headline Business-tier features ($499/mo) at no extra charge. Whether the right fix is to gate the page or to relax the pricing table is a product decision.

**Where to look:**
- `src/App.tsx` line 269-274 (Portfolio route — no tier guard).
- `src/components/layout/AppSidebar.tsx` line 60 (nav item missing `requiresBusiness: true`; line 152 is where the lock icon would render).
- `src/pages/app/Portfolio.tsx` line 24+ (no `canAccessFeature('business')` check).
- Reference exemplar: `src/components/ai/AiAssistant.tsx:33` and `src/pages/Reports.tsx:65` both correctly gate with `canAccessFeature('business')`.

**Stub remediation:** Pick the model. If Portfolio remains Business-tier per CLAUDE.md: add `requiresBusiness: true` to the AppSidebar nav item (gets the lock icon for Starter), wrap the route in a tier-check (or render an upgrade prompt inside `Portfolio.tsx` when `canAccessFeature('business')` is false — matches the AI Assistant pattern), and confirm there's no backend RLS that already enforces it (there isn't — `leases` reads are workspace-scoped, not tier-scoped, so the gate must be UI-side). If Portfolio should be available to all tiers: drop "Portfolio Intelligence" from the Business-only row in CLAUDE.md pricing and update marketing copy accordingly.

**Decision:** Filed not fixed — needs a product call (gate vs. relax). Surfaced during the 2026-06-02 CLAUDE.md File-Map reconciliation (closing of #43).

---

### Item #47: Shape helpers duplicated between `generate-lease-report` and `generate-workspace-asc842-report`

**Symptom:** The new `supabase/functions/generate-workspace-asc842-report/index.ts` duplicates ~150 lines of "shape" helpers (`asNumber`, `asString`, `pickClassification`, `shapeRentSchedule`, `shapeCitations`, `shapeEscalation`, `shapeRenewals`, `shapeTermination`, `shapeAuditEntries`, `shapeAsc842Inputs`) from `supabase/functions/generate-lease-report/index.ts`. Two callers, same code.

**Severity:** Low. Maintenance burden — any shape change must be applied in both files. Was kept duplicated in 2026-06-03 because refactoring the working per-lease function in the same pass would have risked the disclosure flow.

**Where to look:** `supabase/functions/_shared/` is the proper home. Extract to `_shared/lease_report_shapes.ts` and update both functions to import.

**Stub remediation:** Move the helpers to `_shared/lease_report_shapes.ts`. Replace local definitions in both edge functions with imports. Verify both functions still produce identical output (snapshot the JSON sections before/after).

**Decision:** Filed not fixed. Surfaced during the 2026-06-03 workspace ASC 842 report build.

---

### Item #48: Lease detail page no longer surfaces activity timeline inline

**Symptom:** Per the 2026-06-03 lease-detail cleanup, the `ActivityTimeline` component is no longer rendered inside `LeaseReview.tsx` (it was rendered twice — main view + Documents tab — both removed). The audit log lives at `/app/reports/audit-log` now, with a deep link from the locked-lease header ("Audit trail" button).

**Severity:** Note, not a bug. Filed so a future contributor doesn't add it back assuming it was a regression. The activity timeline is the same data, just centralized.

**Where to look:** `src/components/leases/locked/LockedHeader.tsx` for the deep link; `src/pages/app/AuditLog.tsx` for the destination page; `src/components/lifecycle/ActivityTimeline.tsx` is still imported in non-lease contexts (admin operations / Phase 7 exceptions surfaces) — verify those callers remain valid.

**Decision:** Filed for context. No action needed.

---

### Item #50: Executed-vs-pipeline reconciliation UI removed; underlying data still computed

**Symptom:** The two UI surfaces that consumed the executed-stage reconciliation data — `ExecutedTermsReview` (editable 7-row comparison + per-field confidence + audit-logged corrections) and `VarianceReport` (5-row Match/Variance summary) — were deleted from the lease workbench 2026-06-04. The underlying columns and writer code are still load-bearing for other surfaces:

- `executed_*` columns on `leases` (executed_tenant_name, executed_landlord_name, executed_commencement_date, executed_expiry_date, executed_monthly_payment, executed_rent_review_clause, executed_break_clause, executed_extraction_confidence) — still populated by `supabase/functions/process_lease/index.ts` (lines 1977, 2018) when an executed PDF is processed. `executed_monthly_payment` in particular is consumed by `ai-assistant`, `process-alerts`, `generate-lease-report`, and `generate-workspace-asc842-report` as a fallback for the monthly amount.
- `variance_*` columns (variance_monthly_payment, variance_commencement_days, variance_expiry_days, variance_tenant_name_match, variance_landlord_name_match) — still populated by `process_lease` and still consumed by `src/pages/Reports.tsx:85` as the "Variance Outliers" panel data source.
- Activity-log types `'executed_terms_extracted'` and `'executed_terms_edited'` remain in the `lifecycle.ts` enum. The "extracted" entry is still emitted by process_lease; the "edited" entry no longer has a writer (the only call site was inside `ExecutedTermsReview.tsx`, deleted).

**Severity:** Low. Nothing breaks. The columns continue to fill correctly. Future contributors might be confused by columns that have writers but no per-lease UI consumer — this note exists so they understand the columns power Reports and edge functions, not the deleted panels.

**Where to look:** `supabase/functions/process_lease/index.ts:1977,2018`; `src/pages/Reports.tsx:85`; `src/types/lifecycle.ts`; the removed components live at `git log -- src/components/leases/ExecutedTermsReview.tsx src/components/leases/VarianceReport.tsx`.

**Stub remediation:** None required. If we ever decide the variance signal is purely vestigial:
1. Confirm Reports.tsx Variance Outliers panel is actually used (it's currently hidden behind `varianceLeases.length > 0` so already self-suppresses).
2. Drop the writer + columns in a coordinated migration.
3. Remove `executed_terms_edited` from the activity-type enum.

For now, leave alone.

**Decision:** Filed for context. No action needed.

---

### Item #49: `generate-lease-insights` deployed as a 410-Gone stub with no repo source

**Symptom:** The `generate-lease-insights` slug still appears in the Supabase Edge Functions list, but the repo no longer contains a `supabase/functions/generate-lease-insights/` directory or a `[functions.generate-lease-insights]` config.toml stanza.

**Severity:** Low — purely cosmetic. The Supabase MCP doesn't expose a delete tool, so on 2026-06-03 the function was redeployed (version 18) with a stub body that returns HTTP 410 + `{"ok": false, "reason": "function_retired"}` for every request. No Anthropic API calls, no Sonnet code, no surfaces with stale behavior. The repo-side CI guard (`check:edge-function-config`) only checks `supabase/functions/*` ↔ `config.toml` parity and is intentionally unaware of live deployments, so the repo stays green.

**Where to look:** Supabase dashboard → Edge Functions → `generate-lease-insights`. Click delete when convenient.

**Stub remediation:** Delete the function from the Supabase dashboard. No code change required.

**Decision:** Filed for visibility. The stub is the durable safe state; deletion is a one-click cleanup whenever an operator is in the dashboard.

---

### Item #51: `deleted_workspaces` has no `deletion_reason` discriminator

**Symptom:** Workspace deletions now arrive from three semantically different sources — an owner deleting a populated workspace (`delete-workspace`), a user cancelling a still-pending multi-workspace creation (`create-workspace` cancel mode), a Stripe-error rollback of a never-activated workspace (`create-workspace` confirm), and the abandonment cron (`sweep-pending-workspaces`). All write the same `deleted_workspaces` shape. A query for "workspaces customers lost" cannot, without joining to `workspace_creation_requests`, tell a real populated-workspace deletion from a never-live rollback/abandonment.

**Severity:** Medium — forensic clarity, not correctness or security. Surfaced by the repository-integrity reviewer during the Workspace Management Phase 1 fix pass (2026-06-09). Filed (not bundled) per the reviewer's recommendation.

**Root-cause hypothesis:** `deleted_workspaces` was designed (baseline schema) for the single owner-delete path; Phase 1 added three more deletion sources without a discriminator column, so the table conflates "lost real data" with "cleaned up an unpaid shell."

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql:931` (table); insert sites at `supabase/functions/delete-workspace/index.ts:303`, `supabase/functions/create-workspace/index.ts` (cancel + rollback), `supabase/functions/sweep-pending-workspaces/index.ts`.

**Stub remediation:** New migration adding `deletion_reason text` (e.g. `'owner_delete' | 'pending_cancel' | 'stripe_rollback' | 'abandonment_sweep'`) to `deleted_workspaces`; stamp it at each of the four insert sites. Backfill existing rows to `'owner_delete'` (the only pre-Phase-1 source).

**Decision:** Filed for a follow-up. The current rows are still recoverable (distinguishable by joining `workspace_creation_requests.status`), so this is a clarity improvement, not a data-loss fix.

---

### Item #52: Member role-change and removal queries are not workspace-scoped client-side

**Symptom:** The `workspace_members` UPDATE (role change) and DELETE (remove member) queries filter only by row PK (`.eq('id', memberId)`), with no `.eq('workspace_id', workspaceId)` constraint. RLS (`is_workspace_owner`) is the sole enforcement layer — the DB correctly blocks cross-workspace writes, but the client query expresses no scope intent of its own.

**Severity:** High (defense-in-depth, not an active vulnerability). Surfaced by lease-security-scanner during the Workspace Management Phase 4 review (2026-06-09). Pre-existing code (predates Phase 4) — filed, not bundled, per the pre-existing-issues rule.

**Root-cause hypothesis:** The original WorkspaceSettings member controls were written when the panel could only ever render the active workspace, so PK-only filtering was implicitly scoped. The MembersPanel extraction made the component workspace-agnostic without revisiting the query predicates.

**Where to look:** `src/components/workspace/MemberRoleSelect.tsx` (the `workspace_members` UPDATE), `src/components/workspace/MembersPanel.tsx` `handleRemoveMember` (the DELETE).

**Stub remediation:** Add `.eq('workspace_id', workspaceId)` to both queries (MemberRoleSelect already receives `workspaceId` as a prop; MembersPanel has it in scope). Pure belt-and-braces — no behavior change when RLS is intact.

---

### Item #53: `workspace_activity_log.event_type` has no CHECK constraint

**Symptom:** Any authenticated workspace member permitted by the insert policy can write rows with arbitrary `event_type` strings — including service-role-reserved values like `'owner_transferred'` — poisoning the workspace audit trail. Integrity currently depends entirely on client discipline.

**Severity:** High (audit-trail integrity). Surfaced by lease-security-scanner during the Workspace Management Phase 4 review (2026-06-09). Pre-existing schema (Phase 1 migration, already applied) — filed, not bundled.

**Root-cause hypothesis:** The Phase 1 migration documented the event-type vocabulary in a comment (`created | activated | renamed | owner_transferred | member_added | member_removed`) but never enforced it as a constraint; client-side writers were trusted to stay within it.

**Where to look:** `supabase/migrations/20260609120000_workspace_management_phase1.sql:32` (column definition + comment); client writers in `RenameWorkspaceInline.tsx`, `MemberRoleSelect.tsx`, `MembersPanel.tsx`.

**Stub remediation:** New migration adding a CHECK constraint enumerating allowed values — must include `'member_role_changed'` (added by the Phase 4 fix pass as the correct event for role changes; the Phase 1 comment predates it). Consider going further: restrict the client INSERT policy to the client-writable subset (`renamed`, `member_added`, `member_removed`, `member_role_changed`) so `created`/`activated`/`owner_transferred` are service-role-only.

---

### Item #54: `workspace_activity_log` INSERT policy permits forgeable rows by any member

**Symptom:** The authenticated INSERT policy requires membership and `user_id = auth.uid()`, but nothing restricts WHICH `event_type` a member may write — a plain member can insert a legitimate-valued but false `owner_transferred` / `renamed` / `member_removed` row. Combined with #53 (no CHECK constraint), the workspace audit trail is forgeable by its own subjects. The omission side is equally real: members mutating via direct REST skip logging entirely, since client-side audit writes are voluntary.

**Severity:** Medium (audit-trail integrity, defense-in-depth — RLS still prevents cross-workspace writes and edits/deletes). Surfaced by lease-security-scanner during the Phase 3 review (2026-06-09). Pre-existing schema (Phase 1 migration) — filed, not bundled.

**Root-cause hypothesis:** The Phase 1 policy mirrored `lease_activity_log`'s INSERT policy shape without considering that workspace-lifecycle events include service-role-reserved vocabulary.

**Where to look:** `supabase/migrations/20260609120000_workspace_management_phase1.sql:58-65` (policy); client writers in `RenameWorkspaceInline.tsx`, `MemberRoleSelect.tsx`, `MembersPanel.tsx`.

**Stub remediation:** Remediate together with #53 and #55 as one audit-hardening migration: restrict client-insertable event_types to the genuinely client-written subset, keep `created`/`activated`/`owner_transferred` service-role-only.

---

### Item #55: Member-event audit writes should move server-side (trigger), not live in client discipline

**Symptom:** `member_role_changed` / `member_removed` / `renamed` audit rows are written client-side, fire-and-forget (deliberate, so an audit failure can't masquerade as an operation failure — 2026-06-09 fix pass). The integrity reviewer's assessment: for permission changes, the structural answer is atomicity, not silent drop — a tab close right after the success toast can drop the row, and direct-REST mutations log nothing. Related gaps: `member_added` is documented vocabulary (migration comment, spec §2) but has NO writer anywhere (`accept-invite` logs nothing); `workspace_activity_log` is absent from the generated `src/integrations/supabase/types.ts`, forcing `(supabase as any)` casts on every client writer.

**Severity:** High (audit-trail completeness for permission changes). Surfaced by lease-repository-integrity-reviewer during the Phase 3 review (2026-06-09). Filed by owner decision: fix `user_id` stamping now (done), build the structural fix as its own beat.

**Root-cause hypothesis:** Spec §6.5 chose client-side writes via the constrained INSERT policy to resolve a writer-model contradiction; that resolved WHO may write but left WHETHER a write happens to client discipline.

**Where to look:** `src/components/workspace/{MemberRoleSelect,MembersPanel,RenameWorkspaceInline}.tsx`; `supabase/functions/accept-invite/index.ts` (missing `member_added` writer); `supabase/migrations/20260609120000_workspace_management_phase1.sql`.

**Stub remediation:** One audit-hardening migration (bundle with #53 + #54): AFTER UPDATE OF role / AFTER DELETE triggers on `workspace_members` and AFTER UPDATE OF name ON `workspaces` writing `workspace_activity_log` in the same transaction (actor from `auth.uid()`, before/after from OLD/NEW); remove the client-side writes; wire `member_added` from `accept-invite` (or a member-insert trigger); regenerate types and drop the `(supabase as any)` casts. Security-class migration — reviewer routing before push. Note the trigger-ordering gotcha in CLAUDE.md (alphabetical firing; inventory existing triggers from the live DB first).

Two LOWs from the 2026-06-09 remediation re-review fold in here:
- `previous_role` in the client's `member_removed` write comes from the page-load member snapshot, not the deleted row — a role changed in another session is recorded stale. The AFTER DELETE trigger MUST source it from `OLD.role` (this is the motivation; don't drop it during the bundle).
- Residual post-commit race in the transfer RPC: a member-removal of the target that blocks on the RPC's FOR UPDATE proceeds after commit and deletes the NEW OWNER's freshly-promoted member row (not data loss — `workspaces.owner_id` holds and `is_workspace_member` covers owners — but it recreates the owner-with-no-member-row state). The AFTER DELETE trigger can detect `OLD.user_id = workspaces.owner_id` and log it distinctly (or re-insert per the owner-self-row convention).

---

### Item #56: Lease-meter "approaching limit" CTA on Usage sends Business users to a page selling them Business — RESOLVED 2026-06-12

**Symptom:** `UsageContent.tsx`'s approaching-limit banner fires for lease/archive saturation on any plan; for Business users the CTA routed to `/app/upgrade`, which unconditionally pitches the Business plan with an `autoCheckout=1` handoff. The 2026-06-09 fix retargeted the banner CTA to subscription management when `plan === 'business'`, but `Upgrade.tsx` itself remains plan-unaware: any Business user who reaches `/app/upgrade` by other paths (sidebar, deep link) is still sold their current plan.

**Severity:** Medium (misleading dead-end; potential duplicate-checkout confusion — `create-checkout` server-side behavior for an already-subscribed customer unverified). Surfaced by lease-product-polish during the Phase 3 review (2026-06-09). The banner half is fixed; the `Upgrade.tsx` half is pre-existing — filed, not bundled.

**Where to look:** `src/pages/app/Upgrade.tsx` (plan-unaware pitch + autoCheckout link); `src/pages/settings/AccountSettings.tsx:414` (autoCheckout reader); `supabase/functions/create-checkout/index.ts` (verify behavior for an already-Business customer).

**Stub remediation:** Make `Upgrade.tsx` plan-aware: for Business users render "You're on Business" + a Manage subscription link instead of the checkout CTA; verify `create-checkout` rejects/no-ops for an already-active Business subscription.

**RESOLVED 2026-06-12:** `Upgrade.tsx` was deleted in the settings Claude-alignment pass; `/app/upgrade` now redirects to `/app/settings/account?tab=billing`, which is plan-aware (upgrade card renders only for Starter admins).

---

### Item #57: Owner Workspace Management surface is hardcoded English

**Symptom:** `WorkspaceManagement.tsx` (section headers, card actions, leave/delete confirmations) and `DeleteWorkspaceDialog.tsx` are entirely hardcoded English, predating the workstream's i18n standard (Phase 2 shipped `workspace.create.*`, Phase 3 shipped `workspace.transfer.*` in both locales). A Spanish-locale user gets a mixed-language management page, including the delete confirmation.

**Severity:** Low-Medium (locale consistency; comprehension on a destructive dialog). Surfaced by lease-product-polish (2026-06-09). Pre-existing — filed, not bundled.

**Where to look:** `src/pages/account/WorkspaceManagement.tsx`, `src/components/workspace/DeleteWorkspaceDialog.tsx`, `src/components/workspace/MembersPanel.tsx` (toasts + a few inline strings).

**Stub remediation:** Extract to `workspace.manage.*` / `workspace.delete.*` keys in en + es in one pass; update the jsdom tests that assert literal strings.

---

### Item #58: Leaving your only workspace strands the session in a zero-workspace state

**Symptom:** `handleLeaveWorkspace` in `WorkspaceManagement.tsx` looks for a fallback workspace to switch to; when the departed workspace was the user's ONLY one, no fallback exists and the flow proceeds anyway, refreshing into an app state with no active workspace and no recovery surface.

**Severity:** Medium (user stranded; recoverable only by re-invite). Surfaced by lease-product-polish (2026-06-09). Pre-existing (Owner Workspace Management Checkpoint 3) — filed, not bundled.

**Where to look:** `src/pages/account/WorkspaceManagement.tsx:171-196`; whatever AppContext renders when `availableWorkspaces` is empty.

**Stub remediation:** Either block Leave when it's the last workspace (with copy explaining why), or build an explicit "no workspaces" recovery screen (create-new or accept-invite paths) and route into it.

---

### Item #59: `enforceWorkspaceRateLimit` read-then-upsert is not atomic

**Symptom:** The shared helper (`supabase/functions/_shared/audit.ts:226-261`) reads `request_count`, then upserts `count + 1` — concurrent requests in the same window can each read the same count and both pass, overshooting the cap. For owner-gated functions (delete-workspace, transfer-workspace-ownership, ceiling 5/hr) abuse value is minimal since only the verified owner can reach the limiter; the broader exposure is the AI/processing functions sharing the helper.

**Severity:** Low. Surfaced by lease-security-scanner during the transfer-RPC pre-push review (2026-06-09). Pre-existing shared-helper behavior — filed, not bundled.

**Where to look:** `supabase/functions/_shared/audit.ts:226-261`; all `enforceWorkspaceRateLimit` call sites (grep).

**Stub remediation:** Atomic increment — single UPSERT with `request_count = processing_rate_limits.request_count + 1` ON CONFLICT (or an RPC doing INSERT ... ON CONFLICT DO UPDATE ... RETURNING) and compare the returned count to the limit. Fix once in the helper; all callers inherit. (A cousin of this helper's "document processing request" copy being wrong for non-processing callers — add an optional label param in the same pass.)

---

### Item #60: Itemized per-workspace billing — forward-looking invariant (NOT a defect)

**Context:** Daniel flagged (2026-06-10) that owners of multiple workspaces will want an itemized bill showing the cost of each workspace, not just a summarized total. This item exists to pin the architectural invariant that makes that surface buildable later, so it isn't accidentally optimized away.

**The invariant to preserve:** Each workspace is its own independent Stripe subscription, created in `create-workspace/index.ts` with `metadata: { workspace_id, plan_id, billing_interval }` stamped on the subscription (`index.ts:403`). Because each workspace = one subscription = its own invoice stream, Stripe already itemizes billing per workspace. The future itemized-billing page is therefore **pure frontend work** — list the customer's subscriptions, join each subscription's `workspace_id` metadata back to `workspaces.name`, and offer a summary ↔ itemized toggle + per-workspace billing history. **If we ever stop stamping `workspace_id` onto the subscription metadata, the itemized view becomes impossible to build cleanly** — that one line is the load-bearing dependency.

**Related design fact (decided 2026-06-10):** There is no proration. A new workspace's subscription anchors its billing cycle to creation time and charges the full $499 that day (`create-workspace/index.ts:392-393`, "no billing_cycle_anchor (keeps '$499 today' honest)"). The price-awareness gate in `NewWorkspaceDialog.tsx` states this honestly ("$499 today, then $499/month on this date"). Switching to shared-subscription + proration would re-introduce proration math AND make the itemized view harder (one invoice with many lines vs. clean per-subscription invoices) — explicitly NOT the chosen direction.

**Severity:** N/A — forward-looking note. No action required until the itemized-billing surface is scheduled.

**Phase 9 update (2026-06-15):** The per-workspace-subscription invariant is **preserved for standalone Plus/Business workspaces** (still one sub each, `metadata.workspace_id` stamped). Firm children are the documented **exception**: a firm bills via ONE firm-level Stripe subscription covering all its children, tagged `metadata.firm_id` (NOT `workspace_id`), mirrored onto `firms.stripe_customer_id`/`stripe_subscription_id` by the stripe-webhook firm branch (`applyFirmSubscription`), which propagates `plan='business'` to the children. So itemized billing splits into two regimes once firm billing is live: standalone = per-subscription invoices (unchanged); firm = the firm billing page (Phase 10) consuming `v_firm_billing_period_summary` (which respects `firms.billing_summary_mode` detailed|summarized). The load-bearing `workspace_id` metadata line for standalone subs is untouched.

**Where to look:** `supabase/functions/create-workspace/index.ts:392-403`; the future page would live alongside `src/pages/app/UsageContent.tsx` / the account subscription tab. Firm side: `supabase/functions/stripe-webhook/index.ts` (`applyFirmSubscription`).

---

### Item #61: `create-checkout` resolves the Stripe customer by caller email (the P2-07 class, re-surfacing)

**Severity:** Medium. **Pre-existing** — surfaced 2026-06-11 by the security scanner during the subscription-tab polish pass; NOT introduced by that change.

**Symptom:** `create-checkout/index.ts:137-141` resolves/creates the Stripe customer with `stripe.customers.list({ email })` — the exact pattern P2-07 already fixed in `customer-portal` (which resolves from `workspaces.stripe_customer_id`). An account holder who is admin of two workspaces shares one email-keyed Stripe customer across both. Combined with the per-workspace-subscription architecture (#60) and the recovery-checkout button on the subscription tab (`proceedWithCheckout('business')`), a checkout can bind to a customer record already carrying another workspace's billing state.

**Fix (its own beat, not bundled):** mirror P2-07 — prefer `workspaces.stripe_customer_id` when present, fall back to email lookup only for a workspace's first-ever checkout, and stamp the resolved customer id back onto the workspace. Two adjacent pre-existing LOWs in the same function to sweep in the same pass: (a) `workspaceId` is presence-checked but not type-checked (`customer-portal:41` does `typeof === "string"`) → a non-string body produces a raw 500; (b) `Invalid plan: ${planId}` reflects raw user input into the JSON error body (`index.ts:69,178`) — return a static message + `reason: 'invalid_plan'` instead.

**Phase 9 note (2026-06-15) — NOT resolved by the firm layer.** The plan briefly hypothesized the firm work would "resolve #61's firm-customer gap"; in practice Phase 9 did NOT touch `create-checkout`, so this bug **remains open for standalone workspaces**. What Phase 9 *did* establish is the correct customer-resolution pattern on the firm path: the stripe-webhook firm branch resolves via `resolveCustomerId(subscription)` and persists onto `firms.stripe_customer_id` — the same prefer-stored-id discipline #61 asks `create-checkout` to adopt. When the #61 fix is scheduled, the firm path is the reference; the standalone `create-checkout` email lookup still needs the P2-07 mirror.

**Where to look:** `supabase/functions/create-checkout/index.ts:69,71-73,137-141,178`; reference fix in `supabase/functions/customer-portal/index.ts`.

---

### Item #62: "Your subscription renews on {{date}}" still shows after a cancel-at-period-end (no Stripe flag mirror)

**Severity:** Low/Medium (copy correctness). **Surfaced 2026-06-11** (polish pass); deferred because the proper fix needs webhook work.

**Symptom:** When a user cancels via the billing portal, Stripe keeps `status='active'` with `cancel_at_period_end=true`. Nothing in the repo mirrors that flag (grep: zero hits for `cancel_at_period_end`). The subscription tab's Current Plan card therefore shows "Your subscription renews on {{date}}" for a subscription that is actually ending on that date — copy that contradicts the user's own cancel action; they may think the cancel failed and try again or email support.

**Fix:** mirror `cancel_at_period_end` (and ideally `cancel_at`) onto `workspaces` via `stripe-webhook` (`customer.subscription.updated`), then branch the Current Plan copy: "Ends on {{date}} (canceled)" vs "Renews on {{date}}". Frontend half is trivial once the column exists; the webhook half is the work. Repository-integrity lane (touches the Stripe→DB mirror).

**Where to look:** `supabase/functions/stripe-webhook/index.ts` (subscription.updated handler); `src/pages/settings/AccountSettings.tsx` (Current Plan `renews_on` block); `src/contexts/AppContext.tsx` (`WorkspaceRow` + mapping).

---

### Item #63: No sidebar billing signal for `past_due` (only `trialing` gets a pill)

**Severity:** Low (UX gap). **Surfaced 2026-06-11** (polish pass).

**Symptom:** The new sidebar trial pill (`AppSidebar.tsx`) shows for `subscriptionStatus === 'trialing'`, but `past_due` — a strictly more urgent billing state (a payment has already failed) — has no global signal. The user only sees it if they navigate to the subscription tab, where the past-due banner lives.

**Fix:** add a red "Payment failed" pill in the same sidebar slot for `['past_due','unpaid','incomplete'].includes(subscriptionStatus)`, deep-linking to `?tab=subscription`. Reuses the trial-pill pattern exactly. Small, self-contained follow-up.

**Where to look:** `src/components/layout/AppSidebar.tsx` (trial pill block, just above the user menu).

---

### Item #64: Document-pack purchase idempotency key is per-attempt, not per-intent

**Severity:** Low. **Surfaced 2026-06-11** (Workstream B integrity review). Pre-existing-by-design.

**Symptom:** `DocumentPackDialog.handleBuy` generates a fresh `crypto.randomUUID()` per call; the server namespaces it `pack_<workspaceId>_<key>`. Stripe idempotency therefore only dedupes a literal retry of one call — it does NOT stop a user from buying the same pack twice (close dialog → reopen → buy again). Because capacity is intentionally additive (stacking is a feature), an accidental duplicate is silently honored as 2× capacity AND 2× recurring charge.

**Why deferred not fixed:** intentional stacking and accidental duplicate are indistinguishable without a product rule. Today the consent→processing transition unmounts the buy button, so a fast double-click is already unlikely; the residual risk is a deliberate-looking re-purchase.

**Fix (when scoped):** derive the idempotency key from a stable intent (e.g. `pack_<workspaceId>_<packId>_<preview-nonce>`) so a same-session re-confirm of the same pack collapses while genuine stacking (new dialog session) still creates a new sub; or add a soft "you already have an active N-pack — add another?" confirm. Defer to product.

**Where to look:** `src/components/workspace/DocumentPackDialog.tsx` (`handleBuy`); `supabase/functions/manage-document-pack/index.ts` (confirm idempotencyKey).

---

### Item #65: Document-pack webhook silently drops a paid grant if `workspace_id` metadata is missing

**Severity:** Low. **Surfaced 2026-06-11** (Workstream B integrity review).

**Symptom:** `stripe-webhook`'s `applyDocumentPack` returns early with only a `console.warn` if a pack subscription event lacks `metadata.workspace_id` (or customer). In normal flow this never happens — `manage-document-pack` always stamps `workspace_id` — but a pack sub created out-of-band in the Stripe dashboard, or a future code path that forgets the tag, would leave the customer's paid capacity un-mirrored with no durable trail. Unlike a mis-attributed plan sub (loud — no Business features), a dropped pack grant is quiet (the customer just never sees the slots they paid for). Brushes the "no silent vendor failures" hard rule.

**Fix (when scoped):** on the missing-`workspace_id` branch, write an append-only audit / dead-letter row (or emit a monitored alert per OPERATIONAL_MONITORING_SPEC) so a dropped paid grant is attributable and recoverable, not just logged.

**Extension (2026-06-11, Workstream C):** the same silent-drop shape now exists on `applySingleLeaseCredit` (missing `workspace_id` on a `payment_intent.succeeded` event → `console.warn` + 200 ack, paid one-time charge never granted). And one broader gap in the same lane: there is no reconciliation sweep comparing succeeded single-lease PaymentIntents against the `lease_credit_purchases` ledger, so a missed/undelivered webhook event (see the five-event subscription requirement in `OPERATOR_PLAYBOOK.md`) is permanently silent. Scoped remediation should cover both functions' drop branches plus a periodic reconcile (e.g. in `manage-document-pack` preview or the nightly health check).

**Where to look:** `supabase/functions/stripe-webhook/index.ts` (`applyDocumentPack` + `applySingleLeaseCredit` early-return guards).

---

### Item #66: `src/integrations/supabase/types.ts` not regenerated for `addon_document_capacity`

**Severity:** Low (cosmetic / type-safety). **Surfaced 2026-06-11** (Workstream B audit).

**Symptom:** The new `workspaces.addon_document_capacity` column is read in `AppContext.tsx` via an `as any` cast because the auto-generated `types.ts` predates the column. Consistent with the file's established cast pattern, but the column should be reflected in the generated types after the migration applies.

**Fix:** run the Supabase type generation (`supabase gen types` / MCP `generate_typescript_types`) after the migration is applied to staging, commit the regenerated `types.ts`, and drop the `as any` at the `addon_document_capacity` read site.

**Where to look:** `src/integrations/supabase/types.ts`; `src/contexts/AppContext.tsx` (mapping).

**Extension (2026-06-11, Workstream C):** the regen must also pick up `workspaces.purchased_lease_credits`, the `lease_credit_purchases` table, and the `consume_lease_credit` RPC (currently bridged with `as any` casts in `AppContext.tsx` and a manual row cast in `LimitReachedDialog.tsx`).

---

### Item #67: `retry_lease` has no processing-quota gate

**Severity:** Low/Medium (cost exposure, not tenant isolation). **Pre-existing** — surfaced 2026-06-11 by the Workstream C security review; NOT introduced by that change.

**Symptom:** `supabase/functions/retry_lease/index.ts` enforces AI consent and rate limiting but never calls `assertProcessingQuota`. An over-cap workspace can keep triggering paid Opus extractions by retrying failed leases. The window is bounded (retries only apply to existing failed leases + the per-workspace rate limit), and the same bypass is what makes the single-lease credit's "Opus failure after consume" loss path recoverable for free — so any fix must preserve free retries of an *already-quota-passed* upload while blocking retry-as-quota-evasion. Needs a deliberate design, not a blanket gate.

**Where to look:** `supabase/functions/retry_lease/index.ts`; `assertProcessingQuota` in `process_lease/index.ts`.

---

### Item #68: Intake entry buttons and LeaseUploadModal are hardcoded English

**Severity:** Medium (i18n completeness). **Pre-existing** — surfaced 2026-06-11 by the Workstream C polish review; NOT introduced by that change.

**Symptom:** The gated entry points — Dashboard "New Request" (`Dashboard.tsx`), Leases "Add Lease" (`Leases.tsx`), the `AddLeaseDialog` chooser, and the entire `LeaseUploadModal` (titles, steps, errors) — are raw English strings. A Spanish-language user clicks an English button and lands on the fully-translated, usted-toned limit wall: mixed-language whiplash at the billing moment. Same class as the resolved Owner Workspace Management item (#57).

**Fix (when scoped):** move all four surfaces' copy into `common.json` (en + es) in one sweep; polish-review the Spanish for usted consistency with the billing surfaces.

**Where to look:** `src/pages/Dashboard.tsx`, `src/pages/Leases.tsx`, `src/components/leases/{AddLeaseDialog,LeaseUploadModal}.tsx`.

---

## Tracking

Surfaced 2026-05-03 during Phase 2 Path A smoke (items 1-4), Phase 2 Path A
follow-up (item 5), Phase 3 audit (items 6-7), Phase 3 close-out
forensics + smoke (items 8-10), Phase 4 close-out audit (item 11),
Phase 8 C1 (items 12-13), audit P2-01 (item 15), P1-10 baseline review
(items 16-18), governance hardening follow-up review (items 19-28), post-apply smoke check (item 29),
the #29 post-merge regression audit (items 30-31),
the 2026-05-24 full-codebase audit — security / dead-ends / data-integrity passes (items 32-45),
the 2026-06-02 CLAUDE.md File-Map reconciliation pass (item 46),
the 2026-06-03 lease-detail cosmetics pass (items 47-48),
the 2026-06-03 zombie-edge-function neutralization (item 49),
the 2026-06-04 executed-vs-pipeline UI removal (item 50),
the 2026-06-09 Workspace Management Phase 1 fix pass (item 51),
the 2026-06-09 Workspace Management Phase 4 review pass (items 52-53),
the 2026-06-09 Workspace Management Phase 3 five-reviewer pass (items 54-58),
and the 2026-06-09 transfer-RPC pre-push security review (item 59).
Filed by Claude per user direction. Each item should get its own commit
when fixed; reference this file in the message and remove the entry once
green.

### Item #69: Profile tab Phone field is never loaded or saved

**Symptom:** `AccountSettings.tsx` Profile tab renders a Phone input, but the user-hydration effect never calls `setPhone` from stored data and `handleSaveProfile` omits `phone` from the `profiles` update — the user types a number, gets "Profile updated successfully!", and the value evaporates on reload.

**Severity:** High (lying control on the primary settings tab). Pre-existing; surfaced by lease-product-polish during the 2026-06-12 settings-alignment sweep.

**Where to look:** `src/pages/settings/AccountSettings.tsx` (phone state, hydration effect, `handleSaveProfile`); confirm whether `profiles` has a phone column at all.

**Stub remediation:** Either persist phone end-to-end (add/verify column, load + save) or remove the field. Root-cause hypothesis: field added with the form scaffold, persistence never wired.

---

### Item #70: Workspace-settings saves silently no-op for non-owner admins (owner-only RLS vs admin UI gates)

**Symptom:** The only UPDATE policy on `workspaces` is owner-only, but settings UIs gate on `canEditWorkspaceSettings` (admin ∥ owner). A non-owner admin's save (thresholds, discount rate, lease config, backdoor toggle, report settings) matches 0 rows, PostgREST returns no error, and a success toast fires. Worst case is the discount-rate card: the lease-financials recompute then runs with the UNSAVED rate (the `leases` UPDATE policy does allow admins/editors), rewriting every lease's `calc_*` figures from a rate the workspace row does not hold.

**Severity:** High (silent data inconsistency + figures untraceable to stored rate). Pre-existing class — same family as the `workspace_members` owner-vs-admin mismatch already filed; surfaced by lease-security-scanner + lease-repository-integrity-reviewer on 2026-06-12.

**Where to look:** `src/components/workspace/DiscountRateCard.tsx` (update → recompute without verifying the write landed); `src/pages/settings/WorkspaceSettings.tsx` save handlers; `supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql` (owner-only policy).

**Stub remediation:** Class-shape fix, one pass: (a) decide owner-only vs admin-writable for the non-entitlement settings columns and align RLS accordingly; (b) until then, chain `.select('id')` on these updates and treat 0 rows as failure before any follow-on work (especially before the recompute) or success toast. Related: the recompute and threshold saves write no audit/activity rows, and the recompute's `Promise.all` ignores per-lease errors (partial recompute still toasts success).

---


**RESOLVED 2026-06-13** — migration `20260613060000_workspaces_admin_update.sql` (applied + verified live): widened the workspaces UPDATE policy to owners + accepted admins (product decision: admins manage settings), with a new `enforce_workspace_owner_immutable` trigger blocking non-service-role owner_id reassignment (escalation). Safety verified by pre-apply security + integrity (both APPLY): #29 guard still blocks billing for all non-service-role; read-only guard still blocks config on non-live; service-role ownership-transfer path unaffected; only `intended_plan` newly admin-writable (UI-only hint, accepted LOW). FOLLOW-UP (defense-in-depth, non-blocking): the WorkspaceSettings/DiscountRateCard save handlers still don't check affected-row count — add `.select('id')` 0-row detection (esp. before DiscountRateCard's lease recompute).
### Item #71: Three WorkspaceSettings handlers missing the canEdit guard; dead upgrade-confirm dialog; unused imports

**Symptom:** (a) `handleSaveBackdoor`, `handleSaveAssetTypes`, and `makeOptionListHandlers.handleSave` lack the `if (!canEdit) return` guard their sibling handlers all have (unreachable via UI for non-admins; RLS blocks non-owners — consistency/defense-in-depth only). (b) `AccountSettings.tsx`'s confirm-upgrade AlertDialog + `confirmUpgradePlan` state is unreachable (with the two-plan type, `currentPlan !== 'starter' && isUpgrade(...)` can never be true). (c) `WorkspaceSettings.tsx` carries unused `cn`, `useQuery`, `WorkspaceRole` imports and an unused `getRoleLabel`.

**Severity:** Low (hygiene). All pre-existing; surfaced by lease-security-scanner + lease-code-auditor on 2026-06-12.

**Stub remediation:** One hygiene pass: add the guard to all three handlers (class shape, not piecemeal), delete the dead dialog + state + branch, drop the unused imports/function.

---

### Item #72: discount_rate has no DB CHECK constraint

**Symptom:** The 0 < rate ≤ 50 validation is client-only; a workspace owner can PATCH `workspaces.discount_rate` to a negative/absurd value via PostgREST, producing nonsense PV figures (own workspace only). Sibling columns (`counter_signature_default_due_days`, `report_*`) have CHECK constraints.

**Severity:** Low. Pre-existing; surfaced by lease-security-scanner 2026-06-12.

**Stub remediation:** Migration adding `CHECK (discount_rate > 0 AND discount_rate <= 50)` (security-adjacent: route through reviewers BEFORE db push per CLAUDE.md).

---

### Item #73: Out of Office has no UI entry point (intentional) — restore a revoke path before any reactivation

**Symptom:** The 2026-06-12 settings pass removed the Out of Office tab by product decision (delegation covers absence). The Phase 7 backend (table, `declare-out-of-office`/`revoke-out-of-office` functions, cron reroutes, ExceptionsDashboard read-only card) remains dormant. Verified `user_out_of_office` had ZERO rows at removal time, so nobody is stranded. However: there is no expiry cron and `act-on-chain-step` doesn't check windows — only the revoke function reverts delegated steps. If OOO is ever reactivated (or a row is created out-of-band), a user could hold an active window with no way to end it.

**Severity:** Low while dormant. Filed by lease-repository-integrity-reviewer 2026-06-12.

**Stub remediation:** If reactivating OOO: restore the settings tab AND add an admin revoke control to the ExceptionsDashboard OOO card. Until then, treat any `user_out_of_office` row as an anomaly.

---

### Item #74: delete-workspace (owner-initiated) doesn't cancel Stripe subscriptions or purge lease-documents/lease-reports buckets

**Symptom:** The owner-initiated `delete-workspace` edge function purges only the `leases` + `executed-leases` buckets (uploader-prefix convention) and never cancels the workspace's Stripe subscriptions — pack subscriptions keep billing after deletion, and `lease-documents`/`lease-reports` objects (`{workspace_id}/...` convention) survive (KNOWN_ISSUES #11 family). The cancellation-lifecycle cron fixed both for system purges (2026-06-12); the owner path still has the gaps.

**Severity:** High (recurring charges post-deletion; "deleted" documents persisting). Pre-existing; surfaced by lease-security-scanner + lease-repository-integrity-reviewer reviewing cda30d1.

**Stub remediation:** Extract the cron's Stripe-cleanup + four-bucket purge into a shared helper and use it from `delete-workspace` — one implementation so the two paths can't drift.

**RESOLVED 2026-06-13** — `_shared/workspace_purge.ts` (`cancelWorkspaceSubscriptions` + recursive 4-bucket `purgeWorkspaceStorage`) now used by BOTH `delete-workspace` (v22) and `process-cancellation-lifecycle` (v3). delete-workspace now cancels Stripe subs (incl. packs) + purges lease-documents/lease-reports (was leaking both); cron behavior preserved verbatim (order, race guards, defer-on-Stripe-failure). Security + integrity reviews: DEPLOY (no Critical/High/Medium). Both functions redeployed. Residual filed as #93 (forensic-row ordering on the owner path).

---

### Item #75: Grace "read-only" is enforced only for document processing; soft-delete access wall is UI-only

**Symptom:** During the 30-day grace window, server-side enforcement covers `process_lease`, `retry_lease`, and pack purchases. Other mutating surfaces (lease edits via PostgREST under RLS, approval-chain functions, `upload-lease-document`, invites, report generation) remain open to members of canceled — and even soft-deleted — workspaces. Workspace-scoped only (no cross-tenant risk); a policy-vs-enforcement gap, not a breach path.

**Severity:** Medium. Filed by lease-security-scanner reviewing cda30d1; remediation deliberately scoped out of the lifecycle commit.

**Stub remediation:** An `is_workspace_live()` SQL helper folded into write-side RLS policies (security migration — reviewer routing BEFORE push), or `canceled_at`/`soft_deleted_at` gates in the remaining mutating edge functions. Decide enforcement depth before customer #1 cancels.

**RESOLVED 2026-06-13** — Vault V1 read-only enforcement, BOTH depths shipped: migration `20260613000000_vault_v1_readonly_enforcement.sql` (78 restrictive RLS policies over 28 public tables via `is_workspace_live()`/`is_lease_live()`, 3 on `storage.objects`, applied + verified live) AND `_shared/workspace_live.ts` liveness gates in all 21 user-invokable mutators, liveness skips in all 7 workspace-touching crons, and full-liveness backstops in `process_lease`/`retry_lease`/`manage-document-pack` — all 31 changed functions redeployed and content-verified. Three review rounds (lease-security-scanner + lease-repository-integrity-reviewer), both APPROVED. Accepted residuals documented in `VAULT_TIER_SPEC.md` V1 as-built note; the one knowingly open mutator is #84 (resolve-approval-chain frozen deployment). Follow-up (non-blocking): LeaseReview secondary writers swallow PostgREST errors — see #85.

---

### Item #76: Nine deployed edge functions write activity types the CHECK constraint rejects — audit rows silently dropped since 2026-05-08

**Symptom:** The 2026-05-08 `lease_insights` constraint re-snapshot (archive `20260508000000`) RENAMED several activity-type values (e.g. `counter_signature_received` → `counter_signature_recorded`, `ooo_revoked` → `out_of_office_revoked`, `delegate_activated` → `delegate_timer_activated`) without renaming the writers. Nine functions still write the OLD names — `record-counter-signature` (:306), `declare-out-of-office` (:198), `revoke-out-of-office` (:158), `process-delegate-timers` (:118), `voluntary-delegate-step` (:185), `handle-deactivated-approver` (:156, :185), `upload-lease-document` (:270), `escalate-to-concept-approver` (:295), `send-counter-signature-reminder` (:268) — and every one of those inserts is awaited WITHOUT an error check, so the constraint violation is invisible. Entire categories of approval-workflow audit evidence (counter-signatures, OOO, delegation, document iterations) have not been recorded since the re-snapshot.

**Severity:** CRITICAL for audit completeness (no data corruption; rows are missing, not wrong). Root cause: re-snapshot treated the archive as specification and nobody diffed writers against the constraint. Filed by lease-repository-integrity-reviewer reviewing 5fe9e06 (2026-06-12).

**Stub remediation:** Dedicated session: (1) migration appending the nine legacy writer values to the CHECK (fastest path to stop the bleeding) OR coordinated writer rename + redeploy of all nine functions; (2) add error checks to those inserts; (3) static test that greps `activity_type:` literals across `supabase/functions/` and diffs them against the migration's CHECK list so this class can't recur.

**RESOLVED 2026-06-12** (same day filed). Full writer sweep found **12** orphaned values, not nine — the variable-assignment pass added `final_review_returned_to_negotiation` (act-on-chain-step) and `unlock_rejected` (lease-governance-action; unlock denials were never logged). Remediation shipped: migration `20260612230000_restore_orphaned_activity_types.sql` appends all twelve (APPLIED to live DB — writer inserts started landing immediately, zero redeploys needed); AuditLog labels added for the restored types; every `lease_activity_log` insert in the 11 writer functions is now error-checked (`console.error` on rejection — takes effect on next redeploy of those functions); static test `src/lib/__tests__/activityTypeConstraintSync.test.ts` diffs every writer-emitted value (literal, switch-assigned, helper-funneled) against the latest constraint migration so the class can't recur silently. Residual (non-blocking): ~18 unchecked audit inserts in 8 functions OUTSIDE the #76 writer set (finalize-report-pdf, advance-to-final-review, revoke-voluntary-delegation, generate-lease-report, admin-override-step, detect-stuck-chains, admin-trigger-manual-reroute, assign-execution-owner) — their values are all IN the constraint (the sync test proves nothing is being dropped); harden opportunistically when those files are next touched.

---

### Item #77: Storage DELETE policies on leases/executed-leases are lock-unaware — locked leases' source files deletable via raw storage API

**Symptom:** `prevent_locked_lease_edits` guards the DB row, but the storage policies ("Users can delete own lease files", `executed_leases_delete`) check only path ownership. The uploader of a model-locked lease can delete its source PDF via a direct storage API call, destroying the audit-defensible source while the lease row still points at it. The Documents-tab UI (2026-06-12) gates correctly; the API path does not.

**Severity:** High. Pre-existing; surfaced by lease-security-scanner reviewing 5fe9e06.

**Stub remediation:** Security migration (reviewer routing BEFORE push): add a `NOT EXISTS (SELECT 1 FROM leases WHERE ... AND model_locked)` condition to both DELETE policies — or route deletion through an edge function that re-checks `model_locked` server-side.

**RESOLVED 2026-06-13** — migration `20260613030000_destruction_guards.sql` (applied + verified live): restrictive DELETE policy `locked lease source files are not deletable` on storage.objects blocks deleting a leases/executed-leases object referenced by a `model_locked` lease (ANDs with the V1 liveness policy). Pre-apply security+integrity review: APPLY.

---

### Item #78: Lease archive ("Delete") admin gate is UI-only; archived_by/archived_at are client-supplied

**Symptom:** `leases_update_own_or_workspace_editor` lets any workspace editor set `archived = true` on any lease (including locked ones — archive columns are in the lock trigger's ignored_keys) via direct PostgREST, with arbitrary `archived_by` attribution and a client-clock `archived_at`. The UI (ArchiveButton, AmendmentsList) gates to admin/owner and now logs both directions (2026-06-12), but the log writes are also client-side and skippable.

**Severity:** High (audit-relevant records hideable by non-admins with forged attribution). Pre-existing; surfaced by lease-security-scanner reviewing 5fe9e06.

**Stub remediation:** BEFORE UPDATE trigger on archive-column transitions: require admin/owner, stamp `archived_by = auth.uid()` and `archived_at = now()` server-side (disjoint-columns pattern; inventory existing triggers first per CLAUDE.md). Same family: "Users can create activity entries" INSERT policy allows any member to forge ANY activity_type with `user_id` self-or-NULL — constrain client-insertable types to an allowlist in the same pass.

**PARTIALLY RESOLVED 2026-06-13** — archive half APPLIED + verified live: migration `20260613040000_lease_archive_attribution_guard.sql` (BEFORE UPDATE trigger requiring admin/owner to toggle `archived`, stamping `archived_by`/`archived_at` server-side; firing order `enforce_lease_archive_attribution < enforce_model_lock` confirmed). Pre-apply integrity + security reviews both APPLY (no Critical/High/Medium). The activity-type allowlist half is split out as **#90** (still OPEN — needs per-type adjudication).

**Addendum (2026-06-12, lease-security-scanner reviewing 3b9ec87):** the #76 remediation widened the CHECK with 12 writer values, all of which are written EXCLUSIVELY by edge functions (service role) — the allowlist remediation above must exclude every one of them from client-insertable types. Priority subset: dashboard-consumed types, where a forged row drives admin action — `policy_assignee_validation_failed` and `stuck_chain_detected` both render as exception alerts in `ExceptionsDashboard.tsx` (:97, :104); a member-forged "validation failed" row (user_id NULL = system-attributed) can induce an admin to reassign/override a healthy chain step.

---

### Item #79: "Delete" means hard-delete on the Leases list but restorable-archive everywhere else

**Symptom:** `Leases.tsx` + `DeleteLeaseDialog` perform a true `DELETE` ("permanently removed… cannot be undone") while LockedHeader, LeaseReview's overflow, and AmendmentsList all use archive semantics under the same "Delete" label and trash iconography. A user who learns "Delete is restorable" on the detail page will hard-delete from the list expecting restorability.

**Severity:** High (misled-into-destructive-action class). Pre-existing; surfaced by lease-product-polish reviewing 5fe9e06.

**Stub remediation:** Pick the vocabulary once: either make the list delete archive-semantics (preferred — hard delete then only via a deeper governance path), or relabel it "Delete permanently" with distinct iconography.

**RESOLVED 2026-06-13** — chose archive-semantics (product decision): the Leases-list row action now archives (restorable, admin/owner-only, server-enforced by the #78 trigger) via the new `ArchiveLeaseDialog`, not hard-delete. True hard-delete remains only on the deeper path (ImportHistory import-rollback, `DeleteLeaseDialog`). Frontend; integrity/auditor reviewed. Remaining copy-layer work (archive still WORDED 'Delete' on detail-page surfaces) split to #92; archived-lease findability/restore-in-list to #91.

---

### Item #80: Profile Phone field is a dead control

**Symptom:** `AccountSettings.tsx` renders a Phone input that is never loaded from and never saved to `profiles` — Save Changes toasts success while silently discarding the value.

**Severity:** Medium-High (silent data loss + lying success toast on the first Settings tab). Pre-existing; surfaced by lease-product-polish reviewing 5cac271.

**Stub remediation:** Wire `phone` into the profile load + `handleSaveProfile` payload (column exists check first), or remove the field.

**RESOLVED 2026-06-13** — verified `profiles` has NO `phone` column (live DB), so the field was a pure dead control (never loaded, omitted from the save payload). Removed the Phone input + state from AccountSettings; #69 is the same issue and is resolved by this. Restore only with a real column + load/save wiring.

---

### Item #81: Audit-insert failures have no observer; two residual silent paths

**Symptom:** The #76 error-check pass converts rejected `lease_activity_log` inserts from silent to `console.error` — but nothing watches edge-function logs (no Sentry capture in functions; retention is short; cron writers have no user in the loop), so a future rejection from a new cause could again run for weeks. Residuals: (a) `request-lease-unlock/index.ts:130` uses `.catch()` on the insert — supabase-js RESOLVES with `{error}` on Postgres rejection, so the catch only fires on network failures (an error check that looks present but isn't); (b) ~18 unchecked audit inserts in 8 functions outside the #76 writer set (values all in-constraint per the sync test — nothing currently dropped); (c) repo-file ↔ live-constraint parity is statically unverifiable after the out-of-band apply.

**Severity:** Medium. Filed by lease-repository-integrity-reviewer + lease-security-scanner reviewing 3b9ec87/6110442 (2026-06-12).

**Stub remediation:** (1) wire audit-insert failure counts into the ops-monitoring surface at `/app/admin/operations` or the AI-operator nightly health check ("daily chain-step actions vs. audit rows"); consider failing the request when approval-evidence inserts (`status_change`, `chain_step_*`) fail — an approval without its row is not defensible; (2) convert request-lease-unlock to the destructure pattern next touch; (3) add a live constraint-vs-migration diff to `scripts/smoke-audit-hardening.mjs`.

---

### Item #82: Twelve dead renamed activity types in the constraint; one pre-existing label gap

**Symptom:** The 2026-05-08 re-snapshot's renamed values (`counter_signature_recorded`, `out_of_office_revoked`, `delegate_timer_activated`, `voluntary_delegation_set`, `deactivated_approver_handled`, `document_iteration_started`, `counter_signature_overdue_recorded`, etc.) have had ZERO writers ever — no rows exist or can exist under those spellings. They sit in the constraint advertising a vocabulary that was never real; a future writer "adopting" one would fork event vocabulary (two names for one event class — unreconstructable for an auditor). The writer spellings restored by #76 are canonical. Separately: `counter_signature_reminder_sent` is actively written but has no ACTIVITY_LABELS entry in AuditLog.tsx (renders raw).

**Severity:** Low. Filed by lease-repository-integrity-reviewer + lease-code-auditor (2026-06-12).

**Stub remediation:** Next constraint snapshot: after a live `SELECT activity_type, count(*)` confirms zero rows, drop the twelve dead values and comment the writer spellings as canonical — do-not-adopt. Add the missing label.

---

### Item #83: Owner can hard-DELETE the workspaces row via PostgREST, bypassing the deleted_workspaces forensic record

**Symptom:** The baseline permissive policy "Owners can delete their workspaces" lets an owner DELETE their `workspaces` row directly (PostgREST), cascading away the entire repository WITHOUT the forensic `deleted_workspaces` row that the `delete-workspace` edge function writes — unattributable bulk destruction. Pre-existing; reachable in any workspace state including grace/Vault (the Vault V1 restrictive layer deliberately leaves `workspaces` open for owner rename and must not block this path silently either way — it needs an explicit decision).

**Severity:** High (unattributable destruction of the audit-defensible repository). Filed by lease-repository-integrity-reviewer reviewing 69fdc2e (2026-06-13).

**Stub remediation:** Drop the permissive DELETE policy in favor of the `delete-workspace` edge function (which writes the forensic row), or add a restrictive DELETE policy on `workspaces` denying client deletes outright. Security migration — reviewer routing BEFORE push. Verify the delete-account flow doesn't depend on the client-side DELETE first. NOTE (Vault V1, 2026-06-13): the fix must also cover non-live workspaces — FK CASCADE deletes are not subject to the Vault restrictive DELETE policies on child tables, so this direct-DELETE path is also the one way a frozen repository can be destroyed client-side.

**RESOLVED 2026-06-13** — migration `20260613030000_destruction_guards.sql` (applied + verified live): dropped the permissive `Owners can delete their workspaces` policy and added a restrictive `workspace deletes are server-only` (USING false) DELETE policy. Verified both deletion paths (delete-workspace, delete-account) use service_role (RLS-exempt) and no client-side workspace DELETE exists, so the forensic/cleanup paths are unaffected. Pre-apply review: APPLY.

---

### Item #84: resolve-approval-chain deployed snapshot is un-gateable for Vault V1 (accepted residual)

**Symptom:** `resolve-approval-chain` is user-invokable (JWT member) and triggers service-role writes to `leases`, `lease_approval_chain`, `lease_attribute_snapshots`, `lease_reroute_events` — but its deployed copy is the frozen pre-Phase-7 snapshot whose redeploy is permanently deferred (CLAUDE.md / PHASE_7_BUILD_SPEC A4). The Vault V1 liveness gate therefore cannot reach it: a member of a canceled/soft-deleted/vault workspace can still invoke it directly and mutate chain state.

**Severity:** Medium (member-only exposure, chain-resolution logic only; the resulting writes are system-attributed). ACCEPTED RESIDUAL per product-owner decision 2026-06-13 — filed, not fixed, because gating requires overriding the standing Phase 7 redeploy deferral.

**Stub remediation:** When Phase 7 A4 remediation is eventually executed, add the `checkWorkspaceLive` gate (pattern: any gated chain function, e.g. `act-on-chain-step`) to the repo file in the same change and redeploy. Until then this is the one knowingly open mutator in the Vault V1 read-only surface.

---

### Item #85: LeaseReview secondary writers swallow PostgREST errors (optimistic UI lies on rejected writes)

**Symptom:** `src/pages/app/LeaseReview.tsx` — `handleConfirmTab` (~:1326), `handleConfirmSection` (~:1206), `handleConfirmAndAdvance` (~:1266), and `trackFieldCorrection` (~:1176) ignore the PostgREST `error` object. With Vault V1's restrictive `WITH CHECK` policies, a grace-workspace user unmarking an approved tab gets "Tab reopened" while the DB rejected the write (42501); section-confirm state diverges optimistically; `field_corrections` inserts drop silently. The main save handler (~:1588) does it right — destructure, throw, toast.

**Severity:** Medium (UI/DB drift for non-live workspaces; live workspaces unaffected). Filed by lease-repository-integrity-reviewer round 2 of Vault V1 (2026-06-13).

**Stub remediation:** Destructure and surface `error` in each of the four writers, matching the ~:1588 pattern. Frontend-only commit; route through auditor + security + polish (user-facing error copy).

---

### Item #86: stripe-webhook trusts frozen subscription metadata plan_id over the live price

**Symptom:** `resolvePlan` (`supabase/functions/stripe-webhook/index.ts`) returns `metadata.plan_id` unconditionally before consulting the subscription's actual price. Metadata is stamped at creation and frozen; if the Stripe billing-portal configuration (dashboard-side, not in repo) ever permits price switches, a Business sub moved to the Starter price keeps `plan_id='business'` → Business entitlements at Starter money. All current creation paths stamp metadata server-side from validated input, so this is configuration-contingent, not exploitable today.

**Severity:** Medium. Filed by lease-security-scanner reviewing 59481c6 (2026-06-13); pre-existing class, V2 merely extended it to a third value (vault metadata can only under-privilege, so the new direction is benign).

**Stub remediation:** When both metadata and price resolve, prefer the price-derived plan and log a mismatch warning ("trust the money, not the metadata" — same principle as `applySingleLeaseCredit`). Or verify + document that the portal config disallows price changes.

---

### Item #87: WorkspaceSettings "General" save bundles name+timezone — rename fails as collateral during grace/Vault

**Symptom:** `src/pages/settings/WorkspaceSettings.tsx` `handleSaveGeneral` updates `name` AND `timezone` in one `workspaces` UPDATE. The read-only config guard (migration `20260613010000`) rejects the statement on a non-live workspace because `timezone` is a guarded column — so an owner on a canceled-in-grace / soft-deleted / Vault workspace who only wanted to rename gets a hard failure with no indication timezone is the cause. The dedicated rename path (`RenameWorkspaceInline.tsx`, name-only) still works, so rename is not globally lost.

**Severity:** Medium (UX wrinkle on a read-only workspace; no data risk — the guard is working as intended). Filed by lease-security-scanner pre-apply review of the Vault V3 read-only guard (2026-06-13). Root cause is broader: WorkspaceSettings' client `canEdit` is role-only and doesn't reflect non-live state — full client-side read-only gating of WorkspaceSettings is V4 (read-only UI walls) territory.

**Stub remediation:** Either split the name update out of `handleSaveGeneral` when non-live, or gate the General form (and the rest of WorkspaceSettings) client-side on `isReadOnlyRetention`/grace state as part of the V4 read-only UI pass. Until then, the inline rename remains the working path.

**RESOLVED 2026-06-13** — `handleSaveGeneral` now attempts the bundled name+timezone update, and on rejection retries the rename ALONE (so a non-live config-guard rejection of timezone no longer blocks the rename), with a `.select('id')` 0-row check (#70 defense-in-depth) surfacing RLS no-ops as honest errors instead of false success. Full client-side read-only gating of WorkspaceSettings remains V4 read-only-UI territory.

---

### Item #88: Vault dashboard still shows intake-oriented widgets with live CTAs

**Symptom:** On a Vault (read-only) workspace the Dashboard top-level "New Request" CTA is hidden and the VaultBanner explains the read-only state, but the dashboard BODY widgets (NeedsAction, LeasePipeline, etc.) still render and some of their inline items link to create/approve flows that can't run on a read-only workspace. The felt experience is a half-disabled cockpit rather than a clean archive. Server backstop blocks any write; this is UX completeness, not a data risk.

**Severity:** Medium (UX). Filed during Vault V4 polish review (2026-06-13); deliberately deferred from the V4 hardening round (diffuse, lower-priority than the LeaseReview/billing surfaces which were fixed).

**Stub remediation:** Thread a read-only signal into the Dashboard widgets (or gate per-widget create/approve CTAs on `isReadOnlyRetention`), so NeedsAction/pipeline items render view-only for Vault. Consider a "read-only archive" empty-affordance treatment.

---

### Item #89: Vault renewal-reminder email is English-only

**Symptom:** `supabase/functions/vault-renewal-reminder/index.ts` hard-codes English copy and `en-US` date formatting for the ~14-day renewal reminder, even though the owner may be a Spanish-locale user. Every other user-facing surface is bilingual.

**Severity:** Low. Filed during Vault V4 polish review (2026-06-13).

**Stub remediation:** Branch the subject/body/date-format on the owner's profile/workspace locale if available (the cancellation-lifecycle emails share the same English-only limitation — consider a shared bilingual email helper). Content itself is clear and correctly framed; this is i18n completeness only.

---

### Item #90: lease_activity_log INSERT policy allows any activity_type + forged system attribution (split from #78)

**Symptom:** The "Users can create activity entries" INSERT policy on `lease_activity_log` is `WITH CHECK (((user_id = auth.uid()) OR (user_id IS NULL)) AND <member-of-lease's-workspace>)`. So any workspace member can insert a row with ANY of the ~100 constraint activity_types AND `user_id = NULL` (system attribution) via direct PostgREST. The dashboard-consumed types are the sharp edge (#78 addendum): a member-forged `policy_assignee_validation_failed` / `stuck_chain_detected` row (NULL user_id = system-attributed) renders as an exception alert in `ExceptionsDashboard.tsx` and can induce an admin to reassign/override a healthy chain step. The 12 dead renamed types (#82) and every edge-function-exclusive writer type must be excluded from any client allowlist.

**Severity:** High (forgeable audit history + admin-misleading alerts in an audit-defensible product). Split from #78 (2026-06-13) — the archive half shipped as migration `20260613040000`; this half needs per-type adjudication across the ~100-value constraint and the ~10 client insert sites, so it's its own deliberate pass, not a same-migration rush.

**Stub remediation:** Security migration (reviewer routing BEFORE push). Enumerate every client insert site (grep `lease_activity_log` in `src/` — currently ~10 sites writing ~18 types) and confirm which types clients legitimately write directly vs. should be moved to an edge function (e.g. `status_change`/`approval` arguably belong server-side, cf. #32). Then narrow the INSERT policy WITH CHECK to `user_id = auth.uid()` (drop the NULL option) AND `activity_type = ANY(<client allowlist>)`. Verify no legitimate client flow breaks (each currently-written type stays allowed or is rerouted) before applying. Add a static/smoke test pinning the allowlist.

**RESOLVED 2026-06-13** — migration `20260613050000_activity_log_client_allowlist.sql` (applied + verified live): the INSERT policy now AND-s a 19-type client allowlist (enumerated + verified against all 37 src/ writer sites incl. the two dynamic ones), so a browser client can no longer forge the ~80 service-role-only types — the alert types (`policy_assignee_validation_failed`, `stuck_chain_detected`) are confirmed excluded. Predicate preserved verbatim; edge functions bypass RLS. `user_id` left flexible (NULL retained for legit system comments — tightening to NULL-only-for-comment is the noted follow-up). Regression test `src/lib/__tests__/clientActivityAllowlist.test.ts`. Pre-apply security + integrity: both APPLY (no Critical/High/Medium).

**#90-NULL RESOLVED 2026-06-13** — the noted follow-up shipped as migration `20260613070000_activity_log_null_attribution_comment_only.sql` (applied + verified live via `pg_policy.polwithcheck`): the user_id clause tightened from `(user_id = auth.uid()) OR (user_id IS NULL)` to `(user_id = auth.uid()) OR (user_id IS NULL AND activity_type = 'comment')`, so an authenticated member can no longer forge a system-attributed (NULL) row for any non-comment allowlisted type (`status_change`/`approval`/`lease_archived`/etc.). Strictly monotonic tightening; allowlist + EXISTS predicate + Vault RESTRICTIVE policy preserved verbatim. Verified non-breaking against every client writer: all literal `user_id: null` sites are comment-typed; the defensive `?? null` non-comment sites only run inside authenticated, member-gated flows (EXISTS already needs a non-null `auth.uid()`), so user_id is the real UID at runtime. Regression guard extended in `clientActivityAllowlist.test.ts` (pins the carve-out + sweeps for literal-null non-comment writers; 8/8). Pre-apply security + integrity: both APPLY (no Critical/High/Medium). PR #39.

---

### Item #91: Leases "Show archived" shows all leases (no archived-only filter) + no in-list restore

**Symptom:** `Leases.tsx` "Show archived" toggle widens the query but doesn't `.eq('archived', true)`, so it shows active + archived together with no badge distinguishing them; and archived rows have no in-list Restore action (restore lives only on the lease detail page via `ArchiveButton`). After #79 the archive dialog points users to "Show archived" + the detail page, so findability matters more.

**Severity:** Low-Medium (UX). Pre-existing filter gap surfaced by lease-repository-integrity-reviewer during the #79 review (2026-06-13); the #79 fix pointed restore at the detail page to avoid a false promise, leaving this as the polish follow-up.

**Stub remediation:** In the showArchived branch, filter `.eq('archived', true)` (or add an "Archived" badge on archived rows), and add an in-list Restore action on archived rows mirroring `ArchiveButton`'s restore (archived=false, null attribution, log `lease_restored`). Route through lease-product-polish.

**RESOLVED 2026-06-13** — 'Show archived' now filters to archived-only; archived rows get an 'Archived' badge + an in-list Restore action (mirrors ArchiveButton: non-destructive, admin-only via the #78 trigger, logs lease_restored, .select check). Polish-reviewed; follow-up fixes applied: archive-specific empty state with a 'Back to active leases' way-out (was the misleading 'No executed leases' dead-end), refreshProfile() after archive+restore so quota counters resync, and i18n'd restore toasts + tooltip labels. Accepted residual: in-list restore has no pre-action cap-warning dialog (non-destructive + reversible; counters resync + QuotaWarningBanner gives post-hoc feedback) — the dialog-gated ArchiveButton restore remains for the warned path.

---

### Item #92: Archive vocabulary is labeled "Delete"/"deleted" across ArchiveButton, badges, banners, and archive.* locale keys

**Symptom:** The restorable-archive action is worded as "Delete" throughout the detail-page surfaces: `archive.archive` = "Delete", `archive.archived_toast` = "Lease deleted", `archive.deleted_badge` = "Deleted", `archive.deleted_banner`, `archive.confirm_archive_title` = "Delete this lease?". So "Delete" still means archive (restorable) on the detail page while meaning permanent deletion in ImportHistory — the same dual-meaning #79 set out to remove, at the copy layer. #79 fixed the Leases-LIST semantics + used clear "Archive" wording in the new list dialog, but did not rename the detail-page archive vocabulary.

**Severity:** Medium (the core #79 confusion persists in detail-page copy). Surfaced during the #79 review (2026-06-13).

**Stub remediation:** Vocabulary unification pass (lease-product-polish + locale parity en/es): rename the `archive.*` key VALUES from Delete→Archive wording across `ArchiveButton`, badges, and banners so "Delete" means only permanent deletion anywhere. Multi-surface user-facing copy change — review before shipping.

**RESOLVED 2026-06-13** — archive vocabulary unified to Archive/Archived/Restore across archive.* + amendments.delete_* VALUES (en+es), AmendmentsList (Archive icon + aria-label, non-destructive), and the three trigger labels polish caught (LeaseReview toolbar + overflow menu, AmendmentsList confirm CTA — now localized, non-destructive). "Delete" now appears only for genuine permanent deletion (ImportHistory/DeleteLeaseDialog, LeaseDocumentsTab). Polish + auditor reviewed; locale parity holds. Minor LOW left: a couple of internal code comments still say "delete" (non-rendered).

---

### Item #93: delete-workspace writes the forensic deleted_workspaces row LAST; a failure leaves a destroyed workspace unrecorded

**Symptom:** `delete-workspace/index.ts` writes the `deleted_workspaces` forensic row near the END (after Stripe cancel + storage purge), and a forensic-insert failure is only logged — so a workspace can be destroyed with no forensic record. The cancellation cron does the opposite (forensic row BEFORE destruction, abort on failure). The two destruction paths use opposite forensic ordering by design; delete-workspace's is the weaker one.

**Severity:** Medium (forensic gap on the owner-initiated path). Pre-existing; surfaced by lease-repository-integrity-reviewer during the #74 review (2026-06-13).

**Stub remediation:** Move delete-workspace's forensic `deleted_workspaces` insert to BEFORE the destructive deletes (mirror the cron), aborting the delete if the forensic insert fails — so destruction is never unattributable.

**RESOLVED 2026-06-13** — delete-workspace (v23 deployed) reordered to match the cron: forensic `deleted_workspaces` row inserted BEFORE the lease/workspace deletes (aborts 500 `forensic_insert_failed` on a non-duplicate error; resumes on the unique-index duplicate), storage purge moved LAST, `storage_objects_purged` backfilled. Pre-deploy integrity review: DEPLOY (no findings).

---

### Item #94: UploadExecutedDocumentDialog sets lifecycle_status='executed' client-side without status_changed_at or an activity-log row

**Symptom:** `src/components/leases/UploadExecutedDocumentDialog.tsx:61` does a client-side `leases.update({ lifecycle_status: 'executed' })` with NO `status_changed_at` set and NO `lease_activity_log` row written in `src/` — it relies on `process_lease` having already written the `executed_uploaded`/`status_change` rows. This violates the Lifecycle Transition Convention (CLAUDE.md: any code transitioning `lifecycle_status` must set `status_changed_at` + write a `status_change` activity row with `from_status`/`to_status` + `routing_path`). If the process_lease path doesn't fire for this transition, the change is unattributable.

**Severity:** Medium (lifecycle-convention gap; potential unattributable status transition). Surfaced by lease-repository-integrity-reviewer during the #90 review (2026-06-13).

**Stub remediation:** Either route this transition through the canonical lifecycle writer (so status_changed_at + the activity row are guaranteed), or confirm + document that process_lease always writes them for this path and the client update is redundant/safe. Verify against the convention before closing.

**RESOLVED 2026-06-14** — the flip was moved server-side into `process_lease`'s executed branch (deployed v101, `verify_jwt` preserved false; deployed bundle confirmed to contain the change). It now captures `from_status` from the already-fetched `existingLease.lifecycle_status`, sets `lifecycle_status`+`status_changed_at` in the SAME existing UPDATE (single trigger fire), and writes a convention `status_change` row carrying the real `user.id` (top-level `from_status`/`to_status` AND `details.{from,to,routing_path:'extraction',triggered_by:'process_lease_executed_upload'}`). Idempotent: only flips+logs when prior status != 'executed' (`executed_uploaded`/`executed_terms_extracted` still log every upload). The client flip in `UploadExecutedDocumentDialog.tsx` was removed. Reviewers: auditor CLEAN, security APPLY, integrity APPLY (no Critical/High/Medium on the change). Test: `src/lib/__tests__/executedLifecycleFlip.test.ts`. Spawned follow-up #96 (pre-existing `transitioned_by` NULL gap). Verification ceiling: deployed-code == committed + convention-compliant by review; a live executed-upload was not exercised end-to-end (needs an approved lease + PDF). PR #41.

---

### Item #95: live smoke layer (`audit_rls_smoke_check`) has no key for the `lease_activity_log` INSERT policy

**Symptom:** The `audit_rls_smoke_check` SECURITY DEFINER function (`supabase/migrations/20260517000000_governance_hardening_followup.sql:~549`, run via `npm run smoke:security` / `scripts/smoke-audit-hardening.mjs`) content-checks 25+ policies against the live DB but has **no key for the `lease_activity_log` "Users can create activity entries" INSERT policy** — neither #90's 19-type client allowlist nor #90-NULL's `user_id IS NULL AND activity_type='comment'` carve-out. So the live net that catches Studio/MCP policy drift is blind to this policy. The static tests (`clientActivityAllowlist.test.ts`) catch in-repo drift only; the live layer is what would catch a hand-edit reverting the allowlist/carve-out in the DB. **The original #90 residual came from exactly this class of live policy state**, so the absence of a smoke key here is the meaningful gap.

**Severity:** Medium (live-drift blind spot on an audit-defensibility policy). Pre-existing — #90/#90-NULL added static guards but never a smoke key; surfaced by lease-test-author during the #90-NULL post-work sweep (2026-06-13).

**Stub remediation:** Add a boolean key (e.g. `lease_activity_log_insert_comment_null_only`) to `audit_rls_smoke_check` that introspects the policy's `with_check` (via `pg_policies` / `pg_get_expr`) and asserts BOTH the 19-type allowlist presence AND the comment-only NULL carve-out (`user_id IS NULL AND activity_type = 'comment'`), plus the absence of the loose unqualified `user_id IS NULL` clause. The runner is key-agnostic (any new boolean key is auto-asserted), so this is a superset addition. **Requires a new migration to a SECURITY DEFINER governance function → routes through lease-security-scanner review BEFORE `db push` (expect 3+ rounds per CLAUDE.md security-migration rule).** Add a static test pinning the new smoke key alongside.

---

### Item #96: `lease_state_transitions.transitioned_by` is NULL for every server-side (service-role) lifecycle flip

**Symptom:** The AFTER UPDATE trigger `log_lease_state_change()` (`supabase/migrations/20260516120000_baseline_schema.sql:~456`, bound at `:3063`) records `transitioned_by = auth.uid()` into the secondary `lease_state_transitions` table on every `lifecycle_status` change. Edge functions run as `supabaseAdmin` (service_role), where `auth.uid()` is NULL — so **every server-side lifecycle flip writes `transitioned_by = NULL`** to `lease_state_transitions`. An auditor reconciling that table finds executed/active/etc. transitions with no actor, even though the parallel `lease_activity_log.status_change` row DOES carry the real `user_id`. The two audit tables disagree on attribution for the same event.

**Severity:** Medium (secondary-audit-table attribution gap; the primary `lease_activity_log` is correctly attributed). **Pre-existing and broad** — affects ALL service-role flips: `process_lease`'s new-lease pipeline flip (`:~2619`) and the new #94 executed flip, plus the chain/legacy edge writers (`act-on-chain-step`, etc.) that hit the same trigger under service_role. NOT introduced by #94 — surfaced by lease-repository-integrity-reviewer during the #94 review (2026-06-14); #94 actually improves attribution (its `lease_activity_log` row carries the real actor).

**Stub remediation:** The fix lives in the trigger + the callers, not in any one edge function. Have the edge functions pass the actor explicitly into the transaction (e.g. `SET LOCAL` a `app.transition_actor` GUC, or `request.jwt.claim.sub`) and have `log_lease_state_change()` read `transitioned_by = COALESCE(auth.uid(), current_setting('app.transition_actor', true)::uuid)`. Touches a baseline trigger + every service-role lifecycle writer → security + integrity review BEFORE apply; sweep all callers in one pass so the GUC is set everywhere the trigger can fire.

---

### Item #97: workspace component tests fail locally on Node ≥22 (`localStorage` undefined) — CI on Node 20 is green

**Symptom:** `npm test` on Node ≥22 (reproduced on Node 26) fails 49 tests across `src/components/workspace/__tests__/NewWorkspaceDialog.test.tsx` and `WorkspaceCommandPalette.test.tsx` with `TypeError: Cannot read properties of undefined (reading 'setItem'/'clear')` plus `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`. Root cause: Node 22 introduced a built-in experimental `localStorage` global that is inert without `--localstorage-file`; under vitest's jsdom environment it shadows jsdom's own `localStorage`, so the bare `localStorage` these tests use resolves to `undefined`. On Node 20 (no built-in) jsdom's `localStorage` is used and the tests pass. **CI runs Node 20 (`.github/workflows/ci.yml:35`) so its "Run tests" step is green** — this is a local-dev-only failure, not a code or CI regression.

**Severity:** Low (developer-experience / test-portability; no production or CI impact). NOT a code defect — the components work in-browser where `localStorage` is real. Pre-existing — these workspace tests have always assumed jsdom's `localStorage`; surfaced 2026-06-14 during the #94 "nothing broken" verification when the suite was run on Node 26. Discovery side-note: the local `node_modules` was also stale (jsdom + `@stripe/stripe-js` declared but uninstalled), which masked the suite entirely until `npm ci` — unrelated, resolved by reinstall.

**Stub remediation (pick one):** (a) Pin local Node to 20 to match CI — add a `.nvmrc` (`20`) and/or `engines.node` in package.json so contributors don't run on a drifting toolchain; lowest effort, restores parity. (b) Make the tests Node-22+ tolerant — in `_jsdomPolyfills.ts` (or a shared setup), guard/stub `localStorage` when the global is the inert Node built-in (e.g. detect missing `setItem` and install an in-memory shim), so the suite passes on any Node. (b) is the more durable fix as the floor Node version rises; (a) is the quick parity fix. Either way, also consider bumping CI's `node-version` deliberately rather than letting local drift decide.

---

### Item #98: CI actions run on deprecated Node 20 — `actions/checkout@v4`, `actions/setup-node@v4`, `supabase/setup-cli@v1`

**Symptom:** The green CI run on 2026-06-14 (run 27520431813) emitted a GitHub deprecation warning: "Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, supabase/setup-cli@v1. Actions will be forced to run with Node.js 24 by default starting **June 16th, 2026**. Node.js 20 will be removed from the runner on **September 16th, 2026**." The workflow uses four action refs (all in `.github/workflows/ci.yml`): `actions/checkout@v4` (lines 30, 93), `actions/setup-node@v4` (line 33), `supabase/setup-cli@v1` (line 96). The runner explicitly flagged checkout@v4 and setup-cli@v1; setup-node@v4 also runs its action runtime on Node 20 (v5.0.0+ moved to node24), so it belongs in the same bump even though it wasn't named.

**Severity:** Low now (warning only; the 2026-06-14 run passed). Escalates on two dates: **2026-06-16** Node 24 becomes the forced default (could surface action-runtime incompatibilities early), and **2026-09-16** Node 20 is removed from the runner (hard break if not bumped). Ref: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/

**Stub remediation:** Bump each action ref to a major whose action runtime is Node 24, then push and confirm the next run still produces job rows (per the CLAUDE.md GH Actions gotcha — a broken workflow shows zero job rows). Targets verified 2026-06-14 (re-confirm latest at fix time): `actions/checkout@v4 → v6`; `actions/setup-node@v4 → v6` (v5+ runs node24); `supabase/setup-cli@v1 → v2` (Bun-based runtime, current major). Pure CI-config change; no app/DB impact. Note vs #97: the CI `node-version` is pinned to 20 in setup-node — that's the Node the workflow *installs* and is independent of the action *runtime* bump here, but revisit both together if standardizing the toolchain.

---

### Item #99: UsageContent "Unlimited active leases" branch (`activeMax === -1`) is unreachable for every current plan — Low

**Symptom:** `src/pages/app/UsageContent.tsx` carries an `activeUnlimited = activeMax === -1` branch (renders "Unlimited", no bar, no count line). `activeMax` comes from `workspace.maxActiveLeases`, which `AppContext.tsx:232` sets to `documentLimit` (the DB `document_limit`, or `planConfig.maxActiveLeases`). No plan in `pricing.ts` sets `maxActiveLeases` to `-1` (starter 15, business 50, vault 0; only `maxUsers` is `-1`), so the branch is dead defensive code — it only fires if a `document_limit` of `-1` is hand-written to a workspace row. Consequence: a Business workspace at 50/50 active leases shows a full red "100% used" bar, which is **correct** per the no-unlimited pricing model (CLAUDE.md Pricing: packs/overage are the relief valve), not a missing "Unlimited" state.

**Severity:** Low. NOT a defect — surfaced by lease-product-polish during the 2026-06-13 Usage row-redesign review and dismissed by the product owner as benign pre-existing code. Pre-existing: the original 4-card layout had the identical `activeMax === -1` handling; the redesign preserved it verbatim. No customer-facing wrongness today.

**Stub remediation:** Optional cleanup — either delete the `-1` branch (and the `activeUnlimited` plumbing) if no future plan will ever be unlimited, or keep it as forward-compat scaffolding with a one-line comment that no current plan config triggers it. Do NOT add an unlimited active-lease tier without a pricing decision (violates the 75%-margin / no-unlimited rule). A guard test pinning the branch already exists in `UsageContent.test.tsx` (added during the same review).

---

### Item #100: Billing tab — recovery banner and plan header offer two competing CTAs to the same Business checkout — Low

**Symptom:** On the Billing tab (`src/pages/settings/AccountSettings.tsx`) when a workspace abandoned a Business checkout (`intendedPlan === 'business' && plan !== 'business'` and not active/trialing), the recovery banner ("You picked Business during signup… complete Business checkout") renders, and directly below it the plan header shows the Starter plan with an "Adjust plan" button that also routes to a Business upgrade. Two stacked CTAs lead to the same checkout — extra decision friction on a conversion-critical surface (violates one-gesture-per-state).

**Severity:** Low. **Pre-existing** — the old design had the same double-up (recovery banner Card + inline upgrade Card); surfaced by lease-product-polish during the 2026-06-15 Billing Claude-redesign review and dismissed by the product owner as not blocking. Not a dead-end (both paths work); purely a friction/clarity nit.

**Stub remediation:** When the recovery banner is visible, suppress the plan header's "Adjust plan" button (or vice-versa) so there's one obvious next gesture. Both gate on the same `workspace.intendedPlan`/`subscriptionStatus` state already, so the condition is cheap to add.

---

### Item #101: Staging billing data is pre-Stripe synthetic — live card/invoice path unverified — Low (staging-only)

**Symptom:** The only staging workspace (`Labs Analytix`, `c9dad4c7-d04a-4d14-b846-8e017d662341`, owner `daniel.c.priest@gmail.com`) is `plan='business'`, `subscription_status='active'`, but has `stripe_customer_id=NULL`, `stripe_subscription_id=NULL`, and `subscription_period_end=NULL` (no `lease_credit_purchases` rows either). That's an impossible *real* state — the workspace was created 2026-01-07 (before billing was wired) and grandfathered to business/active directly in the DB, never through a Stripe checkout. Consequence: the new `get-billing-summary` edge function returns its `no_customer` 200 for it, so the Billing tab's Payment shows "Add payment method" / "No payment method on file yet" and Invoices shows "No invoices yet". The live Stripe card + invoice **retrieval** path therefore could not be smoke-tested end-to-end (verified live: deploy, CORS, auth gates, clean boot, and the `no_customer` branch — but not a real card/invoice fetch).

**Severity:** Low, **staging-only**. NOT a code defect — the redesign (PR #47, merged 2026-06-15) and `get-billing-summary` handle the no-customer state by design. The data inconsistency predates the billing work. Product owner chose to **leave the data as-is** (2026-06-15) rather than create test Stripe objects or reset the workspace.

**Stub remediation (when verification is wanted):** the path self-heals the first time any workspace completes a real checkout — `stripe-webhook` backfills `stripe_customer_id`/`stripe_subscription_id`/`subscription_period_end` and the Payment/Invoices sections light up. To force it on staging without a browser checkout: create a Stripe **test-mode** customer + card + Business subscription for the owner and write the IDs back (a one-off backfill), or reset this workspace to a pre-checkout state and run Stripe Checkout in-app with test card `4242 4242 4242 4242`. Do NOT write a fabricated `cus_…` id — the function would call Stripe with a non-existent customer and 502 instead of returning the clean empty state.

---

### Item #102: Phase 9 firm edge functions return raw DB error messages (constraint-name leak) — Low

**Severity:** Low. **Surfaced 2026-06-15** during the Phase 9 firm-foundation build (self-noted while writing `create-firm`/`add-firm-member`/`bind-workspace-to-firm`/`release-workspace-from-firm`); NOT yet fixed — filed as its own beat per the pre-existing-issue discipline.

**Symptom:** The four service-role firm edge functions surface Postgres errors to the client by passing `error.message` straight into the JSON response body. When a guard trigger or CHECK constraint fires (e.g. `enforce_firm_entitlement_guard`, `enforce_workspace_firm_binding_guard`, the plan-lock trigger, the child-limit enforcement, or a UNIQUE violation on `firm_members`), the raw message can include the trigger/constraint name and the `ERRCODE`. That's internal schema detail leaking to an authenticated caller — low impact (these are authorization-boundary functions, the caller is already authed and owns the firm), but it's information disclosure and makes the API contract brittle (clients keying on raw strings).

**Fix (its own beat):** map known constraint/trigger names to stable `{ ok: false, reason: '…' }` codes (e.g. `firm_plan_locked`, `firm_child_limit_reached`, `firm_member_exists`, `not_firm_owner`) + a static human message; log the raw error server-side only. Mirror the structured-error idiom the limit-wall functions already use (`reason: 'quota_exceeded'`). Sweep all four functions in one pass.

**Where to look:** `supabase/functions/{create-firm,add-firm-member,bind-workspace-to-firm,release-workspace-from-firm}/index.ts` (the `catch` / error-response blocks); reference idiom in `supabase/functions/process_lease/index.ts` (`quotaBlockResponse`).

---

### Item #103: Firm-bound workspace billing lockdown is incomplete + UI-only — complete in Phase 10 (firm billing surface)

**Severity:** High (latent — not customer-reachable until Phase 10). **Surfaced 2026-06-15** by the lease-security-scanner + lease-product-polish sweep of the Phase 9 minimal frontend (branch `claude/phase9-firm-foundation`, PR #49). **Decision (Daniel, 2026-06-15): defer all of it to Phase 10**, which owns the firm billing surface end-to-end. Nothing here is reachable by a customer today because firm minting is service-role-only (the 4 Phase 9 edge functions) — no user-facing firm onboarding exists until Phase 10, so no customer workspace has `firm_id` set. Filed as one beat; do NOT bundle a fix into the Phase 9 foundation PR.

**The gap (one theme — the firm-bound Billing tab promises "managed at the firm level" but several billing actions remain live, and the gates that exist are UI-only):**

1. **(HIGH, server) `create-checkout` + `customer-portal` are not firm-aware.** An owner/admin of a firm-bound child who calls `create-checkout` directly creates a *new independent* Stripe subscription stamped `metadata.workspace_id`; `stripe-webhook`'s `applySubscription` (service role) then writes it onto the child's `workspaces` row — clobbering `stripe_subscription_id`/`subscription_status`/`billing_interval`/`stripe_customer_id` and starting a duplicate charge against a workspace whose billing is firm-governed. The plan-lock trigger `prevent_independent_plan_change_for_firm_workspace` only blocks the *plan column* changing to non-`business`; it does NOT block a `business` checkout or protect the other billing columns. So the UI suppression in `AccountSettings` is the only firm-level gate on this path. **Fix:** firm-aware preflight in both fns — select `firm_id`; if non-null, reject fail-closed (`reason: 'firm_managed'`, mirroring `vault_owner_only` / `annual_not_configured`). This belongs with the deferred webhook-firm-branch deploy beat.
2. **(HIGH, UI) Payment section still renders the admin "Update/Add payment method" button on a firm-bound workspace** (`AccountSettings.tsx` Payment block, ~1131–1170) → opens `customer-portal` scoped to the child (whose `stripe_customer_id` is NULL) → errors or opens an empty/irrelevant portal, contradicting the banner directly above it. **Fix:** gate the Payment action button (or the whole Payment+Invoices block) on `!firmBound`, same pattern as the Adjust-plan/Cancel gates already shipped.
3. **(HIGH, UI+server) Capacity-pack purchase remains reachable on a firm-bound workspace** via the Usage tab Active-leases "Add capacity" CTA and the `?packs=1` deep-link (`AccountSettings.tsx:181,1229–1233,1279`; `setPackDialogOpen`). A pack is its own workspace-scoped Stripe sub — buying one under firm billing is a contradiction + unauthorized charge. **Fix:** thread `firmBound` into `UsageContent`/the Active-leases row to hide the CTA + short-circuit the `?packs=1` open path; AND reject workspace-scoped pack checkout for firm-bound workspaces server-side in `manage-document-pack` (UI-only is insufficient).
4. **(MED, UX) The firm banner is a dead-end** (`AccountSettings.tsx:982–990`) — explains WHY but not WHO can act. Add a "Contact your firm administrator to change the plan" line (surface firm billing_email/owner if resolvable) so the child admin has a next step.
5. **(MED, UX) Plan-header card is thin/stale for firm children** — `subscription_status`/`subscription_period_end` are populated by the firm webhook branch (not yet deployed), so until then the card shows a bare "Business" label with no renewal line and no controls. Confirm the firm sub mirrors period-end onto child workspaces; if intentionally not, add a "Plan set by {firm}" line so the card reads as intentional.
6. **(MED, UX) Sidebar switcher row crowding** (`AppSidebar.tsx:302–319`) — firm label (`text-[10px] max-w-[6rem] truncate`) + pending-resume label + check icon + name compete for the right edge on a ~240px dropdown; long names truncate harder. Consider showing the firm label only when multiple firms are present, or move to a second line/tooltip.
7. **(LOW) Fallback copy** "This workspace is part of your firm" reads awkwardly (doubled "firm"/possessive) — use a fallback-specific sentence ("This workspace is managed by your firm.") rather than interpolating "your firm" into the named template.
8. **(LOW) Selector inconsistency** — palette groups firm children under firm headings; sidebar uses a per-row label and no grouping; firm-bound children in "Recent" lose firm context. Acceptable given space constraints; optionally unify.

**Cleared as false positives in the same sweep (no action):** the blanket `where firm_id is not null` selector query is RLS-correct (`is_workspace_member` firm EXISTS with `restrict_firm_access=false`); the firm-name `in("id", firmIds)` resolution is row-filtered by `firms` RLS (`is_firm_member`) — no IDOR; the banner/label show only members-visible firm names through auto-escaped JSX — no info-disclosure or XSS. One LOW defense-in-depth note: the selector query trusts RLS entirely with no secondary client scoping (acceptable per LeaseIO's RLS-first model).

**Where to look:** `src/pages/settings/AccountSettings.tsx`, `src/pages/app/UsageContent.tsx`, `src/components/layout/AppSidebar.tsx`, `src/components/workspace/WorkspaceCommandPalette.tsx`; `supabase/functions/{create-checkout,customer-portal,manage-document-pack,stripe-webhook}/index.ts`. Related: #60 (firm billing model), #61 (create-checkout customer resolution).

---

### Item #104: delete-firm deferred to Phase 11 — firm_activity_log ON DELETE RESTRICT blocks a hard delete

**Severity:** N/A — deferred-feature note. **Surfaced 2026-06-15** during Phase 10 CP3. **Decision (Daniel, 2026-06-15): defer delete-firm to Phase 11.** It is a rare destructive operation not needed for "Business tier sellable" (a firm operates fine without ever being deleted), so FirmSettings (CP4b) omits the danger-zone delete or shows it as "coming soon."

**The schema constraint:** `firm_activity_log.firm_id` is `ON DELETE RESTRICT` (migration `20260615172439_phase9_firm_layer_foundation.sql` — Phase 9's deliberate "an audit log must never be silently erased" choice). Every firm has at least a `firm_created` audit row, so a hard `DELETE FROM firms` is **permanently blocked** while any audit history exists. Combined with `workspaces.firm_id` (NO ACTION, blocks delete while children are bound), a firm hard-delete is doubly blocked by design.

**The decision delete-firm needs (when Phase 11 builds it):** pick one —
- **Soft-delete (recommended):** add `firms.deleted_at`; delete-firm releases all children, captures the `deleted_firms` forensic row, sets `deleted_at`. Firm + audit preserved; hidden from all UI. Satisfies RESTRICT.
- **Hard-delete + audit archival:** copy `firm_activity_log` rows into `deleted_firms.details` (or an archive table), delete the audit rows, then hard-delete the firm. Truly removes the row but destroys the live audit FK — conflicts with the Phase 9 "never destroy the audit" intent.

The `deleted_firms` table + the `firm_deleted` activity_type already exist (Phase 9 / Phase 10 CP1) ready for whichever path is chosen.

**Where to look:** `supabase/migrations/20260615172439_phase9_firm_layer_foundation.sql` (the firm_activity_log FK + deleted_firms); a future `supabase/functions/delete-firm/index.ts`; `firms` RLS already has a "firm owner deletes firm" policy (the client DELETE attempt fails at the FK, as intended).

---

### Item #105: Self-serve firm onboarding (Stripe checkout) — pricing model DECIDED 2026-06-16; now a build task (no longer operator-blocked)

> **PRICING DECIDED 2026-06-16 (Daniel delegated; recorded in PRODUCT_STRATEGY.md §"Firm-level Stripe billing"): per-child quantity at the standard Business rate.** One Stripe subscription on the EXISTING Business price (`prod_TlQhRntCDhkxfK` / business monthly + `STRIPE_PRICE_BUSINESS_ANNUAL` — NOT a new firm Product) with `quantity` = bound child count + `metadata.firm_id`. N children = N × $499/mo; no base fee; no v1 volume discount (deferred GTM lever). Bind → quantity +1 (prorate); release → −1 (credit) + 30-day grace. summarized = one consolidated line; detailed = `invoice.created` webhook expands to N per-child lines via `firm_child_label`.
>
> **This resolves blocker (1) below and largely dissolves blocker (2):** reusing the Business price means NO firm-specific operator Stripe setup — the only operator dependency is the live-mode Business price (already owed for standalone Business, STOP 3/7). So this is now a **build task**, not an operator gate. **Build progress (each its own beat, all under the decided model):**
> 1. ✅ **#105-A (merged):** `create-firm-subscription` (firm sub on the Business price, quantity = child count, metadata.firm_id, 3DS); `applyFirmSubscription` webhook mirrors it + propagates `business`.
> 2. ✅ **#105-A (merged):** quantity sync — `bind`/`release`/`act-on-join-approve` call `syncFirmSubscriptionQuantity` (recompute from live child count). Closes the Phase 9 gap.
> 3. ✅ **#105-B:** `create-firm-workspace` edge fn + `create_firm_workspace_locked` RPC (firm child, no independent sub, + quantity sync). Applied/deployed to staging.
> 4. **`billing_summary_mode` — RESOLVED as IN-APP breakdown, NOT a Stripe-invoice handler.** Under the decided *quantity* model the firm sub emits ONE invoice line ("Business × N"); true per-child Stripe-invoice lines would require per-child *subscription items* (a different, more complex model — not chosen). So "detailed vs summarized" is the IN-APP FirmBilling view (it already shows per-child usage; the toggle controls that breakdown's emphasis, wired in #105-C). No `invoice.created` line-item manipulation is built — deliberately avoided (it would touch real invoice totals for marginal benefit). If a future GTM need demands per-child Stripe-invoice lines, switch the subscription to per-child items then.
> 5. **#105-C (remaining):** FirmOnboarding "one company or multiple?" fork + card-collection (SetupIntent) → `create-firm-subscription` 3DS flow + initial setup UI; FirmBilling wired to the real sub.
>
> Original deferral context (now mostly resolved) preserved below.

**Severity:** N/A — deferred-feature note (Phase 10 scope cut, surfaced 2026-06-16 during CP4b-ii). FirmOnboarding's self-serve flow up to firm creation is buildable, but the **Stripe-checkout step that creates the firm subscription** is blocked on two things, so it (and the pieces coupled to it) are deferred:

1. **The firm-subscription pricing model is unspecified.** PRODUCT_STRATEGY confirms "the firm pays a single subscription covering all child workspaces; children inherit the plan and have no independent subscription" — but NOT the price structure: per-child quantity (N × business rate, Stripe `quantity`), per-child line items, or a flat firm rate. The `billing_summary_mode` (detailed=per-child lines vs summarized=one line) strongly implies per-child items/quantity, but the exact mechanics (how a child added mid-cycle bills, proration) are a product/pricing decision not in the specs.
2. **No firm Stripe Product/Price exists** (operator setup, like Vault's STOP 10). There's no `STRIPE_PRICE_FIRM_*` and the firm Product isn't created in Stripe.

**Coupled pieces deferred with it:**
- **`create-workspace` firm_id extension** — creating a firm child should reconcile the firm subscription quantity/cost; without the pricing model that reconciliation is undefined. (Binding existing workspaces via `bind-workspace-to-firm` / join requests already works and does NOT touch the firm sub — a pre-existing Phase 9 gap that the pricing decision should also resolve.)
- **`billing_summary_mode` invoice line-item construction** (stripe-webhook `invoice.created`) — operates on the firm subscription's invoice; meaningless until the sub structure exists.

**What IS built + works without this:** firms are created via the service-role `create-firm` (admin/ops), then fully operated through the UI — invite/manage members, manage child workspaces + `restrict_firm_access`, the cross-workspace inbox, and the FirmBilling **visibility** page (subscription status, per-child usage, `billing_summary_mode` toggle). The `applyFirmSubscription` webhook branch is deployed + ready to mirror a firm sub onto `firms` + propagate `business` to children the moment a firm sub is created.

**When unblocking (the decision + setup needed):** (a) decide the firm pricing model (recommend per-child `quantity` on the existing business price — simplest, makes detailed/summarized natural); (b) operator creates the firm Stripe Product/Price + `STRIPE_PRICE_FIRM_*` env; (c) build FirmOnboarding's checkout (create-checkout firm branch or a new create-firm-subscription fn), the create-workspace firm_id reconciliation, and the invoice line-item handler. Mirrors the Vault operator-gate pattern.

**Where to look:** `src/pages/app/firm/FirmBilling.tsx` (the visibility page the checkout will extend); `supabase/functions/stripe-webhook/index.ts` (`applyFirmSubscription` + the deferred `invoice.created` handler); `docs/PRODUCT_STRATEGY.md` §"Firm-level Stripe billing"; `docs/ops/OPERATOR_PLAYBOOK.md` (add a firm-pricing STOP item).

---

### Item #106: Overlapping permissive `profiles` UPDATE policies — `current_firm_id`/`current_workspace_id` lack a WITH CHECK — Low (pre-existing)

**Severity:** Low. **Surfaced 2026-06-16** by the lease-security-scanner during the Phase 10 firm-frontend review. **Pre-existing** (baseline `20260516120000_baseline_schema.sql`), NOT introduced by Phase 10.

**Symptom:** `profiles` has two overlapping permissive UPDATE policies — `profiles_update_own` (`USING (id = auth.uid())`, **no WITH CHECK**) and `profiles_update_self` (with a WITH CHECK constraining `current_workspace_id` to a membership). Because Postgres OR's permissive policies and `profiles_update_own` has no WITH CHECK, the membership constraint is effectively bypassable, and `current_firm_id` (written by `FirmContext.tsx`) has no membership WITH CHECK at all.

**Why it's Low:** it's the user's OWN row, and `current_firm_id`/`current_workspace_id` are selection POINTERS only — a forged value grants no access (every downstream read is still RLS-gated, and FirmContext re-resolves the active firm via `resolveActiveFirm` against real memberships, so a stale/forged pointer is ignored). No privilege escalation.

**Fix (its own beat):** consolidate to a single `profiles` UPDATE policy with a complete WITH CHECK (id = auth.uid() AND the pointer columns reference real memberships, or simply id = auth.uid() with the membership checks dropped since pointers are harmless). Sweep both `current_workspace_id` and `current_firm_id`.

**Where to look:** `supabase/migrations/20260516120000_baseline_schema.sql` (`profiles_update_own` / `profiles_update_self`); `src/contexts/FirmContext.tsx` (current_firm_id writes).

---

### Item #107: Firm billing reconciliation + offboarding-cancel (hard rule #9)

> **BUILT 2026-06-16 (mostly resolved) — remaining is OPERATOR setup.** `_shared/firm_billing.ts` `syncFirmSubscriptionQuantity` is now SELF-AUDITING (writes `firm_billing_quantity_changed` on a quantity change with old→new; writes the same with `details.sync_failed=true` on a Stripe failure so it's queryable) and does OFFBOARDING-CANCEL (0 children → `cancel_at_period_end`; re-binding a child UN-cancels — money-bug fixed in the integrity review). New `firm-billing-reconcile` cron (x-cron-secret, deployed) sweeps every subscribed firm and corrects drift. The `firm_activity_log` CHECK gained `firm_billing_quantity_changed` (migration `20260616140000`, applied). #102 raw-error leaks in bind/release fixed; a per-owner create-firm cap (10) added. Security+integrity reviewed (no unaddressed Critical/High). **OPERATOR remaining (STOP-style, before customer #1):** set `FIRM_BILLING_CRON_SECRET` (32+ char) + schedule `firm-billing-reconcile` (e.g. hourly) — until then the cron fail-closes (401) and the in-line self-healing sync + audits are the coverage. **Scale follow-up:** reconcile pagination (see note below). Original gap description preserved below.

**Severity:** Medium — **before-customer-#1 gate**, NOT deploy-blocking (no firm subscription exists anywhere yet; zero money moves until self-serve onboarding ships AND a real firm subscribes). **Surfaced 2026-06-16** by the security+integrity review of the #105 firm-billing core. The per-child quantity sync (`_shared/firm_billing.ts` `syncFirmSubscriptionQuantity`, called best-effort from bind/release/act-on) is correct and idempotent (recompute-from-live-child-count), but two revenue-integrity gaps remain that conflict with **CLAUDE.md hard rule #9 ("no silent vendor failures")**:

1. **Silent sync failure is unobserved.** Every `syncFirmBilling` caller swallows Stripe errors with only `console.error`. "Self-heals on next op" holds ONLY if there's a next bind/release for that firm — a firm that binds its last child (or releases one) and then stops is mis-billed indefinitely with no alarm. Per hard rule #9 this Stripe write is currently in the prohibited fourth "we'll notice if it breaks" state.
2. **Last-child release over-bills.** When a release drops the child count to 0, `syncFirmSubscriptionQuantity` no-ops at `qty < 1` (correctly avoiding a Stripe `quantity: 0` rejection) — but nothing cancels the now-childless subscription, so the firm keeps paying 1 × $499/mo. The code comment says "offboarding cancels the sub instead," but that offboarding-cancel flow is **not built**.

**Fix (before customer #1):**
- A **reconcile cron** (scheduled edge fn, like `vendor-health-check`) that, for every firm with a `stripe_subscription_id`, recomputes quantity = live child count and corrects drift (+ alerts on mismatch). Register it in the `vendor-health-check` / monitoring framework so the Stripe-quantity dependency is in the "monitored" state hard rule #9 requires.
- **Offboarding-cancel:** when a release drives the child count to 0, hand off to a cancel flow (`stripe.subscriptions.update(cancel_at_period_end: true)` or the 30-day grace offboarding path) rather than leaving a live 1×$499 sub.
- **Quantity-change audit:** have `syncFirmSubscriptionQuantity` return old→new and the caller write a `firm_activity_log` row (the dollar amount changing should be attributable — integrity-lane). Needs a new `firm_activity_log` activity_type value (e.g. `firm_billing_quantity_changed`) added to the CHECK.
- **#102 continuation:** `bind-workspace-to-firm` / `release-workspace-from-firm` still return raw DB error messages (`updErr.message`) — now in the money path; convert to structured `reason` codes like `create-firm-subscription` does.

- **(#107 build, 2026-06-16) reconcile-cron pagination (scale follow-up):** `firm-billing-reconcile` sweeps `firms WHERE stripe_subscription_id IS NOT NULL` with no `.limit()` — PostgREST caps at ~1000 rows and silently truncates beyond that. Fine at current scale (few firms); add keyset pagination + a `length < 1000` warn before firm counts approach four digits.
- **(#105-C LOWs, 2026-06-16):** add a per-user rate limit / cap on self-serve `create-firm` (spam-create / row-pollution defense-in-depth — an empty firm is inert but unbounded creation pollutes); and align `create-firm-checkout`'s customer resolution to fully dedup (it now stamps + scans, closing the double-sub HIGH, but a net-new owner with a pre-existing Stripe customer may still get a duplicate customer record — minor).

**Where to look:** `supabase/functions/_shared/firm_billing.ts`; `supabase/functions/{bind-workspace-to-firm,release-workspace-from-firm,act-on-firm-workspace-join-request,create-firm-subscription}/index.ts`; the monitoring framework in `docs/OPERATIONAL_MONITORING_SPEC.md`; `docs/ops/OPERATOR_PLAYBOOK.md` (add a firm-billing-reconcile STOP item).

---

### Item #116: Lease hard-delete (ImportHistory) destroys a committed lease's audit trail (audit DF1)

> **RESOLVED 2026-06-18 (branch `claude/lease-delete-audit-guard`, pending merge — delete this stub on merge).** Closed by a `BEFORE DELETE` trigger on `public.leases` (`prevent_committed_lease_hard_delete`, migration `20260618140000`) + an ImportHistory UI steer. **Cross-branch note:** this item originated as **DF1** in `docs/AUDIT_FINDINGS_2026-06-17.md` (the six-sweep audit) and is also stubbed as #116 on the consolidated PR #57 branch (`approval-jargon-fix`, #108–#122). That branch was off-`main`'s KNOWN_ISSUES too; **whichever of #57 / this branch merges second will conflict on this entry — keep the RESOLVED version.**

**Severity:** High (data integrity / audit-defensibility) — **was** client-reachable.

**Symptom (verified first-hand 2026-06-18, repo):** the permissive DELETE RLS policy `leases_delete_own_or_workspace_admin` (`baseline_schema.sql:4206`) lets any lease creator OR workspace admin `DELETE` *any* lease via PostgREST, with **no lifecycle / lock check**. `ImportHistory.tsx` (`handleDeleteConfirm`) exposes exactly that — and it lists *all* workspace leases (not just in-flight imports), so a committed/active/`model_locked` lease was one click from a hard `leases.delete()`. Because `lease_activity_log`, `lease_governance_audit`, `lease_approval_chain`, `lease_unlock_requests`, etc. are `ON DELETE CASCADE`, the hard-delete **silently destroyed the entire audit trail** — directly violating "customer entered it, we stored it faithfully, every change is attributable." This was the row-level twin of #77 (which already blocked deleting a *locked lease's source files* in storage but not the lease row itself).

**Fix (shipped):**
- **`supabase/migrations/20260618140000_prevent_committed_lease_hard_delete.sql`** — a `BEFORE DELETE` row trigger that RAISEs (`check_violation`, with an Archive hint) for any committed lease. It is the **sole** DELETE trigger on `leases` (all prior guards are BEFORE/AFTER UPDATE → no ordering concern). Chosen as a trigger, not a RESTRICTIVE RLS DELETE policy, because (a) it matches the table's existing guard-trigger family and (b) a RAISE gives a clear error, whereas a RESTRICTIVE policy silently matches 0 rows (ImportHistory would falsely toast "deleted"). **Disposable allowlist (the only client-deletable set): `model_locked IS NOT TRUE AND (lifecycle_status IS NULL OR lifecycle_status = 'draft')`** — a *positive* allowlist so any future lifecycle state defaults to PROTECTED (fail-safe). Fresh/failed imports OMIT lifecycle_status on INSERT, so they take the column DEFAULT `'draft'` (`baseline_schema.sql:1459`) — `'draft'` is the normal rollback target (a saved-but-not-submitted request is also `'draft'`); `IS NULL` is kept only as a defensive belt for any legacy / explicit-NULL row. `service_role` (delete-workspace/-account + any FK CASCADE they drive) bypasses via `COALESCE(auth.role(),'') = 'service_role'`.
- **`src/pages/app/ImportHistory.tsx`** — fetches `lifecycle_status, model_locked`; uses the shared `isCommittedLease()` gate to swap the destructive Trash2 for an **Archive steer** on committed leases. Disposable imports keep hard-delete. The delete-confirm catch now surfaces the trigger's message verbatim (no false-success toast). New locale key `import.archive_committed` (en/es).
- **`src/lib/leaseDisposability.ts` (NEW)** — `isCommittedLease()` extracted to a pure lib (client-side mirror of the SQL allowlist, documented as a SYNC CONSTRAINT) so it can be behavior-tested independently of the page module.
- **Archive deep-link (product-polish HIGH fix):** the Archive steer now navigates to `/app/leases/{id}?action=archive`, and **`LeaseReview.tsx`** (workbench path) + **`src/components/leases/locked/LockedHeader.tsx`** (locked-active path) each read that param on mount and auto-open the archive dialog for an admin/owner (self-stripping the param). This closes the review's "dead-end/scavenger-hunt" finding — the archive action was admin-gated and buried in a ⋯ menu, so the bare navigate stranded the user. Non-admins (who can't archive) get no auto-open; the tooltip sets that expectation honestly. Tooltip copy corrected to "Confirmed leases can't be deleted here — open the lease to archive it instead" (the prior "in the approval workflow" was inaccurate for finalized/active leases).
- **Tests:** `src/lib/__tests__/leaseDisposability.test.ts` (behavioral — iterates `lifecycleStates.ALL_STATES` × `model_locked`, asserting parity with the SQL allowlist + the fail-safe sync constraint that any non-`draft` state is committed); `src/lib/__tests__/leaseHardDeleteGuard116.test.ts` (static — trigger SQL, the shared-gate wiring, the deep-link in both destinations, locale parity).

**Design judgment (resolved):** the disposable line is deliberately tight — only NULL/`'draft'` (unlocked) leases are client-hard-deletable; `rejected`/`cancelled` and everything submitted-or-beyond steer to Archive (restorable, attributed). This matches "import rollback is for unconfirmed imports" and was validated by the integrity review as correct + fail-safe (positive allowlist → new states default to PROTECTED). Daniel chose the full deep-link fix for the steer. If terminal-negative (`rejected`/`cancelled`) leases should ever become hard-deletable, it's a one-line allowlist change in both the SQL and `leaseDisposability.ts`.

**Review:** security (no Critical/High/Medium), integrity (Critical+High clean; allowlist sound), code-auditor (clean), product-polish (1 HIGH — the dead-end, fixed above; MEDIUM opacity + tooltip, addressed), test-author (1 HIGH coverage gap — fixed by the extraction + behavioral test). All five routed BEFORE apply per the security-migration rule.

**Adjacent pre-existing items surfaced during this review (assign #-numbers at merge to avoid colliding with PR #57's #108–#122; not bundled into this change):**
- *delete-account orphan-by-differing-user_id (LOW, security):* `delete-account` deletes the owner's workspaces (leases there go `workspace_id=NULL` via `ON DELETE SET NULL`) then deletes leases by `user_id`; a lease in a deleted workspace created by a *different* user would orphan and survive. Pre-existing, unrelated to this trigger.
- *hardcoded "No imports match your search" (LOW, polish):* `ImportHistory.tsx` empty-search-results row is the one un-i18n'd string on the screen — ES users see English. Add `import.no_search_results` (en/es).
- *49 pre-existing jsdom test failures (MEDIUM, test infra):* `NewWorkspaceDialog`/`WorkspaceCommandPalette` tests fail at `localStorage.clear()` — the Vitest jsdom env doesn't provide `localStorage` and `_jsdomPolyfills.ts` doesn't stub it. Unrelated to #116 (fail in isolation with no #116 code loaded). Add a `localStorage` stub to `_jsdomPolyfills.ts`.

**Where to look:** `supabase/migrations/20260618140000_prevent_committed_lease_hard_delete.sql`; `src/pages/app/ImportHistory.tsx`; `src/lib/leaseDisposability.ts`; the deep-link in `src/pages/app/LeaseReview.tsx` + `src/components/leases/locked/LockedHeader.tsx`; the sibling guard `prevent_locked_lease_edits` (`baseline_schema.sql:526`) and the #77/#83 destruction-guard pattern (`20260613030000_destruction_guards.sql`); archive flow `src/components/leases/ArchiveButton.tsx`.

---

### Item #123: Dead `confidenceScores` plumbing (`leases.confidence_scores` is never written)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, P0 audit remediation). Surfaced by the code-auditor while reviewing the B1 fix; **pre-existing** (git blame `^0575f35`, 2026-06-04), exposed — not introduced — by that fix. Per "pre-existing issues are their own beat," filed here rather than bundled.

**Severity:** Medium (dead code / fragility — the exact "reads a column nothing populates" pattern B1 just removed from the banner, still live on the section-card surface).

**Symptom:** `leases.confidence_scores` (a `Json` column typed `0-100` via `ConfidenceScores` in `src/types/workflow.ts:23`) is **read-only across the entire codebase and written by nothing** — no edge function (`process_lease` emits per-field confidence into `extracted_json`, not this column), no client write. After the B1 fix re-pointed `NeedsReviewBanner` to the live `extracted_json[field].confidence` source, the only remaining consumer is:
- `LeaseReview.tsx:331-333` — the `confidenceScores` memo reads `lease?.confidence_scores` (always `{}`),
- passed to `SectionCard` at `LeaseReview.tsx:3112/3289/3310/3342` via the `confidenceScores` prop,
- which `SectionCard` (`LeaseReviewSections.tsx:122` decl, `:146` destructure) **never references** — the section cards read confidence solely via `getFieldConfidence(extractedJson, …)`.

So the prop, the memo, the `ConfidenceScores` type, and the column read form a dead chain that implies a data dependency that isn't real.

**Fix (stub):**
- Remove the `confidenceScores` prop from `SectionCardProps` + the four `LeaseReview.tsx` call sites.
- Delete the `confidenceScores` memo (`LeaseReview.tsx:331-333`) and the now-unused `ConfidenceScores` import; the `ConfidenceScores` interface in `types/workflow.ts:23` would then have no consumers (remove it too).
- Optional DB cleanup: a migration to drop the unpopulated `leases.confidence_scores` column (schema-change rule applies — write the `.sql`, confirm no other reader first).

**Where to look:** `src/pages/app/LeaseReview.tsx:331-333,3112/3289/3310/3342`; `src/components/leases/LeaseReviewSections.tsx:122,146`; `src/types/workflow.ts:23`.

**Adjacent minor items surfaced in the same B1/polish review (not bundled):**
- *Banner field-name lost `<strong>` emphasis (LOW, polish):* moving `NeedsReviewBanner`'s copy into single-`<span>` i18n strings dropped the bold on the interpolated field name (both the missing + low-confidence lines), a minor scan-ability regression. Restoring it correctly needs react-i18next `<Trans>` (a `<strong>` placeholder) — deferred because `<Trans>` is not an established pattern here and would require reworking the `useAppTranslation`-mock-based banner tests; disproportionate for a LOW.
- *Banner field labels render English inside Spanish copy (LOW, i18n):* `TIER1_FIELDS` labels ("Landlord Name", …) are English literals interpolated into the translated `{{label}}` slot, so ES users see "Falta Landlord Name". Intentional for now — field labels are English everywhere on this surface (section cards / `SECTION_CONFIG`), so translating them banner-only would create a same-field-two-names mismatch. Fix only as part of an app-wide field-label i18n pass (TIER1_FIELDS + section config together).

---

### Item #124: FailedLeaseBanner partial i18n + retry_lease raw-error leak (C1 review pre-existing LOWs)

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, C1 in-place re-upload review). Two pre-existing LOWs surfaced by product-polish + security while reviewing C1. The C1 change made the i18n contrast more visible but did **not** introduce either (the new re-upload paths already return generic errors + are localized). Filed, not bundled.

**Severity:** Low (×2).

- **FailedLeaseBanner partial i18n (polish).** `src/components/leases/FailedLeaseBanner.tsx` — the new re-upload branch is fully localized (`failed_lease.*`, en+es), but the rest is hardcoded English: the title "Processing Failed", the `errorMessage` fallback, the canRetry button ("Retry Processing" / "Retrying..."), and the `handleRetry` toasts ("Re-processing started", "Failed to retry processing", "Cannot retry: original file not found in storage", "Please log in to retry"). An ES user on a failed lease that DOES have a stored file (the common retry case) sees a half-translated surface. **Fix:** migrate the remaining literals into the established `failed_lease.*` namespace as a small i18n pass.
- **retry_lease top-level catch leaks raw error (security).** `supabase/functions/retry_lease/index.ts` — the outer `catch` returns `error.message` to the client, which can surface the Anthropic/Azure vendor error string or the internal "Failed to download file" message. Pre-existing; C1's own new failure paths already return generic copy + `console.error` the detail. **Fix:** apply the same generic-to-client + log-server pattern to the top-level catch (and audit `process_lease`'s outer catch for the same habit).

**Where to look:** `src/components/leases/FailedLeaseBanner.tsx`; `src/locales/{en,es}/common.json` (`failed_lease`); `supabase/functions/retry_lease/index.ts` (top-level catch).

---

### Item #125: Formatting-sweep leftovers — LeaseReview parent-rent currency + deferred date tail

> **Filed 2026-06-21** (branch `claude/affectionate-hamilton-bp58tu`, formatting-consistency sweep). Surfaced by product-polish while reviewing the currency/date migration. Filed, not bundled — each needs a small targeted decision the sweep deliberately scoped out.

**Severity:** Low (×3).

- **`src/pages/app/LeaseReview.tsx:3153` — un-migrated parent-lease rent currency (same-screen inconsistency).** `${parentLease.current_monthly_rent?.toLocaleString() || parentLease.base_rent_amount || 'N/A'}` was left as-is by the currency sweep because its `||` fallback chain relies on `?.toLocaleString()` returning `undefined`; the canonical helper's truthy `'—'` sentinel would break the `|| base_rent_amount` fallback. After the sweep, the migrated metric cards on the same screen render `-$1,234` / `USD 1,234` (es) while this sibling still shows `$1,234` (browser-locale, no es). Polish flagged the side-by-side dialect mismatch. **Secondary bug:** the `||` chain mixes a formatted string, a raw `base_rent_amount` (string of uncertain format), and the literal `'N/A'`. **Fix:** `parentLease.current_monthly_rent != null ? formatLocalizedCurrency(parentLease.current_monthly_rent, language) : (parentLease.base_rent_amount ? '$' + parentLease.base_rent_amount : 'N/A')` — but first confirm `base_rent_amount`'s stored format (it may already include `$`/grouping).
- **Deferred date tail — bare `.toLocaleString()` admin/internal timestamps.** `OperationsPage.tsx:248,343`, `PortfolioReportsAdmin.tsx:271`, `DisclosureReportLibrary.tsx:238`, `LeaseReportDetail.tsx:127,317`, `Asc842InputsTab.tsx:660`, `LeaseDiscountRateCard.tsx:299` render "generated/last-updated" timestamps via bare `new Date(x).toLocaleString()` (follows browser locale). Migrating to `formatLocalizedDateTime(x, language)` would localize them but also CHANGE the format (short month, no seconds), so it needs a quick design nod. Low value (admin/internal surfaces). **Fix:** migrate to `formatLocalizedDateTime` if a format change is acceptable.
- **Deferred date tail — already-correct DRY collapses.** `VaultBanner.tsx:32`, `CancellationBanner.tsx:79`, `AccountSettings.tsx` (×4), `DocumentPackDialog.tsx:116` already localize correctly via an inline `language === 'es' ? 'es-419' : 'en-US'` ternary. They're not buggy — just a second date-formatting pattern alongside the canonical `formatLocalizedDate`. **Fix:** optional DRY collapse onto the helper (watch the `parseToLocalDate` off-by-one semantics for any date-only inputs).

- **Mixed-locale on partially-i18n'd surfaces (pre-existing, made slightly more visible).** Localizing dates exposed that some surfaces are otherwise hardcoded English: `src/pages/LeaseAudit.tsx` — the public lead-magnet card (currency `fmt()` was since migrated, so dates+currency now both localize, but labels "Tenant"/"Landlord"/"Monthly Rent" stay English); `src/components/dashboard/RecentActivity.tsx` — older feed rows show a localized date while "Today"/"Yesterday"/"N days ago" stay English. These surfaces just need a full i18n pass (labels + relative-time strings), not a piecemeal fix. **Fix:** fold each surface into i18n as its own pass; do not half-translate.
- **`src/components/QuotaWarningBanner.tsx` null-limit copy has a doubled space.** When `limit_value` is null the banner renders e.g. `"5 of  documents."` (the `?? ''` leaves a gap). Pre-existing (faithfully preserved through the number-formatting migration). **Fix:** tidy the template to drop the "of {limit}" clause entirely when the limit is absent.
- **`src/components/billing/PlanPickerDialog.tsx:114` uses a hardcoded `$` in the i18n template** (`account.billed_annually` with a `formatLocalizedNumber` total), diverging in strategy from sibling sites that route the symbol through `formatLocalizedCurrency`. Correct as-built (no `$$`), but worth unifying when the annual-billing copy next gets touched.

**Where to look:** `src/pages/app/LeaseReview.tsx:3153`; the timestamp + DRY files listed above; `src/pages/LeaseAudit.tsx`, `src/components/dashboard/RecentActivity.tsx`; canonical helpers in `src/lib/dateFormatters.ts`.
