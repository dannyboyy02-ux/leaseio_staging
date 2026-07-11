# Billing & Entitlements — End-to-End Code Review

Reviewer scope: `src/config/pricing.ts`, `src/components/billing/`, `src/lib/{stripe,trialStatus}.ts`,
`src/hooks/useWorkspaceQuota.ts`, edge functions `create-checkout`, `stripe-webhook`, `customer-portal`,
`get-billing-summary`, `manage-document-pack`, `_shared/document_packs.ts`, `LimitReachedDialog`,
`QuotaWarningBanner`, the Billing tab in `AccountSettings.tsx`, plus everything those files reference
(AppContext, process_lease quota, CancellationBanner, firm billing functions, Onboarding, send-invite,
report generators, ai-assistant). All claims below carry file:line evidence from the repo as of 2026-07-03.

---

## 1. Money-path map (as built)

| Path | Client entry | Server | Entitlement writer |
|---|---|---|---|
| Plan checkout (monthly) | `AccountSettings.tsx:409-439` (`proceedWithCheckout`) → PlanPickerDialog / recovery callout / Vault reactivate buttons | `create-checkout/index.ts:187-217` — Stripe Checkout, hardcoded monthly price IDs (`:19-27`), `trial_period_days: 7` (`:46`, `:210`) | `stripe-webhook` `applySubscription` (`stripe-webhook/index.ts:148-408`) |
| Plan checkout (annual) | same, `billingInterval` state (`AccountSettings.tsx:137`, pre-armed via `?billing=`) | same fn; price from `STRIPE_PRICE_{STARTER,BUSINESS}_ANNUAL`; **503 `annual_not_configured` when unset** (`create-checkout/index.ts:92-107`) | same |
| Trial | Not a standalone path — every plan Checkout carries `trial_period_days: 7` (`create-checkout/index.ts:46`), except Vault (`:210`) | Stripe converts day 8 | webhook (`trialing` counts as entitled, `stripe-webhook/index.ts:156`) |
| Document packs (recurring) | `DocumentPackDialog.tsx` (preview/consent/3DS) opened from Usage tab (`AccountSettings.tsx:1293`), quota banner `?packs=1` deep-link (`QuotaWarningBanner.tsx:148`), limit wall door 2 | `manage-document-pack` modes preview/confirm/cancel (`index.ts:202-468`); price env `STRIPE_PRICE_PACK_{10,20,50}` fail-closed 503 (`:392-395`), price-amount verification against catalog (`:407-422`) | webhook `applyDocumentPack` recompute-sum (`stripe-webhook/index.ts:463-540`), dead-letters un-honorable events (`:425-461`) |
| Single lease credit (one-time) | `LimitReachedDialog.tsx` door 3 (`:382-395`, consent → `handleBuySingle` `:129-219`) | `manage-document-pack` `buy_single` — on-session PI at plan overage rate (`index.ts:283-341`), Stripe idempotency key `single_{ws}_{key}` (`:316`) | webhook `applySingleLeaseCredit` — validates price/customer, idempotent ledger upsert on `payment_intent_id` (`stripe-webhook/index.ts:547-659`); consumed atomically by `consume_lease_credit` RPC in process_lease (`process_lease/index.ts:1125-1143`) |
| Vault ($249/yr offramp) | Grace-banner CTA, owner-only (`CancellationBanner.tsx:39-116`); reactivation buttons on Billing tab (`AccountSettings.tsx:1084-1094`) | `create-checkout` planId `vault`, yearly-only, no trial, owner-only (`index.ts:83-89`, `:158-169`, `:210`); **503 `vault_not_configured` until `STRIPE_PRICE_VAULT_ANNUAL` set** | webhook (metadata `plan_id: 'vault'` recognized without env, `:70-84`); pack retirement on conversion (`:321-355`) |
| Firm subscription | `FirmOnboarding.tsx:69-79` + `FirmBilling.tsx:120-128` → hosted Checkout | `create-firm-checkout/index.ts` — Business monthly price × child-count quantity, `metadata.firm_id`, owner-only, double-sub guard (`:76-80`), **no trial** | webhook `applyFirmSubscription` (`stripe-webhook/index.ts:668-717`); quantity sync `_shared/firm_billing.ts` from bind/release; `firm-billing-reconcile` cron backstop |
| Downgrade / cancel | Downgrade confirm → Stripe **portal** (`AccountSettings.tsx:1480-1506`); Cancel section → confirm → portal (`:1268-1286`, `:1510-1547`) | `customer-portal/index.ts` (workspace-scoped, owner/admin, firm 403 `:64-72`) | Stripe events → webhook cancellation lifecycle (`stripe-webhook/index.ts:230-248`), grace floor = now+7d |
| Billing read surface | Billing tab fetch-once (`AccountSettings.tsx:548-576`) | `get-billing-summary/index.ts` — owner/admin gated (`:70-89`), card brand/last4 + 12 invoices, 200-empty for no customer (`:91-94`) | n/a (read-only) |

Webhook routing order is correct: firm → pack → plan on both `checkout.session.completed` and
`customer.subscription.*` (`stripe-webhook/index.ts:749-770`). Signature verification `:135`, C1
stale-cancel guard `:189-197`, C2 consent guard `:210-218`, unresolvable-entitled-sub fails loudly `:163-170`.
This webhook is genuinely well-defended for the paths it covers. The findings below are about the paths it
does *not* cover.

---

## 2. CRITICAL — plan switch via Checkout never cancels the previous plan subscription (double-billing)

**Evidence.** `create-checkout/index.ts:187-217` creates a *new* Stripe subscription via Checkout and does
nothing to any existing subscription. The webhook's C2 guard (`stripe-webhook/index.ts:210-218`) is designed
to let a checkout-consented *new* sub take over the workspace row and then **ignore every future event from
the old sub** (C1 `:189-197` ignores its eventual `canceled`; C2 ignores its entitled `updated`s). Nothing —
in `create-checkout`, in the webhook, or anywhere else (`grep cancel_at_period_end|subscriptions.cancel`
across `supabase/functions/` hits only pack retirement `stripe-webhook/index.ts:341`, purge cron
`_shared/workspace_purge.ts:52`, firm quantity sync `_shared/firm_billing.ts:70`, pack cancel
`manage-document-pack/index.ts:363`, and abandoned-creation sweeps) — cancels the old plan sub in Stripe.

**Failure scenarios (real money):**
1. Paying Starter customer clicks Adjust plan → Business. `handleUpgrade` (`AccountSettings.tsx:398-407`)
   goes straight to checkout (currentPlan === 'starter' skips even the confirm dialog). New Business sub is
   created (with a fresh 7-day trial); the old $249/mo Starter sub keeps charging forever. Customer pays
   $249 + $499 monthly until they notice in the portal.
2. Vault customer clicks "Reactivate on Starter/Business" (`AccountSettings.tsx:1086-1093`). New plan sub
   starts; the $249/yr Vault sub keeps renewing alongside it. (The webhook retires *packs* on Vault
   conversion `:321-355` but there is no inverse retirement on reactivation.)

The C2 comment (`stripe-webhook/index.ts:204`) references "V3 sets cancel_at_period_end on it" — no code
in the repo does that; the design assumed an old-sub retirement step that was never built.

**Fix.** In the webhook's `checkout.session.completed` plan branch (or in `create-checkout` before session
creation), when `storedSubId && storedSubId !== newSub.id`, cancel (or `cancel_at_period_end`) the old
subscription — mirroring the existing pack-retirement loop. Alternatively route upgrades through
subscription *update* (proration) instead of a second Checkout.

---

## 3. HIGH — Starter signups get the product free, forever (no checkout is ever required)

**Evidence.** `Onboarding.tsx:84-135`: a Starter-selecting signup inserts the workspace at DB defaults
(plan `starter`, document_limit 15) and navigates straight to `/app/leases`. Only `plan === 'business'`
routes toward checkout (`:131-135`). No gate anywhere requires a subscription to exist:
- `process_lease` blocks only `canceled_at` / `soft_deleted_at` / `plan='vault'` (`process_lease/index.ts:1016-1046`); a never-subscribed workspace (`subscription_status` null) passes and gets 15 extractions / 15 active leases per the normal Starter quota.
- The trial banner and pill key off `subscriptionStatus === 'trialing'` (`AccountSettings.tsx:995`, `AppSidebar.tsx:281`) — a never-subscribed workspace shows *no* billing pressure at all.
- `sweep-pending-workspaces` only reaps *additional* workspaces created via `create-workspace` (`workspace_creation_requests` rows); the onboarding workspace has none (`sweep-pending-workspaces/index.ts:1-60`).

Meanwhile the landing page sells "Start 7-day Free Trial" (`PricingSection.tsx:58`,
`landing.pricing.start_trial`) and the docs say there is no free tier (CLAUDE.md Pricing Model). As coded,
"Starter trial" is actually "Starter free forever, capped at 15/mo" — the entire monetization funnel for
the default signup path depends on the user voluntarily visiting Billing and paying.

**Fix.** Either (a) route Starter signups through checkout with the 7-day trial (matching the marketing), or
(b) add a trial-expiry gate for never-subscribed workspaces (e.g. `created_at + 7d` without an entitled sub
→ same read-only state as `canceled_at`), enforced in `process_lease` and surfaced with a banner.

---

## 4. HIGH — `subscription_period_end` is read from a field Stripe's Basil API removed (trial/renewal dates likely never populate)

**Evidence.** All Stripe clients pin `apiVersion: "2025-08-27.basil"` (`create-checkout/index.ts:172`,
`stripe-webhook/index.ts:130`, `manage-document-pack/index.ts:247`). Stripe's Basil versions removed
`current_period_start/end` from the Subscription object (they moved to subscription items). The code reads
it through `as any` casts — the tell that the SDK types no longer have it:
- `stripe-webhook/index.ts:97-100` `resolvePeriodEnd` → writes `subscription_period_end` (null when the field is absent);
- `manage-document-pack/index.ts:136` and `:364` (pack "renews on" dates);
- fallback in the grace anchor `:238` (harmless — `ended_at` still exists).

For `checkout.session.completed` the sub is **freshly retrieved** at Basil (`stripe-webhook/index.ts:735`),
so the field is absent there with certainty. For `customer.subscription.*` events the payload shape follows
the *webhook endpoint's configured* API version, so it may or may not carry the field depending on operator
config — i.e. this is at minimum inconsistent and at worst always-null.

**Blast radius when null:** trial banner never renders (requires `formattedPeriodEnd`,
`AccountSettings.tsx:995`), sidebar trial pill never renders (`AppSidebar.tsx:736`), "auto-renews on" line
hidden (`:1111`), cancel-confirm shows the vaguer no-date copy (`:1515-1517`), pack rows show blank renewal
dates (`DocumentPackDialog.tsx:317-319`), and **`vault-renewal-reminder` matches zero workspaces**
(`vault-renewal-reminder/index.ts:55-61` filters `subscription_period_end NOT NULL`) — silently breaking the
V4 "no-surprise-billing" rule. A trialing user then gets charged on day 8 with no in-app countdown at all.

**Verification step for the owner:** inspect a real `workspaces.subscription_period_end` after a staging
checkout. **Fix:** read the period end from `subscription.items.data[0].current_period_end` (Basil location)
with the legacy field as fallback.

---

## 5. HIGH — abandoned-Business-checkout recovery banner is dead code (column never fetched)

**Evidence.** `Onboarding.tsx:89` writes `intended_plan` precisely so the Billing tab can recover an
abandoned Business checkout, and `AccountSettings.tsx:1047-1065` renders the recovery callout from
`workspace.intendedPlan`. But AppContext's workspace select list (`AppContext.tsx:113-114`) does **not**
include `intended_plan`, so `(resolvedWorkspace as any).intended_plan` (`:277-278`) is always `undefined`
→ `intendedPlan` is always `null` → the banner can never render. The one UI that was built to rescue the
"picked Business, closed the Stripe tab" user is unreachable. (Same select-list omission:
`max_archived_leases` is read at `:205` but never selected — benign only because the fallback equals the
plan constant.)

**Fix:** add `intended_plan` to `workspaceSelect`. One-line fix; add a regression test that the recovery
callout renders for `intended_plan='business'` + non-entitled status.

---

## 6. Entitlement gates — where each Business-only feature is actually gated

| Feature (Business-only per pricing) | Client gate | Server gate |
|---|---|---|
| Embedded AI assistant | `AiAssistant.tsx:33` (`canAccessFeature('business')`) | ✅ `ai-assistant/index.ts:234` (`plan !== 'business'` → error) + liveness `:226-231` + consent `:243-261` + 30/hr rate limit `:263-279` |
| Portfolio intelligence | `Portfolio.tsx:293`, sidebar lock `AppSidebar.tsx:301,376` | ❌ none (data is plain RLS reads — a Starter user calling the DB directly gets the same rows; low practical risk, no vendor cost) |
| Reports / audit package / ASC 842 disclosures | `Reports.tsx:73` | ❌ **none** — `generate-workspace-asc842-report/index.ts:310-335` and `generate-portfolio-report/index.ts:384-401` check only owner/member role, never plan. A Starter user can invoke Business-tier report generation (PDF/storage cost, entitlement bypass). |
| Amendment comparison | ❌ none (`UploadAmendmentDialog`, `AmendmentsList` — no plan checks) | ❌ none (`process_lease` amendment path is plan-blind; only the shared quota applies) |
| Custom approval playbook (approval policies) | ❌ none (`WorkspaceSettings.tsx` — no `canAccessFeature` anywhere) | ❌ none |
| Unlimited users (Starter cap = 3) | ❌ none | ❌ **none** — `send-invite/index.ts:144-172` checks owner/admin + liveness only; `maxUsers` (`pricing.ts:56,84`) is read by no runtime code. A Starter workspace can invite unlimited members while the landing card sells "3 users". |
| `hasBulkUpload` / `hasExportIntegrations` / `hasAdvancedReports` / `hasRoleBasedAccess` flags | Never read anywhere (grep: only pricing.ts + tests) | — |

Quota / caps (both tiers):
- **Abstraction quota + active-lease cap — properly server-enforced** in `process_lease/index.ts:990-1115`
  (trailing-30d extraction count `:1059-1073`; active count for new leases `:1078-1094`; packs raise both caps
  `:1053-1056`; credits reserved pre-Tier-2 and consumed atomically post-classification `:1102`, `:1125-1143`,
  `:2319`). Client mirror `useWorkspaceQuota.ts:31-58` is advisory-only, correctly documented as such.
- Fail-open choices: a monthly-count DB error passes the upload (`:1066-1071`); documented, monitored by the
  soft-quota poller — acceptable but worth knowing.
- **`retry_lease` has no quota check at all** (grep `quota|document_limit` in `retry_lease/index.ts` → zero
  hits) yet runs the full Haiku+Opus pipeline (`:192-397`). Bounded only by it applying to failed leases and
  the liveness backstop (`:607`). Unmetered AI spend path — deliberate for failed extractions, but nothing
  stops repeated retries.

## 7. Fail-closed env vars — features that 503/no-op TODAY until the operator acts

| Env var | What dies without it | Behavior |
|---|---|---|
| `STRIPE_PRICE_STARTER_ANNUAL` / `STRIPE_PRICE_BUSINESS_ANNUAL` | Annual checkout (toggle is live on landing + PlanPicker) | 503 `annual_not_configured` (`create-checkout/index.ts:92-107`). **Client shows only a generic toast** — `proceedWithCheckout` (`AccountSettings.tsx:432-435`) does not parse the response body the way `CancellationBanner.tsx:52-61` does, so the user sees "Edge Function returned a non-2xx status code"-class noise, not "annual isn't available yet". |
| `STRIPE_PRICE_VAULT_ANNUAL` | Vault conversion CTA on the grace banner | 503 `vault_not_configured`; CancellationBanner does surface a proper message (`:52-61`) |
| `STRIPE_PRICE_PACK_10/20/50` | Pack purchases | 503 `pack_not_configured` (`manage-document-pack/index.ts:392-395`); UI degrades well — unconfigured packs render disabled "unavailable" (`DocumentPackDialog.tsx:349-374`) |
| `STRIPE_WEBHOOK_SECRET` + live endpoint (STOP 3) | ALL entitlement writes | webhook 500s (`stripe-webhook/index.ts:111-120`) — money taken, plan never lands |
| `VITE_STRIPE_PUBLISHABLE_KEY` (correct prefix per MODE) | 3DS confirmation for packs + single-credit + multi-workspace create | `getStripe()` returns null fail-closed (`stripe.ts:21-36`) → "temporarily unavailable" errors |
| `VAULT_RENEWAL_CRON_SECRET` (+ cron schedule) | Vault renewal reminders | cron 401s (`vault-renewal-reminder/index.ts:32-37`) |
| `CANCELLATION_LIFECYCLE_CRON_SECRET`, `FIRM_BILLING_CRON_SECRET`, `SWEEP_PENDING_WORKSPACES_CRON_SECRET`, `LEASE_RETENTION_CRON_SECRET` | grace→soft-delete→purge progression; firm billing reconcile; abandoned-workspace sweep; lease retention purge | each cron fails closed on missing secret |
| vendor-health-check cron + secrets | `workspace_quota_snapshots` — **QuotaWarningBanner renders nothing without snapshot rows** (`QuotaWarningBanner.tsx:53-76`) | silent no-banner |

All are documented in `.env.example` (good), which however still points its sanity check at a
`check-subscription` function that does not exist in `supabase/functions/` (stale).

## 8. Webhook correctness — remaining gaps (beyond §2)

- **Idempotency:** good where it matters — credit ledger UNIQUE upsert (`:644-655`), pack capacity is a
  recompute (`:410-419`), plan writes are value-idempotent. No event-id dedup table, but redelivery of the
  *same* event is harmless.
- **Same-sub out-of-order events are unguarded:** C1/C2 only compare *subscription ids*. Two `updated`
  events for the current sub arriving out of order can regress `subscription_status`/interval (e.g. a stale
  `trialing` overwriting `active`). Low probability, self-heals on next event. Consider comparing
  `event.created` against a stored watermark.
- **Dunning = instant entitlement downgrade:** any non-entitled status (`past_due`, `unpaid`,
  `incomplete`) writes `plan: 'starter'` + `document_limit: 15` immediately (`:171`, `:263-277`). A Business
  workspace loses AI assistant/Portfolio/Reports on the *first* failed renewal charge, before Stripe's smart
  retries run — while the Billing tab header now says "Starter" under a past-due banner
  (`AccountSettings.tsx:1027-1043`, `:1107`), which reads as "we already downgraded you". Deliberate
  fail-closed posture, but confirm it's the intended customer experience; most SaaS keep entitlements through
  dunning.
- **Refunds are not handled:** no `charge.refunded`/`charge.dispute.*` handling — a refunded single-lease
  PI leaves the credit spendable (low).
- **Firm branch:** `invoice.payment_failed` unhandled; children stay `business` until
  `customer.subscription.deleted` (documented as P11+ grace work, `stripe-webhook/index.ts:680-691`).
  `applyFirmSubscription` reads `firm.stripe_subscription_id` *after* updating it in the same function, so the
  `isNew` audit flag (`:707`) is computed from the pre-update fetch — correct as written.

## 9. Trial-expiry UX walkthrough

- Trialing (post-checkout): banner with charge date + "Add payment method" portal button
  (`AccountSettings.tsx:995-1021`), sidebar pill (`AppSidebar.tsx:736-762`) — **both dead if §4 holds.**
- Trial charge fails → `past_due`: red banner + portal CTA (`:1027-1043`); entitlements already floored to
  starter (§8). Not stuck.
- Cancel during trial → `canceled` → grace banner with export / Vault (owner) / renew CTAs
  (`CancellationBanner.tsx:85-125`); soft-deleted wall after grace (`:130-171`). No dead-ends found; renew
  path from soft-delete goes through Billing → checkout.
- **Serial free trials:** `trial_period_days: 7` is stamped on *every* non-Vault checkout
  (`create-checkout/index.ts:46`, `:210`) — grace renewals, Vault reactivations, and Starter→Business
  upgrades all mint a fresh 7-day trial. The in-code comment "Stripe handles that natively; trial_period_days
  is best-effort" (`:175-178`) is wrong — Stripe applies `trial_period_days` unconditionally. A user can
  cancel-at-period-end and re-checkout each cycle for recurring free weeks. Also means "renew now" during
  grace doesn't take money for 7 more days (entitlement restores instantly via `trialing`).
- Non-admin member at trial end: banner shows "billing admin only" note (`:1018`) — fine.

## 10. Pricing-number consistency

- `pricing.ts` ($249/$499 monthly; $2,390/$4,790 annual = exactly 20% off; packs 90/160/350 for 10/20/50;
  overage 12/10) matches the Deno mirror `_shared/document_packs.ts:23-41` (incl. `SINGLE_LEASE_PRICE_CENTS`
  1200/1000) and the landing PricingSection (renders directly from `PLANS`/`PLAN_ORDER`,
  `PricingSection.tsx:31-63`). Billing locale keys are en/es-complete (scripted diff: 0 missing either way).
- `manage-document-pack` verifies the operator-created Stripe Price amount/currency/interval against the
  catalog before charging (`index.ts:407-422`) — excellent.
- **Mismatches:** Starter's landing feature list includes `plan.feature.audit_package` ("Audit-ready lease
  population export", `pricing.ts:66`) while CLAUDE.md's pricing table puts Audit Package in the
  Business-only row. Docs' "Onboarding Packs" (one-time historical-load SKUs, $200/$500/$1,200) exist nowhere
  in code. "3 users" (Starter) is advertised but unenforced (§6).
- **Usage-tab inconsistency:** the Active-leases meter uses `maxActiveLeases` *without* pack capacity
  (`UsageContent.tsx:103` vs `useWorkspaceQuota.ts:38` which adds `addon`), while the Abstractions meter above
  it *does* add it (`:98`). A workspace with a 10-pack shows a red 100% active-lease bar at 15/15 while the
  wall/server allow 25 — nudging an already-paying customer to buy again.

## 11. Docs drift (code contradicts docs)

1. **Firm self-serve Stripe checkout is BUILT, docs say deferred.** CLAUDE.md ("The one deferred piece is
   self-serve firm onboarding's Stripe checkout… #105") and KNOWN_ISSUES #105 item 5 ("#105-C (remaining)")
   vs code: `create-firm-checkout/index.ts` (complete, owner-gated, double-sub-guarded), `FirmOnboarding.tsx`
   3-step wizard routed at `/app/firm/onboarding` (`App.tsx:157`), `FirmBilling.tsx` wired with
   checkout-return handling, plus `firmOnboarding105c.test.ts`. Only the live-mode Business price remains
   operator-owed.
2. **`useLifecycleWorkflow.ts` is dead code still listed as a Path-1 component** in CLAUDE.md's
   file-to-feature map. No component imports it (grep: tests only; `App.tsx:184` notes the route was
   retired), and it contains a Business-only gate on lease-request creation
   (`useLifecycleWorkflow.ts:57-60`) that contradicts the pricing table (request workflow is both tiers).
   Delete or un-list it before someone resurrects the wrong gate.
3. **`create-firm-subscription` edge fn is deployed-config'd (`config.toml:229`) but invoked by nothing** —
   superseded by `create-firm-checkout`. Orphan money-path code; remove or mark superseded.
4. `.env.example` sanity check references a non-existent `check-subscription` function.
5. CLAUDE.md "7-day trial" + landing "Start 7-day Free Trial" vs the no-checkout Starter reality (§3).

## 12. Smaller findings

- **Annual-503 client handling:** `proceedWithCheckout` doesn't extract the structured `reason` from a
  FunctionsHttpError the way CancellationBanner does — annual pickers today get a generic failure toast
  (`AccountSettings.tsx:432-435`; compare `CancellationBanner.tsx:52-61`).
- `LimitReachedDialog` poll-loop reads a stale `workspace` closure (`:104` — `workspace?.purchasedLeaseCredits`
  inside the effect won't see refreshed values because `workspace` isn't in the dep array; the marker-key
  pending panel can persist one open-cycle longer than needed). Cosmetic; the direct-row poll in
  `handleBuySingle` (`:188-201`) is correct.
- Firm-managed check runs before the auth check in `create-checkout:129` / `customer-portal:64` — any
  authenticated user can learn a workspace id is firm-bound (info-leak, trivial).
- Downgrade/cancel both terminate in the Stripe portal; whether the portal actually offers plan switches is
  Stripe-dashboard configuration (operator dependency not expressible in repo — worth a runbook line).
- `QuotaWarningBanner` CTA sends non-admins nothing extra but shows admins "Add capacity" + everyone
  "View plans" — firm-bound workspaces still get the Billing-tab CTA here (`QuotaWarningBanner.tsx:151-155`),
  which lands on the firm-managed banner; mild dead-end (the `?packs=1` path is firm-suppressed,
  `AccountSettings.tsx:184-189`, but the banner CTA itself isn't).

## 13. Recommendations (priority order)

1. Cancel the superseded plan sub on checkout-driven plan switch (§2) — revenue-integrity blocker before
   any real customer upgrades or reactivates.
2. Decide and implement the never-subscribed Starter gate (§3) — currently the default signup path never
   pays.
3. Fix `resolvePeriodEnd` to the Basil field location and backfill `subscription_period_end` (§4); verify
   with a staging checkout.
4. Add `intended_plan` to AppContext's select (§5) — one line.
5. Enforce the Starter 3-user cap in `send-invite`; add plan checks to the report generators; decide whether
   amendment comparison / approval playbook are genuinely Business-only and gate or re-price accordingly (§6).
6. Add pack capacity to the Usage-tab active-lease meter (§10).
7. Reconcile CLAUDE.md/KNOWN_ISSUES #105 with the built firm checkout; delete `useLifecycleWorkflow.ts` and
   the orphan `create-firm-subscription` (§11).
8. Parse the `annual_not_configured` reason client-side, or hide the annual toggle until the env is set (§12).
