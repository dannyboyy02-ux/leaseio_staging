import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { syncFirmSubscriptionQuantity } from "../_shared/firm_billing.ts";

// Phase 10 / #107 — firm billing reconcile cron (hard rule #9: no silent vendor
// failures). For every firm with a live Stripe subscription, recompute the
// billed quantity from the live child count and correct any drift left by a
// best-effort sync that silently failed (Stripe rate limit, transient 5xx, etc).
// syncFirmSubscriptionQuantity is idempotent + self-auditing, so this is just a
// sweep. Auth: shared x-cron-secret (verify_jwt=false). No emails, no PII.
const jsonHeaders = { "Content-Type": "application/json" };

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }

  const cronSecret = Deno.env.get("FIRM_BILLING_CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!supabaseUrl || !serviceRoleKey || !stripeKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: jsonHeaders });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  // Firms with a live subscription (the only ones that can drift).
  const { data: firms, error } = await supabaseAdmin
    .from("firms").select("id").not("stripe_subscription_id", "is", null);
  if (error) {
    console.error("[firm-billing-reconcile] firm fetch failed:", error.message);
    return new Response(JSON.stringify({ error: "firm fetch failed" }), { status: 500, headers: jsonHeaders });
  }

  const stats = { checked: 0, in_sync: 0, corrected: 0, canceled: 0, failed: 0 };
  const drifted: Array<{ firm_id: string; old?: number; new?: number }> = [];

  for (const f of (firms ?? []) as Array<{ id: string }>) {
    stats.checked++;
    const r = await syncFirmSubscriptionQuantity(stripe, supabaseAdmin, f.id);
    if (r.status === "updated") { stats.corrected++; drifted.push({ firm_id: f.id, old: r.old, new: r.new }); }
    else if (r.status === "canceled_no_children") stats.canceled++;
    else if (r.status === "failed") stats.failed++;
    else if (r.status === "in_sync") stats.in_sync++;
  }

  if (stats.corrected > 0 || stats.failed > 0) {
    console.warn(`[firm-billing-reconcile] drift detected — corrected=${stats.corrected} failed=${stats.failed}`, JSON.stringify(drifted));
  }
  return new Response(JSON.stringify({ ok: true, stats, drifted }), { status: 200, headers: jsonHeaders });
});
