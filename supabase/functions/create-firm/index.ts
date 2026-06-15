import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Phase 9: provision a firm. OPERATOR-ONLY (ops_admins) — self-serve firm
// creation is Phase 10. Runs service-role to write past the firm entitlement
// guard. Stripe customer is attached later by the webhook, not here.
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

    // Operator-only gate (Phase 9 manual provisioning).
    const { data: opsRow } = await supabaseAdmin
      .from("ops_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!opsRow) return json({ error: "Only operators can provision firms in this phase", reason: "not_authorized" }, 403);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ownerId = (body as { ownerId?: string }).ownerId;
    const name = (body as { name?: string }).name;
    const firmType = (body as { firmType?: string }).firmType;
    const billingEmail = (body as { billingEmail?: string }).billingEmail;

    if (!ownerId || typeof ownerId !== "string") return json({ error: "ownerId is required", reason: "bad_request" }, 400);
    if (!name || typeof name !== "string" || name.trim().length < 2)
      return json({ error: "name must be at least 2 characters", reason: "bad_request" }, 400);
    if (!firmType || !["cpa_firm", "parent_company", "other"].includes(firmType))
      return json({ error: "firmType must be cpa_firm | parent_company | other", reason: "bad_request" }, 400);
    if (!billingEmail || typeof billingEmail !== "string")
      return json({ error: "billingEmail is required", reason: "bad_request" }, 400);

    const { data: firm, error: insErr } = await supabaseAdmin
      .from("firms")
      .insert({ name: name.trim(), firm_type: firmType, owner_id: ownerId, billing_email: billingEmail })
      .select()
      .single();
    if (insErr) return json({ error: insErr.message, reason: "insert_failed" }, 400);

    await supabaseAdmin.from("firm_activity_log").insert({
      firm_id: firm.id,
      user_id: user.id,
      activity_type: "firm_created",
      details: { owner_id: ownerId, firm_type: firmType, name: name.trim(), provisioned_by: user.id },
    });

    return json({ ok: true, firm }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[CREATE-FIRM] Error:", msg);
    return json({ error: msg }, 500);
  }
});
