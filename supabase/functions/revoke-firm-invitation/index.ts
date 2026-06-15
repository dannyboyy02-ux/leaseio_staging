import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: revoke a pending firm invitation. Authorization mirrors
// owner-only-mints-admins: revoking a firm_admin invite requires the OWNER;
// a firm_member invite requires a firm_admin (owner counts). verify_jwt = true.
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

    const { invitationId } = await req.json().catch(() => ({ invitationId: undefined }));
    if (!invitationId || typeof invitationId !== "string") return json({ ok: false, reason: "bad_request", message: "invitationId is required" }, 400);

    const { data: invite } = await supabaseAdmin
      .from("firm_invitations").select("id, firm_id, role, accepted_at, revoked_at").eq("id", invitationId).maybeSingle();
    if (!invite) return json({ ok: false, reason: "not_found" }, 404);
    if (invite.accepted_at) return json({ ok: false, reason: "already_accepted", message: "Accepted invitations cannot be revoked" }, 409);
    if (invite.revoked_at) return json({ ok: true, status: "already_revoked" }, 200);

    const { data: firm } = await supabaseAdmin.from("firms").select("owner_id").eq("id", invite.firm_id).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    const isOwner = (firm as { owner_id: string }).owner_id === user.id;
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: m } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", invite.firm_id).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
      isAdmin = Boolean(m);
    }
    if (invite.role === "firm_admin" && !isOwner) return json({ ok: false, reason: "not_authorized", message: "Only the firm owner can revoke an admin invitation" }, 403);
    if (invite.role === "firm_member" && !isAdmin) return json({ ok: false, reason: "not_authorized", message: "Only firm admins can revoke invitations" }, 403);

    const { error: updErr } = await supabaseAdmin.from("firm_invitations")
      .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
      .eq("id", invite.id).is("accepted_at", null).is("revoked_at", null);
    if (updErr) { console.error("[revoke-firm-invitation] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: invite.firm_id, user_id: user.id, activity_type: "firm_invitation_revoked", details: { invitation_id: invite.id, role: invite.role },
    });
    return json({ ok: true, status: "revoked" }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[revoke-firm-invitation] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
