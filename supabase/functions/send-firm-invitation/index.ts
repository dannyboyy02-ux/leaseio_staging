import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: invite a user to a firm by email. Mirrors send-invite (workspace).
// Authorization mirrors the firm_invitations RLS (owner-only-mints-admins):
// granting firm_admin requires the firm OWNER; firm_member requires a firm_admin
// (owner counts). verify_jwt = false — auth is verified manually so we can send
// a structured 401. Runs service-role.

function escapeHtml(text: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendFirmInviteEmail(opts: {
  resendApiKey: string; to: string; firstName: string; firmName: string; role: string; inviteUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const { resendApiKey, to, firstName, firmName, role, inviteUrl } = opts;
  const roleLabel = role === "firm_admin" ? "firm administrator" : "firm member";
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,";
  const greetingText = firstName ? `Hi ${firstName},` : "Hi,";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: Deno.env.get("RESEND_INVITES_FROM_EMAIL") ?? Deno.env.get("RESEND_FROM_EMAIL") ?? "LeaseIO <noreply@notifications.theleaseio.com>",
        to: [to],
        subject: `You've been invited to join ${escapeHtml(firmName)} on LeaseIO`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>${greeting}</h2>
            <p>You've been invited to join <strong>${escapeHtml(firmName)}</strong> on LeaseIO as a <strong>${escapeHtml(roleLabel)}</strong>.</p>
            <p>A firm groups multiple workspaces under one organization. Accept to gain access.</p>
            <p style="margin: 24px 0;">
              <a href="${inviteUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Accept Invitation</a>
            </p>
            <p style="color: #666; font-size: 14px;">This invitation expires in 14 days.</p>
            <p style="color: #666; font-size: 14px;">If you didn't expect this invitation, you can safely ignore this email.</p>
          </div>`,
        text: `${greetingText}\n\nYou've been invited to join ${firmName} on LeaseIO as a ${roleLabel}.\n\nAccept here: ${inviteUrl}\n\nThis invitation expires in 14 days.`,
      }),
    });
    if (!res.ok) {
      console.error("[send-firm-invitation] resend error:", res.status, await res.text().catch(() => "(no body)"));
      return { sent: false, error: `Resend returned ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-firm-invitation] resend fetch error:", msg);
    return { sent: false, error: msg };
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: s });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ ok: false, reason: "email_not_configured", message: "Email delivery is not configured" }, 503);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, reason: "no_auth", message: "No authorization header" }, 401);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace(/^Bearer\s+/i, "").trim());
    if (userError || !userData?.user?.id) return json({ ok: false, reason: "invalid_auth", message: "Not authenticated" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const firmId = (body as { firmId?: string }).firmId;
    const emailRaw = (body as { email?: string }).email;
    const role = (body as { role?: string }).role;
    const firstName = typeof (body as { firstName?: string }).firstName === "string" ? (body as { firstName: string }).firstName : "";

    if (!firmId || typeof firmId !== "string") return json({ ok: false, reason: "bad_request", message: "firmId is required" }, 400);
    if (!emailRaw || typeof emailRaw !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw))
      return json({ ok: false, reason: "bad_request", message: "A valid email is required" }, 400);
    if (role !== "firm_admin" && role !== "firm_member")
      return json({ ok: false, reason: "bad_request", message: "role must be firm_admin | firm_member" }, 400);
    const email = emailRaw.trim().toLowerCase();

    const { data: firm } = await supabaseAdmin.from("firms").select("id, owner_id, name").eq("id", firmId).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found", message: "Firm not found" }, 404);

    const isOwner = (firm as { owner_id: string }).owner_id === user.id;
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: m } = await supabaseAdmin.from("firm_members").select("role").eq("firm_id", firmId).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
      isAdmin = Boolean(m);
    }
    // Owner-only-mints-admins (firm_invitations RLS parity, D2).
    if (role === "firm_admin" && !isOwner) return json({ ok: false, reason: "not_authorized", message: "Only the firm owner can invite a firm administrator" }, 403);
    if (role === "firm_member" && !isAdmin) return json({ ok: false, reason: "not_authorized", message: "Only firm admins can invite members" }, 403);

    // Already a member?
    const { data: existingProfile } = await supabaseAdmin.from("profiles").select("id").ilike("email", email).maybeSingle();
    if (existingProfile?.id) {
      const { data: alreadyMember } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", firmId).eq("user_id", existingProfile.id).maybeSingle();
      if (alreadyMember) return json({ ok: true, status: "already_member" }, 200);
    }

    const appUrl = (Deno.env.get("APP_URL") ?? "https://theleaseio.com").replace(/\/$/, "");
    const firmName = (firm as { name: string }).name;

    // Existing pending invite for this (firm, email)? → refresh token + re-email.
    const { data: pending } = await supabaseAdmin
      .from("firm_invitations").select("id")
      .eq("firm_id", firmId).ilike("email", email)
      .is("accepted_at", null).is("revoked_at", null)
      .maybeSingle();

    const token = generateInviteToken();
    const inviteUrl = `${appUrl}/firm/accept-invitation?token=${token}`;

    if (pending?.id) {
      const { error: updErr } = await supabaseAdmin.from("firm_invitations")
        .update({ token, role, invited_by: user.id, invited_at: new Date().toISOString(), expires_at: new Date(Date.now() + 14 * 864e5).toISOString() })
        .eq("id", pending.id);
      if (updErr) { console.error("[send-firm-invitation] update:", updErr.message); return json({ ok: false, reason: "write_failed", message: "Could not refresh the invitation" }, 400); }
      const sent = await sendFirmInviteEmail({ resendApiKey, to: email, firstName, firmName, role, inviteUrl });
      await supabaseAdmin.from("firm_activity_log").insert({ firm_id: firmId, user_id: user.id, activity_type: "firm_invitation_resent", details: { email, role, email_sent: sent.sent } });
      return json({ ok: true, status: "resent", email_sent: sent.sent }, 200);
    }

    const { error: insErr } = await supabaseAdmin.from("firm_invitations")
      .insert({ firm_id: firmId, email, role, invited_by: user.id, token });
    if (insErr) { console.error("[send-firm-invitation] insert:", insErr.message); return json({ ok: false, reason: "write_failed", message: "Could not create the invitation" }, 400); }

    const sent = await sendFirmInviteEmail({ resendApiKey, to: email, firstName, firmName, role, inviteUrl });
    await supabaseAdmin.from("firm_activity_log").insert({ firm_id: firmId, user_id: user.id, activity_type: "firm_invitation_sent", details: { email, role, email_sent: sent.sent } });
    return json({ ok: true, status: "sent", email_sent: sent.sent }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[send-firm-invitation] error:", msg);
    return json({ ok: false, reason: "server_error", message: "An unexpected error occurred" }, 500);
  }
});
