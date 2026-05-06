// assign-execution-owner — Phase 5 Checkpoint 3
//
// Reassigns the execution owner of a lease in pending_counter_signature.
// The execution owner is the person responsible for chasing the
// counter-signed document; they receive reminders from
// send-counter-signature-reminder and act via record-counter-signature.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true)
//   - Caller must be ONE OF:
//       (a) the lease submitter (requestor_id === user.id OR user_id === user.id)
//       (b) the current execution_owner_id
//       (c) the workspace owner
//       (d) a workspace admin (workspace_members.role = 'admin')
//
// PRECONDITIONS
//   - leases.lifecycle_status MUST be 'pending_counter_signature'.
//   - newOwnerId MUST be a member of the workspace (or the owner).
//
// EFFECTS
//   1. UPDATE leases SET execution_owner_id = newOwnerId
//   2. INSERT lease_activity_log execution_owner_reassigned with
//      prior owner, new owner, reason. NOT a status_change — the
//      lifecycle_status stays at pending_counter_signature.
//   3. Notify the new execution owner.

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

interface RequestBody {
  leaseId: string;
  newOwnerId: string;
  reason?: string;
}

interface LeaseRow {
  id: string;
  workspace_id: string;
  lifecycle_status: string;
  requestor_id: string | null;
  user_id: string | null;
  execution_owner_id: string | null;
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

  // ── Body validation ────────────────────────────────────────────────
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

  if (!body?.leaseId || typeof body.leaseId !== "string") {
    return jsonResponse(
      { ok: false, error: "leaseId is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!body?.newOwnerId || typeof body.newOwnerId !== "string") {
    return jsonResponse(
      { ok: false, error: "newOwnerId is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  // ── Load lease + verify state ──────────────────────────────────────
  const { data: leaseData, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, requestor_id, user_id, execution_owner_id")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[assign-execution-owner] lease load error:", leaseError.message);
    return jsonResponse(
      { ok: false, error: "Failed to load lease", reason: "internal" },
      500,
      origin,
    );
  }
  if (!leaseData) {
    return jsonResponse(
      { ok: false, error: "Lease not found", reason: "not_found" },
      404,
      origin,
    );
  }
  const lease = leaseData as LeaseRow;

  if (lease.lifecycle_status !== "pending_counter_signature") {
    return jsonResponse(
      {
        ok: false,
        error:
          `Cannot reassign: lease is in '${lease.lifecycle_status}', not 'pending_counter_signature'`,
        reason: "wrong_state",
      },
      409,
      origin,
    );
  }

  // ── Authorization ──────────────────────────────────────────────────
  const isSubmitter =
    lease.requestor_id === user.id || lease.user_id === user.id;
  const isCurrentOwner = lease.execution_owner_id === user.id;

  let isOwnerOrAdmin = false;
  if (!isSubmitter && !isCurrentOwner) {
    const { data: ownerRow } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", lease.workspace_id)
      .maybeSingle();
    if ((ownerRow as { owner_id: string } | null)?.owner_id === user.id) {
      isOwnerOrAdmin = true;
    }
    if (!isOwnerOrAdmin) {
      const { data: memberRow } = await supabaseAdmin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", lease.workspace_id)
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (memberRow) isOwnerOrAdmin = true;
    }
  }

  if (!isSubmitter && !isCurrentOwner && !isOwnerOrAdmin) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Forbidden — only the submitter, current execution owner, workspace owner, or workspace admin can reassign",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  // ── Verify newOwnerId is a workspace member or the workspace owner ──
  const { data: newOwnerWorkspaceCheck } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", lease.workspace_id)
    .maybeSingle();
  const newOwnerIsWorkspaceOwner =
    (newOwnerWorkspaceCheck as { owner_id: string } | null)?.owner_id === body.newOwnerId;

  let newOwnerIsMember = newOwnerIsWorkspaceOwner;
  if (!newOwnerIsMember) {
    const { data: memberCheck } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", lease.workspace_id)
      .eq("user_id", body.newOwnerId)
      .maybeSingle();
    newOwnerIsMember = Boolean(memberCheck);
  }

  if (!newOwnerIsMember) {
    return jsonResponse(
      {
        ok: false,
        error: "New owner must be a workspace member",
        reason: "not_a_member",
      },
      400,
      origin,
    );
  }

  // ── Rate limit ─────────────────────────────────────────────────────
  // Tight ceiling — reassignments shouldn't be a hot path.
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    lease.workspace_id,
    "assign-execution-owner",
    origin,
    20,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(
    `[assign-execution-owner] User ${user.id} reassigning lease ${lease.id} from ${lease.execution_owner_id} to ${body.newOwnerId}`,
  );

  // ── Apply the reassignment ─────────────────────────────────────────
  const priorOwnerId = lease.execution_owner_id;
  const { error: updateError } = await supabaseAdmin
    .from("leases")
    .update({ execution_owner_id: body.newOwnerId })
    .eq("id", lease.id);
  if (updateError) {
    console.error("[assign-execution-owner] update error:", updateError.message);
    return jsonResponse(
      {
        ok: false,
        error: `Failed to reassign: ${updateError.message}`,
        reason: "update_failed",
      },
      500,
      origin,
    );
  }

  // ── Audit row ──────────────────────────────────────────────────────
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: lease.id,
    user_id: user.id,
    activity_type: "execution_owner_reassigned",
    details: {
      prior_owner_id: priorOwnerId,
      new_owner_id: body.newOwnerId,
      reassigned_by: user.id,
      reason: reason || null,
    },
  });

  // ── Notify the new execution owner ────────────────────────────────
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: lease.id,
    user_id: null,
    activity_type: "comment",
    details: {
      notification_type: "execution_owner_reassigned",
      recipient_ids: [body.newOwnerId],
      message:
        `You have been assigned as the execution owner for this lease. You're now responsible for chasing the counter-signed document.`,
    },
  });

  return jsonResponse(
    {
      ok: true,
      leaseId: lease.id,
      priorOwnerId,
      newOwnerId: body.newOwnerId,
    },
    200,
    origin,
  );
});
