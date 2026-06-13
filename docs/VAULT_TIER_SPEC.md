# Vault Tier — Build Spec (retention / data-only)

Ratified 2026-06-12 (PRODUCT_STRATEGY.md Decision 5 — read that first; it holds
the rationale and the eight ratified decisions). Status: **scoped, not started.**

## One paragraph

Vault is a $249/year, owner-only, read-only repository state for workspaces
that would otherwise cancel and purge. Offered only as an offramp (cancel
dialog, grace banner, grace reminder emails) — never on the public pricing
page. Flatten entitlements: view + export everything the workspace has.
Lapsed Vault feeds the existing cancellation lifecycle unchanged.

## Build outline (sequenced)

### V1 — Server-side read-only enforcement (KNOWN_ISSUES #75 — BLOCKER)
The foundation, and it hardens the existing grace window for free.
- `is_workspace_live(workspace_id)` SQL helper: false when `plan = 'vault'`
  OR `canceled_at IS NOT NULL` OR `soft_deleted_at IS NOT NULL`.
- Fold into write-side RLS policies / mutating edge functions (leases,
  rent_schedules, risks, approval chain actions, invites, uploads).
  **Security migration — reviewer routing BEFORE db push, expect 3+ rounds.**
- Read + export paths stay open; `transfer-workspace-ownership` stays open.

**As-built (2026-06-13):** migration `20260613000000_vault_v1_readonly_enforcement.sql`
(restrictive RLS over 23 tables + storage.objects; `is_workspace_live` /
`is_lease_live` helpers) + `_shared/workspace_live.ts` gates across all
user-invokable mutators, liveness skips in the crons, and full-liveness
backstops in `process_lease`/`retry_lease`/`manage-document-pack`. Three
review rounds (security + integrity), both APPROVED. **Accepted residuals:**
(a) DELETE is a silent zero-row no-op (no DELETE WITH CHECK in Postgres) —
documented in the migration header; (b) `resolve-approval-chain`'s frozen
pre-Phase-7 deployment is un-gateable while its redeploy stays deferred —
KNOWN_ISSUES #84, the one knowingly open mutator; (c) unreferenced
`leases`/`executed-leases` storage objects stay writable (storage spend
only). Owner workspace hard-DELETE forensics gap filed as #83 (pre-existing,
cross-referenced for Vault).

### V2 — Plan plumbing
- `SubscriptionPlan` → `'starter' | 'business' | 'vault'`; `normalizePlanId`;
  `PLANS` config (yearly interval, $249, ownerOnly + readOnly flags).
- #29 entitlement guard: no derivation change needed (plan column already
  guarded); verify INSERT default stays 'starter'.
- Stripe: new Product + yearly Price; ID via `STRIPE_PRICE_VAULT_ANNUAL` env
  (fail closed if unset, same as annual plan prices).
- `stripe-webhook`: recognize the Vault price → `plan='vault'`,
  `document_limit` untouched (intake is frozen anyway; backstops gate on plan),
  clear cancellation-lifecycle columns on conversion (it's an active sub).

**V2 as-built (2026-06-13):** `'vault'` in `SubscriptionPlan` (single source:
pricing.ts, re-exported by types/index.ts), `PLANS.vault` ($249/yr,
ownerOnly/readOnly/yearlyOnly), `PLAN_ORDER` exclusion, `normalizePlanId`;
stripe-webhook recognizes Vault subs (metadata or `STRIPE_PRICE_VAULT_ANNUAL`),
leaves `document_limit` untouched (path-dependent + meaningless under vault —
consumers gate on plan), clears lifecycle on entitled, writes a `plan_changed`
audit row, fails loudly (500) on unresolvable entitled subs, and carries the
C2 entitled-event guard (consent via checkout.session.completed; session +
subscription metadata both stamped). #29 guard verified value-agnostic; INSERT
default verified 'starter'. Five review passes (auditor, security, integrity,
test-author, then a webhook verification round that caught a CRITICAL dead
consent channel — fixed + regression-pinned). stripe-webhook v25 +
create-checkout v43 deployed. 720/720. OPERATOR ITEM: create the Vault Stripe
Product + yearly Price (live + sandbox) and set `STRIPE_PRICE_VAULT_ANNUAL`.

### V3 — Conversion flows

**Pre-V3 blockers recorded during V2 review (2026-06-13):**
1. ~~Entitled-event clobber~~ FIXED in V2: the webhook's C2 guard now skips
   entitled events for a non-current subscription unless they arrive via
   checkout.session.completed. V3's cancel-dialog flow MUST run conversions
   through a Checkout session (not bare subscriptions.create) so the consent
   override applies, and should still cancel the old plan sub at conversion.
2. Reports/export wall: `canAccessFeature('business')` is false for vault, so
   a converted Business workspace loses the Reports surface (disclosure,
   projections, exports) until V4 — but "export gating in Vault is a bug by
   definition" (invariants below). Before conversions ship, special-case
   read/export surfaces for `planConfig.readOnly` (do NOT blanket-pass vault
   through business gates — that would remount the AI assistant and break the
   zero-AI-spend invariant). V3 and the V4 read-only UI walls must ship
   together or in that order.
- **Cancel dialog** (Billing): "Switch to Vault instead" path → checkout for
  the yearly price; copy warns: owner-only (members lose access), read-only,
  no AI, packs end at period close.
- **Grace banner** (`CancellationBanner`): third CTA "Keep your data — Vault
  $249/yr" (admins → owner-only nuance: only the OWNER can convert).
- **Grace reminder emails** (`process-cancellation-lifecycle`): add the Vault
  CTA line + link.
- Pack auto-cancel at period end during conversion (Stripe API, webhook-safe).

### V4 — In-product Vault experience
- Non-owner members: wall (reuse `SoftDeletedWall` shape) — "in Vault,
  contact the owner."
- Owner: read-only UI state (banner: "Vault — read-only repository. Renews
  {date} at $249/yr. [Reactivate]"); intake entry points hidden; AI assistant
  unmounted; exports all available (flatten rule).
- Billing tab: Vault plan card, Reactivate CTA (→ Starter/Business checkout;
  no Vault-fee refund), renewal date.
- Renewal reminder email ~14 days ahead (no-surprise-billing rule);
  failed renewal → normal Stripe dunning → `canceled` → existing lifecycle.

### Deferred (fast-follow, do not build now)
- 3.5% yearly escalator (billing subsystem: `invoice.upcoming` → computed
  price swap → escalated amount quoted in the reminder email).
- Any firm-layer / parent-child data-only construct (Phase 9 territory).

## Invariants
- Vault has ZERO AI spend. Anything that calls a paid API is off.
- Every conversion/reactivation is an explicit consented purchase; no
  proration, no refunds on early reactivation.
- Vault never appears on `/` pricing or in signup; offramp surfaces only.
- A Vault workspace is exportable in full at all times — export gating in
  Vault is a bug by definition.
