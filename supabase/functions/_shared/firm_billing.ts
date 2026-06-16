// Phase 10 / KNOWN_ISSUES #105 — firm billing helpers (Deno, edge functions).
//
// Pricing model (PRODUCT_STRATEGY §"Firm-level Stripe billing", decided
// 2026-06-16): a firm pays per-child quantity on the STANDARD Business price —
// one Stripe subscription, quantity = number of bound child workspaces,
// metadata.firm_id set. N children = N × $499/mo. No new firm Product/Price:
// the firm sub reuses BUSINESS_MONTHLY_PRICE_ID.
//
// The quantity is always RECOMPUTED from the live child count (idempotent,
// drift-free) — every bind/release/create just calls syncFirmSubscriptionQuantity.

import Stripe from "https://esm.sh/stripe@18.5.0";

// Count the firm's bound child workspaces (the billable quantity).
export async function countFirmChildren(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  firmId: string,
): Promise<number> {
  const { count } = await supabaseAdmin
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("firm_id", firmId);
  return count ?? 0;
}

// Set the firm subscription's quantity to its current child count, with
// proration (Stripe charges/credits the partial period). Idempotent. No-op when:
//   * the firm has no subscription yet (quantity is set at sub creation), or
//   * the child count is 0 (winding down — releasing the last child does NOT
//     drop quantity to 0; the firm cancels via the offboarding flow instead, so
//     we never send Stripe a quantity-0 update).
// Returns the applied quantity, or null if it was a no-op.
export async function syncFirmSubscriptionQuantity(
  stripe: Stripe,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  firmId: string,
): Promise<number | null> {
  const { data: firm } = await supabaseAdmin
    .from("firms")
    .select("stripe_subscription_id")
    .eq("id", firmId)
    .maybeSingle();
  const subId = (firm as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
  if (!subId) return null;

  const qty = await countFirmChildren(supabaseAdmin, firmId);
  if (qty < 1) {
    console.warn(`[firm_billing] firm ${firmId} has 0 children — leaving subscription quantity unchanged (offboarding cancels the sub)`);
    return null;
  }

  // Resolve the single subscription item to update its quantity.
  const sub = await stripe.subscriptions.retrieve(subId);
  const item = sub.items?.data?.[0];
  if (!item) {
    console.error(`[firm_billing] firm ${firmId} subscription ${subId} has no items`);
    return null;
  }
  if (item.quantity === qty) return qty; // already in sync — avoid a no-op proration

  await stripe.subscriptions.update(subId, {
    items: [{ id: item.id, quantity: qty }],
    proration_behavior: "create_prorations",
  });
  return qty;
}
