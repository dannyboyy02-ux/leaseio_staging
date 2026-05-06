// reroute-audit-sweep — Phase 6 Checkpoint 3
//
// Daily scheduled function. Re-evaluates every active chain-driven
// lease against current policy state to catch:
//   - Policies edited by admins after a chain was resolved (the
//     lease's snapshot is stale relative to the new policy).
//   - Workspace-level changes that affect attribute interpretation.
//   - Bug-induced state where a lease's chain is silently misaligned.
//
// CONSERVATIVE BY DESIGN: this function detects but does not act.
// Findings surface to admins via the reroute_audit_run activity rows
// and the admin reroute audit dashboard (Phase 6 C4). Acting requires
// explicit admin approval via admin-trigger-manual-reroute.
//
// AUTH: verify_jwt = true. Production cron passes the service-role
// JWT. Manual smoke runs work with any authenticated user JWT.

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

// Active, chain-driven, non-terminal lifecycle states. Reroute mode is
// only meaningful for these. fully_executed and active are included so
// the sweep can detect post-execution gaps (which the resolver will
// surface as chain_violation if a real reroute fires later).
const SWEEP_LIFECYCLES = [
  "concept_submitted",
  "concept_under_review",
  "in_negotiation",
  "final_review",
  "pending_counter_signature",
  "fully_executed",
  "active",
] as const;

interface SweepLease {
  id: string;
  workspace_id: string;
  lifecycle_status: string;
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

  // Find chain-driven leases (have at least one chain row) in the
  // active sweep lifecycles. Two-step query because Supabase's
  // PostgREST doesn't natively express EXISTS subqueries.
  const { data: chainLeaseIdsData, error: chainErr } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("lease_id");
  if (chainErr) {
    console.error("[reroute-audit-sweep] chain load error:", chainErr.message);
    return jsonResponse(
      { ok: false, error: chainErr.message, reason: "internal" },
      500,
      origin,
    );
  }
  const chainLeaseIds = Array.from(
    new Set(((chainLeaseIdsData ?? []) as Array<{ lease_id: string }>).map((r) => r.lease_id)),
  );
  if (chainLeaseIds.length === 0) {
    return jsonResponse(
      {
        ok: true,
        ranAt: new Date().toISOString(),
        scanned: 0,
        wouldReroute: 0,
        wouldChainViolation: 0,
      },
      200,
      origin,
    );
  }

  const { data: leases, error: leasesError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status")
    .in("id", chainLeaseIds)
    .in("lifecycle_status", SWEEP_LIFECYCLES as unknown as string[]);
  if (leasesError) {
    console.error("[reroute-audit-sweep] leases load error:", leasesError.message);
    return jsonResponse(
      { ok: false, error: leasesError.message, reason: "internal" },
      500,
      origin,
    );
  }

  const sweepLeases = (leases ?? []) as SweepLease[];
  let scanned = 0;
  let wouldReroute = 0;
  let wouldChainViolation = 0;
  const failures: Array<{ leaseId: string; error: string }> = [];

  for (const lease of sweepLeases) {
    scanned++;
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
          auditMode: true,
          detectionMode: "manual_audit",
          triggerReason: "reroute_audit_sweep",
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        failures.push({ leaseId: lease.id, error: `${resp.status}: ${text.slice(0, 200)}` });
        continue;
      }
      const data = await resp.json();
      if (data?.would_reroute) {
        wouldReroute++;
        if (data?.would_chain_violation) wouldChainViolation++;
      }
    } catch (err: any) {
      failures.push({ leaseId: lease.id, error: err?.message ?? String(err) });
    }
  }

  return jsonResponse(
    {
      ok: true,
      ranAt: new Date().toISOString(),
      scanned,
      wouldReroute,
      wouldChainViolation,
      failuresSample: failures.slice(0, 20),
    },
    200,
    origin,
  );
});
