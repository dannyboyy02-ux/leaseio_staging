import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Incident #161 (2026-07-16, owner live repro): both expansion-revenue
// purchase surfaces — document packs / single lease credits
// (manage-document-pack) and the $499 add-workspace (create-workspace) —
// resolved the saved payment method with `paymentMethods.list({ type:
// "card" })` and confirmed client-side with `confirmCardPayment`. Stripe
// Checkout defaults new subscribers to **Link**, a non-card method, so the
// mainstream customer was rejected `no_card_on_file` from every purchase.
// This was the SECOND occurrence of the type:'card' class (display half fixed
// 2026-07-11 in get-billing-summary). These pins make a third occurrence a CI
// failure: charge-flow resolvers accept any method type and every purchase
// dialog confirms through the method-agnostic helper.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const CHARGE_FLOW_FUNCTIONS = [
  'supabase/functions/manage-document-pack/index.ts',
  'supabase/functions/create-workspace/index.ts',
];

const PURCHASE_DIALOGS = [
  'src/components/workspace/DocumentPackDialog.tsx',
  'src/components/workspace/NewWorkspaceDialog.tsx',
  'src/components/leases/LimitReachedDialog.tsx',
];

describe('#161 — charge-flow edge functions accept any saved payment method', () => {
  for (const p of CHARGE_FLOW_FUNCTIONS) {
    it(`${p} never filters paymentMethods.list to type card`, () => {
      const src = read(p);
      expect(src).not.toMatch(/type:\s*["']card["']/);
    });

    it(`${p} labels the method via the shared describePaymentMethod mapper`, () => {
      const src = read(p);
      expect(src).toContain('from "../_shared/payment_method.ts"');
      expect(src).toContain('describePaymentMethod(');
    });

    it(`${p} declines deferred-settlement methods (no charge-while-told-failed)`, () => {
      const src = read(p);
      // Bank debits settle to PI `processing`, which these instant flows can't
      // narrate — the resolver must reject them (#161 security review).
      expect(src).toContain('isDeferredSettlementMethod(');
      expect(src).toContain('deferred_method_unsupported');
    });
  }
});

describe('#161 — purchase dialogs confirm method-agnostically', () => {
  for (const p of PURCHASE_DIALOGS) {
    it(`${p} uses confirmSavedMethodPayment, never confirmCardPayment`, () => {
      const src = read(p);
      expect(src).not.toContain('confirmCardPayment(');
      expect(src).toContain('confirmSavedMethodPayment(');
    });
  }

  it('the shared helper resolves in-page for non-redirect methods', () => {
    const src = read('src/lib/stripeConfirm.ts');
    expect(src).toContain('confirmPayment');
    expect(src).toContain('redirect: "if_required"');
    expect(src).toContain('return_url');
    expect(src).toContain('clientSecret');
  });
});
