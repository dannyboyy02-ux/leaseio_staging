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
// Schedule: daily at 08:30 UTC, wired via pg_cron in
// `20260507210000_cleanup_expired_reports_cron.sql`. Manual invocation
// for testing requires the same x-cron-secret header — there is no
// JWT fallback by design (the Phase 4 audit-remediation pattern moved
// scheduled functions off Bearer auth to a deployment-managed secret).
//
// AUTH: verify_jwt = false (config.toml override). Caller must present
// `x-cron-secret: $CLEANUP_EXPIRED_REPORTS_CRON_SECRET`. The secret is
// set in two places at deploy time:
//   1. Edge function env: `supabase secrets set CLEANUP_EXPIRED_REPORTS_CRON_SECRET=<value>`
//   2. Database setting:  `ALTER DATABASE postgres SET app.cleanup_expired_reports_cron_secret = '<value>';`
// pg_cron reads the database setting and forwards it as the header.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...baseCorsHeaders(origin, "POST, GET, OPTIONS"),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret",
  };
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
  const expectedCronSecret = Deno.env.get("CLEANUP_EXPIRED_REPORTS_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const providedCronSecret = req.headers.get("x-cron-secret");
  if (providedCronSecret !== expectedCronSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

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

  // P2-06 fix: process row-by-row, and ALWAYS null the storage paths
  // when we mark a row expired — even if the storage remove failed.
  // Rationale: the lease-reports SELECT policy (phase8 migration)
  // gates on `lr.pdf_storage_path = name OR lr.json_storage_path = name`.
  // Nulling the paths means an orphaned blob can no longer be matched
  // by any row → invisible to authenticated readers even if the bytes
  // remain in the bucket. The companion migration also adds a
  // status-and-time gate to the read policy so even a re-introduced
  // path can't grant access to an expired report.

  for (const r of rows) {
    const paths: string[] = [];
    if (r.pdf_storage_path) paths.push(r.pdf_storage_path);
    if (r.json_storage_path) paths.push(r.json_storage_path);

    let thisRowRemoveError = false;
    for (let i = 0; i < paths.length; i += STORAGE_REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + STORAGE_REMOVE_CHUNK);
      const { data: removed, error: rmErr } = await supabaseAdmin.storage
        .from("lease-reports")
        .remove(chunk);
      if (rmErr) {
        console.warn(
          `[cleanup-expired-reports] storage remove error for report ${r.id} chunk ${i}: ${rmErr.message}`,
        );
        thisRowRemoveError = true;
        storageRemoveErrors++;
        continue;
      }
      storageObjectsRemoved += (removed ?? []).length;
    }

    // Mark expired AND null the paths. Done atomically as a single UPDATE
    // so a partial-state row never exists. If thisRowRemoveError is true
    // we accept an orphan blob in storage; the next row keeps trying.
    const { error: updateErr } = await supabaseAdmin
      .from("lease_reports")
      .update({
        status: "expired",
        pdf_storage_path: null,
        json_storage_path: null,
      })
      .eq("id", r.id);
    if (updateErr) {
      console.error(
        `[cleanup-expired-reports] failed to mark row ${r.id} expired: ${updateErr.message}`,
      );
      continue;
    }
    rowsMarkedExpired++;
    void thisRowRemoveError; // tracked in storageRemoveErrors

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
