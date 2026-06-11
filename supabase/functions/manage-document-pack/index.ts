// manage-document-pack — buy / list / cancel recurring document capacity packs
//
// Spec: PRODUCT_STRATEGY.md Decision 4; pricing in src/config/pricing.ts +
// _shared/document_packs.ts. A pack is its own Stripe subscription tagged
// metadata.addon_type='document_pack' so the webhook recomputes the workspace's
// addon_document_capacity (sum of active pack sizes) without ever touching the
// plan. Full price charged on purchase, no proration, cancel-at-period-end.
//
// Modes (body { mode, workspaceId, packId?, subscriptionId?, idempotencyKey? }):
//   preview — read-only: card on file + current capacity + the workspace's
//             active packs + which catalog packs are configured. No writes.
//   confirm — create an ON-SESSION default_incomplete pack subscription on the
//             workspace's existing Stripe customer/card; return the
//             PaymentIntent client_secret so the client can confirm (3DS). The
//             webhook mirrors capacity once payment succeeds. Does NOT touch the
//             workspace row (the webhook is the sole entitlement writer).
//   cancel  — set cancel_at_period_end on a pack subscription owned by this
//             workspace; capacity persists until the period ends.
//
// Authorization: Bearer JWT (verify_jwt = true) + workspace owner/admin.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  ADDON_TYPE_DOCUMENT_PACK,
  DOCUMENT_PACKS,
  packPriceId,
} from "../_shared/document_packs.ts";

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
  workspaceId?: string;
  packId?: string;
  subscriptionId?: string;
  idempotencyKey?: string;
}

interface WorkspaceRow {
  id: string;
  owner_id: string;
  stripe_customer_id: string | null;
  addon_document_capacity: number | null;
}

// Owner OR workspace admin may manage billing (matches create-checkout).
async function canManageBilling(
  supabaseAdmin: ReturnType<typeof createClient>,
  ws: WorkspaceRow,
  userId: string,
): Promise<boolean> {
  if (ws.owner_id === userId) return true;
  const { data: membership } = await supabaseAdmin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", ws.id)
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(membership);
}

// Resolve the workspace's Stripe customer (prefer the stored id) and default card.
async function resolveCard(
  stripe: Stripe,
  supabaseAdmin: ReturnType<typeof createClient>,
  ws: WorkspaceRow,
  userEmail: string | undefined,
): Promise<
  | { ok: true; customerId: string; pmId: string; cardLast4: string | null; cardBrand: string | null }
  | { ok: false; reason: "no_customer" | "no_card_on_file" }
> {
  let customerId = ws.stripe_customer_id;
  if (!customerId && userEmail) {
    const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
    customerId = customers.data[0]?.id ?? null;
  }
  if (!customerId) return { ok: false, reason: "no_customer" };

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
  return { ok: true, customerId, pmId, cardLast4: pm.card?.last4 ?? null, cardBrand: pm.card?.brand ?? null };
}

// The workspace's active/cancelable pack subscriptions, for the preview list.
async function listActivePacks(stripe: Stripe, customerId: string, workspaceId: string) {
  const packs: Array<{
    subscriptionId: string;
    packId: string;
    size: number;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  }> = [];
  let startingAfter: string | undefined = undefined;
  while (true) {
    const page: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      starting_after: startingAfter,
    });
    for (const s of page.data) {
      if (
        s.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK &&
        s.metadata?.workspace_id === workspaceId &&
        (s.status === "active" || s.status === "trialing")
      ) {
        const periodEnd = (s as unknown as { current_period_end?: number }).current_period_end;
        packs.push({
          subscriptionId: s.id,
          packId: s.metadata?.pack_id ?? "",
          size: Number.parseInt(s.metadata?.pack_size ?? "0", 10) || 0,
          status: s.status,
          cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
          currentPeriodEnd: typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null,
        });
      }
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return packs;
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

  const workspaceId = body.workspaceId;
  if (!workspaceId || typeof workspaceId !== "string") {
    return jsonResponse({ ok: false, reason: "bad_request", error: "workspaceId required" }, 400, origin);
  }

  // Load + authorize the workspace.
  const { data: wsData } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id, stripe_customer_id, addon_document_capacity")
    .eq("id", workspaceId)
    .maybeSingle();
  const ws = wsData as WorkspaceRow | null;
  if (!ws) return jsonResponse({ ok: false, reason: "not_found" }, 404, origin);
  if (!(await canManageBilling(supabaseAdmin, ws, user.id))) {
    return jsonResponse({ ok: false, reason: "forbidden", error: "Billing is admin-only" }, 403, origin);
  }

  const mode = body.mode ?? "preview";
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  // Catalog with per-pack configured flag (Stripe price id present in env).
  const catalog = Object.values(DOCUMENT_PACKS).map((p) => ({
    id: p.id,
    size: p.size,
    priceMonthlyUsd: p.priceMonthlyUsd,
    configured: Boolean(packPriceId(p)),
  }));

  // ── PREVIEW ───────────────────────────────────────────────────────────
  if (mode === "preview") {
    const card = await resolveCard(stripe, supabaseAdmin, ws, user.email);
    const activePacks = card.ok ? await listActivePacks(stripe, card.customerId, workspaceId) : [];
    return jsonResponse(
      {
        ok: true,
        eligible: card.ok,
        reason: card.ok ? null : card.reason,
        cardLast4: card.ok ? card.cardLast4 : null,
        cardBrand: card.ok ? card.cardBrand : null,
        currentCapacity: Math.max(0, Number(ws.addon_document_capacity ?? 0)),
        activePacks,
        catalog,
      },
      200,
      origin,
    );
  }

  // ── CANCEL ────────────────────────────────────────────────────────────
  if (mode === "cancel") {
    const subscriptionId = body.subscriptionId;
    if (!subscriptionId || typeof subscriptionId !== "string") {
      return jsonResponse({ ok: false, reason: "bad_request", error: "subscriptionId required" }, 400, origin);
    }
    let sub: Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    } catch {
      return jsonResponse({ ok: false, reason: "not_found" }, 404, origin);
    }
    // Hard ownership check: the subscription must be a document pack belonging to
    // THIS workspace. Prevents canceling another workspace's (or the plan's) sub.
    if (
      sub.metadata?.addon_type !== ADDON_TYPE_DOCUMENT_PACK ||
      sub.metadata?.workspace_id !== workspaceId
    ) {
      return jsonResponse({ ok: false, reason: "forbidden" }, 403, origin);
    }
    const updated = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    const periodEnd = (updated as unknown as { current_period_end?: number }).current_period_end;
    return jsonResponse(
      {
        ok: true,
        subscriptionId,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null,
      },
      200,
      origin,
    );
  }

  // ── CONFIRM (buy) ───────────────────────────────────────────────────────
  if (mode !== "confirm") {
    return jsonResponse({ ok: false, reason: "bad_request", error: "unknown mode" }, 400, origin);
  }

  const packId = body.packId;
  const idempotencyKey = body.idempotencyKey;
  if (!packId || !DOCUMENT_PACKS[packId]) {
    return jsonResponse({ ok: false, reason: "invalid_pack" }, 400, origin);
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return jsonResponse({ ok: false, reason: "bad_request", error: "idempotencyKey required" }, 400, origin);
  }
  const pack = DOCUMENT_PACKS[packId];
  const priceId = packPriceId(pack);
  if (!priceId) {
    // Operator hasn't created this pack's Stripe Price yet — fail closed,
    // never charge against a missing/wrong price.
    return jsonResponse({ ok: false, reason: "pack_not_configured" }, 503, origin);
  }

  // Rate limit pack purchases (rare action) anchored on the workspace.
  const rl = await enforceWorkspaceRateLimit(supabaseAdmin, workspaceId, "manage-document-pack", origin, 10);
  if (rl) return rl;

  // Defense against operator misconfiguration: confirm the resolved Stripe
  // Price actually charges what the catalog advertises (and is a recurring
  // monthly price) before we create a subscription. A price id pointed at the
  // wrong amount would otherwise charge a number that doesn't match the consent
  // copy the user just agreed to. Fail closed on any mismatch.
  try {
    const price = await stripe.prices.retrieve(priceId);
    const expectedCents = pack.priceMonthlyUsd * 100;
    if (
      price.unit_amount !== expectedCents ||
      price.currency !== "usd" ||
      price.recurring?.interval !== "month"
    ) {
      console.error(
        `[manage-document-pack] price mismatch for ${pack.id}: got ${price.unit_amount} ${price.currency} ${price.recurring?.interval}, expected ${expectedCents} usd month`,
      );
      return jsonResponse({ ok: false, reason: "pack_price_mismatch" }, 503, origin);
    }
  } catch {
    return jsonResponse({ ok: false, reason: "pack_not_configured" }, 503, origin);
  }

  const card = await resolveCard(stripe, supabaseAdmin, ws, user.email);
  if (!card.ok) return jsonResponse({ ok: false, reason: card.reason }, 402, origin);

  try {
    const subscription = await stripe.subscriptions.create(
      {
        customer: card.customerId,
        items: [{ price: priceId }],
        default_payment_method: card.pmId,
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.payment_intent"],
        metadata: {
          workspace_id: workspaceId,
          addon_type: ADDON_TYPE_DOCUMENT_PACK,
          pack_id: pack.id,
          pack_size: String(pack.size),
        },
      },
      { idempotencyKey: `pack_${workspaceId}_${idempotencyKey}` },
    );

    const invoice = subscription.latest_invoice as unknown as
      { payment_intent?: Stripe.PaymentIntent | null } | null;
    const pi = invoice?.payment_intent ?? null;

    return jsonResponse(
      {
        ok: true,
        subscriptionId: subscription.id,
        packId: pack.id,
        size: pack.size,
        clientSecret: pi?.client_secret ?? null,
        paymentIntentStatus: pi?.status ?? null,
      },
      200,
      origin,
    );
  } catch (e) {
    // Log the full Stripe error server-side; return a generic reason so we
    // never leak internal detail (price/customer ids) to the client.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[manage-document-pack] subscription create failed:", msg);
    return jsonResponse({ ok: false, reason: "stripe_error" }, 502, origin);
  }
});
