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
export type FirmSyncResult = { status: "no_sub" | "in_sync" | "updated" | "canceled_no_children" | "failed"; old?: number; new?: number };

// deno-lint-ignore no-explicit-any
async function audit(supabaseAdmin: any, firmId: string, activity_type: string, details: Record<string, unknown>) {
  await supabaseAdmin.from("firm_activity_log").insert({ firm_id: firmId, user_id: null, activity_type, details });
}

export async function syncFirmSubscriptionQuantity(
  stripe: Stripe,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  firmId: string,
): Promise<FirmSyncResult> {
  const { data: firm } = await supabaseAdmin
    .from("firms")
    .select("stripe_subscription_id")
    .eq("id", firmId)
    .maybeSingle();
  const subId = (firm as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
  if (!subId) return { status: "no_sub" };

  const qty = await countFirmChildren(supabaseAdmin, firmId);
  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    const item = sub.items?.data?.[0];
    if (!item) {
      console.error(`[firm_billing] firm ${firmId} subscription ${subId} has no items`);
      await audit(supabaseAdmin, firmId, "firm_billing_quantity_changed", { sync_failed: true, reason: "no_items", attempted_quantity: qty, subscription_id: subId });
      return { status: "failed" };
    }
    const oldQty = item.quantity ?? 0;

    if (qty < 1) {
      // Offboarding: the firm has no children left. Cancel at period end (never
      // send Stripe quantity 0). Idempotent — skip if already cancelling/canceled.
      if (!sub.cancel_at_period_end && sub.status !== "canceled") {
        await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
        await audit(supabaseAdmin, firmId, "firm_billing_subscription_canceled", { reason: "no_children", subscription_id: subId, cancel_at_period_end: true });
      }
      return { status: "canceled_no_children", old: oldQty, new: 0 };
    }

    // qty >= 1. A firm that released its last child (sub set to
    // cancel_at_period_end) and then re-bound one MUST un-cancel — otherwise the
    // sub still cancels and the now-active firm runs for free. So un-cancel even
    // when the quantity already matches (the in_sync early-return only applies
    // when there is nothing to cancel).
    const needsUncancel = sub.cancel_at_period_end === true;
    if (oldQty === qty && !needsUncancel) return { status: "in_sync", old: oldQty, new: qty };

    await stripe.subscriptions.update(subId, {
      items: [{ id: item.id, quantity: qty }],
      proration_behavior: "create_prorations",
      ...(needsUncancel ? { cancel_at_period_end: false } : {}),
    });
    await audit(supabaseAdmin, firmId, "firm_billing_quantity_changed", { old_quantity: oldQty, new_quantity: qty, subscription_id: subId, ...(needsUncancel ? { uncanceled: true } : {}) });
    return { status: "updated", old: oldQty, new: qty };
  } catch (e) {
    // Record the failure so a silent vendor failure is queryable (hard rule #9).
    // Best-effort: never throw (callers treat sync as fire-and-forget; the
    // reconcile cron catches any drift this failure leaves behind).
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[firm_billing] sync failed for firm ${firmId}:`, msg);
    await audit(supabaseAdmin, firmId, "firm_billing_quantity_changed", { sync_failed: true, error: msg, attempted_quantity: qty, subscription_id: subId })
      .catch((ae: unknown) => console.error(`[firm_billing] failure-audit insert also failed for firm ${firmId}:`, ae instanceof Error ? ae.message : String(ae)));
    return { status: "failed" };
  }
}
