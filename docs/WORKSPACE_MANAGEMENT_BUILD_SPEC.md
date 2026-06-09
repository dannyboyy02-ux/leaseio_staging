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

---

# Phase 2 Addendum — Switcher UX + create flow (the user-facing layer)

**Status:** DRAFT (pre-build, pending pressure-test)
**Date:** 2026-06-09 (added after Phase 1 applied to staging)

Phase 1 built the capability layer (tables, RPC, edge functions, webhook
reconciliation) and applied it to staging; the edge-function deploys were
**held back** for a coordinated rollout with Phase 2 (no caller exists until
the UI ships and `stripe-webhook` shouldn't be redeployed alone). Phase 2
ships the user-facing surface that makes multi-workspace real, plus the
coordinated function deploys.

## P2.0 New external dependency + env

- **`@stripe/stripe-js`** (client-only) — required for `stripe.confirmCardPayment`
  in the confirmation modal, the in-app 3DS authentication step. Lightweight
  (~30KB gz), Stripe-maintained, the standard pairing for off-session-incomplete
  + on-session-confirm. Add via `npm install @stripe/stripe-js`. **No new
  bundler config.**
- **`VITE_STRIPE_PUBLISHABLE_KEY`** — new env var. **Test mode** (`pk_test_…`)
  for staging, **live mode** (`pk_live_…`) for production. Must match the
  Stripe account whose secret key the edge function uses. **Operator must set
  before Phase 2 deploy; the UI fails closed (banner "Multi-workspace
  unavailable, contact support") if the key is missing.**
- `.env.example` updated to document the name only (no value).

## P2.1 Workspace switcher (sidebar) — `src/components/layout/AppSidebar.tsx:188-221`

Upgrade the existing dropdown (it already conditionally renders for
`length > 1`) into the Slack-style affordance:

- **Always rendered** when the user is signed in (drops the
  `length > 1` conditional), because we need the "+ New workspace" entry even
  for single-workspace users. A single-workspace user with no eligibility
  sees just their workspace + the management link (no "+" CTA — see eligibility).
- **Initials avatar** (`<WorkspaceAvatar id={ws.id} name={ws.name} />`) — new
  small primitive at `src/components/workspace/WorkspaceAvatar.tsx`. Rounded
  square (`h-6 w-6` in dropdown, `h-9 w-9` in management cards), 2-letter
  initials from name (first letter of first two words, fallback first 2 chars),
  deterministic background color from a hash of `id` (palette of 8 muted
  Tailwind tones — accessible-contrast text foreground). No new column on
  `workspaces`; both inputs already exist.
- **Dropdown contents** in order: current workspace marker → other workspaces
  (alpha) → divider → **"+ New workspace"** (when eligible — see P2.4) →
  **"Manage workspaces"** (links to `/app/account/workspaces`).
- **Eligibility for "+ New workspace" entry** is computed client-side from
  `availableWorkspaces` + `workspace.plan` (the active workspace's plan
  determines the gate UX-side; the server re-checks the real plan + cap). The
  CTA is shown when the active workspace is `business` AND
  `ownedCount < maxWorkspaces`; hidden otherwise. (A Starter user never sees
  the affordance; a Business user at cap sees "Workspace limit reached" as a
  disabled entry that opens the management page on click.)
- **Past 5 workspaces → command palette.** When `availableWorkspaces.length > 5`,
  the dropdown's first row becomes **"Search workspaces… (⌘K)"**; clicking it
  (or pressing Cmd/Ctrl+K anywhere in the app) opens a `cmdk` palette
  (`src/components/ui/command.tsx`, vendored) with type-to-filter, ↑↓/Enter/Esc,
  and the same "+ New workspace" entry pinned at the bottom. Recent workspaces
  (last 3 switched-to, tracked client-side in `localStorage` under
  `lease:recentWorkspaces`) appear above the alphabetical list.
- **Global Cmd/Ctrl+K listener** — registered in `AppLayout.tsx` (one
  listener, scoped to authenticated routes). Confirmed free of conflicts (only
  global binding today is Cmd+B → sidebar toggle, `sidebar.tsx:20`). Does NOT
  fire while a `Dialog`/`Sheet` is open (palette is suppressed when any other
  modal is open, so it doesn't compete with form input).
- **Switch action** uses existing `switchWorkspace` (`AppContext.tsx:290-297`).
  No optimistic update — the existing full re-fetch is acceptable for a rare
  action and avoids stale React Query state across workspaces.

## P2.2 New-workspace dialog — `src/components/workspace/NewWorkspaceDialog.tsx` (new)

Two-step modal. **Step 1 (name):** simple input, max 100 chars, trimmed
client-side, Submit calls `create-workspace` `mode:'preview'`. Errors
(`no_card_on_file` → "Add a payment method" linking to `customer-portal`;
`no_customer` → same; `not_eligible` → quiet error; `cap_reached` → cap
copy) replace step 2 with the appropriate message. **Step 2 (consent):**
the confirmation modal — see P2.3.

Lives in `src/components/workspace/`. Opened from (a) the sidebar
"+ New workspace" entry, (b) the management page CTA (Phase 4), (c) the Cmd+K
palette's "+ New workspace" item.

## P2.3 Confirmation modal — the money path UX

This is the highest-stakes screen of the feature. Copy is final, not
suggested:

> ### Create **{name}**
> Business workspaces have their own subscriptions.
> 
> - You'll be charged **$499 today** to start.
> - **$499/month** going forward, billed to **{cardBrand} •••• {cardLast4}**.
> - This workspace gets its own monthly abstraction allowance — it does NOT
>   share with your other workspaces.
> 
> [ Cancel ] [ **Confirm & create** ]

Behavior on **Confirm & create**:
1. Generate an `idempotencyKey` **once at modal open** (stable client UUID,
   stored in component state). Reused for every retry within the same dialog
   instance. **Never regenerated per click** (CRIT pressure-test).
2. Disable both buttons; spinner on the primary; the modal becomes
   non-dismissable for the rest of the flow (no Esc, no overlay-click) to
   avoid orphaning a pending workspace + sub.
3. Call `create-workspace` `mode:'confirm'` with `{ name, idempotencyKey }`.
4. On `ok:false`:
   - `cap_reached` / `not_eligible` → swap modal content to copy + "Manage
     workspaces" link, close button reappears.
   - `payment_failed` / `stripe_error` → swap to decline copy with
     the Stripe message + "Update card" link to `customer-portal`. Server has
     already rolled back the workspace.
   - `bad_request` / `invalid_name` → return to step 1 with the input focused.
5. On `ok:true`:
   - If `paymentIntentStatus === 'succeeded'` or `'requires_capture'` →
     proceed to "Activating…" (step 6).
   - Else (`requires_action` or `requires_confirmation`) → call
     `stripe.confirmCardPayment(clientSecret, { payment_method: undefined })`
     via `@stripe/stripe-js`. This is the in-app 3DS step (the modal IS the
     on-session context). If `confirmCardPayment` resolves with no error and
     `paymentIntent.status === 'succeeded'` → "Activating…". If it errors
     (user cancels 3DS, wrong code, etc.) → call `create-workspace`
     `mode:'cancel'` with the returned `workspaceId` to clean up, then surface
     the Stripe error + "Try again" / "Use a different card" CTA.
6. **"Activating…" state.** The webhook is what actually flips the workspace
   to Business. UI polls `workspaces.subscription_status` via the existing
   `AppContext.fetchProfile()` (triggered every 2s via a `setInterval` until
   the active workspace shows Business, max 30s). On success → toast
   ("Workspace {name} is ready") + two CTAs: **Switch to it** /
   **Stay here**. (Do not switch involuntarily — pressure-test §6.2.) On 30s
   timeout → "Activation taking longer than usual — refresh the page in a
   minute" + close (the workspace IS active in Stripe; webhook just lagged.
   This is a known-acceptable corner case.)

Modal accessibility: focus trap, labeled inputs, primary button is the
default-Enter target, secondary cancel is Esc target (except during steps 4-6
where Esc is suppressed).

## P2.4 Stripe client wiring — `src/lib/stripe.ts` (new)

Tiny module: lazy `loadStripe(VITE_STRIPE_PUBLISHABLE_KEY)` on first call,
caches the Promise, exports `getStripe()`. If `VITE_STRIPE_PUBLISHABLE_KEY`
is missing, `getStripe()` returns `null` and the dialog surfaces a "Multi-
workspace temporarily unavailable" error (fail closed).

## P2.5 Coordinated edge-function deploys (Phase 1 carry-over)

Held back from Phase 1 by design. Deploy together at the end of Phase 2,
**after the UI is reviewed clean and merged**, in this order:
1. `stripe-webhook` (carries the reconciliation block — additive, never breaks
   the existing path).
2. `create-workspace` (new).
3. `sweep-pending-workspaces` (new; not yet wired to a cron schedule — that's
   the operator's last step, see P2.7).

All three use the shared `_shared/cors.ts` (`.vercel.app`-aware), so they
inherit the suffix-fix from the prior CORS commit.

## P2.6 Operator setup checklist (added to `docs/ops/OPERATOR_PLAYBOOK.md`)

Before Phase 2 is "shippable to a customer":
1. Set `VITE_STRIPE_PUBLISHABLE_KEY` in Vercel (test+live).
2. Set `SWEEP_PENDING_WORKSPACES_CRON_SECRET` (32+ char random) as a Supabase
   secret + matching `private.cron_secrets` row.
3. Schedule the cron: `SELECT cron.schedule('sweep-pending-workspaces',
   '17 * * * *', $$SELECT net.http_post(...)$$);` (mirror the existing cron
   pattern — exact SQL in playbook).
4. **Live-mode Stripe webhook destination** — already an outstanding ops item
   per CLAUDE.md; this feature inherits the dependency. Webhook must include
   `customer.subscription.created/updated/deleted` (already required for
   single-workspace billing).

## P2.7 What Phase 2 explicitly does NOT do

- Owner transfer UI (Phase 3).
- Settings → Usage row (Phase 4).
- Rename / member-event client-side logging (Phase 4).
- 3-up grid on management page (Phase 4).
- Spanish translation (Phase 4).

## P2.8 Test plan (`lease-test-author`)

- Eligibility-shown matrix: Starter / Business-under-cap / Business-at-cap /
  Business-no-card — each renders the right entry (visible/disabled/hidden).
- Switcher: >1 / ≤5 / >5 workspaces — dropdown vs palette.
- Cmd+K opens palette; suppressed while a Dialog is open; alpha + recent
  ordering; Esc closes.
- Confirmation modal: idempotency key stable across retries, disabled during
  in-flight, all error branches render correct copy.
- 3DS: simulate `requires_action` → confirmCardPayment success → Activating →
  Switch to it; simulate 3DS user-cancel → cancel mode called → workspace
  cleaned up.
- Activation polling: webhook arrives within 30s → success; webhook timeout →
  "taking longer" copy.
- Initials avatar: deterministic color per id; 1-word names; emoji-only
  names; very long names truncate cleanly.

## P2.9 Subagent routing
- `lease-code-auditor` + `lease-security-scanner` always-on.
- `lease-product-polish` — state-walk on the confirmation modal (10 states:
  step1 / step1-error / step2 / step2-confirming / 3DS-in-progress /
  3DS-error / activating / activated-success / activation-timeout / cap-reached);
  surface sweep on the sidebar (1, 2-5, 6+ workspaces; Starter, Business,
  no-card states).
- `lease-test-author` for the test plan.
- No `lease-repository-integrity-reviewer` for Phase 2 (no schema or
  audit-shape changes; data layer was Phase 1's lane).

## P2.10 Open items to confirm during pressure-test
1. **Test-mode key in staging** — confirm the staging Stripe account is in test
   mode so I can validate the full flow without real money.
2. **3DS test cards** — Stripe's `4000 0025 0000 3155` (3DS required) and
   `4000 0027 6000 3184` (3DS optional/insufficient funds) — these need to be
   on the owner's customer in test mode to exercise the path.
3. **Cron schedule cadence** — once an hour matches the 2h cutoff with margin;
   confirm.

## P2.11 Changelog v2 → v3 (Phase 2 pressure-test)
Two pressure-tests (lease-product-polish + lease-security-scanner) folded in:

- **HIGH (sec)** activation polling target — `fetchProfile()` cannot observe
  `subscription_status` on the new workspace; `availableWorkspaces` selects
  only `id/name/plan`. **Fix:** narrow query on `workspaces.id =
  newWorkspaceId` selecting `id, plan, subscription_status`, polled until
  Business+active or 30s timeout, then a final `fetchProfile()` to refresh
  state. Mandatory `useEffect` cleanup + AbortController on the poll.
- **HIGH (polish)** "+ New workspace" eligibility was gated on the ACTIVE
  workspace's plan, stranding a Business owner viewing one of their Starter
  workspaces. **Fix:** eligibility is "user owns any Business workspace with
  an active sub, AND ownedCount < cap." Derived from `availableWorkspaces`
  client-side (server re-checks).
- **HIGH (polish)** no pre-click cost disclosure. **Fix:** sidebar entry label
  is "**+ New workspace · $499/mo**" (or "+ New workspace (Workspace limit
  reached)" when at cap). Same disclosure in the Cmd+K palette entry and the
  management-page CTA.
- **HIGH (sec)** `clientSecret` hygiene unspecified. **Fix:** spec mandates
  (a) the dialog NEVER logs the `create-workspace` response body, (b) global
  Sentry `beforeSend` scrub for `client_secret` and `pi_*_secret_*` patterns
  (note: Sentry not yet wired per CLAUDE.md but rule lands now), (c) the
  React `useState` holding the secret is set to `null` immediately after
  `confirmCardPayment` resolves, (d) the secret is never put in URL/router
  state, (e) idempotencyKey lives in a `useRef` initialized in the modal-open
  effect — **not** localStorage / sessionStorage.
- **HIGH (sec)** 3DS network-fail or tab-close → workspace orphans + leaked
  `clientSecret` could be completed out-of-band. **Fix:** (1) on
  `confirmCardPayment` error, the client calls
  `stripe.retrievePaymentIntent(clientSecret)` first; if `succeeded`,
  treat as paid (proceed to Activating) — do NOT call cancel; only call
  cancel when status is `requires_payment_method` / `requires_action`
  un-completed. (2) The sidebar switcher visibly marks any pending-creation
  workspace (`workspace_creation_requests.status='pending'` + active workspace
  shows `plan='starter'`) with a "Resume setup" affordance opening the
  modal in a recovery mode that re-fetches the existing PaymentIntent via the
  preview endpoint.
- **HIGH (polish)** "Activation taking longer than usual" copy lies in one
  branch. **Fix:** branch-aware copy. If PaymentIntent is `succeeded` on
  Stripe and the 30s timeout fires, copy is "Your workspace is paid — we're
  finishing setup. Refresh in a minute or check **Manage workspaces**." If PI
  isn't succeeded, copy is "Setup is taking longer than expected. You'll get
  an email when it's ready, or contact support." The client uses
  `retrievePaymentIntent` once at timeout to decide which copy.
- **HIGH (sec)** publishable-key prefix assertion. **Fix:**
  `src/lib/stripe.ts` asserts `MODE === 'production'` ⇒ key starts with
  `pk_live_`; non-prod ⇒ `pk_test_`. Fail closed with the same
  "Multi-workspace temporarily unavailable" banner. CI build also rejects
  prefix mismatch.
- **MED (polish + sec)** Cmd+K suppression covers `Dialog` AND `Sheet`;
  >5-workspace dropdown still renders the active workspace + last 3 recent +
  top 3 alpha + Search affordance (not just the search row); on mobile (no
  Cmd key), the "Search workspaces…" dropdown row is itself tappable and
  opens the palette. The palette ignores Cmd+K when focus is in an input
  (let the input handle the keystroke).
- **MED (polish)** "Switch to it" is the default-Enter primary post-success;
  "Stay here" is secondary. **No auto-switch** — the polish review's 5s
  auto-switch is rejected as it's confusing; explicit click is the cleaner
  pattern.
- **MED (polish)** decline copy must explicitly state "**No charge was made
  to your card**" as a mandatory line above the Stripe-provided decline
  reason.
- **MED (polish)** `no_card_on_file` copy must not blame the user: "We
  couldn't find a saved card — add one to continue" + portal link.
- **MED (sec)** activation polling target is a NARROW query on the new
  `workspaceId` (see HIGH-sec #1) with `select('id, plan,
  subscription_status').eq('id', newWorkspaceId).maybeSingle()`. RLS allows
  the owner to read; the existing entitlement update writes plan +
  subscription_status atomically (`stripe-webhook` line 103-114), so a
  single field read is sufficient. Stop polling on (a) Business+active,
  (b) 30s timeout, or (c) component unmount via `AbortController` +
  `clearInterval`.
- **MED (sec)** `pg_cron` schedule uses the `private.cron_secrets` pattern
  (matching `vendor-health-check`), NOT the inline-secret-literal pattern.
  The playbook snippet is updated accordingly.
- **MED (sec)** webhook reconciliation block must be defensive about the
  Phase 1 tables existing in the env it's deployed to. The current code
  already wraps in `try/catch` (non-fatal) so a missing table just logs and
  skips — verified. Spec adds: confirm Phase 1 migration applied to every
  env before the webhook redeploy.
- **LOW (polish)** "Workspace limit reached" entry is enabled + relabeled
  "Manage workspaces (at limit)" — no disabled-but-clickable trap.
- **LOW (polish)** recent-workspaces in the palette appear only when
  `availableWorkspaces.length >= 5` (otherwise noise).
- **LOW (polish + sec)** i18n keys from day one in
  `src/locales/en/common.json` (Spanish file untouched until Phase 4) —
  do NOT hardcode strings. Cleared with CLAUDE.md "locales updated
  together" rule by deferring only the ES additions.
- **LOW (sec)** `localStorage` for recent workspaces is cleared on logout
  in `AuthContext`.
- **LOW (sec)** `VITE_STRIPE_PUBLISHABLE_KEY` added to `.env.example` as
  part of the Phase 2 PR (not a follow-up).
- **LOW (polish)** "$499 today" — US-only acknowledged; tax/total deferred.

## P2.12 Phase 2 Build Order (post-pressure-test)

1. `package.json` + `.env.example` + `src/lib/stripe.ts` (publishable key
   loader + prefix assertion).
2. `src/components/workspace/WorkspaceAvatar.tsx` (initials + deterministic
   color).
3. `src/components/workspace/NewWorkspaceDialog.tsx` (name step + confirm
   modal + 3DS handling + activation polling + all error branches +
   i18n-keyed copy).
4. `src/components/layout/AppSidebar.tsx` — upgrade the switcher
   (always-render, avatars, "+" entry with `· $499/mo`, palette trigger).
5. `src/components/layout/AppLayout.tsx` — global Cmd+K listener
   (Dialog/Sheet/input suppression).
6. `src/components/workspace/WorkspaceCommandPalette.tsx` (new) — the cmdk
   wrapper with recent + alpha + search.
7. `src/contexts/AuthContext.tsx` — clear `lease:recentWorkspaces` on
   logout.
8. i18n keys in `src/locales/en/common.json`.
9. Coordinated edge-function deploys: `stripe-webhook` → `create-workspace`
   → `sweep-pending-workspaces`.
10. Reviewer pass (auditor + security + polish + test-author) BEFORE merging
    to main and BEFORE the cron is scheduled (operator step in playbook).

