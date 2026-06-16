import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: toggle a firm-bound workspace's restrict_firm_access flag (the
// child's opt-out from firm-member visibility — e.g. a subsidiary shielding
// M&A leases from the parent).
//
// AUTHORIZATION — WORKSPACE OWNER ONLY (deliberate, security-critical): the
// point of restrict_firm_access is for the child to protect its data FROM the
// firm. If a firm admin could flip it off, the protection would be meaningless.
// So only the workspace owner may change it; firm admins see it read-only in the
// firm console. Runs service-role (the firm-binding guard makes the column
// service-role-only to write). verify_jwt = true.
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
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    const restrict = (body as { restrict?: boolean }).restrict;
    if (!workspaceId || typeof workspaceId !== "string") return json({ ok: false, reason: "bad_request", message: "workspaceId is required" }, 400);
    if (typeof restrict !== "boolean") return json({ ok: false, reason: "bad_request", message: "restrict must be a boolean" }, 400);

    const { data: ws } = await supabaseAdmin
      .from("workspaces").select("id, owner_id, firm_id, restrict_firm_access").eq("id", workspaceId).maybeSingle();
    if (!ws) return json({ ok: false, reason: "not_found" }, 404);
    if (!(ws as { firm_id: string | null }).firm_id) return json({ ok: false, reason: "not_firm_bound", message: "This workspace does not belong to a firm" }, 409);

    // Workspace owner only.
    if ((ws as { owner_id: string }).owner_id !== user.id)
      return json({ ok: false, reason: "not_authorized", message: "Only the workspace owner can change firm-access visibility" }, 403);

    if ((ws as { restrict_firm_access: boolean }).restrict_firm_access === restrict)
      return json({ ok: true, status: "unchanged", restrict_firm_access: restrict }, 200);

    const { error: updErr } = await supabaseAdmin.from("workspaces").update({ restrict_firm_access: restrict }).eq("id", workspaceId);
    if (updErr) { console.error("[set-firm-access] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: (ws as { firm_id: string }).firm_id,
      user_id: user.id,
      activity_type: restrict ? "workspace_firm_access_restricted" : "workspace_firm_access_unrestricted",
      details: { workspace_id: workspaceId },
    });

    return json({ ok: true, status: "updated", restrict_firm_access: restrict }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[set-firm-access] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
