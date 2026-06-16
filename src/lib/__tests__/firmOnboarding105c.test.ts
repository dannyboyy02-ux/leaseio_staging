import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 / #105-C — self-serve firm onboarding (create-firm relaxation +
// create-firm-checkout hosted Checkout Session).

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, `supabase/functions/${p}/index.ts`), 'utf8');

describe('create-firm — self-serve, no foreign-owner forgery', () => {
  const src = fn('create-firm');
  it('a self-serve caller owns the firm they create (owner forced to user.id)', () => {
    expect(src).toContain('const isOps = Boolean(opsRow)');
    expect(src).toContain('isOps && requestedOwnerId && typeof requestedOwnerId === "string" ? requestedOwnerId : user.id');
  });
  it('only ops can provision a firm owned by someone else', () => {
    // The foreign-owner branch is gated on isOps; a non-ops caller can never set owner_id.
    expect(src).not.toMatch(/const ownerId = \(body as/);
  });
});

describe('create-firm-checkout — owner-gated hosted Checkout Session', () => {
  const src = fn('create-firm-checkout');
  it('firm OWNER only', () => {
    expect(src).toContain('firm as { owner_id: string }).owner_id !== user.id');
    expect(src).toContain('reason: "not_authorized"');
  });
  it('requires ≥1 child and short-circuits if already subscribed', () => {
    expect(src).toContain('reason: "no_children"');
    expect(src).toContain('already_subscribed');
  });
  it('creates a subscription-mode Checkout Session on the Business price with quantity + firm_id metadata', () => {
    expect(src).toContain('stripe.checkout.sessions.create');
    expect(src).toContain('mode: "subscription"');
    expect(src).toContain('line_items: [{ price: BUSINESS_MONTHLY_PRICE_ID, quantity }]');
    expect(src).toContain('metadata: { firm_id: firmId');
    // The webhook routes firm subs on subscription_data.metadata.firm_id.
    expect(src).toContain('subscription_data');
  });
  it('never leaks raw errors', () => {
    expect(src).not.toMatch(/message:\s*\w*[Ee]rr(or)?\.message/);
    expect(src).toContain('reason: "server_error"');
  });
  it('has a double-subscription guard: stamps the customer then scans for a live firm sub', () => {
    // Stamp before the session so a repeat checkout finds the in-flight sub.
    expect(src).toContain('.update({ stripe_customer_id: customerId }).eq("id", firmId)');
    expect(src).toContain('stripe.subscriptions.list({ customer: customerId');
    expect(src).toContain('s.metadata?.firm_id === firmId');
    // Customer resolution is create-only on the email fallback (#61-safe).
    expect(src).toContain('stripe.customers.create({ email: user.email');
  });
});

describe('create-firm — #102 structured errors (now money-adjacent)', () => {
  const src = fn('create-firm');
  it('does not echo raw DB/error messages to the client', () => {
    expect(src).not.toContain('error: insErr.message');
    expect(src).not.toMatch(/return json\(\{ error: msg \}/);
  });
});
