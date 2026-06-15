import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 9: bind a workspace into a firm. Requires the caller to own BOTH the
// workspace and the firm (the simpler P9 model; richer two-party consent is
// Phase 10). Runs service-role so the firm-binding guard is bypassed; the DB
// triggers handle the counter, firm_joined_at, and forcing plan='business'.
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
    if (!authHeader) return json({ error: "No authorization header provided", reason: "no_auth" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user?.id) return json({ error: "User not authenticated", reason: "invalid_auth" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const firmId = (body as { firmId?: string }).firmId;
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    if (!firmId || typeof firmId !== "string") return json({ error: "firmId is required", reason: "bad_request" }, 400);
    if (!workspaceId || typeof workspaceId !== "string") return json({ error: "workspaceId is required", reason: "bad_request" }, 400);

    const { data: firm } = await supabaseAdmin.from("firms").select("id, owner_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ error: "Firm not found", reason: "not_found" }, 404);
    if ((firm as { owner_id: string }).owner_id !== user.id)
      return json({ error: "You must own the firm to bind a workspace to it", reason: "not_authorized" }, 403);

    const { data: ws } = await supabaseAdmin
      .from("workspaces").select("id, owner_id, firm_id").eq("id", workspaceId).maybeSingle();
    if (!ws) return json({ error: "Workspace not found", reason: "not_found" }, 404);
    if ((ws as { owner_id: string }).owner_id !== user.id)
      return json({ error: "You must own the workspace to bind it", reason: "not_authorized" }, 403);
    if ((ws as { firm_id: string | null }).firm_id)
      return json({ error: "Workspace is already bound to a firm", reason: "already_bound" }, 409);

    // The counter trigger raises if the firm's child limit is reached.
    const { error: updErr } = await supabaseAdmin
      .from("workspaces").update({ firm_id: firmId }).eq("id", workspaceId);
    if (updErr) {
      const isQuota = /child workspace limit/i.test(updErr.message);
      return json({ error: updErr.message, reason: isQuota ? "quota_exceeded" : "bind_failed" }, isQuota ? 409 : 400);
    }

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: firmId,
      user_id: user.id,
      activity_type: "workspace_joined_firm",
      details: { workspace_id: workspaceId },
    });

    return json({ ok: true, firm_id: firmId, workspace_id: workspaceId }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[BIND-WORKSPACE-TO-FIRM] Error:", msg);
    return json({ error: msg }, 500);
  }
});
