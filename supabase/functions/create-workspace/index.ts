// create-workspace — owner-level multi-workspace for Business
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md (v2, pressure-tested 2026-06-09).
//
// Lets a Business account holder create an additional workspace (up to 10),
// each its own $499/mo Business subscription on the owner's existing Stripe
// customer (card on file), with an explicit in-app confirmation modal.
//
// Modes (request body { mode, name?, idempotencyKey?, workspaceId? }):
//   preview  — read-only: returns card last4 + price + eligibility so the modal
//              can render honest consent copy. No writes.
//   confirm  — atomic gated insert via create_workspace_locked() RPC, then
//              create an ON-SESSION default_incomplete Stripe subscription and
//              return its PaymentIntent client_secret. Does NOT promote the
//              workspace — the webhook is the sole entitlement writer, promoting
//              after the client confirms payment (handles 3DS in-app).
//   cancel   — client calls on decline / 3DS dismissal: cancel the incomplete
//              subscription and delete the still-pending workspace.
//
// Authorization: Bearer JWT (verify_jwt = true). Eligibility (must own an active
// Business workspace + under cap + has a card) is enforced server-side; the RPC
// is service_role-only so creation cannot bypass the paying path here.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  BUSINESS_MONTHLY_PRICE_ID,
  BUSINESS_MONTHLY_PRICE_USD,
  WORKSPACE_LIMITS,
} from "../_shared/workspace_limits.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}
function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

interface RequestBody {
  mode?: "preview" | "confirm" | "cancel";
  name?: string;
  idempotencyKey?: string;
  workspaceId?: string;
}

// Resolve the caller's Stripe customer (prefer an existing Business workspace's
// stripe_customer_id; fall back to email lookup) and its default card.
async function resolveCustomerAndCard(
  stripe: Stripe,
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  userEmail: string | undefined,
): Promise<
  | { ok: true; customerId: string; pmId: string; cardLast4: string | null; cardBrand: string | null }
  | { ok: false; reason: "no_customer" | "no_card_on_file" }
> {
  // Prefer an authoritative customer id from an existing Business workspace.
  let customerId: string | null = null;
  const { data: bizWs } = await supabaseAdmin
    .from("workspaces")
    .select("stripe_customer_id")
    .eq("owner_id", userId)
    .eq("plan", "business")
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();
  customerId = (bizWs as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;

  if (!customerId && userEmail) {
    const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
    customerId = customers.data[0]?.id ?? null;
  }
  if (!customerId) return { ok: false, reason: "no_customer" };

  // Default payment method: prefer invoice_settings.default_payment_method,
  // fall back to the first attached card. The explicit id is load-bearing —
  // a charge with no PM resolved would fail.
  const customer = await stripe.customers.retrieve(customerId);
  let pmId: string | null = null;
  if (customer && !("deleted" in customer && customer.deleted)) {
    const dpm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    pmId = typeof dpm === "string" ? dpm : dpm?.id ?? null;
  }
  if (!pmId) {
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    pmId = pms.data[0]?.id ?? null;
  }
  if (!pmId) return { ok: false, reason: "no_card_on_file" };

  const pm = await stripe.paymentMethods.retrieve(pmId);
  return {
    ok: true,
    customerId,
    pmId,
    cardLast4: pm.card?.last4 ?? null,
    cardBrand: pm.card?.brand ?? null,
  };
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!supabaseUrl || !serviceRoleKey || !stripeKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin);
  }
  const mode = body.mode ?? "preview";
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  // ── PREVIEW ───────────────────────────────────────────────────────────
  if (mode === "preview") {
    const card = await resolveCustomerAndCard(stripe, supabaseAdmin, user.id, user.email);
    // Eligibility snapshot (advisory; the authoritative gate is the RPC).
    const [{ count: ownedCount }, { count: bizCount }] = await Promise.all([
      supabaseAdmin.from("workspaces").select("id", { count: "exact", head: true }).eq("owner_id", user.id),
      supabaseAdmin
        .from("workspaces")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("plan", "business")
        .in("subscription_status", ["active", "trialing"]),
    ]);
    const cap = WORKSPACE_LIMITS.business;
    const eligible = (bizCount ?? 0) >= 1 && (ownedCount ?? 0) < cap && card.ok;
    return jsonResponse(
      {
        ok: true,
        eligible,
        reason: !card.ok ? card.reason : (bizCount ?? 0) < 1 ? "not_eligible" : (ownedCount ?? 0) >= cap ? "cap_reached" : null,
        cardLast4: card.ok ? card.cardLast4 : null,
        cardBrand: card.ok ? card.cardBrand : null,
        priceMonthly: BUSINESS_MONTHLY_PRICE_USD,
        chargedToday: BUSINESS_MONTHLY_PRICE_USD,
        count: ownedCount ?? 0,
        cap,
      },
      200,
      origin,
    );
  }

  // ── CANCEL ────────────────────────────────────────────────────────────
  if (mode === "cancel") {
    const workspaceId = body.workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return jsonResponse({ ok: false, reason: "bad_request", error: "workspaceId required" }, 400, origin);
    }
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, name, plan, subscription_status")
      .eq("id", workspaceId)
      .maybeSingle();
    const w = ws as { id: string; owner_id: string; name: string | null; plan: string | null; subscription_status: string | null } | null;
    if (!w) return jsonResponse({ ok: false, reason: "not_found" }, 404, origin);
    if (w.owner_id !== user.id) return jsonResponse({ ok: false, reason: "not_owner" }, 403, origin);
    // Only a still-pending (Starter, not yet activated) workspace may be cancelled here.
    if (w.plan !== "starter" || (w.subscription_status && ["active", "trialing"].includes(w.subscription_status))) {
      return jsonResponse({ ok: false, reason: "not_pending" }, 409, origin);
    }

    // Cancel any incomplete subscription Stripe created for this workspace.
    try {
      const subs = await stripe.subscriptions.list({ status: "incomplete", limit: 100 });
      for (const s of subs.data) {
        if (s.metadata?.workspace_id === workspaceId) {
          await stripe.subscriptions.cancel(s.id).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[create-workspace] cancel: stripe cleanup failed:", (e as Error)?.message);
    }

    // Delete the pending workspace (no leases yet) + forensic row + dedupe mark.
    await supabaseAdmin.from("workspaces").delete().eq("id", workspaceId);
    await supabaseAdmin.from("deleted_workspaces").insert({
      original_workspace_id: workspaceId,
      owner_id: w.owner_id,
      workspace_name: w.name,
      workspace_plan: w.plan,
      lease_count_at_deletion: 0,
      member_count_at_deletion: 1,
      storage_objects_purged: 0,
      deleted_by: user.id,
    });
    await supabaseAdmin
      .from("workspace_creation_requests")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId);

    return jsonResponse({ ok: true, workspaceId, status: "canceled" }, 200, origin);
  }

  // ── CONFIRM ───────────────────────────────────────────────────────────
  if (mode !== "confirm") {
    return jsonResponse({ ok: false, reason: "bad_request", error: "unknown mode" }, 400, origin);
  }

  const name = (body.name ?? "").trim();
  const idempotencyKey = body.idempotencyKey;
  if (name.length < 1 || name.length > 100) {
    return jsonResponse({ ok: false, reason: "invalid_name", error: "Name must be 1–100 characters" }, 400, origin);
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return jsonResponse({ ok: false, reason: "bad_request", error: "idempotencyKey required" }, 400, origin);
  }

  // Rate limit, anchored on the caller's current workspace (the new one doesn't
  // exist yet). Creation is rare; 10/hour blocks abuse loops.
  const { data: prof } = await supabaseAdmin
    .from("profiles")
    .select("current_workspace_id")
    .eq("id", user.id)
    .maybeSingle();
  const anchorWs = (prof as { current_workspace_id: string | null } | null)?.current_workspace_id ?? null;
  if (anchorWs) {
    const rl = await enforceWorkspaceRateLimit(supabaseAdmin, anchorWs, "create-workspace", origin, 10);
    if (rl) return rl;
  }

  // Resolve card BEFORE the gated insert so we never create a workspace we
  // can't bill (no_card_on_file / no_customer short-circuit here).
  const card = await resolveCustomerAndCard(stripe, supabaseAdmin, user.id, user.email);
  if (!card.ok) return jsonResponse({ ok: false, reason: card.reason }, 402, origin);

  // Atomic gated insert (advisory lock + eligibility + cap + insert + audit).
  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc("create_workspace_locked", {
    p_owner_id: user.id,
    p_name: name,
    p_idempotency_key: idempotencyKey,
  });
  if (rpcError) {
    console.error("[create-workspace] rpc error:", rpcError.message);
    return jsonResponse({ ok: false, reason: "internal", error: "Could not create workspace" }, 500, origin);
  }
  const result = rpcData as {
    status: string;
    workspace_id?: string;
    request_status?: string;
    count?: number;
    cap?: number;
  };

  if (result.status === "not_eligible") return jsonResponse({ ok: false, reason: "not_eligible" }, 403, origin);
  if (result.status === "cap_reached") {
    return jsonResponse({ ok: false, reason: "cap_reached", count: result.count, cap: result.cap }, 409, origin);
  }
  if (result.status === "invalid_name") {
    return jsonResponse({ ok: false, reason: "invalid_name" }, 400, origin);
  }
  if (result.status === "duplicate") {
    // Idempotent replay: the workspace already exists for this key. Don't create
    // a second subscription. The client should refetch state / re-confirm the
    // existing PaymentIntent if still pending.
    return jsonResponse(
      { ok: true, workspaceId: result.workspace_id, status: "duplicate", requestStatus: result.request_status },
      200,
      origin,
    );
  }
  if (result.status !== "created" || !result.workspace_id) {
    return jsonResponse({ ok: false, reason: "internal", error: "Unexpected RPC result" }, 500, origin);
  }
  const workspaceId = result.workspace_id;

  // Create the subscription ON-SESSION (the customer is present and will
  // confirm) so a 3DS card yields a completable PaymentIntent instead of a hard
  // off-session decline. No trial, no billing_cycle_anchor (keeps "$499 today"
  // honest). The webhook promotes the workspace once payment confirms.
  try {
    const subscription = await stripe.subscriptions.create(
      {
        customer: card.customerId,
        items: [{ price: BUSINESS_MONTHLY_PRICE_ID }],
        default_payment_method: card.pmId,
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.payment_intent"],
        metadata: { workspace_id: workspaceId, plan_id: "business", billing_interval: "monthly" },
      },
      { idempotencyKey: `ws_create_${idempotencyKey}` },
    );

    const invoice = subscription.latest_invoice as Stripe.Invoice | null;
    const pi = invoice?.payment_intent as Stripe.PaymentIntent | null;
    const clientSecret = pi?.client_secret ?? null;

    return jsonResponse(
      {
        ok: true,
        workspaceId,
        status: "pending",
        clientSecret,
        paymentIntentStatus: pi?.status ?? null,
      },
      200,
      origin,
    );
  } catch (e) {
    // Stripe API error (not a card decline — those surface client-side under
    // default_incomplete). Roll back the just-created workspace so no orphaned
    // unpaid workspace lingers, and mark the dedupe row failed.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[create-workspace] subscription create failed, rolling back:", msg);
    await supabaseAdmin.from("workspaces").delete().eq("id", workspaceId);
    await supabaseAdmin
      .from("workspace_creation_requests")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId);
    return jsonResponse({ ok: false, reason: "stripe_error", error: msg }, 502, origin);
  }
});
