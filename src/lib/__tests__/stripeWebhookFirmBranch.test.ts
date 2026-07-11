import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 9: the Stripe webhook gains a firm-tier branch. A subscription tagged
// metadata.firm_id governs all the firm's child workspaces via one firm-level
// subscription, and must route to firm logic BEFORE the workspace plan path
// (otherwise a firm sub would clobber a workspace row). Static-source assertions
// (Deno fn, no unit harness) — same idiom as billingSummaryGating.test.ts.

const src = readFileSync(
  join(process.cwd(), 'supabase/functions/stripe-webhook/index.ts'),
  'utf8',
);

function section(s: string, start: string, end: string): string {
  const i = s.indexOf(start);
  expect(i, `expected "${start}"`).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return s.slice(i, j + end.length);
}

describe('stripe-webhook firm-tier branch', () => {
  it('detects firm subscriptions via metadata.firm_id', () => {
    const fn = section(src, 'function isFirmSubscription', '}');
    expect(fn).toContain('subscription.metadata?.firm_id');
  });

  it('routes firm subscriptions BEFORE the document-pack / workspace paths in both event handlers', () => {
    // checkout.session.completed
    const checkout = section(src, 'if (isFirmSubscription(subscription)) {', 'break;');
    expect(checkout).toContain('await applyFirmSubscription(subscription, event.type);');
    expect(checkout.indexOf('isFirmSubscription')).toBeLessThan(checkout.indexOf('isDocumentPack'));
    // customer.subscription.* — second occurrence
    const second = src.slice(src.indexOf('if (isFirmSubscription(subscription)) {') + 1);
    expect(second).toContain('if (isFirmSubscription(subscription)) {');
  });

  it('cancellation clears the subscription id (current sub only) and audits firm_billing_subscription_canceled', () => {
    // 2026-07-11 hardening: a stale-deleted guard now precedes the clear, so
    // the window runs to the audit type (the first `return;` is the guard's).
    const del = section(src, 'eventType === "customer.subscription.deleted"', '"firm_billing_subscription_canceled"');
    expect(del).toContain('storedSubId !== subscription.id'); // stale guard
    expect(del).toContain('stripe_subscription_id: null');
    expect(del).toContain('if (clearErr) throw new Error'); // loud on DB rejection
  });

  it('created/updated records the sub, propagates business to children, and audits start/updated', () => {
    const apply = section(src, 'async function applyFirmSubscription', '\n  }\n\n  try {');
    // records the firm subscription + customer
    expect(apply).toContain('stripe_subscription_id: subscription.id');
    expect(apply).toContain('resolveCustomerId(subscription)');
    // propagates business to all child workspaces (firm constraint)
    expect(apply).toContain('.from("workspaces").update({ plan: "business" }).eq("firm_id", firmId)');
    // start vs updated audit
    expect(apply).toContain('"firm_billing_subscription_started"');
    expect(apply).toContain('"firm_billing_subscription_updated"');
    // does NOT write firms.plan (CHECK-pinned to business) — only the child plan + stripe ids
    expect(apply).not.toContain('plan: "starter"');
  });

  it('carries firms.billing_summary_mode into the audit detail (invoice itemization is a follow-on)', () => {
    const apply = section(src, 'async function applyFirmSubscription', '\n  }\n\n  try {');
    expect(apply).toContain('billing_summary_mode');
  });
});
