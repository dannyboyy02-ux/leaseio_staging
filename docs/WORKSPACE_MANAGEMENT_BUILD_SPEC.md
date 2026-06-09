# Workspace Management Build Spec — Multi-Workspace for Business

**Status:** DRAFT (pre-build, pending pressure-test)
**Date:** 2026-06-09
**Owner decisions ratified in-session 2026-06-09.**

---

## 0. Summary

Today a LeaseIO user gets exactly one workspace, created once during onboarding
(`src/pages/app/Onboarding.tsx:51-145`). There is **no UI to create a second
workspace** and no tier gate, because no second-creation path exists.

This spec adds **owner-level multi-workspace ownership for Business customers**:
a Business account holder can own up to **10** workspaces, each its own Business
subscription billed to the card on file, created through an **explicit in-app
confirmation modal**. It adds a Slack-style switcher, an ownership-transfer flow,
a per-workspace audit log, and a usage row in Settings.

This ships **ahead of and independent from** the firm layer (Phase 9/10). It uses
`owner_id` fan-out — **no `firm_id`, no grouping entity** — honoring the CLAUDE.md
hard rule "Do not pre-build the firm layer."

### Ratified decisions

| Topic | Decision |
|---|---|
| Tiers | Starter + Business only (no Pro) |
| Multi-workspace | Business-only, owner-level, **max 10**, cap is **owner-only** (members never count) |
| Billing | Each additional workspace = its own **$499/mo** Business subscription on the owner's existing Stripe customer (card on file). **No trial, no proration** — full $499 charged at creation. |
| Consent | **In-app confirmation modal** showing price + card last4 + "charged today"; explicit "Confirm & create" before any charge. SCA/3DS falls back to a Stripe confirmation step. |
| Switcher | Slack-style "Option B": enhanced sidebar dropdown that becomes a Cmd+K command palette past 5 workspaces; initials avatar with deterministic color from id |
| Owner transfer | v1: single transferable owner (reassign to another member). Co-owners (multiple) deferred to v2. |
| Quota visibility | Settings → Usage only (`UsageContent.tsx` row "Workspaces: X of 10"). **No** app-wide banner. |
| Audit | New `workspace_activity_log` table |
| Strategy doc | +1 line recording owner-level multi-workspace ahead of the firm layer |

---

## 1. Scope & phasing

The spec covers the whole feature. Build proceeds in phases; each phase is
independently shippable and reviewer-gated.

- **Phase 1 — Capability (server + schema).** Migration (`workspace_activity_log`,
  `maxWorkspaces` config), `create-workspace` edge function (preview + confirm,
  Stripe subscription, rollback, SCA handling), audit writes. **Build first.**
- **Phase 2 — Switcher UX.** Sidebar dropdown upgrade → Cmd+K palette, initials
  avatars, new-workspace dialog wired to the confirm modal.
- **Phase 3 — Ownership transfer.** `transfer-workspace-ownership` edge function +
  UI on the management page.
- **Phase 4 — Polish.** Usage row in Settings, management-page grid (>5), copy/i18n.

---

## 2. Data model

### 2.1 New table: `workspace_activity_log`

Mirrors the shape and RLS intent of `lease_activity_log`
(`supabase/migrations/20260516120000_baseline_schema.sql:1016`) but scoped to
workspace lifecycle, because `lease_activity_log` is lease-scoped and there is
**no** workspace-level event log today.

```sql
CREATE TABLE IF NOT EXISTS public.workspace_activity_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type   text NOT NULL,   -- created | renamed | owner_transferred | member_added | member_removed | deleted | subscription_attached
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_log_workspace_id
  ON public.workspace_activity_log (workspace_id, created_at DESC);

ALTER TABLE public.workspace_activity_log ENABLE ROW LEVEL SECURITY;

-- Read: any member of the workspace (mirrors is_workspace_member usage).
CREATE POLICY "Members read workspace activity"
  ON public.workspace_activity_log
  FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Write: service role only. No authenticated INSERT/UPDATE/DELETE policy is
-- created, so PostgREST authenticated writes are denied by default (RLS on,
-- no permissive policy). Every writer is a service-role edge function.
```

**Notes for the build:**
- Confirm `public.is_workspace_member(uuid, uuid)` exists and its signature
  (referenced at baseline `:127`). If the owner is not represented in
  `workspace_members`, the read policy must also allow `owner_id = auth.uid()`
  — verify during build and widen the `USING` clause if needed.
- `deleted` rows: because of `ON DELETE CASCADE`, a `deleted` event row would be
  removed with the workspace. If we want a durable deletion record, the delete
  event must be written to a different sink (e.g., keep `workspace_id` but drop
  the FK, or log deletion to an account-level table). **Open item — see §9.**

### 2.2 Config: `maxWorkspaces`

Add to each plan in `src/config/pricing.ts` (`PlanConfig` interface + both plan
objects):

```ts
maxWorkspaces: number;   // starter: 1, business: 10
```

Mirror as a Deno constant the edge function reads, so client and server share
one source of truth. Put the constant in a new
`supabase/functions/_shared/workspace_limits.ts`:

```ts
export const WORKSPACE_LIMITS: Record<string, number> = {
  starter: 1,
  business: 10,
};
export const BUSINESS_MONTHLY_PRICE_USD = 499;
```

### 2.3 No new columns on `workspaces`

Workspace avatar color is **derived deterministically from `id`** at render time
(no column). Initials are derived from `name`. A future `avatar_color` override
column is out of scope for v1.

`owner_id` reassignment for transfer is handled by the existing column; no schema
change — but see §4.2 for why it must go through a service-role function (the
`"Owners can update their workspaces"` RLS policy has
`WITH CHECK (owner_id = auth.uid())`, which **blocks** authenticated ownership
reassignment by design, per KNOWN_ISSUES #29).

---

## 3. Eligibility & cap rules (canonical)

A user may **create** a new workspace iff **all** hold (enforced server-side):

1. The caller **owns ≥1 workspace** with `plan = 'business'` AND
   `subscription_status IN ('active','trialing')`. (Proves they are a Business
   customer — this is the "must have Business to go multi" gate.)
2. Live `COUNT(*) FROM workspaces WHERE owner_id = caller` **< 10**.
3. The caller's Stripe customer has a **default payment method** (card on file).

Members of a workspace they don't own never gain creation rights from that
membership; the cap counts **owned** workspaces only.

The first workspace (onboarding) is unaffected — that path stays as-is. A brand
new user with zero workspaces is not "creating an additional workspace"; they go
through onboarding, which yields a Starter workspace. To get a second, they must
first be Business (via the existing upgrade/checkout flow on workspace #1).

---

## 4. Edge functions

### 4.1 `create-workspace` (new, `verify_jwt = true`)

Single function, two modes via request body `{ mode: 'preview' | 'confirm', name?, idempotencyKey? }`.

Shared deps: `_shared/cors.ts`, `_shared/audit.ts` (rate limit), `_shared/workspace_limits.ts`.
Uses Stripe SDK (`https://esm.sh/stripe@18.5.0`, apiVersion `2025-08-27.basil`) —
mirror `create-checkout`.

**Common preflight (both modes):**
1. CORS from origin; OPTIONS short-circuit.
2. Auth: `supabaseAdmin.auth.getUser(token)` → `user`. 401 on failure.
3. Eligibility check (rules §3.1 + §3.2). On fail return
   `{ ok:false, reason:'not_eligible'|'cap_reached', count, cap }` (200).
4. Resolve Stripe customer:
   - Prefer the `stripe_customer_id` from one of the caller's existing Business
     workspaces (authoritative, avoids email ambiguity).
   - Fallback: `stripe.customers.list({ email: user.email, limit: 1 })`.
   - If none → `{ ok:false, reason:'no_customer' }`.
5. Resolve default payment method:
   `stripe.customers.retrieve(customerId)` →
   `invoice_settings.default_payment_method`; if absent, fall back to
   `stripe.paymentMethods.list({ customer, type:'card', limit:1 })`.
   - If no card → `{ ok:false, reason:'no_card_on_file' }` (client shows
     "Add a payment method" → `customer-portal`).

**`mode: 'preview'`** (called when the dialog opens):
Returns `{ ok:true, cardLast4, cardBrand, priceMonthly: 499, count, cap, chargedToday: 499 }`
so the modal can render honest consent copy. No DB writes, no Stripe writes.

**`mode: 'confirm'`** (called on "Confirm & create"):
1. Validate `name` (non-empty, length ≤ 100, trim).
2. Re-run eligibility (do not trust the preview; state may have changed).
3. **Insert workspace** (service role → bypasses entitlement guard):
   ```ts
   workspaces.insert({ name, owner_id: user.id })   // Starter defaults via guard
   ```
   then `workspace_members.insert({ workspace_id, user_id, role:'admin',
   invited_at: now, accepted_at: now })` (mirror Onboarding).
   Write `workspace_activity_log` `created` row.
4. **Create the subscription** (off-session, no trial):
   ```ts
   stripe.subscriptions.create({
     customer: customerId,
     items: [{ price: BUSINESS_MONTHLY_PRICE_ID }],   // price_1SntqQH03PByDjY3MrvOjOsu
     default_payment_method: pmId,
     off_session: true,
     payment_behavior: 'error_if_incomplete',  // surface declines synchronously
     metadata: { workspace_id, plan_id: 'business', billing_interval: 'monthly' },
   })
   ```
   - `payment_behavior: 'error_if_incomplete'` makes a declined card throw
     synchronously (caught below) instead of leaving a dangling incomplete sub.
   - The `metadata.workspace_id` is what the **existing webhook** uses to promote
     the workspace to Business (`stripe-webhook/index.ts:92-117`,
     `customer.subscription.created`). No new webhook code.
5. **Promote synchronously as backstop** (service role): on a confirmed
   `status === 'active'` subscription, the function itself writes
   `{ plan:'business', document_limit:50, stripe_customer_id, stripe_subscription_id,
   subscription_status, billing_interval:'monthly', subscription_period_end }` to
   the workspace — identical derived state to the webhook, so the two are
   idempotent. This eliminates the "paid but still Starter" window if the webhook
   lags. Write `workspace_activity_log` `subscription_attached` row.
6. Return `{ ok:true, workspaceId, status:'active' }`.

**SCA / 3DS (`requires_action`):** if the subscription's
`latest_invoice.payment_intent.status === 'requires_action'`, return
`{ ok:false, reason:'requires_action', clientSecret, workspaceId }`. The client
confirms via Stripe.js (`stripe.confirmCardPayment(clientSecret)`); on success
the webhook promotes. The workspace row already exists (Starter) and flips to
Business when the payment completes. **If the user abandons 3DS**, a sweep
(or the `confirm` path's rollback timer) must clean up the unpaid workspace —
see §9 open item.

**Failure / rollback:** if subscription creation throws (card declined, Stripe
error) **after** the workspace insert, delete the just-created `workspaces` row
(CASCADE removes the member + activity rows) so no orphaned unpaid workspace
lingers. Return `{ ok:false, reason:'payment_failed', message }`. The client
shows the decline reason + "Update card" → `customer-portal`.

**Idempotency:** accept an `idempotencyKey` from the client and pass it as
Stripe's `idempotencyKey` on `subscriptions.create`, so a double-submit doesn't
create two subscriptions. Guard the workspace insert with the same key (e.g., a
short-lived dedupe or a unique constraint on a request id) — **build decision,
see §9.**

**Rate limit:** `enforceWorkspaceRateLimit(admin, anchorWorkspaceId,
'create-workspace', origin, 10)` — creation is rare; 10/hour is generous and
blocks abuse loops. Anchor on the caller's current workspace id.

### 4.2 `transfer-workspace-ownership` (new, `verify_jwt = true`) — Phase 3

Reassigns `workspaces.owner_id` to another member. Must be service-role because
the RLS `WITH CHECK (owner_id = auth.uid())` blocks authenticated reassignment.

1. Auth caller. Load workspace; require `caller == owner_id` (only the current
   owner may transfer). 403 otherwise.
2. Validate target: `targetUserId` must be an **accepted member** of the
   workspace (`workspace_members` row with `accepted_at IS NOT NULL`). 400 if not.
3. Service-role update: `workspaces.owner_id = targetUserId`. Ensure the target
   has an `admin` membership row (insert/promote if needed); optionally demote
   the prior owner to `admin` (keep them a member, don't strand them).
4. Write `workspace_activity_log` `owner_transferred` row
   `{ from: caller, to: targetUserId }`.
5. **Billing note (v1 limitation):** the Stripe subscription stays on the
   original owner's Stripe customer. Control transfers; billing does not. This is
   a documented v1 limitation — see §9 / surfaced to owner.

---

## 5. Webhook interaction

**No webhook code changes.** `stripe-webhook` already handles
`customer.subscription.created/updated/deleted` and promotes/downgrades the
workspace named in `subscription.metadata.workspace_id`
(`stripe-webhook/index.ts:92-117`). The `create-workspace` function sets that
metadata, so promotion (and future renewals/cancellations) flow through the
existing, signature-verified handler — the single source of truth for
entitlement state.

Per-workspace downgrade (a workspace's sub lapses → webhook sets it back to
Starter) is the existing single-workspace behavior, now applied per workspace.
No "account over limit" cleanup is needed because the cap is a **creation**
ceiling only (§1, ratified).

---

## 6. Frontend

### 6.1 Switcher (Phase 2) — `src/components/layout/AppSidebar.tsx:188-221`

- Replace the conditional static-label/dropdown with an always-present control
  when the user has ≥1 workspace.
- Each row: **initials avatar** (rounded square, color = deterministic hash of
  `workspace.id`), name, role badge, active check.
- Append a **"+ New workspace"** entry, shown only when the user is
  create-eligible (Business + under cap — derived from `availableWorkspaces`
  plan + count client-side; server re-checks).
- When `availableWorkspaces.length > 5`, the dropdown's primary action becomes
  **"Search workspaces… (⌘K)"**, opening a `cmdk` command palette
  (`src/components/ui/command.tsx`, already vendored). Palette: recent on top,
  alpha below, type-to-filter, ↑↓/Enter/Esc.
- Global **Cmd/Ctrl+K** listener (confirmed free; only existing global shortcut
  is Cmd+B → sidebar, `src/components/ui/sidebar.tsx:20`). Optional Cmd+1…9
  quick-jump (nice-to-have, not required for v1).
- Switching calls existing `switchWorkspace` (`AppContext.tsx:290-297`).

### 6.2 New-workspace dialog + confirm modal (Phase 2)

- "+ New workspace" opens a dialog: name input → on submit, call
  `create-workspace` `mode:'preview'`.
- Render the **confirmation modal** with the preview data:
  > "Create **{name}** as a Business workspace. You'll be charged **$499 today**,
  > then **$499/month**, billed to your card ending **{cardLast4}**. Each
  > workspace has its own subscription and its own monthly abstraction
  > allowance."
  Primary button: **"Confirm & create"**. Secondary: Cancel.
- On confirm → `mode:'confirm'`. Handle `requires_action` (Stripe.js 3DS),
  `no_card_on_file`/`no_customer` (→ customer-portal CTA),
  `payment_failed` (decline reason + update-card CTA), `cap_reached`/`not_eligible`.
- On success → toast, offer **"Switch to it"** vs "Stay here" (do not yank the
  user out of their current workspace involuntarily).

### 6.3 Usage row (Phase 4) — `src/pages/app/UsageContent.tsx`

Add a row: **"Workspaces — {ownedCount} of {maxWorkspaces}"** with a small meter,
reading owned count from `availableWorkspaces` (role==='owner') and
`maxWorkspaces` from the plan config. No app-wide banner.

### 6.4 Management page (Phase 3/4) — `src/pages/account/WorkspaceManagement.tsx`

- Add the primary **"+ Create workspace"** CTA (same dialog as 6.2).
- Card list → **3-up grid when owned+member count > 5**.
- Add **"Transfer ownership"** control on owned workspaces (owner-only), calling
  `transfer-workspace-ownership` with a confirm dialog naming the new owner and
  the billing-stays-with-you caveat.

---

## 7. Security model

- **Tier gate is server-side.** Eligibility (§3) is enforced in
  `create-workspace`, not just by hiding the button. A Starter user calling the
  function directly gets `not_eligible`.
- **Entitlement guard intact.** The function inserts at Starter defaults (guard
  bypassed via service_role) and lets billing state be set only through the
  confirmed-subscription path; the webhook remains the entitlement source of
  truth. No authenticated path can self-grant Business (KNOWN_ISSUES #29 stays
  closed).
- **Cap is COUNT-based and live**, not a cached column — avoids the
  `documents_used` dead-column class (KNOWN_ISSUES #31).
- **Transfer is owner-only and service-role**, preserving the
  `WITH CHECK (owner_id = auth.uid())` invariant for all other writers.
- **CORS** uses shared `_shared/cors.ts` (now `.vercel.app`-aware). New function
  must be redeployed whenever cors.ts changes (the deploy bundles a snapshot).
- **Money path** → routed through `lease-security-scanner` +
  `lease-repository-integrity-reviewer` before any deploy.

---

## 8. Audit trail

Every workspace lifecycle mutation writes a `workspace_activity_log` row from the
owning service-role function: `created`, `subscription_attached`,
`owner_transferred`, `renamed` (wire the existing rename path to log too),
`member_added`/`member_removed` (wire invite/remove paths), `deleted`
(see §9 caveat). This gives the "customer created it, every change is
attributable" contract for workspaces, matching what `lease_activity_log` does
for leases.

---

## 9. Open items / decisions to confirm during/after pressure-test

1. **Deletion durability.** `ON DELETE CASCADE` removes the `deleted` audit row
   with the workspace. Options: (a) accept (deletion logged elsewhere / in app
   logs), (b) drop the FK and keep orphan workspace_id, (c) account-level audit
   table. **Recommend (b)** for a durable deletion record. Decide in Phase 1.
2. **3DS abandonment cleanup.** If a user starts `requires_action` and never
   completes 3DS, the Starter workspace row persists unpaid. Need a sweep
   (cron) or a TTL on "pending activation" workspaces. **Recommend** a nightly
   sweep that deletes owner-created workspaces still Starter + no active sub
   after N hours. Decide in Phase 1.
3. **Idempotency mechanism** for double-submit on `confirm` (Stripe
   idempotencyKey + DB-side guard). Decide in Phase 1.
4. **Transfer billing limitation.** v1 transfers control but not the Stripe
   subscription (stays on original owner's customer). Acceptable for v1?
   Surface to owner before Phase 3.
5. **`is_workspace_member` owner coverage.** Confirm the read policy covers the
   owner (widen `USING` to include `owner_id = auth.uid()` if not).

---

## 10. Test plan (for `lease-test-author`)

- Eligibility: Starter user blocked; Business-at-cap blocked; Business-under-cap
  allowed; member (non-owner) does not get creation rights.
- Cap is live COUNT (create to 10, 11th blocked; delete one, create allowed).
- Rollback: simulated decline leaves **no** orphaned workspace.
- Promotion idempotency: function-promote + webhook-promote converge to the same
  row (no double charge, no divergent state).
- Transfer: only owner can transfer; target must be a member; owner_id changes;
  prior owner demoted to admin, not stranded; audit row written.
- Audit: every lifecycle event writes exactly one `workspace_activity_log` row
  with correct `event_type` + `details`.
- RLS: a non-member cannot read another workspace's activity log.
- Lifecycle-convention parity where applicable.

---

## 11. Subagent routing (mandatory before "complete")

- **Every phase:** `lease-code-auditor` + `lease-security-scanner`.
- **Phase 1 & 3 (data/governance/money):** add
  `lease-repository-integrity-reviewer`. Security review runs **before** `db push`
  for the migration (security-migration rule).
- **Phase 2 & 4 (UI):** add `lease-product-polish` (surface sweep + state walk:
  empty/at-cap/decline/3DS/single-workspace states).
- **All phases:** `lease-test-author` alongside.
