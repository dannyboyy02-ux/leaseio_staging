import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-source coverage for the 2026-06 Billing-tab redesign:
//   - supabase/functions/get-billing-summary/index.ts — a NEW read-only edge
//     function that returns the saved card (brand + last4 + exp only) and the
//     recent invoices. It is security-critical: billing data is privileged, so
//     the auth/gating contract (Authorization required, workspaceId validated,
//     owner-OR-admin only, customer resolved from workspaces.stripe_customer_id,
//     no card secret ever leaks) must not regress.
//   - src/pages/settings/AccountSettings.tsx — the fetch is admin-gated and
//     guarded by a per-workspace ref so a tab toggle / re-render never re-hits
//     Stripe; the Payment + Invoices sections are admin-only; the "Adjust plan"
//     picker is wired to the existing upgrade/downgrade handlers.
//
// Deno functions can't run under vitest, so — per repo convention (see
// transferWorkspaceOwnership.test.ts / workspaceLimits.test.ts) — we pin the
// load-bearing source blocks with readFileSync, narrowing the search window to
// each block's declaration before asserting. Full-file toContain is a known
// false-positive trap (CLAUDE.md "Static migration-file tests").

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Slice a source between two unique markers; fail loudly if either moved. */
function section(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `start marker not found: "${start}"`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end marker not found after "${start}": "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

const fnSrc = read('supabase/functions/get-billing-summary/index.ts');
const acctSrc = read('src/pages/settings/AccountSettings.tsx');
const pmSrc = read('supabase/functions/_shared/payment_method.ts');

// ─────────────────────────────────────────────────────────────────────────
// get-billing-summary — auth & request validation
// ─────────────────────────────────────────────────────────────────────────

describe('get-billing-summary (edge fn) — auth', () => {
  it('requires an Authorization header and 401s when absent', () => {
    const block = section(fnSrc, 'const authHeader', 'const user = userData.user');
    expect(block).toContain('req.headers.get("Authorization")');
    expect(block).toContain('if (!authHeader)');
    expect(block).toMatch(/reason:\s*"no_auth"/);
    expect(block).toContain('401');
  });

  it('verifies the bearer token via auth.getUser and 401s an invalid session', () => {
    const block = section(fnSrc, 'const token = authHeader', 'const user = userData.user');
    expect(block).toContain('supabaseAdmin.auth.getUser(token)');
    expect(block).toContain('if (userError || !userData?.user?.id)');
    expect(block).toMatch(/reason:\s*"invalid_auth"/);
  });

  it('validates workspaceId from the body before any DB read', () => {
    const block = section(fnSrc, 'const workspaceId =', 'const { data: workspace');
    expect(block).toContain('if (!workspaceId || typeof workspaceId !== "string")');
    expect(block).toMatch(/reason:\s*"bad_request"/);
    expect(block).toContain('400');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// get-billing-summary — owner-OR-admin gating (the security-critical boundary)
// ─────────────────────────────────────────────────────────────────────────

describe('get-billing-summary (edge fn) — owner-OR-admin gating', () => {
  it('resolves the workspace by id and 404s a missing one', () => {
    const block = section(fnSrc, 'const { data: workspace', 'let canManageBilling');
    expect(block).toContain('.from("workspaces")');
    expect(block).toContain('.eq("id", workspaceId)');
    // Only the columns the function needs — owner_id + the customer/subscription
    // pointers (subscription id drives the scheduled-cancel signal).
    expect(block).toContain('"id, owner_id, stripe_customer_id, stripe_subscription_id"');
    expect(block).toMatch(/reason:\s*"not_found"/);
    expect(block).toContain('404');
  });

  it('allows the owner, else requires a workspace_members row with role=admin', () => {
    const block = section(fnSrc, 'let canManageBilling', 'canManageBilling = Boolean(membership);');
    // Owner is allowed directly.
    expect(block).toContain('owner_id === user.id');
    // Non-owner must be an explicit admin member of THIS workspace.
    expect(block).toContain('.from("workspace_members")');
    expect(block).toContain('.eq("workspace_id", workspaceId)');
    expect(block).toContain('.eq("user_id", user.id)');
    expect(block).toContain('.eq("role", "admin")');
  });

  it('403s any member who is neither owner nor admin (no card/invoice leak)', () => {
    const block = section(fnSrc, 'Only workspace owners or admins', '403,');
    expect(block).toMatch(/reason:\s*"not_authorized"/);
    expect(block).toContain('403');
  });

  it('the gate runs BEFORE any Stripe call — members never trigger a Stripe GET', () => {
    const gateIdx = fnSrc.indexOf('"not_authorized"');
    const stripeIdx = fnSrc.indexOf('new Stripe(stripeKey');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(stripeIdx).toBeGreaterThan(gateIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// get-billing-summary — customer resolution + no_customer + response shape
// ─────────────────────────────────────────────────────────────────────────

describe('get-billing-summary (edge fn) — customer resolution & shape', () => {
  it('resolves the Stripe customer from workspaces.stripe_customer_id', () => {
    const block = section(fnSrc, 'const customerId =', 'const stripe = new Stripe');
    expect(block).toContain('stripe_customer_id');
  });

  it('returns 200 with empty data + reason:"no_customer" when there is no customer (fresh trial)', () => {
    const block = section(fnSrc, 'if (!customerId) {', '200);');
    expect(block).toContain('card: null');
    expect(block).toContain('invoices: []');
    expect(block).toMatch(/reason:\s*"no_customer"/);
    // Explicitly NOT an error response.
    expect(block).toContain('ok: true');
    expect(block).toContain('200');
  });

  it('does not filter type:"card" — a non-card method (Stripe Link/ACH) is not dropped (incident 2026-07-11)', () => {
    // The regression: paymentMethods.list({ type: "card" }) silently dropped a
    // Link/wallet method, so a paying customer saw "no payment method on file".
    // The list call must carry NO type filter, and the PM must be mapped through
    // the type-exhaustive describePaymentMethod helper.
    const block = section(fnSrc, 'const pms = await stripe.paymentMethods.list(', ');');
    expect(block).not.toContain('type: "card"');
    expect(block).not.toContain("type: 'card'");
    expect(fnSrc).toContain('describePaymentMethod(');
    expect(fnSrc).toContain('import { describePaymentMethod }');
  });

  it('describePaymentMethod exposes ONLY safe fields — never a full PAN or a PaymentMethod secret', () => {
    // Card exposure now lives in the shared helper; assert the whole helper
    // never references the number, fingerprint, or a re-usable secret.
    expect(pmSrc).toContain('last4');
    expect(pmSrc).toContain('brand');
    expect(pmSrc).not.toContain('fingerprint');
    expect(pmSrc).not.toContain('client_secret');
    // "number" would appear in `exp_month`/`exp_year` substrings? No — those are
    // "exp_month"/"exp_year". Assert no bare PAN field name.
    expect(pmSrc).not.toMatch(/\bpm\.card\?\.number\b/);
    // The success response returns only card + invoices + subscription — never
    // the raw PaymentMethod id used internally to resolve the method.
    const responseLine = section(fnSrc, 'return json({ ok: true, card, invoices, subscription }', '200);');
    expect(responseLine).not.toContain('pmId');
  });

  it('returns the subscription scheduled-cancel signal (cancelAtPeriodEnd) without a schema migration', () => {
    // Stripe leaves status='active' after a cancel is scheduled, so the Billing
    // tab needs cancel_at_period_end from a live retrieve to distinguish
    // "auto-renews" from "scheduled to cancel". Sourced here, not a mirrored
    // column, so no webhook/entitlement-guard change (incident 2026-07-11 #2).
    const block = section(fnSrc, 'let subscription:', 'return json({ ok: true, card, invoices, subscription }');
    expect(block).toContain('stripe_subscription_id');
    expect(block).toContain('stripe.subscriptions.retrieve(subscriptionId)');
    expect(block).toContain('cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end)');
    expect(block).toContain('currentPeriodEnd');
    // A failed subscription retrieve must NOT fail the whole summary (card +
    // invoices still render) — it's wrapped in its own try/catch.
    expect(block).toContain('non-fatal');
    // The select must actually fetch the subscription id.
    expect(fnSrc).toContain('"id, owner_id, stripe_customer_id, stripe_subscription_id"');
  });

  it('Stripe failures map to 502 (reason:"stripe_error"), not a thrown 500', () => {
    const block = section(fnSrc, 'catch (stripeErr)', '502);');
    expect(block).toMatch(/reason:\s*"stripe_error"/);
    expect(block).toContain('502');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AccountSettings — admin-gated, fetch-once billing summary
// ─────────────────────────────────────────────────────────────────────────

describe('AccountSettings — billing-summary fetch', () => {
  it('only fetches on the Billing tab, for an admin, once per workspace', () => {
    const effect = section(acctSrc, "if (activeTab !== 'billing') return;", 'billingRetry]);');
    // Admin gate: members never invoke (the function 403s them anyway).
    expect(effect).toContain('if (!workspace?.id || !isAdminUser) return;');
    // Fetch-once: the per-workspace ref short-circuits a re-run for the same ws.
    expect(effect).toContain('if (billingSummaryFetchedFor.current === workspace.id) return;');
    expect(effect).toContain('billingSummaryFetchedFor.current = workspace.id;');
    // The actual invoke targets the new function with the workspace id.
    expect(effect).toContain("supabase.functions\n      .invoke('get-billing-summary'");
    expect(effect).toContain('body: { workspaceId: workspace.id }');
  });

  it('isAdminUser counts both owner and admin roles', () => {
    expect(acctSrc).toContain(
      "const isAdminUser = userRole === 'admin' || userRole === 'owner';",
    );
  });

  it('Payment and Invoices DATA is admin-only; members get an explanatory note', () => {
    // The section headings render for everyone, but the card/invoice DATA sits
    // behind a `!isAdminUser ? <billing_admin_only> : <data>` branch — so a
    // member sees a note, never the card or invoice history. (The fetch effect
    // is also admin-gated above, so members never even hit Stripe.)
    const payment = section(acctSrc, "{t('account.payment')}", '</section>');
    expect(payment).toContain('!isAdminUser ?');
    expect(payment).toContain("t('account.billing_admin_only')");
    // Card data renders only in the admin branch.
    expect(payment).toContain('billingSummary.card.last4');

    const invoices = section(acctSrc, "{t('account.invoices')}", '</section>');
    expect(invoices).toContain('!isAdminUser ?');
    expect(invoices).toContain("t('account.billing_admin_only')");
  });

  it('retry resets the per-workspace ref so a manual retry re-fetches', () => {
    const retry = section(acctSrc, 'const retryBillingSummary', '};');
    expect(retry).toContain('billingSummaryFetchedFor.current = null;');
    expect(retry).toContain('setBillingRetry');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AccountSettings — "Adjust plan" picker wiring
// ─────────────────────────────────────────────────────────────────────────

describe('AccountSettings — Adjust plan picker wiring', () => {
  it('routes upgrades through handleUpgrade and downgrades through the confirm dialog', () => {
    const router = section(acctSrc, 'const handleAdjustPlanSelect', '};');
    // Picker closes, then the selection is routed by plan order — never
    // straight to the portal.
    expect(router).toContain('setPlanPickerOpen(false);');
    expect(router).toContain('isUpgrade(currentPlan as SubscriptionPlan, planId)');
    expect(router).toContain('handleUpgrade(planId)');
    expect(router).toContain('setConfirmDowngradePlan(planId)');
    expect(router).not.toContain('handleManagePayment');
  });

  it('mounts PlanPickerDialog wired to the picker state + the routing handler', () => {
    const mount = section(acctSrc, '<PlanPickerDialog', '/>');
    expect(mount).toContain('open={planPickerOpen}');
    expect(mount).toContain('onOpenChange={setPlanPickerOpen}');
    expect(mount).toContain('currentPlan={currentPlan as SubscriptionPlan}');
    expect(mount).toContain('onSelectPlan={handleAdjustPlanSelect}');
  });
});
