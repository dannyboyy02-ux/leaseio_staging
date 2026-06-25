// restore-lease — Leases redesign Phase 3 (restore a soft-deleted lease in-window)
//
// Clears deleted_at / purge_after / deleted_by / deletion_reason on a lease that
// was soft-deleted and has NOT yet been purged. Restore is LOSSLESS: soft-delete
// only ever set the 4 retention columns, so clearing them returns the lease to
// exactly its prior state (archived flag, lifecycle_status, model_locked all
// intact — see migration 20260625130000). After purge_after has passed, the
// process-lease-retention cron may have already purged the row; if the row is
// gone, restore returns 410 (gone) so the caller knows it's past recovery.
//
// WHY service-role: the same lock + retention guards that block a client
// soft-delete also block a client from clearing the columns (the columns are not
// in prevent_locked_lease_edits.ignored_keys). service_role is exempt.
//
// AUTHORIZATION: valid Bearer JWT; caller must be the workspace owner OR an
// accepted workspace admin for the lease's workspace.

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

// deno-lint-ignore no-explicit-any
async function isWorkspaceAdminOrOwner(admin: any, workspaceId: string, userId: string): Promise<boolean> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (ws && ws.owner_id === userId) return true;
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, accepted_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!member && member.role === "admin" && member.accepted_at !== null;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  }
  const user = userData.user;

  let body: { leaseId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin);
  }

  const leaseId = body?.leaseId;
  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse({ ok: false, error: "leaseId is required", reason: "bad_request" }, 400, origin);
  }

  const { data: lease, error: leaseErr } = await admin
    .from("leases")
    .select("id, workspace_id, deleted_at, purge_after")
    .eq("id", leaseId)
    .maybeSingle();
  if (leaseErr) {
    console.error("[restore-lease] load lease error:", leaseErr.message);
    return jsonResponse({ ok: false, error: "Failed to load lease", reason: "internal" }, 500, origin);
  }
  if (!lease) {
    // Either never existed or already hard-purged past the 14-day window.
    return jsonResponse({ ok: false, error: "Lease not found or already purged", reason: "gone" }, 410, origin);
  }
  if (!lease.workspace_id) {
    return jsonResponse({ ok: false, error: "Lease has no workspace", reason: "no_workspace" }, 409, origin);
  }

  const authorized = await isWorkspaceAdminOrOwner(admin, lease.workspace_id, user.id);
  if (!authorized) {
    return jsonResponse({ ok: false, error: "Forbidden", reason: "not_admin" }, 403, origin);
  }

  // ── Idempotent: not soft-deleted → already live ─────────────────────────
  if (!lease.deleted_at) {
    return jsonResponse({ ok: true, leaseId, alreadyLive: true }, 200, origin);
  }

  const priorPurgeAfter = lease.purge_after;

  const { error: updErr } = await admin
    .from("leases")
    .update({ deleted_at: null, purge_after: null, deleted_by: null, deletion_reason: null })
    .eq("id", leaseId)
    .not("deleted_at", "is", null); // only restore a still-deleted row
  if (updErr) {
    console.error("[restore-lease] restore update error:", updErr.message);
    return jsonResponse({ ok: false, error: "Failed to restore lease", reason: "update_failed" }, 500, origin);
  }

  const { error: logErr } = await admin.from("lease_activity_log").insert({
    lease_id: leaseId,
    workspace_id: lease.workspace_id,
    user_id: user.id,
    activity_type: "lease_restored_from_deletion",
    details: { restored_from_purge_after: priorPurgeAfter },
  });
  if (logErr) {
    console.error("[restore-lease] activity-log insert failed (restore stands):", logErr.message);
  }

  return jsonResponse({ ok: true, leaseId, restored: true }, 200, origin);
});
