// process-delegate-timers — Phase 7 Checkpoint 3
//
// Hourly scheduled function. Activates the policy delegate for chain
// steps whose pending_since + delegate_after_days has elapsed, but
// only if no higher-priority delegation is in effect (voluntary or
// OOO). Idempotent — running multiple times in a window doesn't
// double-activate.
//
// Schedule: hourly at :05 UTC, wired via pg_cron in
// `20260507220000_phase567_crons.sql`. Manual invocation for testing
// requires the same x-cron-secret header — no JWT fallback.
//
// AUTH: verify_jwt = false (config.toml override). Caller must present
// `x-cron-secret: $PROCESS_DELEGATE_TIMERS_CRON_SECRET`. The secret is
// set in two places at deploy time:
//   1. Edge function env: `supabase secrets set PROCESS_DELEGATE_TIMERS_CRON_SECRET=<value>`
//   2. Database setting:  `ALTER DATABASE postgres SET app.process_delegate_timers_cron_secret = '<value>';`

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { shouldActivatePolicyDelegate } from "../_shared/approval_chain.ts";

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

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("PROCESS_DELEGATE_TIMERS_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const providedCronSecret = req.headers.get("x-cron-secret");
  if (providedCronSecret !== expectedCronSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Pull every pending step with a delegate configured but not yet
  // activated. Filter further in JS (the partial index covers the
  // SQL-side filter; we still apply shouldActivatePolicyDelegate
  // for the time-elapsed check).
  const { data: candidates, error: candErr } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, delegate_user_id, delegate_after_days, pending_since, assignee_resolution_source",
    )
    .eq("status", "pending")
    .not("delegate_user_id", "is", null)
    .not("delegate_after_days", "is", null)
    .is("delegate_activated_at", null);

  if (candErr) {
    console.error("[process-delegate-timers] load error:", candErr.message);
    return jsonResponse({ ok: false, error: candErr.message, reason: "internal" }, 500, origin);
  }

  const rows = (candidates ?? []) as Array<{
    id: string; lease_id: string; workspace_id: string;
    delegate_user_id: string | null; delegate_after_days: number | null;
    pending_since: string | null; assignee_resolution_source: string | null;
  }>;

  const now = new Date();
  let scanned = 0;
  let activated = 0;
  let skippedTooEarly = 0;
  let skippedDelegationActive = 0;

  for (const r of rows) {
    scanned++;
    if (!shouldActivatePolicyDelegate(r.pending_since, r.delegate_after_days, r.delegate_user_id, now)) {
      skippedTooEarly++;
      continue;
    }
    // Skip if voluntary or OOO delegate already in effect — those
    // outrank policy delegate per resolveEffectiveAssignee.
    if (r.assignee_resolution_source === "voluntary_delegate" ||
        r.assignee_resolution_source === "ooo_delegate") {
      skippedDelegationActive++;
      continue;
    }

    const nowIso = new Date().toISOString();
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({
        delegate_activated_at: nowIso,
        effective_assignee_user_id: r.delegate_user_id,
        assignee_resolution_source: "policy_delegate",
      })
      .eq("id", r.id);

    const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: r.lease_id,
      user_id: null,
      activity_type: "delegate_activated",
      details: {
        chain_step_id: r.id,
        delegate_user_id: r.delegate_user_id,
        delegate_after_days: r.delegate_after_days,
        pending_since: r.pending_since,
        activated_at: nowIso,
      },
    });
    if (auditErr) console.error("lease_activity_log insert failed (delegate_activated):", auditErr.message);

    // Notify the delegate
    if (r.delegate_user_id) {
      const { error: auditErr2 } = await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: r.lease_id,
        user_id: null,
        activity_type: "comment",
        details: {
          notification_type: "policy_delegate_activated",
          recipient_ids: [r.delegate_user_id],
          message:
            `An approval step's original assignee did not respond within ${r.delegate_after_days} days. As the policy delegate, you can act on it now.`,
        },
      });
      if (auditErr2) console.error("lease_activity_log insert failed (comment/policy_delegate_activated notification):", auditErr2.message);
    }

    activated++;
  }

  return jsonResponse(
    {
      ok: true,
      ranAt: now.toISOString(),
      scanned,
      activated,
      skippedTooEarly,
      skippedDelegationActive,
    },
    200,
    origin,
  );
});
