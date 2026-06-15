import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 9: release a workspace from its firm. Allowed for the firm owner OR the
// workspace owner. Per the spec's data-preservation decision the workspace KEEPS
// 'business' on release (the owner downgrades separately if desired) — the
// plan-lock trigger only coerces plan on JOIN, never on release. Runs service-role.
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

    const { data: ws } = await supabaseAdmin
      .from("workspaces").select("id, owner_id, firm_id").eq("id", workspaceId).maybeSingle();
    if (!ws) return json({ error: "Workspace not found", reason: "not_found" }, 404);
    if ((ws as { firm_id: string | null }).firm_id !== firmId)
      return json({ error: "Workspace is not bound to this firm", reason: "not_bound" }, 409);

    const { data: firm } = await supabaseAdmin.from("firms").select("id, owner_id").eq("id", firmId).maybeSingle();
    const isWorkspaceOwner = (ws as { owner_id: string }).owner_id === user.id;
    const isFirmOwner = Boolean(firm) && (firm as { owner_id: string }).owner_id === user.id;
    if (!isWorkspaceOwner && !isFirmOwner)
      return json({ error: "Only the firm owner or workspace owner can release this workspace", reason: "not_authorized" }, 403);

    const { error: updErr } = await supabaseAdmin
      .from("workspaces").update({ firm_id: null }).eq("id", workspaceId);
    if (updErr) return json({ error: updErr.message, reason: "release_failed" }, 400);

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: firmId,
      user_id: user.id,
      activity_type: "workspace_left_firm",
      details: { workspace_id: workspaceId, plan_retained: "business" },
    });

    return json({ ok: true, firm_id: firmId, workspace_id: workspaceId }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[RELEASE-WORKSPACE-FROM-FIRM] Error:", msg);
    return json({ error: msg }, 500);
  }
});
