import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Money-path hardening — second-pass adversarial billing audit, 2026-07-11.
// Static-source pins for the fixes; each block names the failure it prevents.
// Repo idiom: narrow the search window before asserting (full-file toContain
// is a known false-positive trap).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function section(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `start marker not found: "${start}"`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end marker not found after "${start}": "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

const webhook = read('supabase/functions/stripe-webhook/index.ts');
const checkout = read('supabase/functions/create-checkout/index.ts');
const lifecycle = read('supabase/functions/process-cancellation-lifecycle/index.ts');
const quotas = read('supabase/functions/_shared/monitoring/workspace_quotas.ts');

// ─────────────────────────────────────────────────────────────────────────
// Basil confirmation_secret — the invoice.payment_intent expand is REMOVED
// under the pinned API version; all three default_incomplete surfaces must
// use latest_invoice.confirmation_secret instead.
// ─────────────────────────────────────────────────────────────────────────

describe('Basil: confirmation_secret replaces the removed invoice.payment_intent expand', () => {
  const surfaces = [
    'supabase/functions/manage-document-pack/index.ts',
    'supabase/functions/create-workspace/index.ts',
    'supabase/functions/create-firm-subscription/index.ts',
  ];
  for (const file of surfaces) {
    it(`${file} expands confirmation_secret and never latest_invoice.payment_intent`, () => {
      const src = read(file);
      expect(src).toContain('latest_invoice.confirmation_secret');
      expect(src).not.toContain('latest_invoice.payment_intent');
      expect(src).toContain('confirmation_secret?.client_secret');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Webhook: firm-branch hardening (Critical — unpaid incomplete sub recorded
// as the firm's live subscription, blocking payment retry forever).
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-webhook: applyFirmSubscription hardening', () => {
  const fn = section(webhook, 'async function applyFirmSubscription', '\n  }\n\n  try {');

  it('gates the non-deleted branch on entitlement (active/trialing only)', () => {
    expect(fn).toContain('const entitled = status === "active" || status === "trialing";');
    expect(fn).toContain('if (!entitled) {');
    // The gate must run BEFORE the firms pointer write.
    const gateIdx = fn.indexOf('if (!entitled) {');
    const writeIdx = fn.indexOf('stripe_subscription_id: subscription.id');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(gateIdx);
  });

  it('ignores a deleted event for a STALE firm sub (only the current sub clears the pointer)', () => {
    const del = section(fn, 'if (eventType === "customer.subscription.deleted")', 'return;');
    expect(del).toContain('storedSubId !== subscription.id');
  });

  it('billing-critical firm writes fail LOUD on DB rejection (supabase-js returns { error })', () => {
    expect(fn).toContain('if (clearErr) throw new Error');
    expect(fn).toContain('if (firmErr) throw new Error');
    expect(fn).toContain('if (childErr) throw new Error');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Webhook: displaced-plan-sub cancel (ratified review billing §2 — plan
// switches double-billed $299+$499/mo because the old sub was never canceled).
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-webhook: displaced plan subscription is canceled on a checkout switch', () => {
  const block = section(webhook, 'Displaced-plan-sub cancellation', '// Vault conversion (V3)');

  it('fires only on a checkout-consented switch to a different sub', () => {
    expect(block).toContain(
      'if (entitled && workspaceIdOverride && storedSubId && storedSubId !== subscription.id)',
    );
  });

  it('guards: only this workspace\'s own non-terminal PLAN sub (never a pack/firm sub)', () => {
    expect(block).toContain('oldSub.metadata?.addon_type !== ADDON_TYPE_DOCUMENT_PACK');
    expect(block).toContain('!oldSub.metadata?.firm_id');
    expect(block).toContain('oldSub.metadata?.workspace_id === workspaceId');
    expect(block).toContain('"canceled", "incomplete_expired"');
  });

  it('cancels at Stripe and audits the displacement', () => {
    expect(block).toContain('await stripe.subscriptions.cancel(storedSubId);');
    expect(block).toContain('"displaced_subscription_canceled"');
    // Failure is loud — the old sub still billing must never be silent.
    expect(block).toContain('OLD SUB MAY STILL BE BILLING');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Webhook: firm-bound early-exit + stale-payload guard.
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-webhook: applySubscription is inert for firm-bound workspaces', () => {
  it('early-exits before C1/C2 and the entitlement write when workspace.firm_id is set', () => {
    const block = section(webhook, 'Firm-bound early-exit', 'C1 guard');
    expect(block).toContain('if (priorState?.firm_id) {');
    expect(block).toContain('return;');
    // The select must actually fetch firm_id.
    expect(webhook).toContain('"plan, stripe_subscription_id, firm_id"');
  });
});

describe('stripe-webhook: subscription events apply CURRENT Stripe truth, not the (possibly stale) payload', () => {
  it('retrieves the subscription fresh in the created/updated/deleted branch, with payload fallback', () => {
    const block = section(webhook, 'case "customer.subscription.created":', 'break;');
    expect(block).toContain('await stripe.subscriptions.retrieve(subscription.id)');
    expect(block).toContain('applying event payload'); // the fallback path
  });
});

// ─────────────────────────────────────────────────────────────────────────
// create-checkout: first-subscription-only trial + stored-customer preference.
// ─────────────────────────────────────────────────────────────────────────

describe('create-checkout: trial is first-ever-subscription only', () => {
  it('derives trialEligible from the workspace\'s stored billing pointers', () => {
    const block = section(checkout, 'const trialEligible', ';');
    expect(block).toContain('!storedCustomerId');
    expect(block).toContain('stripe_subscription_id');
  });

  it('trial_period_days is gated on trialEligible (and still excluded for Vault)', () => {
    const block = section(checkout, 'subscription_data: {', 'metadata: {');
    expect(block).toContain('isVault || !trialEligible ? {} : { trial_period_days: TRIAL_PERIOD_DAYS }');
  });

  it('prefers the workspace\'s stored Stripe customer over an email match', () => {
    const block = section(checkout, 'const storedCustomerId', 'const trialEligible');
    expect(block).toContain('storedCustomerId ?? undefined');
    // Email lookup only as fallback inside the !customerId branch.
    expect(block).toContain('if (!customerId) {');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Quota poller: effective caps include document_limit + pack capacity.
// ─────────────────────────────────────────────────────────────────────────

describe('workspace_quotas poller: limits reflect the workspace\'s real capacity', () => {
  it('selects document_limit + addon_document_capacity and derives effective caps', () => {
    expect(quotas).toContain("select('id, plan, document_limit, addon_document_capacity')");
    expect(quotas).toContain('const effectiveLeaseCap');
    expect(quotas).toContain('const effectiveExtractionCap');
  });

  it('active_leases and monthly_extractions snapshot against the effective caps, not bare TIER_LIMITS', () => {
    const activeBlock = section(quotas, "metric: 'active_leases'", '});');
    expect(activeBlock).toContain('effectiveLeaseCap');
    const monthlyBlock = section(quotas, "metric: 'monthly_extractions'", '});');
    expect(monthlyBlock).toContain('effectiveExtractionCap');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Purge loop: Stripe-truth re-check + zero-row heal detection.
// ─────────────────────────────────────────────────────────────────────────

describe('process-cancellation-lifecycle: purge cannot destroy a just-renewed customer', () => {
  it('re-checks entitlement against STRIPE (not just the DB mirror) before any destruction, failing closed', () => {
    const block = section(lifecycle, 'STRIPE-TRUTH race guard', 'cancelWorkspaceSubscriptions(');
    expect(block).toContain('stripe.subscriptions.list({');
    expect(block).toContain('s.status === "active" || s.status === "trialing"');
    expect(block).toContain('await healRenewed(ws.id);');
    // Fail closed on Stripe errors — never destroy on unconfirmed truth.
    expect(block).toContain('purge deferred');
  });

  it('the heal predicate matches PLAN/VAULT subs only — an active pack sub must NOT heal (integrity review)', () => {
    // A pack sub also carries metadata.workspace_id and is routinely still
    // active on purge day (packs are only canceled AT purge). Matching it
    // would exempt every pack holder from purge forever while the pack bills.
    const block = section(lifecycle, 'const entitledLive', ');');
    expect(block).toContain("!s.metadata?.addon_type");
    expect(block).toContain("!s.metadata?.firm_id");
  });

  it('detects a zero-row workspace delete (concurrent heal) and skips the storage purge', () => {
    const block = section(lifecycle, 'const { data: deletedWs, error: wsErr }', 'purgeWorkspaceStorage');
    expect(block).toContain(".select(\"id\")");
    expect(block).toContain('if (!deletedWs || deletedWs.length === 0)');
    expect(block).toContain('continue;');
  });
});
