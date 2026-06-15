import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 9: add a user to a firm. Authorization mirrors the DB RLS owner-only-
// mints-admins decision: granting firm_admin requires the firm OWNER; adding a
// firm_member requires a firm_admin (owner counts). Runs service-role.
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
    const targetUserId = (body as { userId?: string }).userId;
    const role = (body as { role?: string }).role;

    if (!firmId || typeof firmId !== "string") return json({ error: "firmId is required", reason: "bad_request" }, 400);
    if (!targetUserId || typeof targetUserId !== "string") return json({ error: "userId is required", reason: "bad_request" }, 400);
    if (role !== "firm_admin" && role !== "firm_member")
      return json({ error: "role must be firm_admin | firm_member", reason: "bad_request" }, 400);

    const { data: firm } = await supabaseAdmin.from("firms").select("id, owner_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ error: "Firm not found", reason: "not_found" }, 404);

    const isOwner = (firm as { owner_id: string }).owner_id === user.id;
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: m } = await supabaseAdmin
        .from("firm_members").select("role").eq("firm_id", firmId).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
      isAdmin = Boolean(m);
    }

    // Owner-only mints admins (matches the firm_members RLS split).
    if (role === "firm_admin" && !isOwner)
      return json({ error: "Only the firm owner can grant the firm_admin role", reason: "not_authorized" }, 403);
    if (role === "firm_member" && !isAdmin)
      return json({ error: "Only firm admins can add members", reason: "not_authorized" }, 403);

    // Idempotent: an existing membership returns success without changing the role.
    const { data: existing } = await supabaseAdmin
      .from("firm_members").select("id, role").eq("firm_id", firmId).eq("user_id", targetUserId).maybeSingle();
    if (existing) return json({ ok: true, member: existing, idempotent: true }, 200);

    const { data: member, error: insErr } = await supabaseAdmin
      .from("firm_members")
      .insert({ firm_id: firmId, user_id: targetUserId, role, created_by: user.id })
      .select()
      .single();
    if (insErr) return json({ error: insErr.message, reason: "insert_failed" }, 400);

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: firmId,
      user_id: user.id,
      activity_type: "firm_member_added",
      details: { member_user_id: targetUserId, role },
    });

    return json({ ok: true, member }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[ADD-FIRM-MEMBER] Error:", msg);
    return json({ error: msg }, 500);
  }
});
