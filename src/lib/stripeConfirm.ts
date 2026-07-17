// Method-agnostic confirmation for a PaymentIntent that already carries the
// customer's saved payment method (card, Stripe Link, ACH, wallet, …).
//
// WHY (#161, 2026-07-16): the three purchase dialogs (packs, single lease
// credit, $499 add-workspace) confirmed with stripe.confirmCardPayment, which
// can only complete type:'card' methods — a Stripe-Link-paying customer
// (Checkout's DEFAULT) could not buy anything. stripe.confirmPayment with
// redirect:'if_required' completes any non-redirect method in-page and
// resolves with the same { error } / { paymentIntent } shape
// confirmCardPayment produced, so callers' error branches carry over
// unchanged.
//
// TRADEOFF — redirect-based methods: `redirect: 'if_required'` keeps card
// (3DS iframe), Link, and wallet confirmations in-page, which is the entire
// realistic saved-method set here. A method that genuinely REQUIRES a full-page
// redirect would navigate away to return_url (the caller's current page) and
// lose the dialog's in-memory state machine on return; the URL would also carry
// Stripe's `payment_intent_client_secret`/`redirect_status` params, which no
// caller consumes today. This is an accepted dead-end, not an integrity break:
// the webhook promotes/grants regardless of the client, and an interrupted
// add-workspace stays recoverable via the sidebar "Resume setup" affordance. If
// a redirect method ever becomes reachable, add a `?purchase=return` handler
// (mirroring the existing `?portal=return`).
//
// Every purchase surface MUST use this helper instead of confirmCardPayment;
// a static test (paymentMethodAgnosticPurchases.test.ts) enforces it.
import type { PaymentIntentResult, Stripe } from "@stripe/stripe-js";

export async function confirmSavedMethodPayment(
  stripe: Stripe,
  clientSecret: string,
): Promise<PaymentIntentResult> {
  return stripe.confirmPayment({
    clientSecret,
    confirmParams: { return_url: window.location.href },
    redirect: "if_required",
  });
}
