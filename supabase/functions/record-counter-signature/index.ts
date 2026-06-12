// record-counter-signature — Phase 5 Checkpoint 3
//
// The counter-signed document has arrived; this function lands the
// lease in fully_executed and the existing extraction → active flow
// (process_lease etc.) takes over from there.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true)
//   - Caller must be the execution_owner_id OR a workspace owner/admin.
//
// PRECONDITIONS
//   - leases.lifecycle_status MUST be 'pending_counter_signature'.
//   - At least one lease_documents row of type
//     'fully_executed_counterparty_returned' MUST exist for this lease
//     (the user uploaded it via Phase 4's upload-lease-document; this
//     function is the post-upload "I confirm receipt" step).
//
// EFFECTS (Lifecycle Transition Convention)
//   1. UPDATE leases SET lifecycle_status='fully_executed',
//      counter_signed_at=now(), fully_executed_at=now(),
//      status_changed_at=now()
//   2. INSERT lease_activity_log status_change row
//   3. INSERT counter_signature_received audit row
//   4. INSERT fully_executed_recorded audit row (Phase 3 contract)
//   5. Notify submitter, signator, workspace admins.
//
// PHASE 5 STOPS HERE. The handoff to 'active' goes through existing
// process_lease + extraction flows; this function does not modify
// that handoff.

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

  // ── Load lease + verify state ──────────────────────────────────────
  const { data: leaseData, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, requestor_id, user_id, execution_owner_id")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[record-counter-signature] lease load error:", leaseError.message);
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
          `Cannot record counter-signature: lease is in '${lease.lifecycle_status}', not 'pending_counter_signature'`,
        reason: "wrong_state",
      },
      409,
      origin,
    );
  }

  // ── Authorization: execution owner OR workspace owner/admin ────────
  const isExecutionOwner = lease.execution_owner_id === user.id;
  let isOwnerOrAdmin = false;
  if (!isExecutionOwner) {
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

  if (!isExecutionOwner && !isOwnerOrAdmin) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Forbidden — only the execution owner or a workspace admin can record the counter-signature",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  // ── Precondition: at least one fully_executed_counterparty_returned doc
  const { data: counterDocs, error: docsError } = await supabaseAdmin
    .from("lease_documents")
    .select("id, filename, iteration_number, version_number")
    .eq("lease_id", lease.id)
    .eq("document_type", "fully_executed_counterparty_returned")
    .order("uploaded_at", { ascending: false })
    .limit(1);

  if (docsError) {
    console.error("[record-counter-signature] documents lookup error:", docsError.message);
    return jsonResponse(
      { ok: false, error: "Failed to verify documents", reason: "internal" },
      500,
      origin,
    );
  }

  if (!counterDocs || counterDocs.length === 0) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Cannot record counter-signature: upload a document of type 'fully_executed_counterparty_returned' first",
        reason: "no_counter_signed_doc",
      },
      409,
      origin,
    );
  }

  const triggeringDoc = counterDocs[0] as {
    id: string;
    filename: string;
    iteration_number: number;
    version_number: number;
  };

  // ── Rate limit ─────────────────────────────────────────────────────
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    lease.workspace_id,
    "record-counter-signature",
    origin,
    10,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(
    `[record-counter-signature] User ${user.id} recording counter-signature for lease ${lease.id}`,
  );

  // ── Lifecycle Transition Convention helpers ────────────────────────
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
      console.error("[record-counter-signature] status_change log error:", error.message);
    }
  }

  // ── Apply lifecycle transition (single UPDATE for atomicity) ───────
  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("leases")
    .update({
      lifecycle_status: "fully_executed",
      counter_signed_at: nowIso,
      fully_executed_at: nowIso,
      status_changed_at: nowIso,
    })
    .eq("id", lease.id);
  if (updateError) {
    console.error("[record-counter-signature] lease update error:", updateError.message);
    return jsonResponse(
      {
        ok: false,
        error: `Failed to update lifecycle: ${updateError.message}`,
        reason: "lifecycle_update_failed",
      },
      500,
      origin,
    );
  }

  // ── Activity log entries ───────────────────────────────────────────
  await logStatusChange("pending_counter_signature", "fully_executed", {
    triggered_by: "counter_signature_received",
    triggering_document_id: triggeringDoc.id,
  });

  const { error: auditErr } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "counter_signature_received",
      details: {
        recorded_by: user.id,
        triggering_document_id: triggeringDoc.id,
        triggering_document_filename: triggeringDoc.filename,
        iteration_number: triggeringDoc.iteration_number,
        version_number: triggeringDoc.version_number,
      },
    });
  if (auditErr) console.error("lease_activity_log insert failed (counter_signature_received):", auditErr.message);

  const { error: auditErr2 } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "fully_executed_recorded",
      details: {
        triggering_document_id: triggeringDoc.id,
      },
    });
  if (auditErr2) console.error("lease_activity_log insert failed (fully_executed_recorded):", auditErr2.message);

  // ── Notify submitter, signator (chain rows), and workspace admins ──
  const recipientIds = new Set<string>();
  if (lease.requestor_id) recipientIds.add(lease.requestor_id);
  else if (lease.user_id) recipientIds.add(lease.user_id);

  // Find the signator approver from the most recent approved signator
  // chain row.
  const { data: signatorRow } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("action_by")
    .eq("lease_id", lease.id)
    .eq("stage", "signator")
    .eq("status", "approved")
    .order("action_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((signatorRow as { action_by: string } | null)?.action_by) {
    recipientIds.add((signatorRow as { action_by: string }).action_by);
  }

  // Workspace admins
  const { data: adminMembers } = await supabaseAdmin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", lease.workspace_id)
    .eq("role", "admin");
  for (const m of (adminMembers ?? []) as Array<{ user_id: string }>) {
    recipientIds.add(m.user_id);
  }

  // Workspace owner
  const { data: ownerRow } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", lease.workspace_id)
    .maybeSingle();
  if ((ownerRow as { owner_id: string } | null)?.owner_id) {
    recipientIds.add((ownerRow as { owner_id: string }).owner_id);
  }

  if (recipientIds.size > 0) {
    const { error: auditErr3 } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "counter_signature_received",
        recipient_ids: Array.from(recipientIds),
        message:
          "Counter-signed document received. Lease is now fully executed.",
      },
    });
    if (auditErr3) console.error("lease_activity_log insert failed (comment/counter_signature_received notification):", auditErr3.message);
  }

  return jsonResponse(
    {
      ok: true,
      leaseId: lease.id,
      newLifecycleStatus: "fully_executed",
      triggeringDocumentId: triggeringDoc.id,
    },
    200,
    origin,
  );
});
