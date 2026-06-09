# Workspace Management Build Spec — Multi-Workspace for Business

**Status:** v2 (post-pressure-test, ready to build)
**Date:** 2026-06-09
**Owner decisions ratified in-session 2026-06-09. Pressure-tested by
lease-security-scanner, lease-repository-integrity-reviewer, and a Stripe-billing
design pass; all CRITICAL/HIGH findings folded in (changelog at §12).**

---

## 0. Summary

Today a LeaseIO user gets exactly one workspace, created once during onboarding
(`src/pages/app/Onboarding.tsx:51-145`). There is **no UI to create a second
workspace** and no tier gate, because no second-creation path exists.

This adds **owner-level multi-workspace ownership for Business customers**: a
Business account holder can own up to **10** workspaces, each its own Business
subscription billed to the card on file, created through an **explicit in-app
confirmation modal**. It adds a Slack-style switcher, an ownership-transfer flow,
a per-workspace audit log, and a usage row in Settings.

Ships **ahead of and independent from** the firm layer (Phase 9/10): `owner_id`
fan-out, **no `firm_id`, no grouping entity** (honors the CLAUDE.md hard rule).

### Ratified decisions

| Topic | Decision |
|---|---|
| Tiers | Starter + Business only (no Pro) |
| Multi-workspace | Business-only, owner-level, **max 10**, cap is **owner-only** |
| Billing | Each additional workspace = its own **$499/mo** Business subscription on the owner's existing Stripe customer. **No trial, no proration.** |
| Consent | **In-app confirmation modal** (price + card last4 + "charged today"); explicit "Confirm & create". |
| Payment model | **On-session** `default_incomplete` + client-side `confirmCardPayment` (the only model where 3DS works in-app). |
| Entitlement writer | **`stripe-webhook` only** (single source of truth). The create function never writes entitlement columns. |
| Switcher | Slack-style "Option B": sidebar dropdown → Cmd+K palette past 5; initials avatar, deterministic color from id |
| Owner transfer | v1: single transferable owner; co-owners deferred |
| Quota visibility | Settings → Usage only (`UsageContent.tsx`). No app-wide banner. |
| Audit | New `workspace_activity_log`; deletions reuse existing `deleted_workspaces` |
| Strategy doc | +1 line: owner-level multi-workspace ships ahead of the firm layer |

---

## 1. Scope & phasing

- **Phase 1 — Capability (server + schema).** Migrations (`workspace_activity_log`,
  `workspace_creation_requests`, `maxWorkspaces` config), `create-workspace` edge
  function (preview/confirm/cancel), abandonment sweep, audit writes. **Build first.**
- **Phase 2 — Switcher UX.** Sidebar dropdown → Cmd+K palette, initials, the
  new-workspace dialog + confirmation modal + `confirmCardPayment` wiring.
- **Phase 3 — Ownership transfer.** `transfer-workspace-ownership` + UI.
- **Phase 4 — Polish.** Usage row, management-page grid (>5), copy/i18n.

---

## 2. Data model

### 2.1 New table: `workspace_activity_log`

Workspace-lifecycle audit. There is **no** workspace-level event log today
(`lease_activity_log` is lease-scoped).

```sql
CREATE TABLE IF NOT EXISTS public.workspace_activity_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type   text NOT NULL,   -- created | activated | renamed | owner_transferred | member_added | member_removed
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_log_workspace_id
  ON public.workspace_activity_log (workspace_id, created_at DESC);

ALTER TABLE public.workspace_activity_log ENABLE ROW LEVEL SECURITY;

-- Read: any member (is_workspace_member covers the owner — baseline:386-401,
-- verified by review; do NOT add a redundant owner_id OR-branch).
CREATE POLICY "Members read workspace activity"
  ON public.workspace_activity_log FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Write (authenticated): constrained, mirrors lease_activity_log's existing
-- INSERT policy (baseline:3811). Lets the CLIENT-SIDE lifecycle writers
-- (rename, member add/remove from MembersPanel) log directly. Service-role
-- functions (create/transfer/sweep) also write, bypassing RLS.
CREATE POLICY "Members insert workspace activity"
  ON public.workspace_activity_log FOR INSERT
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND user_id = auth.uid()
  );
-- No UPDATE/DELETE policy → authenticated edits/deletes denied (append-only).
```

**`event_type` has no `deleted`** — deletion is recorded in the existing durable
`deleted_workspaces` table (baseline:931), written by `delete-workspace` BEFORE
the cascade. A `deleted` row here would cascade away with the workspace, so we
deliberately do not write one. (Resolves v1 §9.1; the FK-drop idea is dropped —
it would create an unreadable orphan.)

### 2.2 New table: `workspace_creation_requests` (idempotency guard)

Prevents double-submit from creating two workspaces / two $499 charges
(CRITICAL). The dedupe row is the **first write** in `confirm`; a duplicate key
short-circuits before any workspace insert or Stripe call.

```sql
CREATE TABLE IF NOT EXISTS public.workspace_creation_requests (
  idempotency_key text PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | active | failed | canceled
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.workspace_creation_requests ENABLE ROW LEVEL SECURITY;
-- Service-role only; no authenticated policy (the function reads/writes it).
```

### 2.3 Config: `maxWorkspaces`

`src/config/pricing.ts`: add `maxWorkspaces` to `PlanConfig` + both plans
(starter: 1, business: 10). Mirror in a new
`supabase/functions/_shared/workspace_limits.ts`:

```ts
export const WORKSPACE_LIMITS: Record<string, number> = { starter: 1, business: 10 };
```

### 2.4 No new columns on `workspaces`

Avatar color = deterministic hash of `id` at render; initials from `name`.
`owner_id` reassignment (transfer) uses the existing column via a service-role
function (§4.2).

---

## 3. Eligibility & cap rules (canonical, enforced server-side under lock)

A user may **create** a workspace iff ALL hold, evaluated **inside a
`pg_advisory_xact_lock(hashtext(owner_id::text))`** so concurrent confirms can't
race past the cap (MEDIUM TOCTOU fix):

1. Caller **owns ≥1 workspace** with `plan='business'` AND
   `subscription_status IN ('active','trialing')`. (The "must be Business" gate.)
2. Live `COUNT(*) FROM workspaces WHERE owner_id = caller` **< 10**.
3. Caller's Stripe customer has a **default payment method** (card on file).

Members never gain creation rights; the cap counts **owned** workspaces only.
A briefly-pending (created-but-not-yet-paid) workspace **does** count toward the
cap and is cleaned up by §4.3 if abandoned.

---

## 4. Edge functions

### 4.1 `create-workspace` (new, `verify_jwt = true`)

Modes via body `{ mode: 'preview'|'confirm'|'cancel', name?, idempotencyKey?, workspaceId? }`.
Deps: `_shared/cors.ts`, `_shared/audit.ts`, `_shared/workspace_limits.ts`,
Stripe SDK (`stripe@18.5.0`, apiVersion `2025-08-27.basil`).

**Preflight (preview/confirm):** CORS+OPTIONS; auth `getUser`; resolve Stripe
customer (prefer an existing Business workspace's `stripe_customer_id`, fallback
`customers.list({email})`); resolve default PM
(`invoice_settings.default_payment_method` → fallback `paymentMethods.list`).

**`mode:'preview'`** — returns `{ ok, cardLast4, cardBrand, priceMonthly:499,
chargedToday:499, count, cap }` (or `reason:'no_card_on_file'|'no_customer'|
'not_eligible'|'cap_reached'`). No writes.

**`mode:'confirm'`** — ordered exactly:
1. Validate `name` (trim, 1–100 chars) and `idempotencyKey` (client-generated
   **once at modal open**, reused across retries — never regenerated per click).
2. `pg_advisory_xact_lock(hashtext(user.id))`.
3. **Idempotency guard (FIRST write):** `INSERT INTO workspace_creation_requests
   (idempotency_key, owner_id) VALUES (...)`. On unique conflict → load the prior
   row; if it already has a `workspace_id`, return that (with its
   `clientSecret` re-fetched if still pending) and do nothing else.
4. Re-check eligibility §3.1–§3.3 (under lock; do not trust preview).
5. **Insert workspace** (service role → guard bypass; Starter defaults) + member
   row **mirroring Onboarding exactly** (`role:'admin', invited_at:now,
   accepted_at:now`). **Do NOT set `profiles.current_workspace_id`** (don't yank
   the user out of their current workspace; §6.2). Update the dedupe row with
   `workspace_id`. Write `workspace_activity_log` `created`
   `details:{ idempotency_key }` (correlation id).
6. **Create subscription — ON-SESSION, no trial, no anchor:**
   ```ts
   stripe.subscriptions.create({
     customer: customerId,
     items: [{ price: BUSINESS_MONTHLY_PRICE_ID }],   // price_1SntqQH03PByDjY3MrvOjOsu
     default_payment_method: pmId,
     payment_behavior: 'default_incomplete',
     payment_settings: { save_default_payment_method: 'on_subscription' },
     expand: ['latest_invoice.payment_intent'],
     metadata: { workspace_id, plan_id: 'business', billing_interval: 'monthly' },
   }, { idempotencyKey })   // Stripe-level dedupe (necessary, not sufficient)
   ```
   - **On-session** (NOT `off_session`) is mandatory: it's the only model where a
     3DS card yields a completable `requires_action` PaymentIntent instead of a
     hard `authentication_required` decline (CRITICAL fix). The customer IS
     present — they clicked Confirm.
   - **No `trial_period_days`** (intentional divergence from `create-checkout`,
     which always trials — do not "fix" by re-adding; trials here = free-week
     farming via create/delete).
   - **No `billing_cycle_anchor`** (adding it would introduce proration; "$499
     today" stays honest only without it).
7. Return `{ ok:true, workspaceId, clientSecret:
   latest_invoice.payment_intent.client_secret, status:'pending' }`.
   **The function does NOT promote the workspace** (no entitlement write) — the
   sub is `incomplete` until the client confirms payment. Single writer = webhook.
8. On a thrown Stripe **API error** before/at create (not a decline — declines
   surface client-side under `default_incomplete`): delete the workspace
   (cascade), mark dedupe row `failed`, return `{ ok:false,
   reason:'stripe_error', message }`.

**Client (Phase 2)** calls `stripe.confirmCardPayment(clientSecret,
{ payment_method: pmId })`. No-SCA cards confirm instantly; SCA cards show the
3DS modal. On success → `customer.subscription.updated`(active) → **webhook**
promotes the workspace to Business (§5). UI shows "Activating…" then refetches.

**`mode:'cancel'`** (client calls on decline / user cancel / 3DS dismissed):
verify the `workspaceId` is owned by caller, still Starter, sub still incomplete;
cancel the incomplete subscription; delete the workspace (cascade); mark dedupe
row `canceled`. This handles the common decline case immediately; §4.3 is the
backstop for true abandonment (browser closed).

**Rate limit:** `enforceWorkspaceRateLimit(admin, callerCurrentWorkspaceId,
'create-workspace', origin, 10)` — anchored on the caller's CURRENT workspace
(the new one doesn't exist at preflight).

### 4.2 `transfer-workspace-ownership` (new, `verify_jwt = true`) — Phase 3

Service-role (the `WITH CHECK (owner_id = auth.uid())` policy blocks
authenticated reassignment — KNOWN_ISSUES #29).
1. Auth; load workspace; require `caller == owner_id` (403 else).
2. Validate target: a row in `workspace_members` with
   `user_id = targetUserId AND user_id IS NOT NULL AND accepted_at IS NOT NULL`
   (excludes invited-but-unaccepted NULL-user_id rows). `targetUserId` must be a
   valid UUID. 400 otherwise.
3. Service-role: set `workspaces.owner_id = targetUserId`; ensure target has an
   `admin` member row; **mandatorily demote** the prior owner to `admin` (keep
   them a member — never strand them).
4. Log `owner_transferred` with
   `details:{ from, to, prior_owner_new_role:'admin',
   billing_remains_on_customer:<stripe_customer_id>, billing_transferred:false }`
   — makes prior state AND the control/billing split recoverable from one row.
5. **v1 limitation (surfaced to owner):** the Stripe subscription stays on the
   original owner's customer; control transfers, billing does not.

### 4.3 Abandonment sweep (cron, Phase 1 — **blocking, not optional**)

Nightly: delete owner-created workspaces still at `plan='starter'` with no
`active|trialing` subscription, whose `workspace_creation_requests` row is
`pending` older than 2 hours (Stripe auto-expires the `incomplete` sub to
`incomplete_expired` ~23h; we don't wait that long). Route deletions through the
existing `delete-workspace` logic so `deleted_workspaces` is written; stamp
`details:{ reason:'pending_activation_sweep' }` and a system actor sentinel so
swept deletions are distinguishable from user deletions (LOW fix). Mark the
dedupe row `canceled`.

---

## 5. Webhook interaction (no code change; one verification)

`stripe-webhook` already promotes/downgrades the workspace in
`subscription.metadata.workspace_id` on `customer.subscription.created/updated/
deleted` (`index.ts:92-117`), deriving `entitled = status IN(active,trialing)`.
The create flow sets that metadata; promotion flows through the existing,
signature-verified handler — **the single entitlement writer.** The create
function deliberately does **not** write entitlement columns (drops v1's
dual-writer divergence hazard).

**Renewal failure:** a month-2 decline → Stripe sets the sub `past_due` →
`customer.subscription.updated` fires → webhook's `entitled` is false →
downgrades to Starter. This rides `subscription.updated`, **not**
`invoice.payment_failed` (which the webhook doesn't handle). **Operator
verification item:** confirm Stripe dunning marks the sub `past_due`/`canceled`
rather than retrying silently while `active`, else a failing renewal keeps
Business access. (Add `invoice.payment_failed` handling later if dunning can't
guarantee this.)

---

## 6. Frontend (Phases 2 & 4)

### 6.1 Switcher — `src/components/layout/AppSidebar.tsx:188-221`
Initials avatar (deterministic color from `id`), name, role badge, active check;
**"+ New workspace"** entry when create-eligible; **Cmd+K command palette**
(`src/components/ui/command.tsx`, vendored) when `availableWorkspaces.length > 5`;
global Cmd/Ctrl+K (free — only Cmd+B is bound, `sidebar.tsx:20`). Switch via
existing `switchWorkspace` (`AppContext.tsx:290-297`).

### 6.2 New-workspace dialog + confirmation modal
Name → `mode:'preview'` → modal:
> "Create **{name}** as a Business workspace — **$499 today**, then **$499/month**,
> billed to your card ending **{cardLast4}**. Each workspace has its own
> subscription and monthly abstraction allowance."

"Confirm & create" → `mode:'confirm'` → `confirmCardPayment(clientSecret)`
(handles 3DS) → poll/refetch until plan flips to Business ("Activating…").
Handle `no_card_on_file`/`no_customer` (→ `customer-portal`), decline (reason +
update-card CTA + `mode:'cancel'`), `cap_reached`/`not_eligible`. On success →
toast + "Switch to it" vs "Stay here" (don't switch involuntarily).

### 6.3 Usage row — `src/pages/app/UsageContent.tsx`
"Workspaces — {ownedCount} of {maxWorkspaces}" + meter, from `availableWorkspaces`
(role==='owner') + plan config. No app-wide banner.

### 6.4 Management page — `src/pages/account/WorkspaceManagement.tsx`
"+ Create workspace" CTA; 3-up grid when owned+member > 5; "Transfer ownership"
(owner-only) with a confirm dialog naming the new owner + the billing-stays
caveat.

### 6.5 Client-side audit writes
Wire the existing client lifecycle writers to log via the new authenticated
INSERT policy: rename (`RenameWorkspaceInline.tsx:61`) → `renamed`
`details:{ from_name, to_name }`; member remove (`MembersPanel.tsx:116`) →
`member_removed`; role change (`MembersPanel.tsx:287`) → `member_added`/role
event. (Resolves the CRITICAL writer-model contradiction: these are client
writes, now permitted by the constrained INSERT policy.)

---

## 7. Security model
- Tier gate server-side (§3), under advisory lock; UI hiding is cosmetic only.
- Entitlement guard intact; create inserts at Starter defaults; **only the
  webhook** writes Business state → KNOWN_ISSUES #29 stays closed; no self-grant.
- Cap is live COUNT under lock (avoids `documents_used` dead-column class, #31).
- Transfer owner-only + service-role; target must be an accepted member.
- Idempotency: stable client key + DB unique guard (first write) + Stripe key.
- New functions use shared `_shared/cors.ts` (`.vercel.app`-aware); redeploy on
  any cors.ts change.

## 8. Audit trail
Service-role functions log `created`, `activated` (optional, if we choose to
mirror the webhook promote into a log row — webhook would need to write it),
`owner_transferred`; client writers log `renamed`, `member_*` via the
constrained policy. Every mutating event records before→after in `details`
(mirrors the lifecycle-convention spirit) + the creation correlation id.
Deletions → `deleted_workspaces` (existing).

## 9. Resolved (was "open items" in v1)
1. Deletion durability → **`deleted_workspaces`** (exists); no FK-drop.
2. 3DS abandonment → `mode:'cancel'` + **committed** sweep (§4.3).
3. Idempotency → `workspace_creation_requests` unique guard + stable key (§2.2/§4.1).
4. Transfer billing limitation → recorded in `details`; surfaced to owner.
5. `is_workspace_member` owner coverage → **confirmed** (baseline:395-400); no change.

## 10. Test plan (`lease-test-author`)
Eligibility (Starter blocked / at-cap blocked / member no rights); cap live +
**race** (parallel confirms can't exceed 10 — the advisory lock); idempotency
(double-submit → one workspace, one charge); decline → no orphan (`cancel` +
sweep); **no synchronous promote** (workspace reaches Business only via webhook
after confirmed payment); transfer (owner-only, accepted-member target, prior
owner demoted not stranded, billing split logged); audit completeness incl.
client-side rename/member events; RLS (non-member can't read activity).

## 11. Subagent routing
Every phase: `lease-code-auditor` + `lease-security-scanner` + `lease-test-author`.
Phase 1 & 3 (data/money/governance): + `lease-repository-integrity-reviewer`;
security review **before `db push`** for migrations. Phase 2 & 4 (UI): +
`lease-product-polish` (state walk: at-cap / decline / 3DS / single-workspace /
activating).

## 12. Changelog v1 → v2 (pressure-test)
- **CRIT** off_session→**on-session `default_incomplete`** (3DS reachable).
- **CRIT** added `workspace_creation_requests` DB idempotency guard (first write).
- **CRIT** added authenticated INSERT policy so client-side rename/member events
  can be logged (table was service-role-write-only vs client writers).
- **HIGH** dropped the synchronous promote → webhook is sole entitlement writer.
- **HIGH** abandonment sweep promoted to a blocking Phase-1 deliverable + `cancel` mode.
- **HIGH** deletions reuse existing `deleted_workspaces`; FK-drop idea removed.
- **HIGH** documented renewal-failure path + dunning verification item.
- **MED** advisory lock around count+insert (cap TOCTOU).
- **MED** transfer: mandatory demotion + billing-split recorded in `details`.
- **MED/LOW** correlation id in `details`; rename before/after; transfer
  NULL-user_id guard; sweep actor sentinel.
- Removed v1 §9.5 (owner coverage) — confirmed non-issue.
