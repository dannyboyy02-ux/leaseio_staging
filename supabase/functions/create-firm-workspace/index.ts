import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { syncFirmSubscriptionQuantity } from "../_shared/firm_billing.ts";

// Phase 10 / #105-B — create a firm-bound child workspace. No independent Stripe
// subscription (firm billing covers it via the firm sub's quantity); the
// create_firm_workspace_locked RPC inserts it (Phase 9 triggers set
// plan='business' + firm_joined_at + child counter), then we sync the firm sub
// quantity (+1, prorated, if a firm sub exists). FIRM ADMIN/OWNER only.
// verify_jwt = true.
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
    const firmId = (body as { firmId?: string }).firmId;
    const name = (body as { name?: string }).name;
    const idempotencyKey = (body as { idempotencyKey?: string }).idempotencyKey;
    if (!firmId || typeof firmId !== "string") return json({ ok: false, reason: "bad_request", message: "firmId is required" }, 400);
    if (!name || typeof name !== "string" || name.trim().length < 1) return json({ ok: false, reason: "bad_request", message: "A workspace name is required" }, 400);
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) return json({ ok: false, reason: "bad_request", message: "idempotencyKey is required" }, 400);

    // Authorize: firm admin or owner.
    const { data: firm } = await supabaseAdmin.from("firms").select("owner_id").eq("id", firmId).maybeSingle();
    if (!firm) return json({ ok: false, reason: "not_found" }, 404);
    let isAdmin = (firm as { owner_id: string }).owner_id === user.id;
    if (!isAdmin) {
      const { data: m } = await supabaseAdmin.from("firm_members").select("id").eq("firm_id", firmId).eq("user_id", user.id).eq("role", "firm_admin").maybeSingle();
      isAdmin = Boolean(m);
    }
    if (!isAdmin) return json({ ok: false, reason: "not_authorized", message: "Only firm admins can add a workspace" }, 403);

    const { data: result, error: rpcErr } = await supabaseAdmin.rpc("create_firm_workspace_locked", {
      p_firm_id: firmId,
      p_owner_id: user.id,
      p_name: name.trim(),
      p_idempotency_key: idempotencyKey,
    });
    if (rpcErr) {
      const isQuota = /child workspace limit/i.test(rpcErr.message);
      console.error("[create-firm-workspace] rpc:", rpcErr.message);
      return json({ ok: false, reason: isQuota ? "quota_exceeded" : "create_failed", message: isQuota ? "The firm's workspace limit is reached" : "Could not create the workspace" }, isQuota ? 409 : 400);
    }
    const status = (result as { status?: string } | null)?.status;
    if (status === "invalid_name") return json({ ok: false, reason: "bad_request", message: "Invalid workspace name" }, 400);
    const workspaceId = (result as { workspace_id?: string } | null)?.workspace_id ?? null;

    // Sync the firm subscription quantity (+1 prorated; no-op if no firm sub yet).
    try {
      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (stripeKey) {
        const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
        await syncFirmSubscriptionQuantity(stripe, supabaseAdmin, firmId);
      }
    } catch (e) {
      console.error("[create-firm-workspace] quantity sync failed (self-heals on next op):", e instanceof Error ? e.message : String(e));
    }

    return json({ ok: true, status: status ?? "created", workspaceId }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[create-firm-workspace] error:", msg);
    return json({ ok: false, reason: "server_error" }, 500);
  }
});
