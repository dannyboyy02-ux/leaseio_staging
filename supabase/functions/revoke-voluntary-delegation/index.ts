// revoke-voluntary-delegation — Phase 7 Checkpoint 3
//
// The original assignee can revoke a voluntary delegation if the
// delegate hasn't acted yet. Soft-delete via revoked_at / revoked_by
// columns on chain_step_voluntary_delegations. Effective assignee on
// the chain step reverts to the next-priority source.
//
// AUTHORIZATION
//   - Bearer JWT
//   - Caller must be the delegated_by user (= original assignee)
//
// PRECONDITIONS
//   - The voluntary delegation must exist and not be already revoked
//   - The chain step must still be pending (delegate hasn't acted)

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import {
  type AssigneeContext,
  resolveEffectiveAssignee,
} from "../_shared/approval_chain.ts";

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

  if (!body?.chainStepId) {
    return jsonResponse({ ok: false, error: "chainStepId is required", reason: "bad_request" }, 400, origin);
  }

  // Load the chain step + the active voluntary delegation
  const { data: stepData } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, stage, approver_user_id, approver_role, delegate_user_id, delegate_after_days, pending_since, status",
    )
    .eq("id", body.chainStepId)
    .maybeSingle();
  if (!stepData) {
    return jsonResponse({ ok: false, error: "Chain step not found", reason: "not_found" }, 404, origin);
  }
  const step = stepData as {
    id: string; lease_id: string; workspace_id: string; stage: string;
    approver_user_id: string | null; approver_role: string | null;
    delegate_user_id: string | null; delegate_after_days: number | null;
    pending_since: string | null; status: string;
  };

  if (step.status !== "pending") {
    return jsonResponse(
      { ok: false, error: `Step has already been acted on (status: ${step.status}); revoke is too late.`, reason: "wrong_state" },
      409,
      origin,
    );
  }

  const { data: vdData } = await supabaseAdmin
    .from("chain_step_voluntary_delegations")
    .select("id, delegated_by, delegated_to")
    .eq("chain_step_id", step.id)
    .is("revoked_at", null)
    .order("delegated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!vdData) {
    return jsonResponse(
      { ok: false, error: "No active voluntary delegation found for this step.", reason: "not_found" },
      404,
      origin,
    );
  }
  const vd = vdData as { id: string; delegated_by: string; delegated_to: string };

  if (vd.delegated_by !== user.id) {
    return jsonResponse(
      { ok: false, error: "Only the user who delegated can revoke.", reason: "not_authorized" },
      403,
      origin,
    );
  }

  console.log(`[revoke-voluntary-delegation] User ${user.id} revoking delegation ${vd.id}`);

  // Soft-delete the voluntary delegation
  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from("chain_step_voluntary_delegations")
    .update({ revoked_at: nowIso, revoked_by: user.id })
    .eq("id", vd.id);

  // Recompute effective_assignee_user_id using the pure helper.
  // Look up active OOO for the original assignee (if any).
  let oooDelegateId: string | null = null;
  if (step.approver_user_id) {
    const { data: oooRow } = await supabaseAdmin
      .from("user_out_of_office")
      .select("delegate_user_id")
      .eq("user_id", step.approver_user_id)
      .eq("workspace_id", step.workspace_id)
      .eq("is_active", true)
      .lte("starts_at", nowIso)
      .gte("ends_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    oooDelegateId = (oooRow as any)?.delegate_user_id ?? null;
  }

  const ctx: AssigneeContext = {
    policy_user_id: step.approver_user_id,
    policy_role: step.approver_role,
    policy_delegate_user_id: step.delegate_user_id,
    policy_delegate_after_days: step.delegate_after_days,
    voluntary_delegate_user_id: null,  // just revoked
    ooo_delegate_user_id: oooDelegateId,
    admin_reassigned_user_id: null,
    pending_since: step.pending_since,
  };
  const resolved = resolveEffectiveAssignee(ctx);

  await supabaseAdmin
    .from("lease_approval_chain")
    .update({
      effective_assignee_user_id: resolved.user_id,
      assignee_resolution_source: resolved.source,
    })
    .eq("id", step.id);

  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: step.lease_id,
    user_id: user.id,
    activity_type: "voluntary_delegation_revoked",
    details: {
      chain_step_id: step.id,
      delegation_id: vd.id,
      revoked_by: user.id,
      reverted_to_user_id: resolved.user_id,
      reverted_to_source: resolved.source,
    },
  });

  // Notify the prior delegate that the delegation was revoked.
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: step.lease_id,
    user_id: null,
    activity_type: "comment",
    details: {
      notification_type: "voluntary_delegation_revoked",
      recipient_ids: [vd.delegated_to],
      message: "A delegation that was assigned to you has been revoked. The step has been routed back.",
    },
  });

  return jsonResponse(
    {
      ok: true,
      delegationId: vd.id,
      chainStepId: step.id,
      revertedTo: { user_id: resolved.user_id, source: resolved.source },
    },
    200,
    origin,
  );
});
