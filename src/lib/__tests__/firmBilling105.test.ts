import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 / #105 — firm per-child billing core. The firm pays N × Business on
// one subscription (quantity = bound child count) on the EXISTING Business
// price. Static-source guards (Deno, no unit harness).

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('firm_billing.ts — quantity recompute helper', () => {
  const src = fn('supabase/functions/_shared/firm_billing.ts');
  it('recomputes quantity from the live child count (idempotent, drift-free)', () => {
    expect(src).toContain('export async function countFirmChildren');
    expect(src).toContain('.eq("firm_id", firmId)');
    expect(src).toContain('count: "exact"');
  });
  it('no-ops without a subscription and skips a zero child count', () => {
    expect(src).toContain('if (!subId) return null');
    expect(src).toContain('if (qty < 1)');
  });
  it('updates the subscription item quantity with proration', () => {
    expect(src).toContain('proration_behavior: "create_prorations"');
    expect(src).toContain('items: [{ id: item.id, quantity: qty }]');
  });
});

describe('create-firm-subscription — owner-gated, Business price, quantity, metadata', () => {
  const src = fn('supabase/functions/create-firm-subscription/index.ts');
  it('firm OWNER only', () => {
    expect(src).toContain('firm as { owner_id: string }).owner_id !== user.id');
    expect(src).toContain('reason: "not_authorized"');
  });
  it('requires at least one child (the quantity) and a card on file', () => {
    expect(src).toContain('reason: "no_children"');
    expect(src).toContain('reason: "no_card_on_file"');
  });
  it('reuses BUSINESS_MONTHLY_PRICE_ID with quantity + metadata.firm_id (no new firm Product)', () => {
    expect(src).toContain('BUSINESS_MONTHLY_PRICE_ID');
    expect(src).toContain('items: [{ price: BUSINESS_MONTHLY_PRICE_ID, quantity }]');
    expect(src).toContain('metadata: { firm_id: firmId');
    expect(src).toContain('payment_behavior: "default_incomplete"');
  });
  it('does not write stripe_subscription_id itself (the webhook records it on confirmation)', () => {
    // Only the customer id is persisted pre-confirmation.
    expect(src).toContain('.update({ stripe_customer_id: customerId })');
    expect(src).not.toMatch(/update\([^)]*stripe_subscription_id/);
  });
  it('never leaks raw DB/Stripe error messages', () => {
    expect(src).not.toMatch(/message:\s*\w*[Ee]rr(or)?\.message/);
    expect(src).toContain('reason: "server_error"');
  });
  it('email-fallback customer resolution is CREATE-ONLY (#61 class — no arbitrary list adoption)', () => {
    // Must NOT adopt an arbitrary customers.list({email}) hit.
    expect(src).not.toContain('existing.data[0]?.id');
    expect(src).toContain('stripe.customers.create({ email: user.email');
  });
  it('has a server-side double-create guard independent of the client idempotency key', () => {
    expect(src).toContain('stripe.subscriptions.list({ customer: customerId');
    expect(src).toContain('s.metadata?.firm_id === firmId');
    // On a found live sub, returns ITS PaymentIntent instead of creating a second.
    expect(src).toContain('existing: true');
  });
});

describe('bind/release/act-on wire the quantity sync', () => {
  for (const f of ['bind-workspace-to-firm', 'release-workspace-from-firm', 'act-on-firm-workspace-join-request']) {
    it(`${f} calls syncFirmBilling after the bind/release`, () => {
      const src = fn(`supabase/functions/${f}/index.ts`);
      expect(src).toContain('syncFirmSubscriptionQuantity');
      expect(src).toContain('syncFirmBilling(supabaseAdmin');
    });
  }
});
