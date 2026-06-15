import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 10: list a firm's pending invitations (the firm members page). Any firm
// member (owner counts) may read. verify_jwt = true. Runs service-role + an
// explicit membership check (so the response shape is independent of RLS).
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

    const { firmId } = await req.json().catch(() => ({ firmId: undefined }));
    if (!firmId || typeof firmId !== "string") return json({ ok: false, reason: "bad_request", message: "firmId is required" }, 400);

    const { data: firm } = await supabaseAdmin.from("firms").select("owner_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    let isMember = (firm as { owner_id: string }).owner_id === user.id;
    if (!isMember) {
      const { data: m } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", firmId).eq("user_id", user.id).maybeSingle();
      isMember = Boolean(m);
    }
    if (!isMember) return json({ ok: false, reason: "not_authorized" }, 403);

    const { data: invites } = await supabaseAdmin
      .from("firm_invitations")
      .select("id, email, role, invited_at, expires_at")
      .eq("firm_id", firmId)
      .is("accepted_at", null).is("revoked_at", null)
      .order("invited_at", { ascending: false });

    return json({ ok: true, invitations: invites ?? [] }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[list-pending-firm-invitations] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
