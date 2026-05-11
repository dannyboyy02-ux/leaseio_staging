# Operational Monitoring — Phase 1 Verification

**Date:** 2026-05-09
**Spec reference:** `docs/OPERATIONAL_MONITORING_SPEC.md` Phase 1 check-in
**Verifier:** Claude (codebase + production-DB-side checks); Daniel (vendor-console-side checks owed below)

---

## Phase 1 check-in — item-by-item

### ✅ 1. Anthropic spending cap configured

**Status: DONE 2026-05-11.** Screenshot captured at `docs/ops/screenshots/anthropic-spend-cap-2026-05-11.png` (146 KB) by Daniel.

What was checked:
- The runtime `ANTHROPIC_API_KEY` is set (process_lease, ai-assistant, generate-lease-insights all running successfully — the rate-limit failures we've seen prove they're hitting Anthropic, not failing on missing key).
- Recent production extraction activity is bounded: 4 leases extracted in production lifetime, 3 recent failures (2× 429 rate-limit, 1× empty-PDF). Recent burn-rate is ~zero — but this is a function of pre-customer state, not of any cap being enforced.

What's still owed (Daniel-side, ~10 minutes):

1. Log into https://console.anthropic.com/settings/limits
2. Set a hard monthly spending limit. Spec recommendation: **$200/mo for the pre-customer phase**. Verify the limit is *enforcing*, not *notifying*. (Anthropic distinguishes these — the enforcing version actually blocks API calls; the notifying version just emails.)
3. Capture a screenshot of the configured cap and save to `docs/ops/screenshots/anthropic-spend-cap-2026-05-09.png`.
4. Re-run this verification (mark this box ✓) once the screenshot is committed.

**Why this is the most important Phase 1 item:** Anthropic is the single highest cost-runaway risk in the LeaseIO stack. A bug in process_lease, a misconfigured retry loop, or a compromised API key can produce four-figure bills in a day. The cap is the only defense against this.

---

### ✅ 2. Domain registrar hardened

**Status: DONE 2026-05-11** by Daniel. State captured privately (registrar-state-2026-05-11.md file in `docs/ops/` is optional — can be filled from the template if you want an in-repo record of which settings were verified; not required if you're keeping the audit privately).

---

### Original verification template (kept for reference)

**Status: VERIFICATION OWED on registrar-side state. Codebase-side checks pass.**

What was checked from outside:

| Check | Status | Evidence |
|---|---|---|
| Domain resolves to deployed app | ✅ | `curl https://theleaseio.com` → HTTP 200 |
| HTTPS works with valid cert | ✅ | TLS handshake successful |
| HSTS enabled with preload | ✅ | `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` |
| CSP, X-Frame-Options, X-Content-Type-Options configured | ✅ | All three headers present |
| MX records on root domain | ✅ Google Workspace | `aspmx.l.google.com` (priority 1), `alt1-4.aspmx.l.google.com` (5/10/10) |

**Important finding for Email Intake (Path 2):** The root domain MX is Google Workspace. The Email Intake plan's choice of `leases.theleaseio.com` subdomain MX (separate from root) is correct — adding MX records on the root would break `daniel@theleaseio.com` and any other Google mailbox. The subdomain MX strategy in `docs/EMAIL_INTAKE_PLAN.md` § 3 stands as the right architecture.

What's still owed (Daniel-side, ~15 minutes):

Log into the registrar where `theleaseio.com` is registered. Verify and document in `docs/ops/registrar-state-2026-05-09.md` (template provided in this directory):

- [ ] Auto-renew is **ON**
- [ ] Card on file is valid for at least 12 months past the next renewal date
- [ ] Renewal-notice contact email is a mailbox Daniel actively monitors (NOT a forwarded alias that might silently break)
- [ ] 2FA is enabled on the registrar account itself
- [ ] Domain locking / transfer protection is enabled

**Why this matters:** Domain expiry is the SaaS-killer. If auto-renew silently fails (typically because card expired six weeks ago), the entire site goes dark when the domain expires. Multi-stage protection: auto-renew on, card valid, 2FA on the registrar so the account itself can't be compromised.

---

### ⚠️ 3. Stripe webhook health verified — SANDBOX ONLY (live destination still owed)

**Status: SANDBOX VERIFIED 2026-05-11** by Daniel. Sandbox destination `leaseio-sandbox-supabase` routes to the `stripe-webhook` edge function. 4 events subscribed: `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`. Test event returned 200 in 355ms.

**🔴 STILL OWED before first real customer:** Live-mode Stripe webhook destination has NOT been created yet. Stripe sandbox and live mode are separate environments with separate webhook endpoints and separate signing secrets. The sandbox verification proves the function works; it does NOT prove the live integration works. Before onboarding customer #1:

1. Open `https://dashboard.stripe.com/webhooks` and switch the dashboard from "Test mode" toggle to LIVE.
2. Click "Add endpoint." URL: `https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook`. Subscribe to the same 4 events as sandbox: `checkout.session.completed` + `customer.subscription.created/updated/deleted`.
3. Copy the live signing secret (starts with `whsec_`, distinct from the sandbox one).
4. Rotate the env var: `supabase secrets set STRIPE_WEBHOOK_SECRET='<live signing secret>'`. This REPLACES the sandbox secret — the deployed `stripe-webhook` function will switch from accepting sandbox events to accepting live events at this point.
5. Trigger a live test event from the dashboard ("Send test webhook" button) → confirm 200 response.
6. Edit this file to flip status from SANDBOX VERIFIED to LIVE VERIFIED.

This is added to the renewal calendar backlog under "Pre-launch checklist" — it's not annual; it's a one-time gate before customer #1.

---

### Original verification template (kept for reference)

What was verified:

| Check | Status | Evidence |
|---|---|---|
| Function deployed | ✅ | `supabase functions list` shows `stripe-webhook` ACTIVE, version 3, deployed 2026-04-29 |
| Webhook signature verification configured | ✅ | `stripe.webhooks.constructEventAsync(body, signature, webhookSecret)` at line 79 |
| Webhook secret env var present | ✅ (indirect) | Function returns 500 ("Server configuration error") at line 60 if missing; production calls have not been failing on config errors |
| Subscribed event types vs. codebase consumption | ✅ MATCH | Codebase handles: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Per the case statement at lines 121-138. |
| Workspaces have valid Stripe subscription state | n/a | 0 of 2 workspaces have `stripe_customer_id` populated. Expected at pre-customer stage; no real subscriptions yet. |

What's still owed (Daniel-side, ~5 minutes):

1. Open Stripe Dashboard → Developers → Webhooks → click the LeaseIO endpoint.
2. Verify:
   - [ ] No current failure backlog (recent deliveries show 200 OK)
   - [ ] Webhook signing secret matches the `STRIPE_WEBHOOK_SECRET` configured in Supabase edge function secrets (you don't need to *see* both values; just confirm the secret hasn't been rotated since last deploy)
   - [ ] Subscribed event types in the dashboard match: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Any extra events in the dashboard are wasted webhook calls; any missing events mean we're not handling something the codebase expects.

**Note on dashboard-side delivery health:** Without real customers, there should be no recent webhook delivery activity (test events from your own dashboard testing don't count toward production health). If the dashboard shows a backlog of failed deliveries from before today, capture them and audit; they may indicate stale test events.

---

### ☐ 4. Manual renewal calendar

**Status: OWED (Daniel-side, ~30 minutes).**

This is intentionally a manual fallback — not in the repo, not in the codebase. Per spec: a calendar (Google Calendar works fine; the same calendar that sends the meeting reminders) with one event per vendor renewal:

- Domain renewal at T-60, T-30, T-7
- Insurance renewal at T-60, T-30 (E&O, cyber liability if applicable)
- Each card-on-file expiration at T-60, T-30, T-14 (one event per card per vendor)
- Anthropic spending cap review at T-90 (quarterly check that the cap is still right-sized as customer count grows)

Once created, capture the list of events (titles + dates) in `docs/ops/manual-renewal-calendar-2026-05-09.md` so the source of truth is in repo.

**Why this matters:** The Phase 2 monitoring system (cron + adapters) will catch usage-based vendor cliffs, but renewal-based cliffs — domain expiry, insurance lapse, card expiry — are date-based and need a calendar pre-warning. The Phase 2 `vendor_renewal_calendar` table will eventually replace this manual one, but the manual one is the immediate-term fallback.

---

### ✅ 5. `docs/ops/` directory exists with screenshots and state docs

**Status: PARTIAL — directory created in this commit; awaiting Daniel-side artifact uploads.**

Created in this commit:
- `docs/ops/README.md` — directory purpose
- `docs/ops/registrar-state-template.md` — template for the registrar state capture
- `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` (this file)

Pending uploads (Daniel-side):
- `docs/ops/screenshots/anthropic-spend-cap-2026-05-09.png` (item 1)
- `docs/ops/registrar-state-2026-05-09.md` (item 2; copy from template)
- `docs/ops/manual-renewal-calendar-2026-05-09.md` (item 4)

---

### ☐ 6. CLAUDE.md updated with Phase 1 completion note

**Status: COMPLETE for spec ratification (Active Workstreams section added in commit `4a05bf2`); pending Phase 1 *completion* note once items 1, 2, and 4 are done.**

When Phase 1 fully closes (all five preceding items checked), update CLAUDE.md "Active Workstreams" section's Operational Monitoring entry from:

```
Phase 1 (no-code operational hardening) — *status: TBD, update when complete*
```

to something like:

```
Phase 1 (no-code operational hardening) — CLOSED 2026-MM-DD per docs/ops/PHASE_1_VERIFICATION_<latest>.md
```

---

## Summary

| Item | Status | Owner | Effort |
|---|---|---|---|
| 1. Anthropic spending cap | ✅ DONE 2026-05-11 | Daniel | ~10 min |
| 2. Domain registrar hardened | ✅ DONE 2026-05-11 | Daniel | ~15 min |
| 3. Stripe webhook health | ⚠️ SANDBOX ✅ 2026-05-11; LIVE destination still owed before first customer | Daniel | ~5 min (live retry) |
| 4. Manual renewal calendar | ⚠️ PARTIAL — see playbook Stop 4 for gaps | Daniel | ~15 min to add missing events |
| 5. Monitoring tokens | ✅ DONE 2026-05-11 from operator side. All 5 adapters now configured + authenticated (MANAGEMENT_API_TOKEN, VERCEL_ACCESS_TOKEN, ANTHROPIC_ADMIN_API_KEY, ANTHROPIC_MONTHLY_CAP_USD=100). Supabase / Vercel / Anthropic adapters return 0 useful snapshots because their API response shapes diverge from what the code expects — separate Claude-side iteration to update the field mapping. | Daniel ✅ / Claude follow-up | done |
| 5. `docs/ops/` artifacts | ⚠️ PARTIAL (structure ✅, screenshots/state owed) | Daniel | uploaded as items 1+2+4 complete |
| 6. CLAUDE.md Phase 1 closeout | ☐ OWED on completion | Claude (next session, after Daniel completes 1-4) | ~2 min |

**Total Daniel-side time to close Phase 1: ~60 minutes of dashboard work** spread across Anthropic Console, the domain registrar, Stripe Dashboard, and Google Calendar. No code changes required.

**Phase 2 is gated on this verification.** Per the spec: "If any item fails, do not proceed to Phase 2. The Phase 2 monitoring assumes Phase 1 cliffs are protected." Translation: do not start the cron + adapters work until items 1, 2, 3, and 4 are confirmed done. The vendor-cap protection at Phase 1 is the safety net under everything Phase 2 measures.

---

## Findings worth surfacing beyond Phase 1

Two observations from this verification that aren't strictly Phase 1 items but are worth recording:

**A. Email Intake plan's MX strategy is validated.** The decision in `docs/EMAIL_INTAKE_PLAN.md` § 5 / `EMAIL_INTAKE_DECISIONS.md` Decision 2 to put email-intake MX on `leases.theleaseio.com` (subdomain) rather than root is structurally correct: the root MX is Google Workspace (`aspmx.l.google.com`), and adding root MX records for Resend would break the Google mailbox routing. No further investigation needed; build can proceed on this assumption.

**B. Stripe webhook is at version 3, last deployed 2026-04-29.** The recent pricing reconciliation work (commit `e223144` on 2026-05-07) modified surrounding pricing functions but did NOT redeploy stripe-webhook itself because no logic in stripe-webhook needed changing. This is correct — the webhook's plan-mapping logic was already idempotent against the starter/business vocabulary. Worth noting that if a future Stripe Product is added (e.g., annual Prices being created in Stripe per Decision 1 of pricing reconciliation), the `PRODUCT_TO_PLAN` map at lines 11-14 of `check-subscription/index.ts` may need updating; `stripe-webhook` itself maps via `subscription.metadata?.plan_id` which is set by `create-checkout`, so it should remain correct.
