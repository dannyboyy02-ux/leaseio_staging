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
// unchanged. A redirect-based method (rare for saved methods) bounces
// through return_url — we return to the caller's current page.
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
