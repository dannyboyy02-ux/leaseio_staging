# Known Issues — Pre-Phase-2 Backlog

Tracked here so they survive across sessions. None of these block Phase 2; all
are pre-existing. Surfaced during the Phase 2 Path A smoke test on 2026-05-03.

When fixing, remove from this list and add a reference in the commit message.

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

## Tracking

Surfaced 2026-05-03 during Phase 2 Path A smoke. Filed by Claude per user
direction. Each item should get its own commit when fixed; reference this
file in the message and remove the entry once green.
