# Operator Backlog Runbook — 2026-07-04

**For:** Daniel (the operator).
**Scope:** every remaining item from the 2026-07-03 end-to-end review's "Operator backlog" that requires *your* hands — verified against the **live system** on 2026-07-04 (project `wwkwoxxcprnjjufkbzac`), not against the older deploy docs, several of which turned out to be stale.
**Time needed:** ~40 minutes at your desk now, plus a ~15-minute go-live block later.
**Prereqs:** the Mac you've deployed from before (Supabase CLI already authenticated — your prior deploys prove it), a terminal in the project directory, and Stripe dashboard access.

---

## Part 1 — Already done. Do NOT redo these. (verified live 2026-07-04)

The review plan's operator table — and `DEPLOY_RUNBOOK_2026-06-18.md`, `LEASES_REDESIGN_DEPLOY_2026-06-25.md`, and KNOWN_ISSUES #18/#84/#111 — are **out of date on the following**. Live checks say:

| Item | Doc claim | Live truth (2026-07-04) |
|---|---|---|
| `resolve-approval-chain` redeploy (#84/#111) | "NOT DONE" | **Done** — v29 deployed 2026-06-23 from your machine; the Phase-7 backfill migration (`backfill_phase7_chain_columns`) is applied; live pending chain rows carry `pending_since`, and the two role-based steps correctly resolve as `policy_role`. |
| `act-on-chain-step`, `escalate-to-concept-approver`, `legacy-lease-action` redeploys | "NOT DONE" | **Done** — deployed 2026-06-19/23, matching last repo changes. |
| Cron secrets + schedules ("four secrets unset, crons never scheduled") | inert | **Working** — 11 jobs scheduled and returning HTTP 200, including `dispatch-notifications` every 10 min, `detect-stuck-chains`, `process-delegate-timers`, `send-counter-signature-reminder`, `reclaim-stuck-extractions`, `process-lease-retention`, `vendor-health-check`, `process-alerts`, `cleanup-expired-reports`, `send-lease-notifications`, `process-cancellation-lifecycle`. |
| Approval e-mail delivery | "delivers nothing" | **Working** — `notification_deliveries` shows sent rows; Resend key is configured. |
| #18 broken storage RLS on `lease-reports` | "filed, never fixed" | **Fixed live** — the policies now bind `objects.name` to `lease_reports` paths (the correct form). The fix was applied out-of-band, so the repo migration + KNOWN_ISSUES are drifted; a build session will capture this via `db pull` and stamp the docs. **No action from you.** |
| Retention/delete/restore functions + cron | "activation owed" | **Done** — `delete-lease`, `restore-lease`, `process-lease-retention` deployed 06-25; retention cron live. |
| Missing cron schedules for `sweep-pending-workspaces`, `firm-billing-reconcile`, `vault-renewal-reminder` | absent | **Scheduled today** (migration `20260704120000`), fail-closed: they 401 harmlessly until you complete **Step 2** below. |

---

## Part 2 — Your checklist

### Step 1 — Redeploy the two stale functions (+1 for safety) · ~3 min

The repo copies changed after the last deploys: `process_lease` (repo 06-25 — the soft-delete filters — vs deployed 06-23) and `vendor-health-check` (repo 06-16 vs deployed 05-16). `retry_lease` was committed and deployed the same day (06-23) so it's ambiguous — redeploying is free and idempotent.

The required `lease_retention_lifecycle` migration is already applied live, so the ordering constraint in `LEASES_REDESIGN_DEPLOY_2026-06-25.md` is satisfied — deploy order no longer matters.

```bash
cd ~/Projects/leaseio_staging
git checkout main && git pull
npx supabase functions deploy process_lease
npx supabase functions deploy vendor-health-check
npx supabase functions deploy retry_lease
```

**Verify:** `npx supabase functions list` — the three rows show today's date (or check Dashboard → Edge Functions → "Last deployed").

### Step 2 — Arm the three new crons (secrets, both sides) · ~5 min

Today's migration scheduled `sweep-pending-workspaces-hourly` (:35), `firm-billing-reconcile-daily` (07:30 UTC), and `vault-renewal-reminder-daily` (08:20 UTC). Each is dead (401) until the same secret exists in **two places**: the edge-function env and the `private.cron_secrets` ledger.

Generate three secrets (run three times, keep the outputs):

```bash
openssl rand -hex 32
```

Function side:

```bash
npx supabase secrets set SWEEP_PENDING_WORKSPACES_CRON_SECRET='<hex-1>'
npx supabase secrets set FIRM_BILLING_CRON_SECRET='<hex-2>'
npx supabase secrets set VAULT_RENEWAL_CRON_SECRET='<hex-3>'
```

Database side — Dashboard → SQL Editor, paste with the same values:

```sql
INSERT INTO private.cron_secrets (id, value) VALUES
  ('sweep_pending_workspaces', '<hex-1>'),
  ('firm_billing',             '<hex-2>'),
  ('vault_renewal',            '<hex-3>')
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
```

**Verify (next day, or after :35 past the hour for the sweep):**

```sql
SELECT status_code, count(*) FROM net._http_response GROUP BY 1;
```

You want 200s and no new 401s. (401s here mean one side of a secret pair is missing or mismatched.)

### Step 3 — Stripe: annual prices (STOP 7) · ~10 min · test mode

1. Stripe Dashboard (**test mode**) → **Products** → **Starter** (`prod_TlQhMebFLbmsbR`) → **Add price** → recurring, **$2,390 / year** → save → copy the `price_…` ID.
2. Same on **Business** (`prod_TlQhRntCDhkxfK`) → **$4,790 / year** → copy the ID.
3. Terminal:
   ```bash
   npx supabase secrets set STRIPE_PRICE_STARTER_ANNUAL='price_…'
   npx supabase secrets set STRIPE_PRICE_BUSINESS_ANNUAL='price_…'
   npx supabase functions deploy create-checkout
   ```

**Verify:** in the app, Billing → toggle Annual → checkout opens at $2,390 (Starter) instead of the "annual isn't configured" toast.

### Step 4 — Stripe: document-pack prices · ~10 min · test mode

1. **Products** → **Add product** → name `LeaseIO Document Pack` (one product carrying three prices is fine — the code identifies packs by Price ID, not Product).
2. Add three **recurring monthly** prices: **$90**, **$160**, **$350**. Copy each `price_…` ID.
3. Terminal:
   ```bash
   npx supabase secrets set STRIPE_PRICE_PACK_10='price_…'   # $90
   npx supabase secrets set STRIPE_PRICE_PACK_20='price_…'   # $160
   npx supabase secrets set STRIPE_PRICE_PACK_50='price_…'   # $350
   npx supabase functions deploy manage-document-pack
   ```

**Verify:** on a workspace at its lease cap, the limit dialog's "Add a pack" path opens checkout at $90 instead of failing with `pack_not_configured`.

### Step 5 — Stripe: Vault product (STOP 10) · ~5 min · test mode

1. **Products** → **Add product** → name `Vault` (new product, separate from Starter/Business).
2. Add a **recurring yearly** price: **$249 / year** → copy the ID.
3. Terminal:
   ```bash
   npx supabase secrets set STRIPE_PRICE_VAULT_ANNUAL='price_…'
   npx supabase functions deploy create-checkout
   npx supabase functions deploy stripe-webhook
   ```
4. The renewal-reminder cron is already scheduled (Step 2 armed it) — nothing more to wire.

**Verify:** cancel-dialog "Switch to Vault" on a test workspace opens a $249/yr checkout; on completion the workspace shows `plan='vault'`, read-only, data viewable + exportable.

### Step 6 — GO-LIVE BLOCK (STOP 3 + live-mode duplicates) · ~15 min · do this only when flipping to real customers

Stripe test and live modes are **separate universes** — every Product, Price, webhook endpoint, and secret above exists per-mode. At go-live:

1. Toggle Stripe to **Live mode** → **Developers → Webhooks → Add endpoint**:
   - URL: `https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook`
   - Events — exactly these five: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded` (the last one is what grants single-lease credits — without it customers are charged and never credited, silently).
   - Copy the endpoint's **signing secret** (`whsec_…`).
2. Re-create in live mode everything from Steps 3–5 (annual prices, three pack prices, Vault product/price) and copy the **live** `price_…` IDs — they differ from test-mode IDs.
3. Swap the whole secret set together (never one at a time — a mixed test/live set half-breaks billing):
   ```bash
   npx supabase secrets set STRIPE_SECRET_KEY='sk_live_…' \
     STRIPE_WEBHOOK_SECRET='whsec_… (live)' \
     STRIPE_PRICE_STARTER_ANNUAL='price_… (live)' \
     STRIPE_PRICE_BUSINESS_ANNUAL='price_… (live)' \
     STRIPE_PRICE_PACK_10='price_… (live)' \
     STRIPE_PRICE_PACK_20='price_… (live)' \
     STRIPE_PRICE_PACK_50='price_… (live)' \
     STRIPE_PRICE_VAULT_ANNUAL='price_… (live)'
   npx supabase functions deploy create-checkout stripe-webhook manage-document-pack customer-portal
   ```
4. Send a live-mode test event from the webhook page ("Send test webhook") and confirm a 200 in **Recent deliveries**.

> Note: the plan's Phase 0 also fixes the checkout **double-billing** and Stripe **Basil-API date** bugs in `create-checkout`/`stripe-webhook`. If the build sessions land those before your go-live block, the deploys in item 3 pick them up automatically — no extra step.

### Step 7 — Final sweep · ~3 min

```bash
npx supabase secrets list
```

Confirm these names all appear (values are hidden — names are enough):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_BUSINESS_ANNUAL`, `STRIPE_PRICE_PACK_10/20/50`, `STRIPE_PRICE_VAULT_ANNUAL`, `SWEEP_PENDING_WORKSPACES_CRON_SECRET`, `FIRM_BILLING_CRON_SECRET`, `VAULT_RENEWAL_CRON_SECRET`, plus the pre-existing `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_DI_*`, and the eleven older `*_CRON_SECRET`s.

Then run the cron health snippet at the bottom of `docs/ops/OPERATOR_PLAYBOOK.md` (or just the `net._http_response` query from Step 2) and confirm no 401s.

---

## Part 3 — Handled by the build sessions (informational, no action from you)

- **Docs reconciliation:** stamp KNOWN_ISSUES #18 (fixed live, with drift note), #84/#111 (redeploys verified complete), and correct `DEPLOY_RUNBOOK_2026-06-18.md` + `LEASES_REDESIGN_DEPLOY_2026-06-25.md`.
- **Capture the #18 drift:** `supabase db pull` so the live (correct) storage policies exist as a committed migration.
- **Phase-6 reroute pollers** (`process-pending-reroute-evaluations`, `reroute-audit-sweep`): deliberately NOT scheduled today — their cron auth path is broken by design (they expect a user JWT) and gets fixed in Phase 1 before scheduling makes sense.
- **Everything in plan Phases 0–6** (code, migrations, staging deploys of session-buildable functions).
