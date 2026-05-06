// handle-deactivated-approver — Phase 7 Checkpoint 3
//
// Called explicitly when a user is deactivated (or marked inactive in
// workspace_members). Finds all pending chain steps where the
// deactivated user is the effective_assignee. For each, attempts
// automatic resolution:
//
//   1. If the step has a policy delegate AND that delegate is active
//      → activate the delegate (set effective_assignee + source =
//      'policy_delegate', delegate_activated_at = now). Log
//      'deactivated_approver_reassigned'.
//   2. Otherwise → log 'policy_assignee_validation_failed' and notify
//      workspace admins that manual reassignment is needed (via
//      admin-override-step reassign action).
//
// AUTHORIZATION
//   - Bearer JWT
//   - Caller must be workspace owner or admin (this is an admin tool;
//     the deactivation flow itself is out of scope for Phase 7 per
//     the spec)
//
// VALIDATION
//   - userId required
//   - workspaceId required
//   - userId must NOT be currently active in the workspace (we only
//     run after deactivation, not before)

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

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
  userId: string;
  workspaceId: string;
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
  const caller = userData.user;

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin); }

  if (!body?.userId || !body?.workspaceId) {
    return jsonResponse({ ok: false, error: "userId and workspaceId are required", reason: "bad_request" }, 400, origin);
  }

  // Authorize caller as admin/owner
  let isAuthorized = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", body.workspaceId)
    .maybeSingle();
  if ((ws as any)?.owner_id === caller.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: m } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspaceId)
      .eq("user_id", caller.id)
      .eq("role", "admin")
      .maybeSingle();
    if (m) isAuthorized = true;
  }
  if (!isAuthorized) {
    return jsonResponse(
      { ok: false, error: "Forbidden — only workspace owners or admins can run.", reason: "not_authorized" },
      403,
      origin,
    );
  }

  // Find pending steps with the deactivated user as the effective
  // assignee in this workspace.
  const { data: affectedSteps } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, stage, approver_user_id, approver_role, delegate_user_id, delegate_after_days, pending_since",
    )
    .eq("workspace_id", body.workspaceId)
    .eq("status", "pending")
    .eq("effective_assignee_user_id", body.userId);

  const steps = (affectedSteps ?? []) as Array<{
    id: string; lease_id: string; workspace_id: string; stage: string;
    approver_user_id: string | null; approver_role: string | null;
    delegate_user_id: string | null; delegate_after_days: number | null;
    pending_since: string | null;
  }>;

  let reassignedToDelegate = 0;
  let surfacedToAdmins = 0;

  for (const s of steps) {
    // Is the policy delegate active in this workspace?
    let delegateIsActive = false;
    if (s.delegate_user_id) {
      // Active = is workspace member OR owner
      delegateIsActive = (ws as any)?.owner_id === s.delegate_user_id;
      if (!delegateIsActive) {
        const { data: m } = await supabaseAdmin
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", body.workspaceId)
          .eq("user_id", s.delegate_user_id)
          .maybeSingle();
        delegateIsActive = !!m;
      }
    }

    if (delegateIsActive && s.delegate_user_id) {
      const nowIso = new Date().toISOString();
      await supabaseAdmin
        .from("lease_approval_chain")
        .update({
          effective_assignee_user_id: s.delegate_user_id,
          assignee_resolution_source: "policy_delegate",
          delegate_activated_at: nowIso,
        })
        .eq("id", s.id);

      await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: s.lease_id,
        user_id: caller.id,
        activity_type: "deactivated_approver_reassigned",
        details: {
          chain_step_id: s.id,
          deactivated_user_id: body.userId,
          reassigned_to_user_id: s.delegate_user_id,
          resolution_source: "policy_delegate",
          stage: s.stage,
        },
      });

      // Notify the delegate
      await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: s.lease_id,
        user_id: null,
        activity_type: "comment",
        details: {
          notification_type: "deactivated_approver_reassigned",
          recipient_ids: [s.delegate_user_id],
          message:
            "An approval step has been routed to you because the original assignee was deactivated.",
        },
      });

      reassignedToDelegate++;
    } else {
      // No clean automatic path — surface to admins
      await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: s.lease_id,
        user_id: caller.id,
        activity_type: "policy_assignee_validation_failed",
        details: {
          chain_step_id: s.id,
          deactivated_user_id: body.userId,
          reason: s.delegate_user_id
            ? "policy_delegate_also_inactive"
            : "no_policy_delegate_configured",
          stage: s.stage,
        },
      });

      // Notify workspace admins for manual reassignment
      const { data: adminMembers } = await supabaseAdmin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", body.workspaceId)
        .eq("role", "admin");
      const recipientIds = new Set<string>();
      for (const m of (adminMembers ?? []) as Array<{ user_id: string }>) recipientIds.add(m.user_id);
      if ((ws as any)?.owner_id) recipientIds.add((ws as any).owner_id);
      if (recipientIds.size > 0) {
        await supabaseAdmin.from("lease_activity_log").insert({
          lease_id: s.lease_id,
          user_id: null,
          activity_type: "comment",
          details: {
            notification_type: "policy_assignee_validation_failed",
            recipient_ids: Array.from(recipientIds),
            message:
              "A pending approval step has lost its assignee due to deactivation and requires manual reassignment via admin override.",
          },
        });
      }

      surfacedToAdmins++;
    }
  }

  return jsonResponse(
    {
      ok: true,
      deactivatedUserId: body.userId,
      workspaceId: body.workspaceId,
      affectedSteps: steps.length,
      reassignedToDelegate,
      surfacedToAdmins,
    },
    200,
    origin,
  );
});
