// voluntary-delegate-step — Phase 7 Checkpoint 3
//
// User-initiated per-step delegation. The original assignee (or the
// current effective assignee, if delegation has already chained) hands
// the step to a workspace member, optionally with a reason.
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be the step's original approver_user_id OR the
//     current effective_assignee_user_id
//   - Self-delegation (caller === delegate) rejected via DB CHECK
//     (vd_no_self_delegation) AND this function's body validation
//
// PRECONDITIONS
//   - Step must be pending
//   - delegateUserId must be a workspace member or the workspace owner
//
// EFFECTS
//   1. Insert chain_step_voluntary_delegations row
//   2. UPDATE lease_approval_chain: effective_assignee_user_id =
//      delegateUserId, assignee_resolution_source = 'voluntary_delegate'
//   3. Insert voluntary_delegation_created activity row
//   4. Notify the new delegate + the original assignee via
//      comment-type activity rows

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
  chainStepId: string;
  delegateUserId: string;
  reason?: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
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
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin); }

  if (!body?.chainStepId || typeof body.chainStepId !== "string") {
    return jsonResponse({ ok: false, error: "chainStepId is required", reason: "bad_request" }, 400, origin);
  }
  if (!body?.delegateUserId || typeof body.delegateUserId !== "string") {
    return jsonResponse({ ok: false, error: "delegateUserId is required", reason: "bad_request" }, 400, origin);
  }
  if (body.delegateUserId === user.id) {
    return jsonResponse(
      { ok: false, error: "Cannot delegate to yourself.", reason: "self_delegation" },
      400,
      origin,
    );
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  // Load the chain step
  const { data: stepData, error: stepError } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("id, lease_id, workspace_id, stage, approver_user_id, effective_assignee_user_id, status")
    .eq("id", body.chainStepId)
    .maybeSingle();
  if (stepError || !stepData) {
    return jsonResponse({ ok: false, error: "Chain step not found", reason: "not_found" }, 404, origin);
  }
  const step = stepData as {
    id: string; lease_id: string; workspace_id: string; stage: string;
    approver_user_id: string | null; effective_assignee_user_id: string | null; status: string;
  };

  if (step.status !== "pending") {
    return jsonResponse(
      { ok: false, error: `Step is not pending (current status: ${step.status}).`, reason: "wrong_state" },
      409,
      origin,
    );
  }

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed).
  const liveness = await checkWorkspaceLive(supabaseAdmin, step.workspace_id);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // Authorization: original assignee OR current effective assignee
  const isOriginalAssignee = step.approver_user_id === user.id;
  const isEffectiveAssignee = step.effective_assignee_user_id === user.id;
  if (!isOriginalAssignee && !isEffectiveAssignee) {
    return jsonResponse(
      { ok: false, error: "Only the assignee can delegate this step.", reason: "not_authorized" },
      403,
      origin,
    );
  }

  // Verify delegate is a workspace member or workspace owner
  let delegateIsMember = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", step.workspace_id)
    .maybeSingle();
  if ((ws as any)?.owner_id === body.delegateUserId) delegateIsMember = true;
  if (!delegateIsMember) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", body.delegateUserId)
      .maybeSingle();
    if (member) delegateIsMember = true;
  }
  if (!delegateIsMember) {
    return jsonResponse(
      { ok: false, error: "Delegate must be a workspace member.", reason: "not_a_member" },
      400,
      origin,
    );
  }

  console.log(`[voluntary-delegate-step] User ${user.id} delegating step ${step.id} → ${body.delegateUserId}`);

  // Insert the voluntary delegation row
  const { data: vdRow, error: vdError } = await supabaseAdmin
    .from("chain_step_voluntary_delegations")
    .insert({
      chain_step_id: step.id,
      lease_id: step.lease_id,
      workspace_id: step.workspace_id,
      delegated_by: user.id,
      delegated_to: body.delegateUserId,
      reason: reason || null,
    })
    .select("id")
    .single();
  if (vdError) {
    return jsonResponse(
      { ok: false, error: `Failed to record delegation: ${vdError.message}`, reason: "insert_failed" },
      500,
      origin,
    );
  }
  const vdId = (vdRow as any)?.id ?? null;

  // Update effective assignee on the chain step
  await supabaseAdmin
    .from("lease_approval_chain")
    .update({
      effective_assignee_user_id: body.delegateUserId,
      assignee_resolution_source: "voluntary_delegate",
    })
    .eq("id", step.id);

  // Activity log: voluntary_delegation_created
  const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: step.lease_id,
    user_id: user.id,
    activity_type: "voluntary_delegation_created",
    details: {
      chain_step_id: step.id,
      delegation_id: vdId,
      delegated_by: user.id,
      delegated_to: body.delegateUserId,
      reason: reason || null,
      original_approver_user_id: step.approver_user_id,
      stage: step.stage,
    },
  });
  if (auditErr) console.error("lease_activity_log insert failed (voluntary_delegation_created):", auditErr.message);

  // Notify the new delegate + the original assignee.
  const { error: auditErr2 } = await supabaseAdmin.from("lease_activity_log").insert([
    {
      lease_id: step.lease_id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "voluntary_delegation_received",
        recipient_ids: [body.delegateUserId],
        message: `An approval step has been delegated to you. Review and act in the approval queue.`,
      },
    },
    ...(step.approver_user_id && step.approver_user_id !== user.id
      ? [{
          lease_id: step.lease_id,
          user_id: null,
          activity_type: "comment",
          details: {
            notification_type: "voluntary_delegation_chain_notified",
            recipient_ids: [step.approver_user_id],
            message: `Your assigned step was delegated by ${user.id}.`,
          },
        }]
      : []),
  ]);
  if (auditErr2) console.error("lease_activity_log insert failed (comment/voluntary_delegation notifications):", auditErr2.message);

  return jsonResponse(
    {
      ok: true,
      delegationId: vdId,
      chainStepId: step.id,
      delegatedBy: user.id,
      delegatedTo: body.delegateUserId,
    },
    200,
    origin,
  );
});
