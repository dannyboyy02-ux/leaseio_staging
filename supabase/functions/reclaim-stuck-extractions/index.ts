// reclaim-stuck-extractions — Cluster B2 (AI extraction robustness)
//
// Scheduled sweep that fails leases stuck in status='Processing'. process_lease
// and retry_lease run extraction SYNCHRONOUSLY inside the request; if the edge
// function hits its wall-clock limit (or the isolate is killed) mid-extraction,
// no catch block runs and the lease stays 'Processing' forever — processed_at
// null, error_message null. (Observed: leases sitting 'Processing' for 60 days.)
// This sweep flips such rows to 'Failed' so the user sees a clear, retryable
// state (FailedLeaseBanner → retry_lease) instead of a permanent spinner.
//
// It deliberately touches ONLY the extraction-status columns (status,
// processed_at, error_message) — never lifecycle_status / approval / model_lock
// columns — so it does not interact with the lease workflow governance triggers.
// Runs under service role.
//
// AUTH: verify_jwt = false (config.toml). The caller must present
//   x-cron-secret: $RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET
// Set at deploy time (two places, same pattern as the other cron functions):
//   1. supabase secrets set RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET=$(openssl rand -hex 32)
//   2. INSERT INTO private.cron_secrets (id, value)
//        VALUES ('reclaim_stuck_extractions', '<same value>');

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

// Extraction completes in well under 3 minutes; 30 gives generous headroom
// before a still-'Processing' lease is declared dead.
const STUCK_THRESHOLD_MINUTES = 30;

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("RECLAIM_STUCK_EXTRACTIONS_CRON_SECRET");
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

  const cutoffIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60_000).toISOString();
  const nowIso = new Date().toISOString();

  // Atomic-per-row flip. The filters make this idempotent: a row already flipped
  // to 'Failed' (or that has a processed_at) no longer matches, so re-runs only
  // touch genuinely-stuck rows. .select() returns exactly the rows we changed.
  const { data: reclaimed, error: updErr } = await supabaseAdmin
    .from("leases")
    .update({
      status: "Failed",
      processed_at: nowIso,
      error_message:
        "Extraction timed out and was automatically failed. Please retry from the lease.",
    })
    .eq("status", "Processing")
    .is("processed_at", null)
    .lt("uploaded_at", cutoffIso)
    .select("id, workspace_id");

  if (updErr) {
    console.error("[reclaim-stuck-extractions] update error:", updErr.message);
    return jsonResponse({ ok: false, error: updErr.message, reason: "internal" }, 500, origin);
  }

  const rows = (reclaimed ?? []) as Array<{ id: string; workspace_id: string | null }>;

  if (rows.length > 0) {
    // Audit each reclaim. user_id is null — this is a system sweep, not a user
    // action (honest attribution; #90 NULL-attribution convention).
    const { error: logErr } = await supabaseAdmin.from("lease_activity_log").insert(
      rows.map((r) => ({
        lease_id: r.id,
        user_id: null,
        activity_type: "extraction_timed_out",
        details: {
          previous_status: "Processing",
          reason: "stuck_extraction_timeout",
          stuck_threshold_minutes: STUCK_THRESHOLD_MINUTES,
        },
      })),
    );
    if (logErr) {
      console.error("[reclaim-stuck-extractions] activity log error:", logErr.message);
    }
  }

  console.log(`[reclaim-stuck-extractions] reclaimed ${rows.length} stuck lease(s)`);
  return jsonResponse({ ok: true, reclaimed: rows.length, threshold_minutes: STUCK_THRESHOLD_MINUTES }, 200, origin);
});
