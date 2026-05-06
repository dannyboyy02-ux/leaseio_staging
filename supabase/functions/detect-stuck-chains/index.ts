// detect-stuck-chains — Phase 7 Checkpoint 3
//
// Daily scheduled function. Surfaces leases with pending steps that
// have been sitting without action for 7+ days. Deduplicates per
// lease via a 14-day look-back: if a stuck_chain_detected row was
// already written for the lease in the last 14 days, the function
// no-ops on it (admins were already notified; further alerts are
// noise).
//
// AUTH: verify_jwt = true. Production cron supplies service-role JWT.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { isStepStuck } from "../_shared/approval_chain.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, GET, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const STUCK_THRESHOLD_DAYS = 7;
const NOTIFICATION_LOOKBACK_DAYS = 14;

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server configuration error" }, 500, origin);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  }

  // Pull pending steps with non-null pending_since. The partial index
  // idx_chain_pending_since covers this. We then filter via the pure
  // helper to avoid duplicating threshold logic in SQL.
  const { data: candidates, error: candErr } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("id, lease_id, workspace_id, stage, step_order, pending_since")
    .eq("status", "pending")
    .not("pending_since", "is", null);

  if (candErr) {
    console.error("[detect-stuck-chains] load error:", candErr.message);
    return jsonResponse({ ok: false, error: candErr.message, reason: "internal" }, 500, origin);
  }

  const rows = (candidates ?? []) as Array<{
    id: string; lease_id: string; workspace_id: string;
    stage: string; step_order: number; pending_since: string | null;
  }>;

  const now = new Date();
  const stuckRows = rows.filter((r) => isStepStuck(r.pending_since, STUCK_THRESHOLD_DAYS, now));

  // Dedupe by lease — one notification per lease per cycle.
  const stuckByLease = new Map<string, typeof stuckRows[number]>();
  for (const r of stuckRows) {
    if (!stuckByLease.has(r.lease_id)) stuckByLease.set(r.lease_id, r);
  }

  let detected = 0;
  let skippedRecent = 0;
  const lookbackCutoff = new Date(now.getTime() - NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (const [leaseId, r] of stuckByLease) {
    // Has a stuck_chain_detected been written for this lease in the
    // last 14 days?
    const { data: prior } = await supabaseAdmin
      .from("lease_activity_log")
      .select("id")
      .eq("lease_id", leaseId)
      .eq("activity_type", "stuck_chain_detected")
      .gte("created_at", lookbackCutoff)
      .limit(1);
    if (prior && prior.length > 0) {
      skippedRecent++;
      continue;
    }

    // Insert stuck_chain_detected
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: leaseId,
      user_id: null,
      activity_type: "stuck_chain_detected",
      details: {
        chain_step_id: r.id,
        stage: r.stage,
        step_order: r.step_order,
        pending_since: r.pending_since,
        days_stuck: Math.floor((now.getTime() - new Date(r.pending_since!).getTime()) / (24 * 60 * 60 * 1000)),
      },
    });

    // Notify workspace admins
    const { data: adminMembers } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", r.workspace_id)
      .eq("role", "admin");
    const { data: ownerRow } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", r.workspace_id)
      .maybeSingle();
    const recipientIds = new Set<string>();
    for (const m of (adminMembers ?? []) as Array<{ user_id: string }>) recipientIds.add(m.user_id);
    if ((ownerRow as { owner_id: string } | null)?.owner_id) {
      recipientIds.add((ownerRow as { owner_id: string }).owner_id);
    }
    if (recipientIds.size > 0) {
      await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: leaseId,
        user_id: null,
        activity_type: "comment",
        details: {
          notification_type: "stuck_chain_detected",
          recipient_ids: Array.from(recipientIds),
          message: `A lease's approval chain has been stuck for 7+ days. Review at /app/admin/exceptions.`,
        },
      });
    }

    detected++;
  }

  return jsonResponse(
    {
      ok: true,
      ranAt: now.toISOString(),
      candidatesScanned: rows.length,
      stuckLeases: stuckByLease.size,
      detected,
      skippedRecent,
    },
    200,
    origin,
  );
});
