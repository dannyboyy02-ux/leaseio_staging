# Stripe Live-Mode Webhook Setup

**Owner:** Daniel · **Status:** owed before customer #1 · **Last updated:** 2026-06-02

This is the step-by-step for switching LeaseIO's billing from Stripe **sandbox/test**
mode to **live** mode. It complements `OPERATOR_PLAYBOOK.md` STOP 3 (which only
*verifies* an existing endpoint). Everything below is grounded in the actual code in
`supabase/functions/stripe-webhook/index.ts` and `supabase/functions/create-checkout/index.ts`
as of 2026-06-02 — re-check those files if they've changed.

---

## ⚠️ Read this first — it's a cutover, not an "add a new endpoint"

LeaseIO's edge functions read a **single** set of Stripe secrets — there is no
per-mode split:

| Secret | Read by | Live value |
|---|---|---|
| `STRIPE_SECRET_KEY` | `stripe-webhook` (line 55) **and** `create-checkout` (line 129) | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` (line 56) | `whsec_...` of the **live** endpoint |

Because both functions share one `STRIPE_SECRET_KEY`, you cannot run test and live
simultaneously. Going live means:

1. Creating a **new live-mode webhook endpoint** in Stripe (separate from the sandbox one).
2. **Swapping both secrets** to their live values in Supabase.

After the swap, the old **sandbox** endpoint will start failing signature verification
(its test-signed events won't validate against the live secret). **That is expected** —
don't panic at red rows on the sandbox endpoint post-cutover.

### Companion prerequisite — verify the live Price IDs (do NOT skip)

The monthly Price IDs are **hardcoded** in the code, and Stripe Price IDs are
**mode-specific** (a test-mode price does not exist in live mode):

```
starter  monthly: price_1SntpyH03PByDjY31dGmC0E2
business monthly: price_1SntqQH03PByDjY3MrvOjOsu
```
…hardcoded in **both** `create-checkout/index.ts` (lines 21, 25) and
`stripe-webhook/index.ts` (lines 6–7).

- The **webhook** is resilient: `resolvePlan` reads `subscription.metadata.plan_id`
  first (set by `create-checkout`), so it resolves the plan even if the price ID
  doesn't match.
- **`create-checkout` is NOT resilient**: it passes the hardcoded price ID straight
  into the Checkout Session. If that price ID only exists in **test** mode, the first
  **live** checkout fails with *"No such price"* under the `sk_live_` key.

**So, before cutover, confirm in the Stripe dashboard (live mode) that those two
Price IDs exist.** If they don't (likely, if they were created during sandbox testing):
this becomes a **code change**, not just a dashboard step — create live Products +
Prices, then update the hardcoded IDs in **both** files and redeploy. See
"If the Price IDs are test-only" at the bottom.

---

## Step-by-step — create the live webhook endpoint

1. **Switch the Stripe dashboard to Live mode.** Toggle off "Test mode" (top-right).
   Everything below must be done with Live mode active.

2. **Confirm the live API key exists.** Developers → API keys → copy the **live**
   secret key (`sk_live_...`). You'll set it in Supabase in step 6.

3. **Create the endpoint.** Developers → Webhooks → **Add endpoint**.
   - **Endpoint URL:**
     ```
     https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook
     ```
   - **Description:** `LeaseIO live subscription sync`

4. **Subscribe exactly these 4 events** (the function ignores everything else — see
   the `switch (event.type)` at `stripe-webhook/index.ts` line 120). Click
   "Select events" and add:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

   > Extra events = harmless (delivered, then ignored). **Missing** events = real bug
   > (e.g. drop `customer.subscription.deleted` and cancellations won't downgrade the
   > workspace back to Starter).

5. **Save**, then open the new endpoint and **reveal the Signing secret** (`whsec_...`).

6. **Set both secrets in Supabase** (CLI; you must be linked to project
   `wwkwoxxcprnjjufkbzac`):
   ```bash
   supabase secrets set STRIPE_SECRET_KEY='sk_live_...'        # the live key from step 2
   supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_...'      # the live endpoint's signing secret
   ```
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected — leave them alone.

7. **(No redeploy needed for secrets.)** Edge function secrets are read at request time.
   You only redeploy if you had to change Price IDs in code (see bottom).

---

## Verification (do before announcing launch)

1. **Send a test event from Stripe.** On the live endpoint page → "Send test webhook"
   → pick `customer.subscription.updated` → Send. Expect a **200** response. A **400**
   "Invalid Stripe signature" means `STRIPE_WEBHOOK_SECRET` doesn't match this endpoint.

2. **Real end-to-end (best signal).** With live mode on, run one real checkout
   (a real card, on the Business monthly plan — you can refund yourself after):
   - Checkout should complete (proves the live Price ID exists — the companion check).
   - Within seconds the workspace row should flip. Verify in SQL:
     ```sql
     SELECT plan, document_limit, subscription_status, stripe_subscription_id,
            subscription_period_end, billing_interval
     FROM   public.workspaces
     WHERE  id = '<your test workspace id>';
     ```
     Expect `plan='business'`, `document_limit=50`, `subscription_status='active'`
     (or `'trialing'`), and a non-null `stripe_subscription_id`.
   - The write is performed by the webhook under **service_role**, which is the only
     writer allowed past the entitlement guard (KNOWN_ISSUES #29) — so a successful
     flip also confirms that guard's carve-out is working in live mode.

3. **Check the Stripe endpoint's event log** shows 200s for the events it delivered.

4. **Record what you did** at the bottom of `OPERATOR_PLAYBOOK.md` (a dated note under
   STOP 3), including whether the Price IDs needed a code change.

---

## Notes & deferrable items

- **`verify_jwt` is already correct.** `supabase/config.toml` sets
  `[functions.stripe-webhook] verify_jwt = false` (line 58) — Stripe can't present a
  Supabase JWT; the function authenticates via signature verification instead. No action.
- **API version.** The function pins `apiVersion: "2025-08-27.basil"` in the SDK, so the
  dashboard endpoint's API-version setting doesn't need to match. Leave it at the
  account default.
- **Annual plans are deferrable.** `STRIPE_PRICE_STARTER_ANNUAL` /
  `STRIPE_PRICE_BUSINESS_ANNUAL` are unset → annual checkout fails **closed** with a
  clear 503 (`reason: 'annual_not_configured'`). Monthly works without them. To enable
  annual later, create live annual Prices and `supabase secrets set` those two vars
  (no code change — they're read from env). See OPERATOR_PLAYBOOK STOP 7.

### If the Price IDs are test-only (the companion-prerequisite failure path)

If step 2 of verification fails at checkout with "No such price", the hardcoded monthly
Price IDs don't exist in live mode. Then:

1. Live mode → Products → create (or confirm) the Starter and Business products with a
   **monthly recurring Price** each ($249 / $499). Copy the two new `price_...` IDs.
2. Update the hardcoded IDs in **both** files (they must agree):
   - `supabase/functions/create-checkout/index.ts` (lines 21, 25)
   - `supabase/functions/stripe-webhook/index.ts` (lines 6–7)
3. Commit (this is a real code change — Project Config Source-of-Truth rule), then
   **redeploy both functions**:
   ```bash
   supabase functions deploy create-checkout
   supabase functions deploy stripe-webhook
   ```
4. Re-run verification step 2.

> Future hardening (not required for launch): move these Price IDs to env vars
> (`STRIPE_PRICE_STARTER_MONTHLY` etc.) the way the annual ones already are, so a
> mode switch never requires a code change again. File as a KNOWN_ISSUES item if you
> hit this wall.
