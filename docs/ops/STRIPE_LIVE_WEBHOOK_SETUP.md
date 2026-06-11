# Stripe Live-Mode Webhook Setup

**Owner:** Daniel · **Status:** owed before customer #1 · **Last updated:** 2026-06-02

---

## Do this first — 60-second check before anything else

The most common reason this fails: the monthly Price IDs hardcoded in the code only exist in **test mode**. Live mode has separate Products and Prices — Stripe never copies them automatically.

**Check now:**

1. Log in to [dashboard.stripe.com](https://dashboard.stripe.com).
2. At the top of the page, make sure the **"Test mode"** toggle is **OFF** (you should see "Live mode" or no test banner).
3. In the left sidebar, click **Product catalog**.
4. Look for your two products (Starter / Business) with monthly prices.

**If you see them:** good, note the two `price_live_...` IDs — you'll need them shortly.

**If you do NOT see them:** you must create them before the webhook will work. Skip to the appendix "If live Products don't exist yet" at the bottom, then come back here.

---

## Step 1 — Create the live webhook endpoint

1. In the left sidebar, click **Developers**.
2. Click **Webhooks** (it's a tab inside Developers).
3. Click the **"Add endpoint"** button (top right of the webhooks table).

   > If you're in a new Stripe Workbench UI, look for **"Add destination"** — same thing.

4. In the **"Endpoint URL"** field, paste exactly:
   ```
   https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/stripe-webhook
   ```

5. In the **"Description"** field (optional), type: `LeaseIO live subscription sync`

6. Under **"Select events"**, click **"Select events"** or **"+ Add events"**.
   Search for and add these five events — no more, no fewer:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `payment_intent.succeeded`  ← required for single-lease credits (limit wall / Workstream C). Omitting it means a "buy 1 lease" charge succeeds but the credit is never granted. Add it on both the sandbox and live endpoints.

7. Click **"Add endpoint"** to save.

---

## Step 2 — Copy the webhook signing secret

1. After saving, Stripe shows you the endpoint detail page.
2. Find the **"Signing secret"** section and click **"Reveal"**.
3. Copy the value — it starts with `whsec_`. Save it somewhere temporary (you'll paste it in Step 4).

---

## Step 3 — Copy the live secret API key

1. In the left sidebar, click **Developers** → **API keys**.
2. Under **"Secret key"**, click **"Reveal live key"**.
3. Copy the value — it starts with `sk_live_`. Save it temporarily.

---

## Step 4 — Update the Supabase secrets

Open a terminal on your machine with the Supabase CLI installed and run these two commands (replace the placeholders with the real values you copied):

```bash
supabase secrets set STRIPE_SECRET_KEY='sk_live_...'
supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_...'
```

> **Note:** You must be linked to the right Supabase project. If you get a "not linked" error, run `supabase link --project-ref wwkwoxxcprnjjufkbzac` first.

No code redeploy is needed — edge functions read secrets at request time.

---

## Step 5 — Verify it works (do this before announcing launch)

### Quick check — send a test event

1. On the webhook endpoint detail page in Stripe (Developers → Webhooks → click your new endpoint), find the **"Send test webhook"** button.
2. Select `customer.subscription.updated` from the dropdown and click **Send**.
3. Scroll down to the **"Recent deliveries"** section and confirm the delivery shows **Status: 200**.

   - If you see **400 "Invalid Stripe signature"**: the `STRIPE_WEBHOOK_SECRET` you set doesn't match this endpoint. Go back and re-reveal and re-copy the signing secret for this specific endpoint, then re-run the `supabase secrets set` command.
   - If you see **500**: check Supabase edge function logs (Supabase dashboard → Edge Functions → stripe-webhook → Logs).

### Real checkout check — best signal

Run one real checkout in live mode (a real card, Business monthly plan — refund yourself after):

- Checkout should complete without error.
- Within a few seconds, open your Supabase SQL editor and run:

```sql
SELECT plan, document_limit, subscription_status, stripe_subscription_id,
       subscription_period_end, billing_interval
FROM   public.workspaces
WHERE  id = '<your test workspace id>';
```

Expect: `plan = 'business'`, `document_limit = 50`, `subscription_status = 'active'` (or `'trialing'`), `stripe_subscription_id` is not null.

---

## Step 6 — Record what you did

In `docs/ops/OPERATOR_PLAYBOOK.md`, add a dated note under STOP 3. Include:
- Date of cutover
- Whether the live Price IDs already existed or had to be created
- The live endpoint ID (visible on the endpoint detail page, starts with `we_`)

---

## Appendix — If live Products don't exist yet

If Step 0 showed no Products (or prices with `price_test_...` IDs), do this:

1. Make sure you're in **Live mode** (test mode toggle is OFF).
2. Left sidebar → **Product catalog** → **"+ Add product"**.
3. Create the Starter product:
   - Name: `Starter`
   - Pricing model: **Standard pricing**
   - Price: `$249.00`
   - Billing period: **Monthly**
   - Click **Save product**. Copy the new `price_live_...` ID that Stripe generates.
4. Repeat for Business:
   - Name: `Business`
   - Price: `$499.00`
   - Billing period: **Monthly**
   - Copy the new `price_live_...` ID.
5. Update the hardcoded Price IDs in **two files**:
   - `supabase/functions/create-checkout/index.ts` (lines 21 and 25)
   - `supabase/functions/stripe-webhook/index.ts` (lines 6 and 7)
6. Commit the code change, then redeploy both functions:
   ```bash
   supabase functions deploy create-checkout
   supabase functions deploy stripe-webhook
   ```
7. Then continue from Step 1 above.

---

## Notes

- **After the cutover**, you'll see red/failed events on the old **test-mode** webhook endpoint. That is expected — the signed events from the old test endpoint won't validate against the new live secret. Ignore them.
- **Annual plans** are intentionally disabled until `STRIPE_PRICE_STARTER_ANNUAL` and `STRIPE_PRICE_BUSINESS_ANNUAL` are set. Monthly plans work without them.
- **No `verify_jwt` action needed** — it's already set to `false` in `supabase/config.toml` for the stripe-webhook function. Stripe can't provide a Supabase JWT.
