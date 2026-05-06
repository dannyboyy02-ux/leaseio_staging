// admin-trigger-manual-reroute — Phase 6 Checkpoint 3
//
// Lets a workspace admin force a reroute evaluation on a specific lease,
// bypassing the trigger-driven flag. Required when the reroute audit
// sweep flagged a misalignment that the auto-trigger didn't catch
// (e.g., a policy was edited after the lease's chain was resolved, so
// no lease-attribute change ever fired the trigger).
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be workspace owner OR workspace_members.role = 'admin'
//
// VALIDATION
//   - reason: required, ≥20 trimmed characters (audit-quality justification)
//   - leaseId: required
//
// EFFECTS
//   1. Insert manual_reroute_requested activity log row (always, even if
//      the resolver later decides no reroute is needed — captures the
//      admin's intent for audit)
//   2. Invoke resolve-approval-chain with initialResolution=false and
//      detectionMode='manual_admin'
//   3. Insert manual_reroute_approved or manual_reroute_rejected based
//      on outcome (rerouted vs no_reroute_needed)
//   4. Return the resolver's response verbatim alongside the request id

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
  reason: string;
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
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20) {
    return jsonResponse(
      {
        ok: false,
        error: "Reason must be at least 20 characters describing why a manual reroute is warranted.",
        reason: "bad_request",
      },
      400,
      origin,
    );
  }

  // Load lease + verify workspace + admin authorization
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    return jsonResponse(
      { ok: false, error: "Failed to load lease", reason: "internal" },
      500,
      origin,
    );
  }
  if (!lease) {
    return jsonResponse(
      { ok: false, error: "Lease not found", reason: "not_found" },
      404,
      origin,
    );
  }
  const workspaceId = (lease as any).workspace_id as string;

  let isAuthorized = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if ((ws as any)?.owner_id === user.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (member) isAuthorized = true;
  }
  if (!isAuthorized) {
    return jsonResponse(
      {
        ok: false,
        error: "Forbidden — only workspace owners or admins can trigger a manual reroute.",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  const rateLimit = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "admin-trigger-manual-reroute",
    origin,
    20,
  );
  if (rateLimit) return rateLimit;

  // Capture intent regardless of outcome — audit-relevant.
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: lease.id,
    user_id: user.id,
    activity_type: "manual_reroute_requested",
    details: {
      reason,
      requested_by: user.id,
      lifecycle_at_request: (lease as any).lifecycle_status,
    },
  });

  console.log(
    `[admin-trigger-manual-reroute] User ${user.id} requesting manual reroute on lease ${lease.id}`,
  );

  // Invoke the resolver
  let resolverResp: Response;
  try {
    resolverResp = await fetch(`${supabaseUrl}/functions/v1/resolve-approval-chain`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        leaseId: lease.id,
        initialResolution: false,
        detectionMode: "manual_admin",
        triggerReason: `manual_admin: ${reason}`,
      }),
    });
  } catch (err: any) {
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "manual_reroute_rejected",
      details: { reason: "resolver_unreachable", error: err?.message ?? String(err) },
    });
    return jsonResponse(
      {
        ok: false,
        error: `Resolver invocation failed: ${err?.message ?? String(err)}`,
        reason: "resolver_failed",
      },
      500,
      origin,
    );
  }

  const resolverBody = await resolverResp.json().catch(() => ({}));

  if (!resolverResp.ok || resolverBody?.ok === false) {
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: "manual_reroute_rejected",
      details: {
        reason: resolverBody?.reason ?? "resolver_error",
        resolver_status: resolverResp.status,
        resolver_body: resolverBody,
      },
    });
    return jsonResponse(
      {
        ok: false,
        error: resolverBody?.error ?? "Resolver rejected the manual reroute",
        reason: resolverBody?.reason ?? "resolver_failed",
        resolver: resolverBody,
      },
      resolverResp.status,
      origin,
    );
  }

  // Resolver returned ok. Distinguish "rerouted" vs "no_reroute_needed".
  const wasApproved = resolverBody?.rerouted === true;
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: lease.id,
    user_id: user.id,
    activity_type: wasApproved ? "manual_reroute_approved" : "manual_reroute_rejected",
    details: {
      reason: wasApproved ? reason : (resolverBody?.reason ?? "no_reroute_needed"),
      reroute_event_id: resolverBody?.reroute_event_id ?? null,
      resolver: resolverBody,
    },
  });

  return jsonResponse(
    {
      ok: true,
      manualRerouteOutcome: wasApproved ? "approved" : "rejected",
      reason: wasApproved ? null : (resolverBody?.reason ?? "no_reroute_needed"),
      resolver: resolverBody,
    },
    200,
    origin,
  );
});
