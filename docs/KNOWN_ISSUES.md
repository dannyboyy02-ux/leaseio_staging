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

**Finding A — dead column drives a broken, always-zero usage meter (customer-facing, Medium).** `AppContext.tsx:215` reads `documents_used` → `documentsUsed`; `AccountSettings.tsx:952-960` renders it as a usage meter (`{documentsUsed} / {documentLimit}` + progress bar + 0.75/0.9 color thresholds). Because nothing writes the column, the meter always shows `0 / <limit>` — a customer at 14/15 abstractions sees "0 / 15". It is also the exact page the banner's "View plans / Upgrade" CTA deep-links to (`?tab=subscription`). Fix: repoint the meter at the live snapshot data the banner already consumes (`workspace_quota_snapshots`, metric `monthly_extractions`), or remove the meter. Routes through reviewers per CLAUDE.md (user-facing surface).

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

### Item #45: ~18 of 97 `src/lib` exports are unused

**Symptom:** A grep sweep found ~19% of `src/lib` exports with no importer. Worst offenders: 8 unused formatters in `src/lib/i18n.ts` (`formatNumber/formatShortDate/formatLongDate/formatDateTime/formatMonthYear/getDateLocale/formatRelativeDate/formatDateDistance`), 4 in `src/lib/dateFormatters.ts`, 5 `canAccess*` helpers in `src/lib/authorization.ts`, and `severityColor` in `reportGeneration.ts`.

**Severity:** Low. Clutter. The unused `canAccess*` authorization helpers are a mild correctness smell (intended guards never called) — worth confirming nothing should be calling them.

**Where to look:** `src/lib/i18n.ts`, `src/lib/dateFormatters.ts`, `src/lib/authorization.ts`, `src/lib/reportGeneration.ts`. Verify each via grep (some may be reached by dynamic/string paths — none found, but confirm before deleting).

**Stub remediation:** Delete confirmed-dead exports; for the `canAccess*` helpers, first confirm no surface *should* be calling them.

**Decision:** Filed not fixed. Surfaced during the 2026-05-24 full-codebase audit (dead-ends pass).

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
and the 2026-06-09 Workspace Management Phase 4 review pass (items 52-53).
Filed by Claude per user direction. Each item should get its own commit
when fixed; reference this file in the message and remove the entry once
green.
