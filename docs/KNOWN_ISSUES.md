# Known Issues — Open Backlog

Tracked here so they survive across sessions. None of these block Phase 2 (now
closed) or Phase 3 (next). Items 1-4 surfaced during the Phase 2 Path A smoke
test on 2026-05-03; item 5 surfaced during the Phase 2 Path B smoke the same
day.

When fixing, remove from this list and reference it in the commit message.

**Status reconciliation (Phase 2 close, 2026-05-03):** No items resolved during
Phase 2. Items 1-5 all still open and confirmed flagged. The lifecycle
transition convention asymmetries surfaced during Path B verification were
fixed inline (commit `dccf2aa`) and are NOT tracked here — they're now part of
the shipped Phase 2 contract via the convention doc in CLAUDE.md.

---

## 1. `profiles` 400 on user-preferences read

**Symptom (browser console):**
```
GET /rest/v1/profiles?select=email_notifications_enabled,sms_notifications_enabled,notify_abstraction_complete,ai_processing_consent_at&id=eq.<uuid>
→ 400
```

**Hypothesis:** the request filters on `id=eq.<uuid>` but the columns being
selected look like per-user preferences. Likely the filter should be on
`user_id` (or wherever those preference columns actually live — could be on
`profiles.user_id` or on a separate `user_preferences` table). RLS rejection on
the wrong filter column would explain the 400 too.

**Where to look:** grep for the column list (e.g.
`email_notifications_enabled,sms_notifications_enabled`) to find the caller,
then verify the actual table schema and filter shape.

**Severity:** Low — silent failure, no user-visible blocker. Likely makes
notification preferences appear unset.

---

## 2. CSP rejecting `wss://*.supabase.co` (Realtime)

**Symptom (browser console):**
```
Refused to connect to 'wss://wwkwoxxcprnjjufkbzac.supabase.co/realtime/v1/...'
because it violates the following Content Security Policy directive: ...
```

**Hypothesis:** the deployed CSP `connect-src` directive lacks the `wss:` scheme
for `*.supabase.co`. Realtime channels (e.g. the lease-pipeline subscription in
`src/components/dashboard/LeasePipeline.tsx`) silently fail to connect, so
realtime invalidation falls back to React Query's polling intervals.

**Where to look:** check Vercel headers config / `vercel.json` / any CSP meta
tag in `index.html`. Add `wss://*.supabase.co` to `connect-src`.

**Severity:** Medium — degrades realtime UX (60s polling instead of instant
updates) but doesn't break feature behavior since polling is the fallback.

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

## 5. WorkspaceSettings tabs hidden from workspace owners (Phase 1 gating bug)

**Symptom:** A workspace owner navigates to `/app/settings/workspace` and does
not see the "Approval Policies", "Lease Configuration", or "Onboarding" tabs —
only Company Profile, Users, Notifications, Financial, Risk Watchlist. The
direct URL `/app/settings/approval-policies` works fine; only the in-page
navigation is missing.

**Root cause:** `src/pages/settings/WorkspaceSettings.tsx:161`:

```ts
const isAdmin = userRole === 'admin';
```

This is a literal string check that excludes workspace owners (who have
`userRole === 'owner'`). The route-level guard in `App.tsx` correctly uses
`canEditWorkspaceSettings` from `src/lib/authorization.ts`, which calls
`isAdmin(role)` and normalizes 'owner' → 'admin'. But this in-page gate doesn't
go through that helper. Result: the owner can navigate to admin pages by
typing the URL but the tabs that link to them are hidden.

Three tabs hit by this gate (lines 168, 170, 171):
- `lease_config` — Lease Configuration
- `approval_policies` — Approval Policies (added in Phase 1)
- `onboarding` — Onboarding

Plus two `{isAdmin && (...)}` blocks that wrap their `TabsContent` (lines
1015, 1155, 1184) — same gate, same hide-from-owners effect.

**Fix:** replace line 161 with:

```ts
import { canEditWorkspaceSettings } from '@/lib/authorization';
// ...
const isAdmin = canEditWorkspaceSettings(userRole);
```

(`canEditWorkspaceSettings` already returns true for both 'admin' and 'owner'.)
One-line change; no behavior change for true admins.

**Severity:** Medium — admin features are reachable by URL but discoverability
is broken for owners. Surfaced 2026-05-03 when the user noticed the new
"Approval Policies" tab wasn't visible after the Phase 1 deploy.

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

## Tracking

Surfaced 2026-05-03 during Phase 2 Path A smoke (items 1-4), Phase 2 Path A
follow-up (item 5), and Phase 3 audit (items 6-7). Filed by Claude per user
direction. Each item should get its own commit when fixed; reference this
file in the message and remove the entry once green.
