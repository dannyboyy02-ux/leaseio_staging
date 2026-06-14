// revoke-out-of-office — Phase 7 Checkpoint 3
//
// User cancels their OOO declaration before it expires. Affects only
// the user's OWN OOO records. For chain steps that were OOO-routed
// and haven't been acted on yet, effective_assignee reverts to the
// next-priority source via resolveEffectiveAssignee.
//
// AUTHORIZATION
//   - Bearer JWT
//   - Caller must be the OOO record's user_id

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { type AssigneeContext, resolveEffectiveAssignee } from "../_shared/approval_chain.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

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
  oooId: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

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
  const user = userData.user;

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin); }

  if (!body?.oooId) {
    return jsonResponse({ ok: false, error: "oooId is required", reason: "bad_request" }, 400, origin);
  }

  const { data: oooRow } = await supabaseAdmin
    .from("user_out_of_office")
    .select("id, user_id, workspace_id, delegate_user_id, is_active")
    .eq("id", body.oooId)
    .maybeSingle();
  if (!oooRow) {
    return jsonResponse({ ok: false, error: "OOO record not found", reason: "not_found" }, 404, origin);
  }
  const ooo = oooRow as {
    id: string; user_id: string; workspace_id: string;
    delegate_user_id: string; is_active: boolean;
  };
  if (ooo.user_id !== user.id) {
    return jsonResponse(
      { ok: false, error: "Only the OOO user can revoke.", reason: "not_authorized" },
      403,
      origin,
    );
  }
  if (!ooo.is_active) {
    return jsonResponse(
      { ok: false, error: "OOO record is already inactive.", reason: "wrong_state" },
      409,
      origin,
    );
  }

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed). Gates the WHOLE
  // mutation path, including the personal user_out_of_office flip:
  // deactivating the row and reverting the OOO-routed chain steps are
  // one logical operation — flipping the row then 403ing on the revert
  // half would strand steps still routed to the delegate with no active
  // OOO record explaining why.
  const liveness = await checkWorkspaceLive(supabaseAdmin, ooo.workspace_id);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // Mark OOO inactive
  await supabaseAdmin
    .from("user_out_of_office")
    .update({ is_active: false })
    .eq("id", ooo.id);

  // Revert effective_assignee on still-pending OOO-routed steps.
  // Identify those by: pending status, assignee_resolution_source =
  // 'ooo_delegate', and either the original assignee was the OOO user
  // (approver_user_id = user_id) OR the prior chain via
  // effective_assignee was the user. The simplest scoped query:
  // pending + ooo_delegate source + workspace match + the original
  // approver was the user. (Other OOO routings unrelated to this OOO
  // record stay as-is; in practice each user has at most one active
  // OOO at a time so this matches cleanly.)
  const { data: routedSteps } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, approver_user_id, approver_role, delegate_user_id, delegate_after_days, pending_since",
    )
    .eq("workspace_id", ooo.workspace_id)
    .eq("status", "pending")
    .eq("assignee_resolution_source", "ooo_delegate")
    .eq("approver_user_id", ooo.user_id);
  const steps = (routedSteps ?? []) as Array<{
    id: string; lease_id: string; workspace_id: string;
    approver_user_id: string | null; approver_role: string | null;
    delegate_user_id: string | null; delegate_after_days: number | null;
    pending_since: string | null;
  }>;

  let revertedCount = 0;
  for (const s of steps) {
    // Look up active voluntary delegation (if any) for this step
    const { data: vd } = await supabaseAdmin
      .from("chain_step_voluntary_delegations")
      .select("delegated_to")
      .eq("chain_step_id", s.id)
      .is("revoked_at", null)
      .order("delegated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ctx: AssigneeContext = {
      policy_user_id: s.approver_user_id,
      policy_role: s.approver_role,
      policy_delegate_user_id: s.delegate_user_id,
      policy_delegate_after_days: s.delegate_after_days,
      voluntary_delegate_user_id: (vd as any)?.delegated_to ?? null,
      ooo_delegate_user_id: null,  // OOO revoked
      admin_reassigned_user_id: null,
      pending_since: s.pending_since,
    };
    const resolved = resolveEffectiveAssignee(ctx);
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({
        effective_assignee_user_id: resolved.user_id,
        assignee_resolution_source: resolved.source,
      })
      .eq("id", s.id);
    revertedCount++;
  }

  // Activity log: ooo_revoked. Attach to the first reverted lease,
  // or if none was reverted, skip the per-lease entry.
  if (steps.length > 0) {
    const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: steps[0].lease_id,
      user_id: user.id,
      activity_type: "ooo_revoked",
      details: {
        ooo_id: ooo.id,
        revoked_by: user.id,
        steps_reverted_count: revertedCount,
      },
    });
    if (auditErr) console.error("lease_activity_log insert failed (ooo_revoked):", auditErr.message);
  }

  return jsonResponse(
    {
      ok: true,
      oooId: ooo.id,
      stepsReverted: revertedCount,
    },
    200,
    origin,
  );
});
