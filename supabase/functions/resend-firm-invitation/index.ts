import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: resend a pending firm invitation (refresh token + expiry, re-email).
// Same owner-only-mints-admins gate as revoke. verify_jwt = true.

function escapeHtml(t: string): string {
  const m: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return t.replace(/[&<>"']/g, (c) => m[c]);
}
function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sendEmail(resendApiKey: string, to: string, firmName: string, role: string, inviteUrl: string): Promise<boolean> {
  const roleLabel = role === "firm_admin" ? "firm administrator" : "firm member";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: Deno.env.get("RESEND_INVITES_FROM_EMAIL") ?? Deno.env.get("RESEND_FROM_EMAIL") ?? "LeaseIO <noreply@notifications.theleaseio.com>",
        to: [to],
        subject: `Your invitation to join ${escapeHtml(firmName)} on LeaseIO`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><p>You've been invited to join <strong>${escapeHtml(firmName)}</strong> on LeaseIO as a <strong>${escapeHtml(roleLabel)}</strong>.</p><p style="margin:24px 0;"><a href="${inviteUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Accept Invitation</a></p><p style="color:#666;font-size:14px;">This invitation expires in 14 days.</p></div>`,
        text: `You've been invited to join ${firmName} on LeaseIO as a ${roleLabel}.\n\nAccept here: ${inviteUrl}\n\nThis invitation expires in 14 days.`,
      }),
    });
    if (!res.ok) { console.error("[resend-firm-invitation] resend error:", res.status); return false; }
    return true;
  } catch (err) { console.error("[resend-firm-invitation] resend fetch error:", err instanceof Error ? err.message : String(err)); return false; }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: s });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ ok: false, reason: "email_not_configured" }, 503);

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
      .from("firm_invitations").select("id, firm_id, email, role, accepted_at, revoked_at").eq("id", invitationId).maybeSingle();
    if (!invite) return json({ ok: false, reason: "not_found" }, 404);
    if (invite.accepted_at) return json({ ok: false, reason: "already_accepted" }, 409);
    if (invite.revoked_at) return json({ ok: false, reason: "revoked" }, 410);

    const { data: firm } = await supabaseAdmin.from("firms").select("owner_id, name").eq("id", invite.firm_id).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    const isOwner = (firm as { owner_id: string }).owner_id === user.id;
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: m } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", invite.firm_id).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
      isAdmin = Boolean(m);
    }
    if (invite.role === "firm_admin" && !isOwner) return json({ ok: false, reason: "not_authorized", message: "Only the firm owner can resend an admin invitation" }, 403);
    if (invite.role === "firm_member" && !isAdmin) return json({ ok: false, reason: "not_authorized", message: "Only firm admins can resend invitations" }, 403);

    const token = generateInviteToken();
    const { error: updErr } = await supabaseAdmin.from("firm_invitations")
      .update({ token, invited_by: user.id, invited_at: new Date().toISOString(), expires_at: new Date(Date.now() + 14 * 864e5).toISOString() })
      .eq("id", invite.id).is("accepted_at", null).is("revoked_at", null);
    if (updErr) { console.error("[resend-firm-invitation] update:", updErr.message); return json({ ok: false, reason: "write_failed" }, 400); }

    const appUrl = (Deno.env.get("APP_URL") ?? "https://theleaseio.com").replace(/\/$/, "");
    const sent = await sendEmail(resendApiKey, invite.email, (firm as { name: string }).name, invite.role, `${appUrl}/firm/accept-invitation?token=${token}`);
    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: invite.firm_id, user_id: user.id, activity_type: "firm_invitation_resent", details: { invitation_id: invite.id, email: invite.email, email_sent: sent },
    });
    return json({ ok: true, status: "resent", email_sent: sent }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[resend-firm-invitation] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
