// transfer-workspace-ownership — Workspace Management Phase 3 (spec §4.2).
//
// Transfers control of a workspace from the current owner to an accepted
// member. The actual transfer is a single atomic SECURITY DEFINER RPC
// (transfer_workspace_ownership_locked, migration 20260609180000): the
// workspace row is locked FOR UPDATE, every mutation (promote target,
// mandatorily demote prior owner, swap owner_id) and the owner_transferred
// audit row commit in one transaction, so the audit trail can never assert
// a transfer the database didn't do. Service-role is required because the
// workspaces UPDATE policy blocks authenticated owner_id reassignment.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true at deploy)
//   - Caller's user.id MUST equal workspaces.owner_id — enforced both by
//     a pre-check here (so non-owners can't burn the rate-limit quota)
//     and authoritatively inside the RPC under the row lock.
//   - "Missing" and "not yours" get the SAME 404 answer — no
//     workspace-existence oracle for non-owners.
//
// BILLING SAFETY (P0-e, 2026-07-16): a workspace with an ACTIVE subscription
// cannot be transferred. The subscription is tied to the prior owner's Stripe
// customer; transferring anyway left the prior owner billed for a workspace they
// no longer own AND made the new owner's next create-workspace inherit the prior
// owner's customer/card (resolveCustomerAndPaymentMethod prefers an owned
// Business workspace's stripe_customer_id). We now REQUIRE billing to be resolved
// first (cancel in Settings → Billing), then transfer, then the new owner
// subscribes on their own card. This uses only existing mechanisms and is the
// least-surprising default; a future "transfer + re-subscribe in one step" flow
// could relax it. Policy choice — flagged for owner confirmation.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestBody {
  workspaceId: string;
  targetUserId: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { ok: false, error: "Unauthorized", reason: "no_auth" },
      401,
      origin,
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse(
      { ok: false, error: "Invalid authentication", reason: "invalid_auth" },
      401,
      origin,
    );
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body", reason: "bad_request" },
      400,
      origin,
    );
  }

  const workspaceId = body?.workspaceId;
  const targetUserId = body?.targetUserId;
  if (!workspaceId || typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) {
    return jsonResponse(
      { ok: false, error: "workspaceId must be a valid UUID", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!targetUserId || typeof targetUserId !== "string" || !UUID_RE.test(targetUserId)) {
    return jsonResponse(
      { ok: false, error: "targetUserId must be a valid UUID", reason: "bad_request" },
      400,
      origin,
    );
  }

  // ── Advisory owner pre-check ─────────────────────────────────────────
  // Keeps non-owners from burning the workspace's rate-limit quota. The
  // RPC re-checks authoritatively under the row lock; this read can be
  // stale without harm. Missing and not-yours get the same 404.
  const { data: preWs, error: preError } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id, subscription_status, stripe_subscription_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (preError) {
    console.error("[transfer-workspace-ownership] precheck error:", preError.message);
    return jsonResponse(
      { ok: false, error: "Failed to load workspace", reason: "internal" },
      500,
      origin,
    );
  }
  const preWsRow = preWs as {
    owner_id: string;
    subscription_status: string | null;
    stripe_subscription_id: string | null;
  } | null;
  if (!preWsRow || preWsRow.owner_id !== user.id) {
    return jsonResponse(
      { ok: false, error: "Workspace not found", reason: "not_found" },
      404,
      origin,
    );
  }

  // ── P0-e billing-safety guard: refuse to transfer a workspace whose
  // subscription is billing the PRIOR owner. Resolve billing first. ──────
  const BILLING_ACTIVE = new Set(["active", "trialing", "past_due", "unpaid"]);
  if (BILLING_ACTIVE.has(preWsRow.subscription_status ?? "") || preWsRow.stripe_subscription_id) {
    return jsonResponse(
      {
        ok: false,
        reason: "active_subscription",
        error:
          "This workspace has an active subscription on your billing account. " +
          "Cancel it first in Settings → Billing, then transfer — the new owner can subscribe on their own card.",
      },
      409,
      origin,
    );
  }

  // ── Rate limit (low ceiling — transfers are rare) ────────────────────
  // Wrapped: the helper throws on rate-limit-table errors, and an uncaught
  // throw would surface to the browser as a CORS failure (no headers on
  // the platform 500), not a JSON error.
  try {
    const rateLimitResponse = await enforceWorkspaceRateLimit(
      supabaseAdmin,
      workspaceId,
      "transfer-workspace-ownership",
      origin,
      5,
    );
    if (rateLimitResponse) return rateLimitResponse;
  } catch (err) {
    console.error(
      "[transfer-workspace-ownership] rate limit check failed:",
      (err as Error)?.message,
    );
    return jsonResponse(
      { ok: false, error: "Rate limit check failed", reason: "internal" },
      500,
      origin,
    );
  }

  console.log(
    `[transfer-workspace-ownership] Owner ${user.id} transferring workspace ${workspaceId} to ${targetUserId}`,
  );

  // ── Atomic transfer via RPC ──────────────────────────────────────────
  const { data: result, error: rpcError } = await supabaseAdmin.rpc(
    "transfer_workspace_ownership_locked",
    {
      p_workspace_id: workspaceId,
      p_caller_id: user.id,
      p_target_user_id: targetUserId,
    },
  );
  if (rpcError) {
    const conflict = rpcError.message?.includes("transfer_conflict");
    console.error("[transfer-workspace-ownership] rpc error:", rpcError.message);
    return jsonResponse(
      conflict
        ? {
            ok: false,
            error: "The workspace changed while transferring — reload and retry",
            reason: "conflict",
          }
        : { ok: false, error: "Failed to transfer ownership", reason: "internal" },
      conflict ? 409 : 500,
      origin,
    );
  }

  const outcome = result as {
    ok: boolean;
    reason?: string;
    new_owner_id?: string;
    billing_transferred?: boolean;
  } | null;
  if (!outcome?.ok) {
    const reason = outcome?.reason ?? "internal";
    const status =
      reason === "not_found" ? 404
      : reason === "already_owner" || reason === "target_not_accepted_member" ? 400
      : 500;
    const message =
      reason === "not_found"
        ? "Workspace not found"
        : reason === "already_owner"
          ? "Target is already the owner of this workspace"
          : reason === "target_not_accepted_member"
            ? "Target must be a member of this workspace who has accepted their invite"
            : "Failed to transfer ownership";
    return jsonResponse({ ok: false, error: message, reason }, status, origin);
  }

  return jsonResponse(
    {
      ok: true,
      workspaceId,
      newOwnerId: targetUserId,
      priorOwnerNewRole: "admin",
      // v1 limitation, surfaced so the UI can tell the prior owner.
      billingTransferred: false,
    },
    200,
    origin,
  );
});
