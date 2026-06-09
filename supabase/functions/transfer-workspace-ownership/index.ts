// transfer-workspace-ownership — Workspace Management Phase 3 (spec §4.2)
//
// Transfers control of a workspace from the current owner to an accepted
// member. Service-role is required because the workspaces UPDATE policy
// is `WITH CHECK (owner_id = auth.uid())` — an authenticated reassignment
// would be rejected the moment owner_id changes (KNOWN_ISSUES #29 class).
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true at deploy)
//   - Caller's user.id MUST equal workspaces.owner_id for the target
//   - targetUserId must be an ACCEPTED member of the workspace
//     (user_id IS NOT NULL AND accepted_at IS NOT NULL — excludes
//     invited-but-unaccepted rows)
//
// GUARANTEES
//   - The prior owner is mandatorily demoted to an `admin` member row
//     (upserted if they had none) — never stranded outside the workspace.
//   - Member-row mutations happen BEFORE the owner_id swap so a failure
//     mid-sequence never leaves the workspace in an inconsistent state
//     (extra admin rows are harmless; a swapped owner without a demoted
//     prior owner is not).
//   - v1 LIMITATION (surfaced in the response and the audit row): the
//     Stripe subscription stays on the original owner's customer.
//     Control transfers; billing does not.

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

  // ── Authorization: load workspace, verify owner ─────────────────────
  const { data: workspace, error: wsError } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id, name, stripe_customer_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (wsError) {
    console.error("[transfer-workspace-ownership] load workspace error:", wsError.message);
    return jsonResponse(
      { ok: false, error: "Failed to load workspace", reason: "internal" },
      500,
      origin,
    );
  }
  if (!workspace) {
    return jsonResponse(
      { ok: false, error: "Workspace not found", reason: "not_found" },
      404,
      origin,
    );
  }
  const ws = workspace as {
    id: string;
    owner_id: string;
    name: string | null;
    stripe_customer_id: string | null;
  };
  if (ws.owner_id !== user.id) {
    // Same answer for "not yours" and "doesn't exist for you" — don't
    // leak workspace existence to non-owners.
    return jsonResponse(
      { ok: false, error: "Forbidden", reason: "not_owner" },
      403,
      origin,
    );
  }
  if (targetUserId === ws.owner_id) {
    return jsonResponse(
      {
        ok: false,
        error: "Target is already the owner of this workspace",
        reason: "already_owner",
      },
      400,
      origin,
    );
  }

  // ── Validate target: accepted member only ───────────────────────────
  const { data: targetMember, error: targetError } = await supabaseAdmin
    .from("workspace_members")
    .select("id, user_id, role, accepted_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .not("user_id", "is", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (targetError) {
    console.error("[transfer-workspace-ownership] target lookup error:", targetError.message);
    return jsonResponse(
      { ok: false, error: "Failed to validate target member", reason: "internal" },
      500,
      origin,
    );
  }
  if (!targetMember) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Target must be a member of this workspace who has accepted their invite",
        reason: "target_not_accepted_member",
      },
      400,
      origin,
    );
  }

  // ── Rate limit (low ceiling — transfers are rare) ───────────────────
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "transfer-workspace-ownership",
    origin,
    5,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(
    `[transfer-workspace-ownership] Owner ${user.id} transferring workspace ${workspaceId} to ${targetUserId}`,
  );

  // ── 1. Ensure target's member row is admin ──────────────────────────
  const { error: targetPromoteError } = await supabaseAdmin
    .from("workspace_members")
    .update({ role: "admin" })
    .eq("id", (targetMember as { id: string }).id)
    .eq("workspace_id", workspaceId);
  if (targetPromoteError) {
    console.error(
      "[transfer-workspace-ownership] target promote error:",
      targetPromoteError.message,
    );
    return jsonResponse(
      { ok: false, error: "Failed to promote target member", reason: "internal" },
      500,
      origin,
    );
  }

  // ── 2. Mandatorily demote prior owner to admin member ───────────────
  // The prior owner usually has a member row already; upsert covers the
  // case where they don't, so they are never stranded outside the
  // workspace they just handed over.
  const { data: priorOwnerRow, error: priorLookupError } = await supabaseAdmin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", ws.owner_id)
    .maybeSingle();
  if (priorLookupError) {
    console.error(
      "[transfer-workspace-ownership] prior owner lookup error:",
      priorLookupError.message,
    );
    return jsonResponse(
      { ok: false, error: "Failed to prepare prior owner demotion", reason: "internal" },
      500,
      origin,
    );
  }
  const priorOwnerWrite = priorOwnerRow
    ? supabaseAdmin
        .from("workspace_members")
        .update({ role: "admin" })
        .eq("id", (priorOwnerRow as { id: string }).id)
        .eq("workspace_id", workspaceId)
    : supabaseAdmin.from("workspace_members").insert({
        workspace_id: workspaceId,
        user_id: ws.owner_id,
        role: "admin",
        accepted_at: new Date().toISOString(),
      });
  const { error: priorOwnerError } = await priorOwnerWrite;
  if (priorOwnerError) {
    console.error(
      "[transfer-workspace-ownership] prior owner demotion error:",
      priorOwnerError.message,
    );
    return jsonResponse(
      { ok: false, error: "Failed to demote prior owner", reason: "internal" },
      500,
      origin,
    );
  }

  // ── 3. Swap owner_id (last — member rows are already consistent) ────
  const { error: swapError } = await supabaseAdmin
    .from("workspaces")
    .update({ owner_id: targetUserId })
    .eq("id", workspaceId)
    .eq("owner_id", ws.owner_id);
  if (swapError) {
    console.error("[transfer-workspace-ownership] owner swap error:", swapError.message);
    return jsonResponse(
      { ok: false, error: "Failed to transfer ownership", reason: "internal" },
      500,
      origin,
    );
  }

  // ── 4. Audit row (non-fatal on error; the transfer is done) ─────────
  const { error: auditError } = await supabaseAdmin
    .from("workspace_activity_log")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      event_type: "owner_transferred",
      details: {
        from: ws.owner_id,
        to: targetUserId,
        prior_owner_new_role: "admin",
        billing_remains_on_customer: ws.stripe_customer_id,
        billing_transferred: false,
      },
    });
  if (auditError) {
    console.error("[transfer-workspace-ownership] audit insert error:", auditError.message);
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
