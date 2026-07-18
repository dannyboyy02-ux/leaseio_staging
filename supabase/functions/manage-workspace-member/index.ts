import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

// Service-role member management: authorizes owner OR admin to change a
// member's role and to remove a member (mirroring how send-invite authorizes
// the third member-management write — invite). workspace_members UPDATE/DELETE
// is owner-only at RLS, so the browser path fails for admins; this function is
// the owner-OR-admin authorization boundary, and it moves the audit write
// server-side so it is guaranteed (the old client insert never fired for
// admins because the rejected UPDATE ran first).
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
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, "").trim(),
    );
    if (userError || !userData?.user?.id) return json({ ok: false, reason: "invalid_auth" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = (body as { action?: string }).action;
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    const memberId = (body as { memberId?: string }).memberId;
    const role = (body as { role?: string }).role;

    if (action !== "set_role" && action !== "remove")
      return json({ ok: false, reason: "bad_request", message: "action must be set_role | remove" }, 400);
    if (!workspaceId || typeof workspaceId !== "string")
      return json({ ok: false, reason: "bad_request", message: "workspaceId is required" }, 400);
    if (!memberId || typeof memberId !== "string")
      return json({ ok: false, reason: "bad_request", message: "memberId is required" }, 400);
    if (action === "set_role" && role !== "admin" && role !== "editor" && role !== "viewer")
      return json({ ok: false, reason: "bad_request", message: "role must be admin | editor | viewer" }, 400);

    // Authorize owner OR admin (mirror send-invite).
    const { data: workspace } = await supabaseAdmin
      .from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
    if (!workspace) return json({ ok: false, reason: "not_found", message: "Workspace not found" }, 404);
    const ownerId = (workspace as { owner_id: string }).owner_id;
    const isOwner = ownerId === user.id;
    if (!isOwner) {
      const { data: membership } = await supabaseAdmin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
      if (membership?.role !== "admin")
        return json({ ok: false, reason: "not_authorized", message: "Only workspace owners or admins may manage members" }, 403);
    }

    // Target row, scoped to this workspace.
    const { data: target } = await supabaseAdmin
      .from("workspace_members").select("id, user_id, role")
      .eq("id", memberId).eq("workspace_id", workspaceId).maybeSingle();
    if (!target) return json({ ok: false, reason: "not_found", message: "Member not found" }, 404);
    // Never touch the owner's own membership row via this path.
    if ((target as { user_id: string }).user_id === ownerId)
      return json({ ok: false, reason: "cannot_modify_owner", message: "The workspace owner cannot be re-roled or removed here" }, 403);

    if (action === "set_role") {
      // Mirror the 'live workspace required for update' RESTRICTIVE RLS.
      const liveness = await checkWorkspaceLive(supabaseAdmin, workspaceId);
      if (!liveness.live) return json({ ok: false, reason: "subscription_inactive", detail: liveness.reason }, 403);
      const previousRole = (target as { role: string }).role;
      if (previousRole === role) return json({ ok: true, status: "unchanged" }, 200);
      const { error: updErr } = await supabaseAdmin
        .from("workspace_members").update({ role }).eq("id", memberId).eq("workspace_id", workspaceId);
      if (updErr) { console.error("[manage-workspace-member] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }
      await supabaseAdmin.from("workspace_activity_log").insert({
        workspace_id: workspaceId, user_id: user.id, event_type: "member_role_changed",
        details: { target_user_id: (target as { user_id: string }).user_id, role, previous_role: previousRole },
      });
      return json({ ok: true }, 200);
    }

    // action === 'remove'. DELETE stays open even on a non-live workspace
    // (Vault V1: shrinking access must stay possible).
    const { error: delErr } = await supabaseAdmin
      .from("workspace_members").delete().eq("id", memberId).eq("workspace_id", workspaceId);
    if (delErr) { console.error("[manage-workspace-member] delete:", delErr.message); return json({ ok: false, reason: "write_failed" }, 400); }
    await supabaseAdmin.from("workspace_activity_log").insert({
      workspace_id: workspaceId, user_id: user.id, event_type: "member_removed",
      details: { target_user_id: (target as { user_id: string }).user_id, previous_role: (target as { role: string }).role },
    });
    return json({ ok: true }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[manage-workspace-member] Error:", msg);
    return json({ ok: false, reason: "unexpected", message: msg }, 500);
  }
});
