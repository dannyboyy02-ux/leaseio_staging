import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: approve/reject a firm⇄workspace join request. The COUNTERPARTY (the
// side that did NOT initiate) decides:
//   firm_to_workspace — firm admin initiated; the workspace owner/admin decides
//   workspace_to_firm — workspace side initiated; the firm admin/owner decides
// On approval the workspace is bound to the firm (service-role update → the DB
// triggers handle the child counter, firm_joined_at, and forcing plan=business).
// verify_jwt = true. Sets acted_by/acted_at on every transition (CP1 invariant).
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: s });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, reason: "no_auth" }, 401);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace(/^Bearer\s+/i, "").trim());
    if (userError || !userData?.user?.id) return json({ ok: false, reason: "invalid_auth" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const requestId = (body as { requestId?: string }).requestId;
    const decision = (body as { decision?: string }).decision;
    const decisionNote = typeof (body as { decisionNote?: string }).decisionNote === "string" ? (body as { decisionNote: string }).decisionNote : null;
    if (!requestId || typeof requestId !== "string") return json({ ok: false, reason: "bad_request", message: "requestId is required" }, 400);
    if (decision !== "approved" && decision !== "rejected") return json({ ok: false, reason: "bad_request", message: "decision must be approved | rejected" }, 400);

    const { data: reqRow } = await supabaseAdmin
      .from("firm_workspace_join_requests")
      .select("id, firm_id, workspace_id, request_direction, status, requested_by")
      .eq("id", requestId).maybeSingle();
    if (!reqRow) return json({ ok: false, reason: "not_found" }, 404);
    if (reqRow.status !== "pending") return json({ ok: false, reason: "not_pending", message: "This request is no longer pending" }, 409);

    // Authorize the COUNTERPARTY (the non-initiating side).
    let authorized = false;
    if (reqRow.request_direction === "firm_to_workspace") {
      const { data: ws } = await supabaseAdmin.from("workspaces").select("owner_id").eq("id", reqRow.workspace_id).maybeSingle();
      authorized = (ws as { owner_id: string } | null)?.owner_id === user.id;
      if (!authorized) {
        const { data: m } = await supabaseAdmin.from("workspace_members").select("id").eq("workspace_id", reqRow.workspace_id).eq("user_id", user.id).eq("role", "admin").maybeSingle();
        authorized = Boolean(m);
      }
    } else {
      const { data: firm } = await supabaseAdmin.from("firms").select("owner_id").eq("id", reqRow.firm_id).maybeSingle();
      authorized = (firm as { owner_id: string } | null)?.owner_id === user.id;
      if (!authorized) {
        const { data: m } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", reqRow.firm_id).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
        authorized = Boolean(m);
      }
    }
    if (!authorized) return json({ ok: false, reason: "not_authorized", message: "Only the other party can decide this request" }, 403);

    const nowIso = new Date().toISOString();

    if (decision === "approved") {
      // Bind the workspace to the firm (mirrors bind-workspace-to-firm). Guard
      // against a workspace that was bound elsewhere since the request opened.
      const { data: ws } = await supabaseAdmin.from("workspaces").select("firm_id").eq("id", reqRow.workspace_id).maybeSingle();
      if (!ws) return json({ ok: false, reason: "not_found", message: "Workspace no longer exists" }, 404);
      if ((ws as { firm_id: string | null }).firm_id) return json({ ok: false, reason: "already_bound", message: "Workspace is already bound to a firm" }, 409);

      const { error: bindErr } = await supabaseAdmin.from("workspaces").update({ firm_id: reqRow.firm_id }).eq("id", reqRow.workspace_id).is("firm_id", null);
      if (bindErr) {
        const isQuota = /child workspace limit/i.test(bindErr.message);
        console.error("[act-on-firm-workspace-join-request] bind:", bindErr.message);
        return json({ ok: false, reason: isQuota ? "quota_exceeded" : "bind_failed", message: isQuota ? "The firm's child-workspace limit is reached" : "Could not bind the workspace" }, isQuota ? 409 : 400);
      }
    }

    const { error: updErr } = await supabaseAdmin.from("firm_workspace_join_requests")
      .update({ status: decision, acted_at: nowIso, acted_by: user.id, decision_note: decisionNote })
      .eq("id", reqRow.id).eq("status", "pending");
    if (updErr) { console.error("[act-on-firm-workspace-join-request] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: reqRow.firm_id, user_id: user.id,
      activity_type: decision === "approved" ? "firm_join_request_approved" : "firm_join_request_rejected",
      details: { request_id: reqRow.id, workspace_id: reqRow.workspace_id, direction: reqRow.request_direction },
    });
    return json({ ok: true, status: decision, workspace_bound: decision === "approved" }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[act-on-firm-workspace-join-request] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
