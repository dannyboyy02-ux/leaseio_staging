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
 * Which publishable-key prefix this deploy must carry. An explicit
 * VITE_STRIPE_KEY_MODE declaration ('live' | 'test') wins; otherwise the
 * fail-closed default stands: production builds require pk_live_, everything
 * else pk_test_. Exported for the unit test — the payment-routing guard's
 * truth table must be pinned.
 */
export function expectedKeyPrefix(
  declaredMode: string | undefined,
  buildMode: string,
): "pk_live_" | "pk_test_" {
  if (declaredMode === "test") return "pk_test_";
  if (declaredMode === "live") return "pk_live_";
  return buildMode === "production" ? "pk_live_" : "pk_test_";
}

/**
 * Returns the singleton Stripe promise, or null if the publishable key is
 * absent or has the wrong prefix for this build MODE. Callers must handle
 * null explicitly — never assume Stripe is available.
 */
export function getStripe(): Promise<Stripe | null> | null {
  if (stripePromise !== null) return stripePromise;
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
  if (!key) return null;
  // The expected key mode comes from an EXPLICIT deploy declaration first —
  // VITE_STRIPE_KEY_MODE ('live' | 'test') — because build mode and Stripe
  // mode are different axes: during pre-launch the production DOMAIN runs
  // against test-mode Stripe end-to-end, and inferring "production build ⇒
  // pk_live_" made in-app payments structurally impossible there (2026-07-18
  // incident: "Payment configuration is missing" on theleaseio.com). The
  // fail-closed default is unchanged: with no declaration, a production build
  // still requires pk_live_. At live cutover, swap the key AND flip/remove
  // VITE_STRIPE_KEY_MODE together — the assertion catches either half done
  // alone (pk_test_ with mode live fails, pk_live_ with mode test fails).
  const expectedPrefix = expectedKeyPrefix(
    import.meta.env.VITE_STRIPE_KEY_MODE as string | undefined,
    import.meta.env.MODE,
  );
  if (!key.startsWith(expectedPrefix)) {
    // Fail closed — log once for ops, but never surface the key in the message.
    console.error(
      `[stripe] VITE_STRIPE_PUBLISHABLE_KEY prefix does not match the expected Stripe mode (${expectedPrefix}*); check VITE_STRIPE_KEY_MODE / MODE=${import.meta.env.MODE}`,
    );
    return null;
  }
  stripePromise = loadStripe(key);
  return stripePromise;
}
