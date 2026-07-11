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

> ### ⚑ UPDATE 2026-07-11 — YOU ARE HERE
>
> **Done and verified live:** Step 2 is complete (all three cron secrets present in `private.cron_secrets`, response log shows 200s and zero 401s — the cron layer is fully armed). Step 1 assumed done; re-running its three deploy commands is harmless if unsure.
>
> **Cron-secret bracket note (verified 2026-07-11, decided: LEAVE AS-IS):** the three new secrets were stored with literal `<>` brackets (66 chars vs the correct 64) on BOTH the function env and the DB ledger. Because both sides carry the *same* bracketed value they match, and the sweep cron has returned HTTP 200 every hour with zero 401s over 24h — so they work and do NOT need regenerating. ⚠️ Do NOT strip the brackets from only one side; that would diverge the pair and silently 401 the cron. If ever cleaning cosmetically, change function env AND DB ledger in the same pass to identical bare-hex values.
>
> **Where you are:** mid-Step 3 — but in a **new Stripe sandbox** ("LeaseIO sandbox") with **newly created products** (Starter `prod_UpI3AgvCxw1ZYY`, Business `prod_UpI5w6gn9xEJr1`, created Jul 5). The app's code still points at the ORIGINAL products/prices, and sandboxes have their own API keys and webhooks. Owner decision 2026-07-11: **Starter is $299/mo (final)** — the $2,870/yr annual you already created is correct; the $249/mo monthly is the one to replace. **Follow the reconciliation below instead of the original Steps 3 items 1–5**, then continue with Steps 4–5 as written (inside this same sandbox).
>
> **R1 — Fix Starter monthly (in the sandbox):**
> 1. Starter → Pricing → **+ Add another price** → **299.00 / Recurring / Monthly** → Add price.
> 2. On the new $299 row: **⋯ → Set as default price**.
> 3. On the old $249 row: **⋯ → Archive price** (possible only after step 2, since a default price can't be archived).
>
> **R2 — Collect SIX price IDs into Notes** (click each price row, copy the `price_…` ID, or ⋯ → Copy price ID): Starter **$299/mo**, Starter **$2,870/yr**, Business **$499/mo**, Business **$4,790/yr** — plus, after you do Steps 4–5, the pack and Vault IDs.
> - The two **monthly** IDs go to Claude (they're hardcoded in `create-checkout`/`stripe-webhook` and must be repointed — paste them into the chat).
> - The two **annual** IDs go into secrets (R4).
>
> **R3 — Webhook inside this sandbox** (webhooks don't carry over between environments). Newer Stripe calls these **"Event destinations,"** found under **Workbench → Webhooks** (or **Developers → Webhooks**). As of 2026-07-11 the destination **already exists** — `leaseio-sandbox-supabase`, Active, pointing at the stripe-webhook URL — so DON'T click "Add destination"; open the existing one and finish it:
> 1. Click the blue destination name **`leaseio-sandbox-supabase`** (or the **⋯** at the row's right end) to open its detail page.
> 2. Confirm it listens to exactly these **five** events (it showed "4 events" — the missing one is almost certainly the last): `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded`. If one's missing → **Update details / Edit destination** (button or ⋯ menu) → add it → save.
> 3. Get the signing secret from the destination's **Overview** detail page (the view page, NOT the Edit form — the secret is not on the edit screen). On the right under the **"Signing secret"** heading is a field `whsec_••••••••`. Click the **👁 eye icon** to its right to reveal, then copy — that's the R4 value. **Do NOT click "Roll secret"** (the ↻ icon or the ⋯-menu item) — that regenerates the secret and invalidates the current one.
> 4. (Only if no destination exists — e.g. in a fresh sandbox: **Add destination** → URL `https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook` → the five events above → create → copy the signing secret.)
>
> **R4 — Point the backend at this sandbox.** In the sandbox: **Developers → API keys** → reveal and copy the **Secret key** (`sk_test_…` — each sandbox has its own). Then in Terminal:
> ```bash
> cd ~/Projects/leaseio_staging
> npx supabase secrets set STRIPE_SECRET_KEY='sk_test_…sandbox…'
> npx supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_…from R3…'
> npx supabase secrets set STRIPE_PRICE_STARTER_ANNUAL='price_…2870…'
> npx supabase secrets set STRIPE_PRICE_BUSINESS_ANNUAL='price_…4790…'
> ```
>
> **R5 — Repoint + deploy.** Paste the two monthly price IDs to Claude → Claude updates the hardcoded IDs and pushes → then:
> ```bash
> git checkout main && git pull
> npx supabase functions deploy create-checkout
> npx supabase functions deploy stripe-webhook
> ```
> (If the pricing/ID commit is still on the review branch rather than main, Claude will tell you which branch to pull.)
>
> **R6 — Continue:** Step 4 (packs) and Step 5 (Vault) exactly as written below, creating everything **inside this same sandbox**; their secrets + `manage-document-pack` deploy as written. Then the Step 7 sweep. Note for go-live later: Step 6's "Copy to live mode" shortcut copies from a sandbox to live the same way.

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

> ⚠️ **PASTE THE BARE VALUE — do NOT include the `< >` angle brackets.** Below, `PASTE_HEX_1` is a stand-in for the 64-character output of `openssl` (letters a–f and digits only, e.g. `4f3c9a1b…d2`). A correct stored secret is exactly **64 characters**; if it's 66 and starts with `<`, the brackets got pasted in — regenerate. (This bit the first setup on 2026-07-11.)

Function side:

```bash
npx supabase secrets set SWEEP_PENDING_WORKSPACES_CRON_SECRET='PASTE_HEX_1'
npx supabase secrets set FIRM_BILLING_CRON_SECRET='PASTE_HEX_2'
npx supabase secrets set VAULT_RENEWAL_CRON_SECRET='PASTE_HEX_3'
```

Database side — Dashboard → SQL Editor, paste the **same** three bare values:

```sql
INSERT INTO private.cron_secrets (id, value) VALUES
  ('sweep_pending_workspaces', 'PASTE_HEX_1'),
  ('firm_billing',             'PASTE_HEX_2'),
  ('vault_renewal',            'PASTE_HEX_3')
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
```

**Verify (next day, or after :35 past the hour for the sweep):**

```sql
SELECT status_code, count(*) FROM net._http_response GROUP BY 1;
```

You want 200s and no new 401s. (401s here mean one side of a secret pair is missing or mismatched.)

### Before Step 3 — one-time Stripe orientation (read this once; ~3 min)

Steps 3–6 all happen on **Stripe's website control panel, called the "Dashboard."** (Navigation labels below verified against Stripe's current documentation, 2026-07-04. Stripe occasionally renames buttons; the anchor check in item 3 below is what tells you you're in the right place regardless.)

1. **Get there:** open a browser → **https://dashboard.stripe.com** → sign in with your existing Stripe account. That's the whole answer to "where do I go" — everything Stripe-side happens on this one site.
2. **Know which universe you're in.** Every Stripe account has two parallel worlds with separate data: a practice world (fake cards, no real money — called **Test mode** or a **Sandbox** depending on account vintage) and the real world (**Live mode**). LeaseIO's staging backend points at the practice world. How to switch, depending on what your account shows:
   - **Classic accounts:** a **"Test mode" toggle** near the top of the page — the page gets an orange banner/badge when it's on. Turn it ON.
   - **Newer accounts:** no toggle; instead click your **business name (top-left account picker)** → **Switch to sandbox** (or **Sandboxes → Open**). An orange banner says you're in the sandbox.
3. **The right-place check (do this before anything else):** in the left sidebar click **Product catalog** — if you don't see it directly, it's under **More ▾**; or just paste `https://dashboard.stripe.com/test/products` into the address bar. **You are in the right place when the list already shows two products named "Starter" and "Business."** Those were created during earlier setup. If you don't see them, you're in the wrong mode/sandbox — go back to item 2 and switch until you do.
4. **"Terminal" means** the Terminal app on your Mac (the same one you've deployed from). Always start with:
   ```bash
   cd ~/Projects/leaseio_staging
   ```
5. **Price IDs:** every price you create gets an ID that looks like `price_1Abc…`. You'll copy five of them across Steps 3–5 — keep a Notes window open and label each one as you go.

### Step 3 — Annual prices on Starter and Business (STOP 7) · ~10 min · practice mode

1. In **Product catalog**, click the product named **Starter** — its detail page opens.
2. Find the **Pricing** section → click **+ Add another price**.
3. In the price form: type **2870.00** (USD) as the amount — this is $299 × 12 with the standing 20% annual discount, matching the owner-ratified $299/mo Starter price → make sure the pricing type is **Recurring** (not One-off) → set **Billing period: Yearly** → leave everything else as-is → click **Add price** (some accounts label it **Create price**).
4. The new **$2,870.00 / year** row now appears in the Pricing table. Click that row — the price's detail opens and its ID (starts with `price_`) is shown at the top with a **copy icon**. Click to copy. (Shortcut on some accounts: the **⋯** menu at the right edge of the row → **Copy price ID**.)
5. Paste it into your Notes, labeled "Starter annual."
6. Go back to **Product catalog** → click **Business** → repeat items 2–5 with amount **4790.00 / Yearly**. Label it "Business annual."
7. Terminal (paste your two IDs inside the quotes):
   ```bash
   npx supabase secrets set STRIPE_PRICE_STARTER_ANNUAL='price_…starter-annual…'
   npx supabase secrets set STRIPE_PRICE_BUSINESS_ANNUAL='price_…business-annual…'
   npx supabase functions deploy create-checkout
   ```

**Verify:** in the LeaseIO app → Settings → Billing → switch the interval to **Annual** → the checkout should open at **$2,870/yr** for Starter instead of showing the "annual isn't configured" message.

### Step 4 — Document-pack prices · ~10 min · practice mode

1. **Product catalog** → click **+ Add product** (top-right).
2. Name: `LeaseIO Document Pack`. Skip image and description. (One product holding all three prices is fine — the code identifies packs by price ID, not by product.)
3. In the same form's price area: amount **90.00**, **Recurring**, **Billing period: Monthly** → save the product (**Add product**).
4. The product page opens. In **Pricing** → **+ Add another price** → **160.00 / Recurring / Monthly** → **Add price**. Then once more: **350.00 / Recurring / Monthly**.
5. Copy all three price IDs (same method as Step 3, item 4) and label them: $90 → pack 10 · $160 → pack 20 · $350 → pack 50.
6. Terminal:
   ```bash
   npx supabase secrets set STRIPE_PRICE_PACK_10='price_…the-$90-one…'
   npx supabase secrets set STRIPE_PRICE_PACK_20='price_…the-$160-one…'
   npx supabase secrets set STRIPE_PRICE_PACK_50='price_…the-$350-one…'
   npx supabase functions deploy manage-document-pack
   ```

**Verify:** on a workspace at its lease cap, the limit dialog's "Add a pack" option opens a **$90/mo** checkout instead of failing with `pack_not_configured`.

### Step 5 — Vault product (STOP 10) · ~5 min · practice mode

1. **Product catalog** → **+ Add product** → name: `Vault` (a brand-new product — do NOT add this price to Starter or Business).
2. Price in the same form: **249.00**, **Recurring**, **Billing period: Yearly** → **Add product**.
3. Open the new product → click the $249/year price row → copy its ID.
4. Terminal:
   ```bash
   npx supabase secrets set STRIPE_PRICE_VAULT_ANNUAL='price_…vault…'
   npx supabase functions deploy create-checkout
   npx supabase functions deploy stripe-webhook
   ```
5. The renewal-reminder cron is already scheduled and armed (Steps you did earlier) — nothing more to wire.

**Verify:** on a test workspace, the cancel dialog's "Switch to Vault" opens a **$249/yr** checkout; on completion the workspace shows plan **Vault**, read-only, with all data viewable and exportable.

### Step 6 — GO-LIVE BLOCK (STOP 3 + live-mode duplicates) · ~15 min · do this only when flipping to real customers

Stripe's practice and live modes are **separate universes** — every Product, Price, webhook endpoint, and secret above exists per-mode. At go-live:

0. **Shortcut for the products:** you do NOT have to rebuild Steps 3–5 by hand. Open each product's detail page in practice mode and click **Copy to live mode** (upper-right) — Stripe copies the product *and its prices* into the live world. Then open each product in **Live mode** and copy the **live** price IDs (they are different IDs from the practice ones).
1. Switch the Dashboard to **Live mode** (toggle off Test mode / leave the sandbox) → **Developers → Webhooks → Add endpoint**:
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
