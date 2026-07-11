import { describe, it, expect } from 'vitest';
import { describePaymentMethod } from '../paymentMethodDisplay';

// Regression guard for the 2026-07-11 billing incident: a Stripe **Link**
// payment method (and any non-'card' type) must NOT be dropped. The old code
// filtered type:'card' + read pm.card, so a Link-paying customer saw "no
// payment method on file" and could not create a $499 workspace.
describe('describePaymentMethod', () => {
  it('returns null only when there is no method', () => {
    expect(describePaymentMethod(null)).toBeNull();
    expect(describePaymentMethod(undefined)).toBeNull();
  });

  it('describes a plain card', () => {
    const d = describePaymentMethod({
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 },
    });
    expect(d).toMatchObject({ type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2034 });
    expect(d?.label).toBe('Visa •••• 4242');
  });

  it('describes a card entered through a wallet (Link) that still exposes card details', () => {
    const d = describePaymentMethod({
      type: 'card',
      card: { brand: 'mastercard', last4: '4444', wallet: { type: 'link' } },
    });
    expect(d?.type).toBe('card');
    expect(d?.last4).toBe('4444');
    expect(d?.walletLabel).toBe('link');
  });

  it('describes a Link payment method (the incident case) instead of dropping it', () => {
    const d = describePaymentMethod({ type: 'link', link: { email: 'kelli@example.com' } });
    expect(d).not.toBeNull();
    expect(d?.type).toBe('link');
    expect(d?.brand).toBe('link');
    expect(d?.last4).toBeNull();
    expect(d?.walletLabel).toBe('kelli@example.com');
    expect(d?.label).toBe('Stripe Link (kelli@example.com)');
  });

  it('describes a Link method with no email', () => {
    const d = describePaymentMethod({ type: 'link', link: {} });
    expect(d?.type).toBe('link');
    expect(d?.label).toBe('Stripe Link');
  });

  it('describes an ACH / US bank account', () => {
    const d = describePaymentMethod({
      type: 'us_bank_account',
      us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' },
    });
    expect(d?.type).toBe('us_bank_account');
    expect(d?.last4).toBe('6789');
    expect(d?.label).toBe('STRIPE TEST BANK •••• 6789');
  });

  it('never returns null for an unknown/future PM type — degrades to a label', () => {
    const d = describePaymentMethod({ type: 'sepa_debit' });
    expect(d).not.toBeNull();
    expect(d?.type).toBe('sepa_debit');
    expect(d?.label).toBe('Sepa Debit');
  });

  it('handles a present-but-typeless method without dropping it', () => {
    const d = describePaymentMethod({});
    expect(d).not.toBeNull();
    expect(d?.label).toBe('Payment method on file');
  });
});
