// admin-override-step — Phase 7 Checkpoint 3
//
// Workspace admin / owner forces a chain step outcome with full audit
// trail. Five actions:
//   - approve / reject / send_back: invokes act-on-chain-step internally
//     (so the existing lifecycle transitions, status_change rows, etc.
//     all flow through the same pipeline as a normal action — keeps
//     downstream behavior identical regardless of who acted)
//   - reassign: updates effective_assignee_user_id; the step stays
//     pending and the new target acts via act-on-chain-step normally
//   - cancel_step: marks the step as 'superseded'. Used when a step
//     was incorrectly required and shouldn't be acted on at all.
//
// AUTHORIZATION
//   - Bearer JWT
//   - Caller MUST be workspace owner or workspace_members.role='admin'
//
// VALIDATION
//   - reason: required, ≥20 trimmed characters (DB CHECK enforces it
//     too — defense in depth)
//   - reassign action requires reassignToUserId; the target must be
//     a workspace member or owner
//
// EFFECTS
//   1. Insert chain_step_overrides row (audit anchor)
//   2. Apply the action (delegate to act-on-chain-step or update
//      directly depending on action)
//   3. Insert admin_override_executed activity row
//   4. Notify original assignee + submitter

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
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
  action: "approve" | "reject" | "send_back" | "reassign" | "cancel_step";
  reason: string;
  reassignToUserId?: string;
}

const VALID_ACTIONS = new Set(["approve", "reject", "send_back", "reassign", "cancel_step"]);

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

  if (!body?.chainStepId) {
    return jsonResponse({ ok: false, error: "chainStepId is required", reason: "bad_request" }, 400, origin);
  }
  if (!body?.action || !VALID_ACTIONS.has(body.action)) {
    return jsonResponse(
      { ok: false, error: "action must be approve|reject|send_back|reassign|cancel_step", reason: "bad_request" },
      400,
      origin,
    );
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20) {
    return jsonResponse(
      { ok: false, error: "Override reason must be ≥20 characters describing why the override is warranted.", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (body.action === "reassign" && !body.reassignToUserId) {
    return jsonResponse(
      { ok: false, error: "reassignToUserId is required for reassign action.", reason: "bad_request" },
      400,
      origin,
    );
  }

  // Load step + verify state
  const { data: stepData } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("id, lease_id, workspace_id, stage, approver_user_id, approver_role, effective_assignee_user_id, status")
    .eq("id", body.chainStepId)
    .maybeSingle();
  if (!stepData) {
    return jsonResponse({ ok: false, error: "Chain step not found", reason: "not_found" }, 404, origin);
  }
  const step = stepData as {
    id: string; lease_id: string; workspace_id: string; stage: string;
    approver_user_id: string | null; approver_role: string | null;
    effective_assignee_user_id: string | null; status: string;
  };
  if (step.status !== "pending" && step.status !== "sent_back") {
    return jsonResponse(
      { ok: false, error: `Step is in '${step.status}' — overrides only apply to pending or sent_back steps.`, reason: "wrong_state" },
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

  // Authorization: workspace owner OR admin
  let isAuthorized = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", step.workspace_id)
    .maybeSingle();
  if ((ws as any)?.owner_id === user.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: admin } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (admin) isAuthorized = true;
  }
  if (!isAuthorized) {
    return jsonResponse(
      { ok: false, error: "Forbidden — only workspace owners or admins can override.", reason: "not_authorized" },
      403,
      origin,
    );
  }

  // For reassign: verify target is a member or owner
  if (body.action === "reassign") {
    let targetIsMember = (ws as any)?.owner_id === body.reassignToUserId;
    if (!targetIsMember) {
      const { data: m } = await supabaseAdmin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", step.workspace_id)
        .eq("user_id", body.reassignToUserId!)
        .maybeSingle();
      targetIsMember = !!m;
    }
    if (!targetIsMember) {
      return jsonResponse(
        { ok: false, error: "Reassign target must be a workspace member.", reason: "not_a_member" },
        400,
        origin,
      );
    }
  }

  const rateLimit = await enforceWorkspaceRateLimit(supabaseAdmin, step.workspace_id, "admin-override-step", origin, 30);
  if (rateLimit) return rateLimit;

  console.log(`[admin-override-step] User ${user.id} override action=${body.action} step=${step.id}`);

  // Insert the audit anchor row
  const { data: overrideRow } = await supabaseAdmin
    .from("chain_step_overrides")
    .insert({
      chain_step_id: step.id,
      lease_id: step.lease_id,
      workspace_id: step.workspace_id,
      override_action: body.action,
      override_by: user.id,
      override_reason: reason,
      reassigned_to_user_id: body.action === "reassign" ? body.reassignToUserId : null,
      prior_assignee_user_id: step.effective_assignee_user_id ?? step.approver_user_id,
      prior_assignee_role: step.approver_role,
    })
    .select("id")
    .single();
  const overrideId = (overrideRow as any)?.id ?? null;

  // Apply the action
  let resultDetail: Record<string, unknown> = { override_id: overrideId };
  let wasResolverCalled = false;

  if (body.action === "reassign") {
    // Update effective_assignee directly; step stays pending.
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({
        effective_assignee_user_id: body.reassignToUserId,
        assignee_resolution_source: "admin_reassign",
      })
      .eq("id", step.id);
    resultDetail.reassigned_to_user_id = body.reassignToUserId;

    // Notify new target
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: step.lease_id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "admin_reassignment_received",
        recipient_ids: [body.reassignToUserId],
        message: `An admin override has reassigned this step to you. Review in your approval queue.`,
      },
    });
  } else if (body.action === "cancel_step") {
    // Mark the step superseded; lease stays as-is.
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({ status: "superseded" })
      .eq("id", step.id);
    resultDetail.cancelled = true;
  } else {
    // approve / reject / send_back: invoke act-on-chain-step. The
    // resolver enforces lifecycle transitions, so we get the same
    // status_change rows and downstream behavior as a normal action.
    // The override_reason serves as the comment for the action so it
    // surfaces in the chain step's audit detail too.
    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/act-on-chain-step`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          chainStepId: step.id,
          action: body.action,
          comment: `[ADMIN OVERRIDE by ${user.id}] ${reason}`,
        }),
      });
      const respBody = await resp.json().catch(() => ({}));
      resultDetail.resolver = respBody;
      wasResolverCalled = true;
      if (!resp.ok || respBody?.ok === false) {
        // Audit anchor row is in place; we leave it for forensic. Surface
        // the failure to the caller.
        return jsonResponse(
          {
            ok: false,
            error: `Override action failed at chain resolver: ${respBody?.error ?? resp.status}`,
            reason: "resolver_failed",
            override_id: overrideId,
            resolver: respBody,
          },
          resp.status,
          origin,
        );
      }
    } catch (err: any) {
      return jsonResponse(
        { ok: false, error: `Resolver invocation failed: ${err?.message ?? String(err)}`, reason: "resolver_failed", override_id: overrideId },
        500,
        origin,
      );
    }
  }

  // admin_override_executed activity row
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: step.lease_id,
    user_id: user.id,
    activity_type: "admin_override_executed",
    details: {
      override_id: overrideId,
      chain_step_id: step.id,
      action: body.action,
      reason,
      stage: step.stage,
      prior_assignee_user_id: step.effective_assignee_user_id ?? step.approver_user_id,
      reassigned_to_user_id: body.action === "reassign" ? body.reassignToUserId : null,
      resolver_called: wasResolverCalled,
    },
  });

  // Notify original assignee that an override happened on their step
  // (skip if the actor IS the original assignee — they already know).
  if (step.approver_user_id && step.approver_user_id !== user.id) {
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: step.lease_id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "admin_override_notice",
        recipient_ids: [step.approver_user_id],
        message: `An admin overrode an approval step that was assigned to you (action: ${body.action}).`,
      },
    });
  }

  return jsonResponse(
    { ok: true, ...resultDetail },
    200,
    origin,
  );
});
