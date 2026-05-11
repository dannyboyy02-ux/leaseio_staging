# Operator Playbook — what you (Daniel) need to do, in order

**Purpose:** Step-by-step instructions for every operator-side task currently owed across all in-flight workstreams. Each step has the URL, the exact buttons to click, what to verify, and what to capture back to the repo.

**How to use this:** Work top-to-bottom. Stops are ordered by urgency × leverage. You can stop after any Stop and resume later — each is self-contained. The first three stops together take ~30 minutes and close the most important risks.

**Last updated:** 2026-05-10. Update the "Done" checkbox in each stop as you complete it; commit the change so future sessions know the state.

---

## ✋ STOP 1 — Lock down Anthropic spending (~10 min)

**Why this is first:** This is the single highest-cost-risk vendor in the LeaseIO stack. A bug in `process_lease`, a misconfigured retry loop, or a compromised API key can produce four-figure bills overnight. The Anthropic Console has a hard spending cap feature — when set, Anthropic *enforces* it (stops accepting requests when the cap is hit). Until you do this, you have no ceiling.

**Status: ☑ Done 2026-05-11.** Screenshot at `docs/ops/screenshots/anthropic-spend-cap-2026-05-11.png`.

### Steps

1. Open **https://console.anthropic.com/settings/limits** in your browser.
2. Log in (your existing Anthropic account — the one whose key is in `ANTHROPIC_API_KEY` env var).
3. Find the **Spending limit** section (sometimes labeled "Monthly budget" or "Workspace limit"). It will look like a configurable USD amount.
4. **Set the monthly cap to: `$200`** (pre-customer phase recommendation per `docs/OPERATIONAL_MONITORING_SPEC.md`). You can raise this later as customer count grows; the right approach is "raise it explicitly" rather than "have no cap."
5. **Critical detail:** Anthropic distinguishes between *enforcing limits* and *notification limits*. You want **enforcing**. If the UI offers both, pick enforcing. If it only offers notification, set the notification threshold to $150 and contact Anthropic support to enable an enforcing cap.
6. Take a screenshot of the saved settings page.

### Verification (capture this back to the repo)

1. Save the screenshot as `docs/ops/screenshots/anthropic-spend-cap-2026-05-10.png` (use today's actual date).
2. Commit it:
   ```
   git add docs/ops/screenshots/anthropic-spend-cap-*.png
   git commit -m "ops: Phase 1 Anthropic spending cap captured"
   git push
   ```
3. Mark the checkbox above to ☑ Done, edit `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` to flip item #1 from ☐ to ✅.

**What this protects against:** A runaway loop or compromised key burning $5K overnight. With the cap, Anthropic stops accepting requests once you hit $200 — extraction fails loudly, you find out same day instead of at billing time next month.

---

## ✋ STOP 2 — Lock down the domain registrar (~15 min)

**Why this is second:** Domain expiry is the SaaS-killer. If `theleaseio.com` lapses, the entire site goes dark. Auto-renew silently fails when the card on file expires; that's the most common cause of unintended domain lapse. Multi-stage protection: auto-renew ON, card valid for 12+ months past renewal, 2FA on the registrar account itself.

**Status: ☑ Done 2026-05-11** by Daniel.

### Steps

1. Open `docs/ops/registrar-state-template.md` in the repo. Copy it to `docs/ops/registrar-state-2026-05-10.md`. Open that new file in your editor — you'll fill it in as you check each setting.

2. Find out **which registrar `theleaseio.com` is at.** Most likely Namecheap, Cloudflare, or GoDaddy. If you don't remember, check:
   - Your email for "Domain renewal" notifications — the sender domain tells you
   - Or run: `whois theleaseio.com` in a terminal — look for "Registrar:" in the output

3. Log into the registrar's web dashboard.

4. **Walk through each item in the template and capture the actual value:**

   | What to check | Where to find it | What you want to see |
   |---|---|---|
   | Auto-renew | Domain settings page | **ON** |
   | Card on file | Billing / payment methods | Last 4 digits, expiration `MM/YYYY`. Must be valid for at least 12 months past the next domain renewal date. |
   | Renewal-notice contact email | Account / contact settings | An email **you actually monitor**. NOT a forwarded alias that might silently break. |
   | 2FA on the registrar account itself | Security / account settings | **ON** (TOTP app preferred, hardware key best, SMS acceptable as fallback) |
   | Domain lock / transfer protection | Domain settings page | **ON** (sometimes called "Registrar Lock") |
   | Auth/EPP code accessible | Domain settings | Retrievable from the dashboard (don't transfer; just verify you could) |

5. **For each item above, if it's wrong, fix it now while you're already logged in:**
   - Auto-renew OFF → turn it ON
   - Card expires before renewal → update the card NOW
   - 2FA OFF → enable it now (use Authy, 1Password, or hardware key — NOT SMS if avoidable)
   - Domain lock OFF → enable it
   - Renewal email goes to a dead alias → change it to one you read

6. **Critical: 2FA recovery codes.** When you enable 2FA, the registrar will give you 10-12 one-time recovery codes. **Save these in 1Password or your password manager NOW** — independent of your primary 2FA device. If you lose your phone, those codes are the only way back in. A domain you can't access is a domain that lapses on renewal.

### Verification (capture this back to the repo)

1. Save your filled-in registrar state doc:
   ```
   git add docs/ops/registrar-state-2026-05-10.md
   git commit -m "ops: Phase 1 registrar state captured + hardened"
   git push
   ```
2. Mark the checkbox above to ☑ Done, edit `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` to flip item #2 from ☐ to ✅.

**What this protects against:** The most common SaaS-failure mode (auto-renew silently fails → domain lapses → site goes dark). Multi-stage protection means several things have to fail together for the lapse to happen.

---

## ✋ STOP 3 — Verify Stripe webhook health (~5 min)

**Why this is third:** Your `stripe-webhook` edge function is what writes subscription state to your database. If it breaks (network error, signing secret rotation), customers can be charged in Stripe without getting their subscription provisioned in LeaseIO, or vice versa. The codebase side is verified clean (we did that already); now verify the dashboard side.

**Status: ⚠️ Sandbox done 2026-05-11; LIVE destination still owed before first customer.** See `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` item 3 for the 6-step live-mode setup. Schedule it as a pre-launch gate.

### Steps

1. Open **https://dashboard.stripe.com/webhooks**. Log in.

2. **Find your LeaseIO endpoint.** It should be one row with a URL ending in `/functions/v1/stripe-webhook`. The full URL will be:
   `https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook`

3. **Click into that endpoint.** You'll see three things to verify:

   **a. Recent deliveries** (a list at the bottom)
   - If the list shows mostly green 200s for the last 7 days, you're good ✅
   - If there's a failure backlog (red rows), click into one to read the error. Common causes:
     - "Signature verification failed" → the signing secret has rotated; copy the current value from the right sidebar ("Signing secret"), update `STRIPE_WEBHOOK_SECRET` in Supabase via:
       ```
       supabase secrets set STRIPE_WEBHOOK_SECRET='<paste here>'
       ```
     - "Connection timeout" → likely a Supabase cold-start hiccup; recent ones (within a few hours) are not a real issue. Older ones mean a problem.

   **b. Signing secret freshness**
   - The right sidebar shows the signing secret (starts with `whsec_`). It's hidden by default; click "Reveal" to see it.
   - You don't need to do anything with it; just confirm it matches what's in your Supabase env var. To check the Supabase side:
     ```
     supabase secrets list
     ```
     Look for `STRIPE_WEBHOOK_SECRET`. The list won't show the value (security), only that it's set. As long as the LAST date both were set is roughly the same, they match.

   **c. Subscribed event types**
   - The endpoint's detail page shows which Stripe events your webhook listens to.
   - **It should include exactly these four:**
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
   - Extra events = wasted webhook calls (Stripe still delivers them, you ignore them — cosmetic issue, not a bug). Missing events = your codebase expects something the dashboard isn't sending; that IS a bug. Fix by clicking "Add events" and adding the missing one.

### Verification (capture this back to the repo)

1. If everything checked out cleanly, edit `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` and flip item #3 from ⚠️ PARTIAL to ✅.
2. If you had to rotate the signing secret or add missing events, note what you did at the bottom of that file under a new heading "Phase 1 dashboard-side findings — 2026-05-10".

**What this protects against:** Subscription-state drift between Stripe and your DB. When real customers sign up, broken webhooks mean people pay you and don't get access (or get access without paying). Catching this pre-launch keeps customer #1 from being a refund.

---

## ✋ STOP 4 — Build the renewal calendar (~20 min, one-time)

**Why this is fourth:** The Phase 2 monitoring system catches usage-based vendor cliffs. Renewal-based cliffs (domains, insurance, card expirations) are date-based and need a separate calendar. This is the cheap, manual safety net.

**Status: ☐ Not done**

### Steps

1. **Open Google Calendar** (or whichever calendar you use daily — the key is it has to be one you actually see).

2. **Create a new calendar** named "LeaseIO Operations" so these events stay separate from your work calendar and don't get muted.

3. **Add the following events.** For each, use the format `Event title | Date | Description with action item`.

   | Event | Schedule | Description |
   |---|---|---|
   | **Domain `theleaseio.com` renewal** | Annual on the renewal date | "Auto-renew should fire. Verify it did. If not, manually renew today. Registrar: <name>." |
   | Domain renewal pre-check (T-60) | 60 days before | "Verify card on file is still valid. Verify auto-renew is still ON." |
   | Domain renewal warning (T-30) | 30 days before | "If auto-renew hasn't fired yet, log into registrar and manually trigger." |
   | Domain expiry alarm (T-7) | 7 days before | "URGENT if not renewed by now. Site goes dark on the renewal date." |
   | **Anthropic spending cap quarterly review** | Quarterly | "Open https://console.anthropic.com/settings/limits. Confirm cap is still set at intended value. Raise if customer growth justifies." |
   | **Each card-on-file expiration** (one event per card per vendor) | 60 days before card expires | "Card ending <####> expires <MM/YYYY>. Update at: <vendor URL>. Affects: <which subscriptions ride on this card>." |
   | E&O / Cyber insurance renewal | 60 days + 30 days before | "Review policy, compare quotes, renew." (Skip if you don't have insurance yet — add when you do.) |
   | **Backup-restore drill** | Annually | "Execute drill per `docs/ops/backup-restore-runbook.md`. Pick a non-production day." |

4. **For card-on-file expirations specifically:** Pull up each vendor you pay (Supabase, Vercel, Anthropic, Resend, OpenAI/Azure DI if billed separately, domain registrar). Note the card-on-file expiration at each. **Most likely it's the same card.** Make one event per unique (card × vendor) pair if different cards; one event if all the same.

### Verification (capture this back to the repo)

1. Create `docs/ops/manual-renewal-calendar-2026-05-10.md` with the list of events you created (titles + dates). This is the in-repo snapshot of what's in your Google Calendar.

   Template (copy this in and fill out):
   ```markdown
   # Manual renewal calendar — snapshot 2026-05-10

   Mirrors the "LeaseIO Operations" calendar in Google Calendar.
   Update whenever the calendar gets new entries or dates shift.

   ## Domain
   - theleaseio.com renewal: <date>
   - Pre-check, warning, alarm at T-60/T-30/T-7

   ## Card expirations
   - Card ending <####> expires <MM/YYYY>; affects: <vendors>

   ## Anthropic
   - Quarterly cap review

   ## Insurance
   - <E&O or skip>

   ## Drills
   - Annual backup-restore drill
   ```

2. Commit:
   ```
   git add docs/ops/manual-renewal-calendar-2026-05-10.md
   git commit -m "ops: Phase 1 renewal calendar snapshot"
   git push
   ```
3. Mark the checkbox above to ☑ Done.

**What this protects against:** Date-based cliffs that the daily cron (Phase 2 monitoring) doesn't see. Once Phase 2's `vendor_renewal_calendar` table is populated, the cron sends reminders too — but the manual Google Calendar is the immediate fallback that doesn't depend on the cron running.

---

## ✋ STOP 5 — Generate monitoring tokens (~15 min)

**Why this matters:** The Phase 2 + Phase 3 monitoring cron is already deployed and running daily at 06:00 UTC, but most adapters are "skipped" right now because their tokens aren't set. Setting them turns on the actual monitoring coverage. Until you do this, you only see Resend + Stripe webhook health.

**Status: ☐ Not done**

### What you'll generate

Five tokens across three vendors. Plus one number (the Anthropic cap value).

### Steps

#### 5a. Supabase Management token

1. Open **https://supabase.com/dashboard/account/tokens**.
2. Click **Generate new token**.
3. Name it: `LeaseIO Monitoring (read-only)`.
4. Scope: **Read-only** if the UI offers a scope picker; otherwise just generate.
5. **Copy the token** — you only see it once. Save to 1Password under "LeaseIO / Supabase Management Token" before doing anything else.
6. In a terminal (the same Bash shell you've been using for `supabase` CLI commands):
   ```
   supabase secrets set SUPABASE_MANAGEMENT_TOKEN='<paste the token here>'
   ```

#### 5b. Vercel access token

1. Open **https://vercel.com/account/tokens**.
2. Click **Create Token**.
3. Name it: `LeaseIO Monitoring (read-only)`.
4. Scope: **Read only** if available.
5. Expiration: **No expiration** is fine for now; alternatively pick 1 year.
6. **Copy the token** and save to 1Password.
7. Terminal:
   ```
   supabase secrets set VERCEL_ACCESS_TOKEN='<paste here>'
   ```
8. **Optional:** If your Vercel project is under a team account (not your personal account), also set the team ID. Find it at vercel.com/<team>/~/settings → URL bar shows `team_xxxxxxxx`. Set it:
   ```
   supabase secrets set VERCEL_TEAM_ID='<team id>'
   ```

#### 5c. Anthropic admin API key

This is **distinct from** your runtime `ANTHROPIC_API_KEY` (which is what `process_lease` uses to call Claude). The admin key has read access to billing/usage; the runtime key has the model access. Don't reuse — generate a new one.

1. Open **https://console.anthropic.com/settings/keys**.
2. Click **Create Key**.
3. Name it: `LeaseIO Monitoring Admin (read-only)`.
4. Permissions / scope: select **Admin (read)** or similar — the goal is `Organization Reports` scope, NOT model-call scope.
5. **Copy the key** and save to 1Password.
6. Terminal:
   ```
   supabase secrets set ANTHROPIC_ADMIN_API_KEY='<paste here>'
   supabase secrets set ANTHROPIC_MONTHLY_CAP_USD='200'
   ```
   (The `200` matches the cap you set in Stop 1. If you set a different cap there, use that value.)

#### 5d. Sentry token + org slug

⚠️ **Skip this section** if you don't have a Sentry account yet. You don't need to set up Sentry just to satisfy the monitoring spec; it's only valuable once you actually have a Sentry workspace receiving errors. Come back here after you've created Sentry (or skip indefinitely).

If you DO have Sentry:

1. Open **https://sentry.io/settings/account/api/auth-tokens/**.
2. Click **Create New Token**.
3. Scopes needed: `org:read` and `project:read`.
4. **Copy the token** and save to 1Password.
5. Note your **org slug** — it's in the URL when you're in your Sentry dashboard: `sentry.io/organizations/<slug>/`.
6. Terminal:
   ```
   supabase secrets set SENTRY_AUTH_TOKEN='<paste here>'
   supabase secrets set SENTRY_ORG_SLUG='<your slug, e.g. leaseio>'
   ```

#### 5e. Redeploy the monitoring function so the new secrets take effect

Edge function env-var changes don't apply to a running function until it's redeployed (or until the next invocation, which is the same thing — the cron is daily, so just wait or force a redeploy).

To force a redeploy now:
```
cd C:/Users/danny/Downloads/Respository/leaseflow-ai
npx supabase functions deploy vendor-health-check
```

To verify the tokens are working:
```
S=$(npx supabase db query "SELECT value FROM private.cron_secrets WHERE id = 'vendor_health_check'" --linked | grep -oE '"value": "[^"]+"' | head -1 | sed 's/"value": "//;s/"$//')
curl -s -X POST "https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/vendor-health-check" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: $S" \
  --data '{}' | head -c 500
```

You should see `"adaptersConfigured": ["resend","supabase","vercel","stripe","anthropic"]` (plus `"sentry"` if you set those up). Each token you set adds its vendor to that list.

### Verification

1. Run the curl command above. Save the output as `docs/ops/monitoring-tokens-verification-2026-05-10.md` (just paste the JSON in).
2. Mark the checkbox above to ☑ Done.

**What this protects against:** Flying blind on vendor caps. With these tokens set, the daily cron writes real Supabase / Vercel / Anthropic / Sentry snapshots; you'll see them on `/app/admin/operations` after a few days of data accumulates.

---

## ⏸️ STOP 6 — Can defer: Email Intake DNS prep (~1-2 hours dashboard + 24-48h DNS wait)

**Defer unless:** You're actively starting the Email Intake v1 build, OR you want to be able to test it as soon as someone authors the code.

This is the setup work documented in `docs/EMAIL_INTAKE_DECISIONS.md` "Operator-side prerequisites." Don't do this until the Email Intake build is queued — DNS records sitting unused for weeks is fine but pointless.

When you're ready:
1. Open `docs/EMAIL_INTAKE_DECISIONS.md` and scroll to "Operator-side prerequisites that block v1 ship"
2. Follow steps 1–6 there

---

## ⏸️ STOP 7 — Can defer: Annual Stripe Price IDs

**Defer unless:** Someone has clicked "annual" on your live pricing UI and complained that it doesn't work.

Until then, the annual billing path fails closed with a clear toast ("Annual billing isn't yet configured — please choose monthly"). Monthly works. Customer can still subscribe.

When you're ready:
1. Open Stripe Dashboard → Products → click your Starter product → Add a recurring price at `$2390/year`. Copy the resulting `price_...` ID.
2. Same for Business at `$4790/year`. Copy that `price_...` ID.
3. Terminal:
   ```
   supabase secrets set STRIPE_PRICE_STARTER_ANNUAL='<starter annual price id>'
   supabase secrets set STRIPE_PRICE_BUSINESS_ANNUAL='<business annual price id>'
   ```
4. `npx supabase functions deploy create-checkout` to pick up the new env vars.

---

## ⏸️ STOP 8 — Can defer: Pre-launch checklist items

These are launch-readiness items that don't matter until you're actively onboarding customer #1. Per the `pre_launch_checklist` memory:

1. **HSTS preload submission.** Open https://hstspreload.org and submit `theleaseio.com`. The site's automated checker will verify your HSTS header is configured correctly (it is — we verified). Takes ~1 week for the browser preload list to update. Submit when you're sure HTTPS will be permanent for the domain (don't submit and then switch to HTTP — undo is painful).
2. **Anthropic DPA + zero-retention.** Email legal@anthropic.com or use https://privacy.anthropic.com/ to request DPA. Required for SOC 2 / GDPR. Probably also covers zero-retention enrollment in the same flow.
3. **Privacy / Terms page renders.** Pull up `https://theleaseio.com/privacy` and `https://theleaseio.com/terms` in a browser. Confirm both render and the footer links to both. Probably already done; just visually verify.

---

## ⏸️ STOP 9 — Annual: Backup-restore drill

Once you've done Stop 5 (monitoring tokens), execute the backup-restore drill at least once to validate the restore path works. The runbook is at `docs/ops/backup-restore-runbook.md`. Takes ~1-2 hours of clock time but ~15 min of attention; mostly waiting for the restore to complete.

After the first run, add an annual reminder to your Google Calendar (Stop 4) so it doesn't get forgotten.

---

## Closing the loop

Once you've worked through Stops 1–5, **send me a message saying so.** I'll:
1. Update `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` to reflect the completed state
2. Update `CLAUDE.md` "Active Workstreams" to mark Operational Monitoring Phase 1 CLOSED
3. Verify Phase 2 + Phase 3 monitoring is fully active by re-running the smoke test
4. Surface any new findings or things that surprised us during your operator work

Stops 6, 7, 8, 9 are independent and can be done whenever they become relevant.

---

## Priorities at a glance

| Stop | Effort | Urgency | Why |
|---|---|---|---|
| 1. Anthropic cap | 10 min | 🔴 HIGH | Single highest-cost-risk vendor; no ceiling without this |
| 2. Registrar lockdown | 15 min | 🔴 HIGH | Domain lapse = site goes dark |
| 3. Stripe webhook check | 5 min | 🟡 MEDIUM | Codebase side already verified; this confirms dashboard side |
| 4. Renewal calendar | 20 min | 🟡 MEDIUM | One-time setup; protects against date-based cliffs |
| 5. Monitoring tokens | 15 min | 🟡 MEDIUM | Phase 2/3 already deployed; tokens turn on coverage |
| 6. Email intake DNS | varies | ⏸️ DEFER | Until the build is queued |
| 7. Annual Stripe prices | varies | ⏸️ DEFER | Until someone hits the missing-price wall |
| 8. Pre-launch checklist | varies | ⏸️ DEFER | Until you're onboarding customer #1 |
| 9. Backup-restore drill | 1-2 hrs | 🟢 ANNUAL | After Stop 5 |

**If you only have 30 minutes today:** Do Stops 1, 2, 3. That's the highest-leverage chunk.

**If you have an hour:** Add Stop 4.

**If you have ~75 minutes:** Add Stop 5.

That's the whole list.
