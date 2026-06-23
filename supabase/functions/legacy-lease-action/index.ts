// legacy-lease-action — P1-11 remediation
//
// Owns every authenticated transition of audit-critical lease columns
// for the LEGACY (non-chain) approval workflow plus the model-lock
// activation step shared by both vocabularies. Audit P1-11 in
// docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md flagged that
// these flows wrote `lifecycle_status`, `model_locked`, and approval
// columns directly from the browser. The same migration that adds
// this function installs a DB trigger that rejects authenticated
// updates to those columns — so every legitimate path runs through
// here under service-role credentials.
//
// Actions:
//   manager_approve       submitted → under_review
//   manager_reject        submitted → rejected (manager_rejection_reason)
//   financial_approve     under_review → approved (+ classification)
//   financial_send_back   under_review → submitted (financial_returned_to_submitter)
//   financial_reject      under_review → rejected (financial_rejection_reason)
//   model_lock            executed → active (model_locked + lock metadata)
//
// Authorization:
//   manager_* actions      workspace owner, admin, or workspace_roles.role
//                          in ('manager_approver', 'admin')
//   financial_* actions    workspace owner, admin, or workspace_roles.role
//                          in ('financial_approver', 'admin')
//   model_lock             workspace owner, admin, or workspace_roles.role
//                          in ('financial_approver', 'admin')
//
// Every successful action writes a row to lease_activity_log in the
// same try-block. If the audit insert fails we surface a 500 — the
// lease update has already committed, so the caller will retry the
// audit-log write or escalate.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";
import {
  getApprovalRequirements,
  getInitialStatusAfterSubmission,
} from "../_shared/approval_routing.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

type Action =
  | "manager_approve"
  | "manager_reject"
  | "financial_approve"
  | "financial_send_back"
  | "financial_reject"
  | "model_lock"
  | "cancel_request"
  | "resubmit_request";

const MANAGER_ACTIONS = new Set<Action>(["manager_approve", "manager_reject"]);
const FINANCIAL_ACTIONS = new Set<Action>([
  "financial_approve",
  "financial_send_back",
  "financial_reject",
]);
// Requester-or-admin actions: the submitter can withdraw their own request, or
// fix-and-resubmit one that financial returned for revision.
const REQUESTER_ACTIONS = new Set<Action>(["cancel_request", "resubmit_request"]);
const VALID_ACTIONS = new Set<Action>([
  ...MANAGER_ACTIONS,
  ...FINANCIAL_ACTIONS,
  ...REQUESTER_ACTIONS,
  "model_lock",
]);

interface RequestBody {
  action: Action;
  leaseId: string;
  reason?: string;
  classification?: "operating" | "finance";
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ error: "Invalid authentication" }, 401, origin);
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const { action, leaseId, reason, classification } = body;
  if (!VALID_ACTIONS.has(action)) {
    return jsonResponse({ error: `Unknown action: ${action}` }, 400, origin);
  }
  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse({ error: "leaseId is required" }, 400, origin);
  }

  // Actions that take a free-text reason must receive a non-empty one.
  if (action === "manager_reject" || action === "financial_reject" || action === "financial_send_back") {
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return jsonResponse({ error: "Reason is required for this action" }, 400, origin);
    }
  }
  if (action === "financial_approve") {
    if (classification !== "operating" && classification !== "finance") {
      return jsonResponse(
        { error: "classification must be 'operating' or 'finance' for financial_approve" },
        400,
        origin,
      );
    }
  }

  // Fetch lease + workspace
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select(
      "id, workspace_id, lifecycle_status, request_title, model_locked, requestor_id, financial_returned_to_submitter, calc_total_commitment, covenant_flagged",
    )
    .eq("id", leaseId)
    .maybeSingle();
  if (leaseError || !lease) {
    return jsonResponse({ error: "Lease not found" }, 404, origin);
  }
  if (!lease.workspace_id) {
    return jsonResponse({ error: "Lease has no workspace" }, 400, origin);
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

  const { data: workspace } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id")
    .eq("id", lease.workspace_id)
    .maybeSingle();
  if (!workspace) {
    return jsonResponse({ error: "Workspace not found" }, 404, origin);
  }

  // Workspace membership — every actor must be a member or the owner.
  const isOwner = workspace.owner_id === user.id;
  let isMember = isOwner;
  if (!isMember) {
    const { data: membership } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", lease.workspace_id)
      .eq("user_id", user.id)
      .maybeSingle();
    isMember = Boolean(membership);
  }
  if (!isMember) {
    return jsonResponse({ error: "Not a member of this workspace" }, 403, origin);
  }

  // Functional-role authorization. Owners + workspace-admin members get
  // bypass; otherwise the user must hold the right role in workspace_roles.
  const { data: roleRows } = await supabaseAdmin
    .from("workspace_roles")
    .select("role")
    .eq("workspace_id", lease.workspace_id)
    .eq("user_id", user.id);
  const userRoles = new Set<string>((roleRows ?? []).map((r) => r.role as string));

  // Admin-on-workspace_members ≠ functional admin; check explicitly.
  let isAdmin = isOwner;
  if (!isAdmin) {
    const { data: adminMembership } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", lease.workspace_id)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    isAdmin = Boolean(adminMembership);
  }

  const canManager = isAdmin || userRoles.has("manager_approver") || userRoles.has("admin");
  const canFinancial = isAdmin || userRoles.has("financial_approver") || userRoles.has("admin");

  if (MANAGER_ACTIONS.has(action) && !canManager) {
    return jsonResponse({ error: "Manager approver role required" }, 403, origin);
  }
  if (FINANCIAL_ACTIONS.has(action) && !canFinancial) {
    return jsonResponse({ error: "Financial approver role required" }, 403, origin);
  }
  if (action === "model_lock" && !canFinancial) {
    return jsonResponse({ error: "Financial approver role required to lock executed records" }, 403, origin);
  }
  if (REQUESTER_ACTIONS.has(action) && !(isAdmin || lease.requestor_id === user.id)) {
    return jsonResponse({ error: "Only the requester or a workspace admin can do this" }, 403, origin);
  }

  // Lifecycle-state preconditions. Defense-in-depth — the UI shouldn't
  // surface these actions in the wrong state, but a hand-rolled call
  // shouldn't be able to bypass them either.
  const status = (lease.lifecycle_status ?? "") as string;
  function badState(expected: string): Response {
    return jsonResponse(
      { error: `Action ${action} is not valid from lifecycle_status='${status}' (expected '${expected}')` },
      409,
      origin,
    );
  }
  if (action === "manager_approve" || action === "manager_reject") {
    if (status !== "submitted") return badState("submitted");
  }
  if (
    action === "financial_approve" ||
    action === "financial_send_back" ||
    action === "financial_reject"
  ) {
    if (status !== "under_review") return badState("under_review");
  }
  if (action === "model_lock") {
    if (status !== "executed") return badState("executed");
    if (lease.model_locked) {
      return jsonResponse({ error: "Lease is already model-locked" }, 409, origin);
    }
  }
  if (action === "cancel_request") {
    // Withdraw a still-in-flight request. Terminal/active states can't be cancelled.
    if (["cancelled", "rejected", "active", "expired"].includes(status)) {
      return jsonResponse(
        { error: `Cannot cancel a request in lifecycle_status='${status}'` },
        409,
        origin,
      );
    }
  }
  if (action === "resubmit_request") {
    // Only a request financial returned for revision (status submitted +
    // financial_returned_to_submitter) can be resubmitted.
    if (status !== "submitted" || !lease.financial_returned_to_submitter) {
      return jsonResponse(
        { error: "Resubmit is only valid for a request returned for revision" },
        409,
        origin,
      );
    }
  }

  // Conservative per-workspace rate limit. These are intentional human
  // actions; 60/hour gives an active workspace plenty of headroom.
  const rateBlock = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    lease.workspace_id,
    "legacy-lease-action",
    origin,
    60,
  );
  if (rateBlock) return rateBlock;

  const now = new Date().toISOString();

  // resubmit_request recomputes the post-revision status SERVER-SIDE from the
  // (already client-saved) lease financials + workspace roles/threshold. Never
  // trust a client-supplied target — a submitter could otherwise self-approve.
  let resubmitNewStatus = "submitted";
  if (action === "resubmit_request") {
    const [{ data: mgrRoles }, { data: finRoles }, { data: wsThresh }] = await Promise.all([
      supabaseAdmin.from("workspace_roles").select("user_id").eq("workspace_id", lease.workspace_id).eq("role", "manager_approver"),
      supabaseAdmin.from("workspace_roles").select("user_id").eq("workspace_id", lease.workspace_id).eq("role", "financial_approver"),
      supabaseAdmin.from("workspaces").select("approval_threshold").eq("id", lease.workspace_id).maybeSingle(),
    ]);
    const requirements = getApprovalRequirements({
      totalCashCommitment: Number((lease as any).calc_total_commitment ?? 0),
      approvalThreshold: (wsThresh as any)?.approval_threshold ?? null,
      hasManagerApprovers: ((mgrRoles ?? []) as unknown[]).length > 0,
      hasFinancialApprovers: ((finRoles ?? []) as unknown[]).length > 0,
      covenantFlagged: Boolean((lease as any).covenant_flagged),
    });
    resubmitNewStatus = getInitialStatusAfterSubmission(requirements);
  }

  type Update = Record<string, unknown>;
  let update: Update;
  let activityType: string;
  let fromStatus = status;
  let toStatus: string;
  let activityDetails: Record<string, unknown>;

  switch (action) {
    case "manager_approve":
      toStatus = "under_review";
      update = {
        lifecycle_status: toStatus,
        manager_approved_by: user.id,
        manager_approved_at: now,
        status_changed_at: now,
      };
      activityType = "approval";
      activityDetails = { role: "manager_approver", action: "manager_approved" };
      break;
    case "manager_reject":
      toStatus = "rejected";
      update = {
        lifecycle_status: toStatus,
        manager_rejection_reason: reason!.trim(),
        status_changed_at: now,
      };
      activityType = "rejection";
      activityDetails = {
        role: "manager_approver",
        action: "manager_rejected",
        reason: reason!.trim(),
      };
      break;
    case "financial_approve":
      toStatus = "approved";
      update = {
        lifecycle_status: toStatus,
        financial_approved_by: user.id,
        financial_approved_at: now,
        lease_classification: classification,
        lease_classification_set_by: user.id,
        lease_classification_set_at: now,
        status_changed_at: now,
      };
      activityType = "approval";
      activityDetails = {
        role: "financial_approver",
        action: "financial_approved",
        classification,
      };
      break;
    case "financial_send_back":
      toStatus = "submitted";
      update = {
        lifecycle_status: toStatus,
        financial_rejection_reason: reason!.trim(),
        financial_returned_to_submitter: true,
        status_changed_at: now,
      };
      activityType = "send_back";
      activityDetails = {
        role: "financial_approver",
        action: "financial_returned",
        reason: reason!.trim(),
      };
      break;
    case "financial_reject":
      toStatus = "rejected";
      update = {
        lifecycle_status: toStatus,
        financial_rejection_reason: reason!.trim(),
        status_changed_at: now,
      };
      activityType = "rejection";
      activityDetails = {
        role: "financial_approver",
        action: "financial_rejected",
        reason: reason!.trim(),
      };
      break;
    case "model_lock":
      toStatus = "active";
      update = {
        model_locked: true,
        model_locked_at: now,
        model_locked_by: user.id,
        lifecycle_status: toStatus,
        status_changed_at: now,
      };
      activityType = "status_change";
      activityDetails = { action: "model_locked", locked_at: now };
      break;
    case "cancel_request":
      toStatus = "cancelled";
      update = {
        lifecycle_status: toStatus,
        status_changed_at: now,
      };
      activityType = "status_change";
      activityDetails = { action: "request_cancelled" };
      break;
    case "resubmit_request":
      toStatus = resubmitNewStatus;
      update = {
        lifecycle_status: toStatus,
        financial_returned_to_submitter: false,
        financial_rejection_reason: null,
        manager_approved_by: null,
        manager_approved_at: null,
        manager_rejection_reason: null,
        status_changed_at: now,
      };
      activityType = "status_change";
      activityDetails = { action: "resubmitted", auto_approved: toStatus === "approved" };
      break;
    default:
      // VALID_ACTIONS guard above makes this unreachable; cast appeases TS.
      return jsonResponse({ error: "Unhandled action" }, 500, origin);
  }

  const { error: updateError } = await supabaseAdmin
    .from("leases")
    .update(update)
    .eq("id", leaseId);
  if (updateError) {
    console.error("[legacy-lease-action] lease update failed:", updateError.message);
    return jsonResponse({ error: `Failed to update lease: ${updateError.message}` }, 500, origin);
  }

  // Activity-log row — CLAUDE.md lifecycle convention requires both the
  // top-level columns and details JSON to carry from_status/to_status, plus
  // routing_path so downstream readers can distinguish legacy vs chain.
  const detailsWithStatus = {
    ...activityDetails,
    from_status: fromStatus,
    to_status: toStatus,
    routing_path: "legacy",
  };
  const { error: activityError } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: leaseId,
      user_id: user.id,
      activity_type: activityType,
      from_status: fromStatus,
      to_status: toStatus,
      details: detailsWithStatus,
    });
  if (activityError) {
    console.error("[legacy-lease-action] activity log insert failed:", activityError.message);
    return jsonResponse(
      {
        error: `Lease updated but activity log failed: ${activityError.message}`,
        warning: "Audit row missing; retry or escalate",
      },
      500,
      origin,
    );
  }

  return jsonResponse(
    {
      success: true,
      leaseId,
      from_status: fromStatus,
      to_status: toStatus,
      action,
    },
    200,
    origin,
  );
});
