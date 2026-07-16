// ─────────────────────────────────────────────────────────────────────────
// Stripe payment-method → display descriptor — Deno mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// Byte-equivalent behavior with the Deno counterpart:
//   src/lib/paymentMethodDisplay.ts
// Node copy: imported by the frontend Billing tab + vitest tests.
// Deno copy: imported by get-billing-summary, create-workspace, and
// manage-document-pack (the #161 charge-flow resolvers).
// No imports in either file — language-level types + logic only.
//
// WHY THIS EXISTS (billing incident 2026-07-11)
// get-billing-summary and create-workspace both resolved the saved payment
// method with `paymentMethods.list({ type: 'card' })` and read `pm.card`.
// A customer who paid through Stripe Checkout with **Link** (or Apple/Google
// Pay, or ACH) has a NON-'card' PaymentMethod, so the filter silently dropped
// it: the Billing tab showed "No payment method on file" for a paying
// customer, and create-workspace rejected a Link-paying customer with
// `no_card_on_file`. This helper is the single, type-exhaustive mapper both
// sites use — the default branch NEVER returns null for a present method, so a
// new/unhandled Stripe PM type degrades to a labeled descriptor instead of a
// phantom "nothing on file".
// ─────────────────────────────────────────────────────────────────────────

/** Minimal shape of the Stripe.PaymentMethod fields we read. */
export interface StripePaymentMethodLike {
  type?: string | null;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
    wallet?: { type?: string | null } | null;
  } | null;
  link?: { email?: string | null } | null;
  us_bank_account?: { bank_name?: string | null; last4?: string | null } | null;
}

export interface PaymentMethodDescriptor {
  /** Stripe PM type: 'card' | 'link' | 'us_bank_account' | … */
  type: string;
  /** Card network for cards; 'link'/bank name/type slug otherwise. */
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** Wallet the card came through (e.g. 'link', 'apple_pay') or the Link email. */
  walletLabel: string | null;
  /** Human, non-localized fallback label — safe to render directly. */
  label: string;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Deferred-settlement PaymentMethod types: a confirm resolves to a PI status of
// `processing` (bank debits clear over days), NOT the synchronous
// succeeded/requires_action that card + Link + wallets produce. The on-session
// instant-capacity purchase surfaces (packs, single-lease credit,
// $499 add-workspace) have no `processing` UX — a customer would be charged
// while told the payment failed (#161 security review, 2026-07-16). Until those
// surfaces branch on `processing`, decline these method types EARLY with honest
// copy. This is a DENYLIST, not an allowlist, on purpose: the whole #161 bug was
// over-restricting methods, so a new SYNCHRONOUS method type must never be
// blocked here — only known-deferred bank debits are.
export const DEFERRED_SETTLEMENT_METHOD_TYPES = new Set<string>([
  'us_bank_account',
  'sepa_debit',
  'acss_debit',
  'bacs_debit',
  'au_becs_debit',
  'becs_debit',
]);

/** True when the method settles asynchronously (PI → `processing`). */
export function isDeferredSettlementMethod(type: string | null | undefined): boolean {
  return type != null && DEFERRED_SETTLEMENT_METHOD_TYPES.has(type);
}

/**
 * Map a Stripe PaymentMethod (or the minimal subset above) to a display
 * descriptor. Returns null ONLY when there is genuinely no method
 * (`pm` is null/undefined). A present method of ANY type returns a
 * non-null, labeled descriptor.
 */
export function describePaymentMethod(
  pm: StripePaymentMethodLike | null | undefined,
): PaymentMethodDescriptor | null {
  if (!pm) return null;

  // A real card — including one entered through a wallet (Link / Apple Pay /
  // Google Pay), where the card brand + last4 ARE exposed under pm.card.
  if (pm.card && (pm.card.last4 || pm.card.brand)) {
    const brand = pm.card.brand ?? null;
    const last4 = pm.card.last4 ?? null;
    return {
      type: 'card',
      brand,
      last4,
      expMonth: pm.card.exp_month ?? null,
      expYear: pm.card.exp_year ?? null,
      walletLabel: pm.card.wallet?.type ?? null,
      label: `${brand ? titleCase(brand) : 'Card'}${last4 ? ` •••• ${last4}` : ''}`,
    };
  }

  // Stripe Link — the underlying card is NOT exposed on the PaymentMethod;
  // represent it as Link (+ email when present). This is the exact case the
  // `type: 'card'` filter used to drop silently (incident 2026-07-11).
  if ((pm.type ?? '') === 'link' || pm.link) {
    const email = pm.link?.email ?? null;
    return {
      type: 'link',
      brand: 'link',
      last4: null,
      expMonth: null,
      expYear: null,
      walletLabel: email,
      label: email ? `Stripe Link (${email})` : 'Stripe Link',
    };
  }

  // ACH / US bank account.
  if ((pm.type ?? '') === 'us_bank_account' || pm.us_bank_account) {
    const bank = pm.us_bank_account?.bank_name ?? null;
    const last4 = pm.us_bank_account?.last4 ?? null;
    return {
      type: 'us_bank_account',
      brand: bank,
      last4,
      expMonth: null,
      expYear: null,
      walletLabel: null,
      label: `${bank ?? 'Bank account'}${last4 ? ` •••• ${last4}` : ''}`,
    };
  }

  // Any other current or future Stripe PM type (sepa_debit, cashapp, …).
  // NEVER return null for a present method — a labeled descriptor beats a
  // phantom "no payment method on file" (the 2026-07-11 miss).
  const type = pm.type ?? 'unknown';
  return {
    type,
    brand: type === 'unknown' ? null : type,
    last4: null,
    expMonth: null,
    expYear: null,
    walletLabel: null,
    label: type === 'unknown' ? 'Payment method on file' : titleCase(type),
  };
}
