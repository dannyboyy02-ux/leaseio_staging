// advance-to-final-review — Phase 4 Checkpoint 3
//
// Submitter-initiated advance: moves a lease from in_negotiation to
// final_review when the negotiation has produced a finalized document
// and the team is ready for signator review.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true)
//   - Caller must be the lease submitter (requestor_id = user.id) OR a
//     workspace admin/owner.
//
// PRECONDITIONS
//   - leases.lifecycle_status MUST be 'in_negotiation'. Reject otherwise.
//   - At least one lease_documents row of document_type='final_negotiated'
//     MUST exist for this lease. The system requires evidence of a
//     finalized document before advancing to signator review.
//
// EFFECTS
//   1. UPDATE leases SET lifecycle_status='final_review',
//      status_changed_at=now() in the same statement (Lifecycle Transition
//      Convention).
//   2. INSERT lease_activity_log status_change row with from_status +
//      to_status BOTH as columns AND inside details, plus
//      routing_path='chain' and triggered_by='advance_to_final_review'.
//   3. INSERT lease_activity_log final_review_stage_entered row capturing
//      which final_negotiated document triggered the advance.
//   4. INSERT a comment activity for the workspace_roles=signator cohort
//      so they get a notification.
//
// PHASE 5 (out of scope) will own the actual signator approve/reject UI
// and chain step consumption. Phase 4 just gets the lease INTO
// final_review; it sits there until Phase 5 wires up the next step.
//
// LIFECYCLE TRANSITION CONVENTION (CLAUDE.md)
//   updateLifecycle / logStatusChange helpers below match the shape used
//   in act-on-chain-step + escalate-to-concept-approver.

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

  // ── Load lease + verify state ──────────────────────────────────────
  const { data: leaseData, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, requestor_id, user_id")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[advance-to-final-review] lease load error:", leaseError.message);
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
          `Cannot advance: lease is in '${lease.lifecycle_status}', not 'in_negotiation'`,
        reason: "wrong_state",
      },
      409,
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
        error: "Forbidden — only the lease submitter or a workspace admin can advance",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  // ── Precondition: at least one final_negotiated document ───────────
  const { data: finalDocs, error: docsError } = await supabaseAdmin
    .from("lease_documents")
    .select("id, filename, iteration_number, version_number, is_current_latest")
    .eq("lease_id", lease.id)
    .eq("document_type", "final_negotiated")
    .order("uploaded_at", { ascending: false })
    .limit(1);

  if (docsError) {
    console.error("[advance-to-final-review] documents lookup error:", docsError.message);
    return jsonResponse(
      { ok: false, error: "Failed to verify documents", reason: "internal" },
      500,
      origin,
    );
  }

  if (!finalDocs || finalDocs.length === 0) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Cannot advance: at least one document of type 'final_negotiated' must be uploaded first",
        reason: "no_final_negotiated",
      },
      409,
      origin,
    );
  }

  const triggeringDoc = finalDocs[0] as {
    id: string;
    filename: string;
    iteration_number: number;
    version_number: number;
    is_current_latest: boolean;
  };

  // ── Rate limit ─────────────────────────────────────────────────────
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    lease.workspace_id,
    "advance-to-final-review",
    origin,
    10,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(
    `[advance-to-final-review] User ${user.id} advancing lease ${lease.id} to final_review`,
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
      console.error("[advance-to-final-review] lease update error:", error.message);
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
      console.error("[advance-to-final-review] status_change log error:", error.message);
    }
  }

  // ── Apply lifecycle transition ─────────────────────────────────────
  const updateResult = await updateLifecycle("final_review");
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

  await logStatusChange("in_negotiation", "final_review", {
    triggered_by: "advance_to_final_review",
    triggering_document_id: triggeringDoc.id,
  });

  // ── final_review_stage_entered audit row ───────────────────────────
  await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "final_review_stage_entered",
      details: {
        triggering_document_id: triggeringDoc.id,
        triggering_document_filename: triggeringDoc.filename,
        iteration_number: triggeringDoc.iteration_number,
        version_number: triggeringDoc.version_number,
      },
    });

  // ── Notify the signator workspace_roles cohort ─────────────────────
  // Phase 5 will own the actual signator approve/reject UI and chain
  // step consumption. Phase 4's notification just lets them know their
  // turn is up.
  const { data: signators } = await supabaseAdmin
    .from("workspace_roles")
    .select("user_id")
    .eq("workspace_id", lease.workspace_id)
    .eq("role", "signator");

  const recipientIds = ((signators ?? []) as Array<{ user_id: string }>)
    .map((r) => r.user_id);

  if (recipientIds.length > 0) {
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "signator_review_required",
        recipient_ids: recipientIds,
        message: "Lease has reached final_review and is awaiting your signator approval.",
      },
    });
  }

  return jsonResponse(
    {
      ok: true,
      leaseId: lease.id,
      newLifecycleStatus: "final_review",
      triggeringDocumentId: triggeringDoc.id,
    },
    200,
    origin,
  );
});
