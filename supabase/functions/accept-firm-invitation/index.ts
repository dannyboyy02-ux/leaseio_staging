import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: accept a firm invitation. The acceptor must be authenticated AND
// their email must match the invited email (acceptance is bound to the invited
// address — a different signed-in user cannot claim someone else's invite). The
// owner-only-mints-admins rule was enforced at INVITE creation, so accepting a
// firm_admin invite legitimately creates a firm_admin membership. verify_jwt =
// false (manual auth so we return structured errors). Runs service-role.
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
    if (!authHeader) return json({ ok: false, reason: "no_auth", message: "You must be signed in to accept" }, 401);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace(/^Bearer\s+/i, "").trim());
    if (userError || !userData?.user?.id) return json({ ok: false, reason: "invalid_auth", message: "Not authenticated" }, 401);
    const user = userData.user;

    const { token } = await req.json().catch(() => ({ token: undefined }));
    if (!token || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token))
      return json({ ok: false, reason: "invalid_token", message: "Invalid token format" }, 400);

    const { data: invite } = await supabaseAdmin
      .from("firm_invitations")
      .select("id, firm_id, email, role, expires_at, accepted_at, revoked_at")
      .eq("token", token)
      .maybeSingle();

    if (!invite) return json({ ok: false, reason: "not_found", message: "Invitation not found" }, 404);
    if (invite.revoked_at) return json({ ok: false, reason: "revoked", message: "This invitation was revoked" }, 410);
    if (invite.accepted_at) return json({ ok: false, reason: "already_accepted", message: "This invitation was already accepted" }, 409);
    if (new Date(invite.expires_at) < new Date()) return json({ ok: false, reason: "expired", message: "This invitation has expired" }, 410);

    // Bind acceptance to the invited email.
    if ((user.email ?? "").toLowerCase() !== invite.email.toLowerCase())
      return json({ ok: false, reason: "email_mismatch", message: "This invitation was sent to a different email address" }, 403);

    // Idempotent membership create.
    const { data: existing } = await supabaseAdmin
      .from("firm_members").select("id").eq("firm_id", invite.firm_id).eq("user_id", user.id).maybeSingle();
    if (!existing) {
      const { error: insErr } = await supabaseAdmin.from("firm_members")
        .insert({ firm_id: invite.firm_id, user_id: user.id, role: invite.role, created_by: user.id });
      if (insErr) { console.error("[accept-firm-invitation] insert:", insErr.message); return json({ ok: false, reason: "write_failed", message: "Could not join the firm" }, 400); }
    }

    await supabaseAdmin.from("firm_invitations")
      .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
      .eq("id", invite.id).is("accepted_at", null);

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: invite.firm_id, user_id: user.id, activity_type: "firm_invitation_accepted",
      details: { role: invite.role, email: invite.email },
    });

    const { data: firm } = await supabaseAdmin.from("firms").select("name").eq("id", invite.firm_id).maybeSingle();
    return json({ ok: true, firmId: invite.firm_id, firmName: firm?.name ?? null, role: invite.role }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[accept-firm-invitation] error:", msg);
    return json({ ok: false, reason: "server_error", message: "An unexpected error occurred" }, 500);
  }
});
