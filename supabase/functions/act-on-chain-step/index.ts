// act-on-chain-step — Phase 2
//
// Called when an approver clicks Approve / Reject / Send Back on their
// assigned chain step. Updates the step row, runs stage-completion
// logic, and advances the lease lifecycle accordingly.
//
// Phase 2 only consumes the 'concept' stage's chain rows. 'signator'
// rows may exist (the resolver inserts them) but stage-advancement for
// signator is a no-op until Phase 5 owns it; the lease still flows
// through legacy execution post-`approved`.
//
// See docs/PHASE_2_BUILD_SPEC.md for the full contract.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  type ChainStepLike,
  advancedPastStepOrder,
  findFirstPendingAssignees,
  isStageComplete,
} from "../_shared/approval_chain.ts";
import { getLifecycleMode, type LifecycleMode } from "../_shared/lifecycle_mode.ts";

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
  action: "approve" | "reject" | "send_back";
  comment?: string;
}

interface ChainStepRow {
  id: string;
  lease_id: string;
  workspace_id: string;
  stage: "concept" | "signator";
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  is_required: boolean;
  status: string;
}

const ACTION_TO_STATUS: Record<string, "approved" | "rejected" | "sent_back"> = {
  approve: "approved",
  reject: "rejected",
  send_back: "sent_back",
};

const ACTION_TO_ACTIVITY: Record<string, string> = {
  approve: "chain_step_approved",
  reject: "chain_step_rejected",
  send_back: "chain_step_sent_back",
};

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
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication" }, 401, origin);
  }
  const user = userData.user;

  async function logActivity(
    leaseId: string,
    activityType: string,
    details: Record<string, unknown>,
  ) {
    const { error } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: activityType,
        details,
      });
    if (error) {
      console.error("[act-on-chain-step] activity log error:", error.message);
    }
  }

  // ── Lifecycle Transition Convention (CLAUDE.md) ─────────────────────────
  // Every leases.lifecycle_status update MUST also bump status_changed_at
  // in the SAME UPDATE statement. Every status_change activity log row
  // MUST populate from_status + to_status as top-level columns AND keep
  // the equivalent fields inside details for backward compatibility,
  // and include a routing_path value so downstream consumers can
  // distinguish how the transition was produced.
  async function updateLifecycle(
    leaseId: string,
    newStatus: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabaseAdmin
      .from("leases")
      .update({
        lifecycle_status: newStatus,
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", leaseId);
    if (error) {
      console.error("[act-on-chain-step] lease lifecycle update error:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async function logStatusChange(
    leaseId: string,
    fromStatus: string,
    toStatus: string,
    extra: Record<string, unknown>,
  ) {
    const details = {
      // Keep the legacy nested shape so any consumer reading details.from /
      // details.to keeps working while we migrate to columns.
      from: fromStatus,
      to: toStatus,
      // Convention: every chain-driven transition is tagged 'chain'.
      routing_path: "chain",
      ...extra,
    };
    const { error } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: "status_change",
        from_status: fromStatus,
        to_status: toStatus,
        details,
      });
    if (error) {
      console.error("[act-on-chain-step] status_change log error:", error.message);
    }
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, origin);
  }

  const chainStepId = body?.chainStepId;
  const action = body?.action;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";

  if (!chainStepId || typeof chainStepId !== "string") {
    return jsonResponse({ ok: false, error: "chainStepId is required" }, 400, origin);
  }
  if (!action || !["approve", "reject", "send_back"].includes(action)) {
    return jsonResponse(
      { ok: false, error: "action must be approve | reject | send_back" },
      400,
      origin,
    );
  }
  // Comment required for reject and send_back, matches existing UX.
  if ((action === "reject" || action === "send_back") && !comment) {
    return jsonResponse(
      { ok: false, error: `${action} requires a comment.` },
      400,
      origin,
    );
  }

  // Load the chain step.
  const { data: stepData, error: stepError } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status",
    )
    .eq("id", chainStepId)
    .maybeSingle();
  if (stepError || !stepData) {
    return jsonResponse(
      { ok: false, error: "Chain step not found" },
      404,
      origin,
    );
  }
  const step = stepData as ChainStepRow;
  if (step.status !== "pending") {
    return jsonResponse(
      { ok: false, error: `Step is not pending (current status: ${step.status})` },
      409,
      origin,
    );
  }

  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    step.workspace_id,
    "act-on-chain-step",
    origin,
    30,
  );
  if (rateLimitResponse) return rateLimitResponse;

  // Authorization: assignee user OR has the step's role OR workspace
  // owner/admin (override path).
  let authorized = false;

  if (step.approver_user_id && step.approver_user_id === user.id) {
    authorized = true;
  }

  if (!authorized && step.approver_role) {
    const { data: roleRow } = await supabaseAdmin
      .from("workspace_roles")
      .select("id")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", user.id)
      .eq("role", step.approver_role)
      .maybeSingle();
    if (roleRow) authorized = true;
  }

  if (!authorized) {
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", step.workspace_id)
      .maybeSingle();
    if ((ws as any)?.owner_id === user.id) authorized = true;
  }

  if (!authorized) {
    const { data: adminMember } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (adminMember) authorized = true;
  }

  if (!authorized) {
    return jsonResponse(
      { ok: false, error: "Forbidden: you are not authorized to act on this step." },
      403,
      origin,
    );
  }

  const newStatus = ACTION_TO_STATUS[action];

  // Update the step row using the admin client. This bypasses the
  // assignee RLS policy's WITH CHECK (which requires action_by=auth.uid()
  // — auth.uid() is null in service-role context). We set action_by
  // explicitly to the acting user, preserving the audit trail.
  const { error: updateError } = await supabaseAdmin
    .from("lease_approval_chain")
    .update({
      status: newStatus,
      action_at: new Date().toISOString(),
      action_by: user.id,
      comment: comment || null,
    })
    .eq("id", step.id);
  if (updateError) {
    return jsonResponse(
      { ok: false, error: `Failed to update step: ${updateError.message}` },
      500,
      origin,
    );
  }

  await logActivity(step.lease_id, ACTION_TO_ACTIVITY[action], {
    chain_step_id: step.id,
    stage: step.stage,
    step_order: step.step_order,
    parallel_group: step.parallel_group,
    comment: comment || null,
  });

  // ── Phase 3: determine lifecycle mode ONCE, before any transition ─────
  // Per CLAUDE.md and the Phase 3 spec, mode is determined once at the
  // top of the request to avoid races where chain rows get inserted or
  // removed mid-handler. In practice act-on-chain-step always operates
  // on a chain step, so mode is virtually always 'chain' — but the
  // branching is implemented defensively to keep all transition sites
  // mode-aware.
  const mode: LifecycleMode = await getLifecycleMode(step.lease_id, supabaseAdmin);

  // Capture lease's current lifecycle for accurate from_status in chain
  // mode. Legacy mode keeps Phase 2's literal from_status values
  // verbatim to honor the byte-identical-observable-behavior contract.
  let currentLifecycle: string | null = null;
  if (mode === "chain") {
    const { data: leaseRow } = await supabaseAdmin
      .from("leases")
      .select("lifecycle_status")
      .eq("id", step.lease_id)
      .maybeSingle();
    currentLifecycle = (leaseRow as any)?.lifecycle_status ?? null;
  }

  // Stage advancement / lifecycle transitions.
  let lifecycleChange: string | null = null;
  let nextAssignees: { userId: string | null; role: string | null }[] = [];
  let stageCompleted: boolean = false;

  if (action === "reject") {
    // Lease → rejected (terminal — same in both vocabularies). Mark all
    // remaining pending steps in the chain as superseded.
    const result = await updateLifecycle(step.lease_id, "rejected");
    if (result.ok) {
      lifecycleChange = "rejected";
      if (mode === "chain") {
        await logStatusChange(
          step.lease_id,
          currentLifecycle ?? "pending",
          "rejected",
          {
            triggered_by: "chain_step_rejected",
            chain_step_id: step.id,
          },
        );
      } else {
        // Legacy — byte-identical to Phase 2.
        await logStatusChange(step.lease_id, "pending", "rejected", {
          triggered_by: "chain_step_rejected",
          chain_step_id: step.id,
        });
      }
    }
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({ status: "superseded" })
      .eq("lease_id", step.lease_id)
      .eq("status", "pending");
  } else if (action === "send_back") {
    // Chain mode → 'concept_submitted' (the chain-vocabulary equivalent
    // of Phase 2's 'submitted' destination). Legacy mode → 'submitted'
    // verbatim. Mark current-stage pending steps as superseded.
    const targetLifecycle = mode === "chain" ? "concept_submitted" : "submitted";
    const result = await updateLifecycle(step.lease_id, targetLifecycle);
    if (result.ok) {
      lifecycleChange = targetLifecycle;
      if (mode === "chain") {
        await logStatusChange(
          step.lease_id,
          currentLifecycle ?? "concept_under_review",
          "concept_submitted",
          {
            triggered_by: "chain_step_sent_back",
            chain_step_id: step.id,
          },
        );
      } else {
        // Legacy — byte-identical to Phase 2.
        await logStatusChange(step.lease_id, "under_review", "submitted", {
          triggered_by: "chain_step_sent_back",
          chain_step_id: step.id,
        });
      }
    }
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({ status: "superseded" })
      .eq("lease_id", step.lease_id)
      .eq("stage", step.stage)
      .eq("status", "pending");
  } else {
    // approve: load full chain to evaluate stage advancement.
    const { data: chainRows } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status")
      .eq("lease_id", step.lease_id);
    const allRows = (chainRows ?? []) as ChainStepLike[];

    if (step.stage === "concept" && isStageComplete(allRows, "concept")) {
      // Stage just completed. Chain mode → in_negotiation; legacy mode
      // → under_review (Phase 2 verbatim).
      const targetLifecycle = mode === "chain" ? "in_negotiation" : "under_review";
      const result = await updateLifecycle(step.lease_id, targetLifecycle);
      if (result.ok) {
        lifecycleChange = targetLifecycle;
        stageCompleted = true;
        // Phase 2's chain_stage_completed entry retained in BOTH modes
        // for backward compatibility with downstream activity-log
        // consumers that filter on it.
        await logActivity(step.lease_id, "chain_stage_completed", {
          stage: "concept",
          chain_step_id: step.id,
        });
        if (mode === "chain") {
          // Phase 3: more specific transition activity types.
          await logActivity(step.lease_id, "concept_stage_completed", {
            chain_step_id: step.id,
          });
          await logActivity(step.lease_id, "negotiation_stage_entered", {
            chain_step_id: step.id,
          });
          await logStatusChange(
            step.lease_id,
            currentLifecycle ?? "concept_submitted",
            "in_negotiation",
            {
              triggered_by: "chain_stage_completed",
              stage: "concept",
            },
          );
        } else {
          // Legacy — byte-identical to Phase 2.
          await logStatusChange(step.lease_id, "submitted", "under_review", {
            triggered_by: "chain_stage_completed",
            stage: "concept",
          });
        }
      }
      // Next assignees would be from the signator stage. Phase 2/3 does
      // not notify signator yet, but compute and return them so the
      // caller has the data if it wants to surface it.
      nextAssignees = findFirstPendingAssignees(allRows, "signator");
    } else if (step.stage === "concept") {
      // Approve in concept stage that did NOT complete the stage.
      // Chain-mode addition (Phase 3): if currently in 'concept_submitted',
      // bump to 'concept_under_review' on the FIRST concept-stage approval
      // (regardless of whether we crossed a sequential parallel-group level).
      // This is a new transition that did not exist in Phase 2; legacy
      // mode skips this branch and behaves identically to Phase 2.
      if (mode === "chain" && currentLifecycle === "concept_submitted") {
        const result = await updateLifecycle(
          step.lease_id,
          "concept_under_review",
        );
        if (result.ok) {
          lifecycleChange = "concept_under_review";
          await logStatusChange(
            step.lease_id,
            "concept_submitted",
            "concept_under_review",
            {
              triggered_by: "chain_step_approved",
              chain_step_id: step.id,
            },
          );
        }
      }
      if (advancedPastStepOrder(allRows, "concept", step.step_order)) {
        // Crossed a sequential level — compute who's now active.
        nextAssignees = findFirstPendingAssignees(allRows, "concept");
      }
    } else if (step.stage === "signator") {
      // Phase 2/3 no-op for signator stage — Phase 5 will own it.
    }
  }

  return jsonResponse(
    {
      ok: true,
      stepStatus: newStatus,
      stageCompleted,
      lifecycleChange,
      nextAssignees,
    },
    200,
    origin,
  );
});
