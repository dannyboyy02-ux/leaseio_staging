// cleanup-expired-reports — Phase 8 follow-up (KNOWN_ISSUES #12)
//
// Daily scheduled function. Marks lease_reports rows that have passed
// their `expires_at` deadline as `status = 'expired'` and removes the
// associated PDF + JSON artifacts from the `lease-reports` storage
// bucket. Idempotent — rows already at `status = 'expired'` are
// skipped via the WHERE filter.
//
// `expires_at` is set at generation time using
// `workspaces.report_artifact_retention_days` (default 90). The row
// is preserved as the audit anchor; only the storage objects are
// purged.
//
// Single-lease reports (`lease_id IS NOT NULL`) get a `report_expired`
// activity row. Portfolio reports skip the activity log (lease_id is
// NULL and lease_activity_log.lease_id is NOT NULL — same Phase 8
// As-built A6 decision used by generate-portfolio-report).
//
// Schedule (when wired in production): daily. Until then, manual
// invocation works with any authenticated JWT.
//
// AUTH: verify_jwt = true (default). Production cron supplies
// service-role JWT.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, GET, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const STORAGE_REMOVE_CHUNK = 100;

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  }

  const ranAt = new Date().toISOString();

  const { data: expiredRows, error: loadErr } = await supabaseAdmin
    .from("lease_reports")
    .select("id, workspace_id, lease_id, report_scope, pdf_storage_path, json_storage_path, expires_at")
    .neq("status", "expired")
    .not("expires_at", "is", null)
    .lte("expires_at", ranAt);

  if (loadErr) {
    console.error("[cleanup-expired-reports] load error:", loadErr.message);
    return jsonResponse({ ok: false, error: loadErr.message, reason: "internal" }, 500, origin);
  }

  const rows = (expiredRows ?? []) as Array<{
    id: string;
    workspace_id: string;
    lease_id: string | null;
    report_scope: string;
    pdf_storage_path: string | null;
    json_storage_path: string | null;
    expires_at: string;
  }>;

  let scanned = rows.length;
  let storageObjectsRemoved = 0;
  let storageRemoveErrors = 0;
  let rowsMarkedExpired = 0;
  let activityRowsWritten = 0;

  // Collect every artifact path across expired rows. The bucket is
  // `lease-reports` for both pdf and json paths (single bucket, so a
  // single batched remove call covers both).
  const allPaths: string[] = [];
  for (const r of rows) {
    if (r.pdf_storage_path) allPaths.push(r.pdf_storage_path);
    if (r.json_storage_path) allPaths.push(r.json_storage_path);
  }

  for (let i = 0; i < allPaths.length; i += STORAGE_REMOVE_CHUNK) {
    const chunk = allPaths.slice(i, i + STORAGE_REMOVE_CHUNK);
    const { data: removed, error: rmErr } = await supabaseAdmin.storage
      .from("lease-reports")
      .remove(chunk);
    if (rmErr) {
      // Don't abort the whole sweep on a single chunk failure — orphan
      // storage is invisible to users (path-prefix RLS) and the row
      // status update below makes the report disappear from the UI.
      // Tracked by storageRemoveErrors counter.
      console.warn(
        `[cleanup-expired-reports] storage remove error for chunk starting at ${i}: ${rmErr.message}`,
      );
      storageRemoveErrors++;
      continue;
    }
    storageObjectsRemoved += (removed ?? []).length;
  }

  for (const r of rows) {
    const { error: updateErr } = await supabaseAdmin
      .from("lease_reports")
      .update({ status: "expired" })
      .eq("id", r.id);
    if (updateErr) {
      console.error(
        `[cleanup-expired-reports] failed to mark row ${r.id} expired: ${updateErr.message}`,
      );
      continue;
    }
    rowsMarkedExpired++;

    // Per Phase 8 As-built A6: portfolio reports skip per-lease
    // activity rows because lease_activity_log.lease_id is NOT NULL.
    // The lease_reports row itself is the workspace-scope audit anchor.
    if (r.report_scope === "single_lease" && r.lease_id) {
      const { error: activityErr } = await supabaseAdmin
        .from("lease_activity_log")
        .insert({
          lease_id: r.lease_id,
          user_id: null,
          activity_type: "report_expired",
          details: {
            report_id: r.id,
            workspace_id: r.workspace_id,
            expires_at: r.expires_at,
            expired_at: ranAt,
            pdf_storage_path: r.pdf_storage_path,
            json_storage_path: r.json_storage_path,
          },
        });
      if (activityErr) {
        console.warn(
          `[cleanup-expired-reports] activity log insert failed for report ${r.id}: ${activityErr.message}`,
        );
        continue;
      }
      activityRowsWritten++;
    }
  }

  return jsonResponse(
    {
      ok: true,
      ranAt,
      scanned,
      rowsMarkedExpired,
      storageObjectsRemoved,
      storageRemoveErrors,
      activityRowsWritten,
    },
    200,
    origin,
  );
});
