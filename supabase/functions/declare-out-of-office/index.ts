// declare-out-of-office — Phase 7 Checkpoint 3
//
// User declares an OOO window with a designated delegate. All
// currently-pending steps assigned to this user that fall within the
// OOO window are immediately routed to the delegate.
//
// AUTHORIZATION
//   - Bearer JWT
//   - Caller is the user themselves (admin-on-behalf is a future
//     enhancement; admins can still INSERT directly via service role
//     if absolutely needed)
//
// VALIDATION
//   - workspaceId required, caller must be a member or owner
//   - startsAt < endsAt
//   - delegateUserId required, must be a workspace member, must NOT
//     be the caller (DB CHECK enforces too)
//   - endsAt must be in the future

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

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
  workspaceId: string;
  startsAt: string;
  endsAt: string;
  delegateUserId: string;
  reason?: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server configuration error" }, 500, origin);

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
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin); }

  if (!body?.workspaceId || !body?.startsAt || !body?.endsAt || !body?.delegateUserId) {
    return jsonResponse(
      { ok: false, error: "workspaceId, startsAt, endsAt, delegateUserId are required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (body.delegateUserId === user.id) {
    return jsonResponse(
      { ok: false, error: "You cannot delegate to yourself.", reason: "self_delegation" },
      400,
      origin,
    );
  }
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return jsonResponse({ ok: false, error: "Invalid date(s).", reason: "bad_request" }, 400, origin);
  }
  if (startsAt >= endsAt) {
    return jsonResponse(
      { ok: false, error: "starts_at must be before ends_at.", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (endsAt < new Date()) {
    return jsonResponse(
      { ok: false, error: "ends_at must be in the future.", reason: "bad_request" },
      400,
      origin,
    );
  }

  // Verify caller is workspace member/owner
  let isMember = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", body.workspaceId)
    .maybeSingle();
  if ((ws as any)?.owner_id === user.id) isMember = true;
  if (!isMember) {
    const { data: m } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", body.workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (m) isMember = true;
  }
  if (!isMember) {
    return jsonResponse({ ok: false, error: "Not a workspace member.", reason: "not_a_member" }, 403, origin);
  }

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed). This gates the WHOLE
  // mutation path, including the personal user_out_of_office insert:
  // the OOO row and the chain routing are one request flow, and
  // persisting the row before a 403 on the routing half would leave a
  // side effect behind an error response (and seed future OOO-based
  // routing in a read-only workspace).
  const liveness = await checkWorkspaceLive(supabaseAdmin, body.workspaceId);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // Verify delegate is a workspace member or owner
  let delegateIsMember = (ws as any)?.owner_id === body.delegateUserId;
  if (!delegateIsMember) {
    const { data: m } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", body.workspaceId)
      .eq("user_id", body.delegateUserId)
      .maybeSingle();
    delegateIsMember = !!m;
  }
  if (!delegateIsMember) {
    return jsonResponse(
      { ok: false, error: "Delegate must be a workspace member.", reason: "not_a_member" },
      400,
      origin,
    );
  }

  // Insert OOO row
  const { data: oooRow, error: oooError } = await supabaseAdmin
    .from("user_out_of_office")
    .insert({
      user_id: user.id,
      workspace_id: body.workspaceId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      delegate_user_id: body.delegateUserId,
      reason: reason || null,
      is_active: true,
    })
    .select("id")
    .single();
  if (oooError) {
    return jsonResponse(
      { ok: false, error: `Failed to record OOO: ${oooError.message}`, reason: "insert_failed" },
      500,
      origin,
    );
  }
  const oooId = (oooRow as any)?.id;

  // Find currently-pending steps in the OOO window assigned to this
  // user (via approver_user_id or effective_assignee_user_id). Route
  // them to the delegate.
  // We only auto-route IF the OOO window covers "now" at declaration —
  // future-dated OOO windows take effect when the cron flips them in
  // (defer to a future enhancement; for now we apply only to the
  // currently-active steps if the window is "now-ish").
  const nowIso = new Date().toISOString();
  const oooWindowActiveNow = startsAt <= new Date() && endsAt >= new Date();

  let routedCount = 0;
  if (oooWindowActiveNow) {
    const { data: pendingSteps } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("id, lease_id, workspace_id")
      .eq("workspace_id", body.workspaceId)
      .eq("status", "pending")
      .eq("effective_assignee_user_id", user.id);
    const steps = (pendingSteps ?? []) as Array<{ id: string; lease_id: string; workspace_id: string }>;
    for (const s of steps) {
      await supabaseAdmin
        .from("lease_approval_chain")
        .update({
          effective_assignee_user_id: body.delegateUserId,
          assignee_resolution_source: "ooo_delegate",
        })
        .eq("id", s.id);
      const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: s.lease_id,
        user_id: user.id,
        activity_type: "ooo_routed_step",
        details: {
          ooo_id: oooId,
          chain_step_id: s.id,
          original_user_id: user.id,
          delegate_user_id: body.delegateUserId,
        },
      });
      if (auditErr) console.error("lease_activity_log insert failed (ooo_routed_step):", auditErr.message);
      routedCount++;
    }
    if (routedCount > 0) {
      const { error: auditErr2 } = await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: steps[0].lease_id,
        user_id: null,
        activity_type: "comment",
        details: {
          notification_type: "ooo_delegated_steps",
          recipient_ids: [body.delegateUserId],
          message: `${routedCount} approval step(s) have been routed to you while ${user.id} is out of office.`,
        },
      });
      if (auditErr2) console.error("lease_activity_log insert failed (comment/ooo_delegated_steps notification):", auditErr2.message);
    }
  }

  // Global ooo_declared activity row — anchored to a lease-level log.
  // (public.workspace_activity_log now exists — 2026-06-09 Workspace
  // Management Phase 1 — but it's scoped to workspace-lifecycle events,
  // not approval-routing ones, so this stays on lease_activity_log.)
  // The spec says "Insert global activity log" so we attach it to the
  // most recent affected lease. lease_activity_log
  // requires lease_id NOT NULL, so we attach to one of the routed
  // leases (or skip if none — declaring future OOO with no current
  // affected steps is a no-op for the audit log here, captured by the
  // OOO row itself).
  if (routedCount > 0) {
    // Already logged per-step above; the per-step rows are the audit
    // trail. The OOO row in user_out_of_office is the primary record.
    // We don't write a redundant global ooo_declared row.
  }

  return jsonResponse(
    {
      ok: true,
      oooId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      delegateUserId: body.delegateUserId,
      stepsRouted: routedCount,
    },
    200,
    origin,
  );
});
