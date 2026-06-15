import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: the INITIATOR cancels their own pending firm⇄workspace join request.
// Only requested_by may cancel (the counterparty rejects via act-on instead).
// verify_jwt = true.
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

    const { requestId } = await req.json().catch(() => ({ requestId: undefined }));
    if (!requestId || typeof requestId !== "string") return json({ ok: false, reason: "bad_request", message: "requestId is required" }, 400);

    const { data: reqRow } = await supabaseAdmin
      .from("firm_workspace_join_requests").select("id, firm_id, workspace_id, status, requested_by").eq("id", requestId).maybeSingle();
    if (!reqRow) return json({ ok: false, reason: "not_found" }, 404);
    if (reqRow.requested_by !== user.id) return json({ ok: false, reason: "not_authorized", message: "Only the requester can cancel" }, 403);
    if (reqRow.status !== "pending") return json({ ok: false, reason: "not_pending", message: "This request is no longer pending" }, 409);

    const { error: updErr } = await supabaseAdmin.from("firm_workspace_join_requests")
      .update({ status: "cancelled", acted_at: new Date().toISOString(), acted_by: user.id })
      .eq("id", reqRow.id).eq("status", "pending");
    if (updErr) { console.error("[cancel-firm-workspace-join-request] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: reqRow.firm_id, user_id: user.id, activity_type: "firm_join_request_cancelled",
      details: { request_id: reqRow.id, workspace_id: reqRow.workspace_id },
    });
    return json({ ok: true, status: "cancelled" }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[cancel-firm-workspace-join-request] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
