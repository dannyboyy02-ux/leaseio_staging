// Stripe.js loader for the in-app 3DS confirmation step in the multi-workspace
// create flow. Lazy-loaded so a missing key doesn't break unrelated pages.
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.4 + §P2.11 (pressure-test).
//
// Publishable-key prefix is asserted against build MODE: pk_live_ in production,
// pk_test_ everywhere else. A mismatched key (e.g. pk_live_ on a staging deploy)
// would silently route real cards through the wrong account — so the loader
// fails closed with a sentinel and the UI surfaces a "Multi-workspace
// temporarily unavailable" banner.

import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * Returns the singleton Stripe promise, or null if the publishable key is
 * absent or has the wrong prefix for this build MODE. Callers must handle
 * null explicitly — never assume Stripe is available.
 */
export function getStripe(): Promise<Stripe | null> | null {
  if (stripePromise !== null) return stripePromise;
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
  if (!key) return null;
  const isProd = import.meta.env.MODE === "production";
  const expectedPrefix = isProd ? "pk_live_" : "pk_test_";
  if (!key.startsWith(expectedPrefix)) {
    // Fail closed — log once for ops, but never surface the key in the message.
    console.error(
      `[stripe] VITE_STRIPE_PUBLISHABLE_KEY prefix does not match MODE=${import.meta.env.MODE}; expected ${expectedPrefix}*`,
    );
    return null;
  }
  stripePromise = loadStripe(key);
  return stripePromise;
}
