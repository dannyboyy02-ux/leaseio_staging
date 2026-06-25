// delete-lease — Leases redesign Phase 3 (admin Delete = soft-delete + 14-day retention)
//
// Soft-deletes a single lease: stamps deleted_at / purge_after (= now + 14 days)
// / deleted_by / deletion_reason. The lease then vanishes from every
// authenticated surface (leases_hide_soft_deleted restrictive RLS), frees an
// active slot, and is retained 14 days for restore-on-request before the
// process-lease-retention cron hard-purges it. This is DISTINCT from Archive
// (restorable forever, lease stays live) — see migration 20260625130000.
//
// WHY service-role (not a guarded client UPDATE like archive): the retention
// columns are deliberately NOT in prevent_locked_lease_edits.ignored_keys, so a
// client UPDATE setting deleted_at on a model_locked lease is rejected. Admin
// Delete must work on ANY lease ("always available to the admin"), so the write
// runs as service_role (which prevent_locked_lease_edits + the
// enforce_lease_retention_columns guard both exempt). Authorization (workspace
// admin/owner) is enforced HERE — the DB guard only enforces "service_role
// wrote it", not "an authorized admin requested it".
//
// AUTHORIZATION
//   - Valid Bearer JWT (verify_jwt = true at deploy)
//   - Caller must be the workspace owner OR an accepted workspace admin for the
//     lease's workspace (mirrors enforce_lease_archive_attribution's gate).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

const RETENTION_DAYS = 14;

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

  let body: { leaseId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin);
  }

  const leaseId = body?.leaseId;
  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse({ ok: false, error: "leaseId is required", reason: "bad_request" }, 400, origin);
  }
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 2000) : null;

  // ── Load the lease (service-role: also sees already-soft-deleted rows) ──
  const { data: lease, error: leaseErr } = await admin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, model_locked, archived, deleted_at")
    .eq("id", leaseId)
    .maybeSingle();
  if (leaseErr) {
    console.error("[delete-lease] load lease error:", leaseErr.message);
    return jsonResponse({ ok: false, error: "Failed to load lease", reason: "internal" }, 500, origin);
  }
  if (!lease) {
    return jsonResponse({ ok: false, error: "Lease not found", reason: "not_found" }, 404, origin);
  }
  if (!lease.workspace_id) {
    // A workspace-less lease has no admin to authorize against; refuse.
    return jsonResponse({ ok: false, error: "Lease has no workspace", reason: "no_workspace" }, 409, origin);
  }

  // ── Authorization: workspace admin/owner only ───────────────────────────
  const authorized = await isWorkspaceAdminOrOwner(admin, lease.workspace_id, user.id);
  if (!authorized) {
    return jsonResponse({ ok: false, error: "Forbidden", reason: "not_admin" }, 403, origin);
  }

  // ── Idempotent: already soft-deleted → return current window ────────────
  if (lease.deleted_at) {
    const { data: existing } = await admin
      .from("leases")
      .select("deleted_at, purge_after")
      .eq("id", leaseId)
      .maybeSingle();
    return jsonResponse(
      { ok: true, leaseId, alreadyDeleted: true, deletedAt: existing?.deleted_at, purgeAfter: existing?.purge_after },
      200,
      origin,
    );
  }

  const now = new Date();
  const purgeAfter = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // ── Soft-delete (service-role UPDATE; bypasses the lock + retention guards) ──
  const { error: updErr } = await admin
    .from("leases")
    .update({
      deleted_at: now.toISOString(),
      purge_after: purgeAfter.toISOString(),
      deleted_by: user.id,
      deletion_reason: reason,
    })
    .eq("id", leaseId)
    .is("deleted_at", null); // guard against a concurrent double-delete
  if (updErr) {
    console.error("[delete-lease] soft-delete update error:", updErr.message);
    return jsonResponse({ ok: false, error: "Failed to delete lease", reason: "update_failed" }, 500, origin);
  }

  // ── Attribution audit row (NOT a status_change — lifecycle_status is
  //    unchanged so restore stays lossless; user_id is the admin, never null) ──
  const { error: logErr } = await admin.from("lease_activity_log").insert({
    lease_id: leaseId,
    workspace_id: lease.workspace_id,
    user_id: user.id,
    activity_type: "lease_soft_deleted",
    details: {
      deletion_reason: reason,
      purge_after: purgeAfter.toISOString(),
      retention_days: RETENTION_DAYS,
      prior_lifecycle_status: lease.lifecycle_status,
      was_archived: lease.archived === true,
      model_locked: lease.model_locked === true,
    },
  });
  if (logErr) {
    // The delete succeeded; a missing audit row is logged, not fatal (#90 class).
    console.error("[delete-lease] activity-log insert failed (delete stands):", logErr.message);
  }

  return jsonResponse(
    { ok: true, leaseId, deletedAt: now.toISOString(), purgeAfter: purgeAfter.toISOString(), retentionDays: RETENTION_DAYS },
    200,
    origin,
  );
});
