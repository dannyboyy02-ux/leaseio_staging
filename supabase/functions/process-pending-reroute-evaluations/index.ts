// process-pending-reroute-evaluations — Phase 6 Checkpoint 3
//
// Cron-friendly poller. Selects leases where reroute_evaluation_pending
// is true and invokes resolve-approval-chain with initialResolution=false
// for each. The resolver clears the flag on completion, so this function
// is safe to run repeatedly — already-cleared leases get skipped at the
// resolver's "no attribute change since last snapshot" gate.
//
// Schedule (when wired in production): every 5 minutes. Until then,
// invoke manually with any authenticated JWT.
//
// AUTH: verify_jwt = true. Production cron passes the service-role JWT.
// For manual smoke tests, any authenticated user works.

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

interface PendingLease {
  id: string;
  workspace_id: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
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

  // Pull every lease with the flag set. No workspace scoping at this
  // layer — the cron runs across all workspaces. Service-role has full
  // access; resolve-approval-chain enforces workspace membership when
  // each lease is processed.
  const { data: leases, error: leasesError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id")
    .eq("reroute_evaluation_pending", true);

  if (leasesError) {
    console.error("[process-pending-reroute-evaluations] load error:", leasesError.message);
    return jsonResponse(
      { ok: false, error: leasesError.message, reason: "internal" },
      500,
      origin,
    );
  }

  const pending = (leases ?? []) as PendingLease[];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ leaseId: string; error: string }> = [];

  // Sequential to keep the resolver from rate-limiting itself or
  // racing on the same lease (e.g., if a real-time call came in
  // between us reading the flag and invoking).
  for (const lease of pending) {
    processed++;
    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/resolve-approval-chain`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          leaseId: lease.id,
          initialResolution: false,
          detectionMode: "auto",
          triggerReason: "process_pending_reroute_evaluations",
        }),
      });
      if (resp.ok) {
        succeeded++;
      } else {
        failed++;
        const text = await resp.text();
        failures.push({ leaseId: lease.id, error: `${resp.status}: ${text.slice(0, 200)}` });
      }
    } catch (err: any) {
      failed++;
      failures.push({ leaseId: lease.id, error: err?.message ?? String(err) });
    }
  }

  return jsonResponse(
    {
      ok: true,
      ranAt: new Date().toISOString(),
      processed,
      succeeded,
      failed,
      // Cap the failure detail list so the response payload stays bounded
      failuresSample: failures.slice(0, 20),
    },
    200,
    origin,
  );
});
