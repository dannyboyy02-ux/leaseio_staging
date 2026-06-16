import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: public token lookup for the firm-invitation acceptance landing page.
// Mirrors get-invite-info (workspace). Returns only display-safe fields — never
// the token or internal ids. verify_jwt = false (the invitee may have no account
// yet).
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

    const { token } = await req.json().catch(() => ({ token: undefined }));
    if (!token || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) {
      return json({ ok: false, code: "INVALID_TOKEN", message: "Invalid token format" }, 400);
    }

    const { data: invite } = await supabaseAdmin
      .from("firm_invitations")
      .select("email, role, expires_at, accepted_at, revoked_at, firm_id")
      .eq("token", token)
      .maybeSingle();

    if (!invite) return json({ ok: false, code: "NOT_FOUND", message: "Invitation not found" }, 404);

    const { data: firm } = await supabaseAdmin
      .from("firms").select("name").eq("id", invite.firm_id).maybeSingle();

    // profiles is 1:1 with auth.users (on_auth_user_created); ilike avoids the
    // paginated auth.admin.listUsers() (P2-11 lesson from get-invite-info).
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles").select("id").ilike("email", invite.email).maybeSingle();

    return json({
      ok: true,
      email: invite.email,
      firmName: firm?.name ?? "a firm",
      role: invite.role,
      expired: new Date(invite.expires_at) < new Date(),
      accepted: invite.accepted_at !== null,
      revoked: invite.revoked_at !== null,
      user_exists: Boolean(existingProfile),
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[get-firm-invitation-info] error:", msg);
    return json({ ok: false, code: "SERVER_ERROR", message: "An unexpected error occurred" }, 500);
  }
});
