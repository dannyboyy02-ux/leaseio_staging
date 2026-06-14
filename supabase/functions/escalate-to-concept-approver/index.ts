// escalate-to-concept-approver — Phase 4 Checkpoint 3
//
// Submitter-initiated escalation: rolls a lease back from in_negotiation
// to concept_under_review when material terms have shifted during
// negotiation enough to require a concept-stage re-review.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true)
//   - Caller must be the lease submitter (requestor_id = user.id) OR a
//     workspace admin/owner.
//
// PRECONDITION
//   - leases.lifecycle_status MUST be 'in_negotiation'. Reject otherwise.
//   - reason text is REQUIRED (so the escalation is auditable).
//
// EFFECTS
//   1. UPDATE leases SET lifecycle_status='concept_under_review',
//      status_changed_at=now() in the same statement (Lifecycle Transition
//      Convention).
//   2. INSERT lease_activity_log status_change row with from_status +
//      to_status BOTH as columns AND inside details, plus
//      routing_path='chain' and triggered_by='negotiation_escalation'.
//   3. INSERT lease_activity_log negotiation_escalated_to_concept row
//      capturing the reason text.
//   4. Re-activate the concept stage by cloning the most recent concept
//      chain rows as fresh pending rows. Prior approved rows are NOT
//      modified — preserving the approval history is the audit pattern;
//      the chain history grows, nothing is destroyed.
//   5. INSERT a comment activity for the workspace_roles=manager_approver
//      members so they get a notification.
//
// PHASE 6 (out of scope) will introduce policy-driven re-routing on
// attribute changes; this is the manual submitter-initiated path.
//
// LIFECYCLE TRANSITION CONVENTION (CLAUDE.md)
//   updateLifecycle / logStatusChange helpers below match the shape used
//   in act-on-chain-step. Every transition site must use this shape so
//   downstream consumers can interpret the activity log uniformly.

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
  leaseId: string;
  reason: string;
}

interface LeaseRow {
  id: string;
  workspace_id: string;
  lifecycle_status: string;
  requestor_id: string | null;
  user_id: string | null;
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
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return jsonResponse(
      {
        ok: false,
        error: "reason is required — describe why escalation back to concept is needed",
        reason: "bad_request",
      },
      400,
      origin,
    );
  }

  // ── Load lease + verify state ──────────────────────────────────────
  const { data: leaseData, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, requestor_id, user_id")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[escalate-to-concept-approver] lease load error:", leaseError.message);
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

  if (lease.lifecycle_status !== "in_negotiation") {
    return jsonResponse(
      {
        ok: false,
        error:
          `Cannot escalate: lease is in '${lease.lifecycle_status}', not 'in_negotiation'`,
        reason: "wrong_state",
      },
      409,
      origin,
    );
  }

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed).
  const liveness = await checkWorkspaceLive(supabaseAdmin, lease.workspace_id);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // ── Authorization: submitter OR workspace owner/admin ──────────────
  const isSubmitter =
    lease.requestor_id === user.id || lease.user_id === user.id;

  let isOwnerOrAdmin = false;
  if (!isSubmitter) {
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

  if (!isSubmitter && !isOwnerOrAdmin) {
    return jsonResponse(
      {
        ok: false,
        error: "Forbidden — only the lease submitter or a workspace admin can escalate",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  // ── Rate limit ─────────────────────────────────────────────────────
  // Tight ceiling — escalations are rare and noisy events.
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    lease.workspace_id,
    "escalate-to-concept-approver",
    origin,
    10,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(
    `[escalate-to-concept-approver] User ${user.id} escalating lease ${lease.id} back to concept`,
  );

  // ── Lifecycle Transition Convention helpers ────────────────────────
  async function updateLifecycle(newStatus: string): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabaseAdmin
      .from("leases")
      .update({
        lifecycle_status: newStatus,
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", lease.id);
    if (error) {
      console.error("[escalate-to-concept-approver] lease update error:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async function logStatusChange(
    fromStatus: string,
    toStatus: string,
    extra: Record<string, unknown>,
  ) {
    const details = {
      from: fromStatus,
      to: toStatus,
      routing_path: "chain",
      ...extra,
    };
    const { error } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: "status_change",
        from_status: fromStatus,
        to_status: toStatus,
        details,
      });
    if (error) {
      console.error("[escalate-to-concept-approver] status_change log error:", error.message);
    }
  }

  // ── Apply lifecycle transition ─────────────────────────────────────
  const updateResult = await updateLifecycle("concept_under_review");
  if (!updateResult.ok) {
    return jsonResponse(
      {
        ok: false,
        error: `Failed to update lifecycle: ${updateResult.error}`,
        reason: "lifecycle_update_failed",
      },
      500,
      origin,
    );
  }

  await logStatusChange("in_negotiation", "concept_under_review", {
    triggered_by: "negotiation_escalation",
  });

  // ── Audit row capturing the reason ─────────────────────────────────
  const { error: escLogError } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "negotiation_escalated_to_concept",
      details: {
        reason,
        escalated_by: user.id,
      },
    });
  if (escLogError) {
    console.error("[escalate-to-concept-approver] escalation log error:", escLogError.message);
  }

  // ── Reactivate concept stage with fresh pending chain rows ─────────
  // Strategy: clone the most recent concept-stage rows (any status) into
  // new pending rows. The prior approved rows stay marked 'approved' so
  // the audit trail is preserved.
  //
  // We pick rows from the highest step_order group present in the
  // concept stage, then re-insert all required steps as pending. This
  // covers single-step and multi-step concept stages uniformly.
  const { data: priorConceptRows } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "policy_id, policy_version, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required",
    )
    .eq("lease_id", lease.id)
    .eq("stage", "concept");

  const conceptRows = (priorConceptRows ?? []) as Array<{
    policy_id: string | null;
    policy_version: number | null;
    step_order: number;
    parallel_group: number;
    approver_user_id: string | null;
    approver_role: string | null;
    delegate_user_id: string | null;
    delegate_after_days: number | null;
    is_required: boolean;
  }>;

  let newChainStepIds: string[] = [];
  if (conceptRows.length > 0) {
    // Re-insert each prior concept row as a fresh pending row. Every
    // row of the prior concept stage is re-activated — the chain
    // history grows, nothing destructive.
    const newRows = conceptRows.map((r) => ({
      lease_id: lease.id,
      workspace_id: lease.workspace_id,
      policy_id: r.policy_id,
      policy_version: r.policy_version,
      stage: "concept",
      step_order: r.step_order,
      parallel_group: r.parallel_group,
      approver_user_id: r.approver_user_id,
      approver_role: r.approver_role,
      delegate_user_id: r.delegate_user_id,
      delegate_after_days: r.delegate_after_days,
      is_required: r.is_required,
      status: "pending",
    }));
    const { data: insertedRows, error: insertError } = await supabaseAdmin
      .from("lease_approval_chain")
      .insert(newRows)
      .select("id");
    if (insertError) {
      console.error(
        "[escalate-to-concept-approver] chain reactivation insert error:",
        insertError.message,
      );
    } else {
      newChainStepIds = (insertedRows ?? []).map((r: { id: string }) => r.id);
    }
  } else {
    // No prior concept chain rows (legacy lease with no chain at all,
    // or chain was previously cleared). Note this in the audit log but
    // proceed — the lifecycle is still rolled back to concept_under_review,
    // which is the spec's primary effect.
    const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "comment",
      details: {
        notification_type: "escalation_no_prior_chain",
        message:
          "Escalation requested but no prior concept-stage chain rows existed to reactivate.",
      },
    });
    if (auditErr) console.error("lease_activity_log insert failed (comment/escalation_no_prior_chain):", auditErr.message);
  }

  // ── Notify the manager_approver workspace_roles cohort ─────────────
  // Same notification shape as resolve-approval-chain / handleApprove —
  // a 'comment' activity_type row with notification_type in details.
  const { data: managerApprovers } = await supabaseAdmin
    .from("workspace_roles")
    .select("user_id")
    .eq("workspace_id", lease.workspace_id)
    .eq("role", "manager_approver");

  const recipientIds = ((managerApprovers ?? []) as Array<{ user_id: string }>)
    .map((r) => r.user_id);

  if (recipientIds.length > 0) {
    const { error: auditErr2 } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "concept_re_review_required",
        recipient_ids: recipientIds,
        message: `Lease re-escalated to concept stage by submitter. Reason: ${reason}`,
      },
    });
    if (auditErr2) console.error("lease_activity_log insert failed (comment/concept_re_review_required notification):", auditErr2.message);
  }

  return jsonResponse(
    {
      ok: true,
      leaseId: lease.id,
      newLifecycleStatus: "concept_under_review",
      newChainStepCount: newChainStepIds.length,
    },
    200,
    origin,
  );
});
