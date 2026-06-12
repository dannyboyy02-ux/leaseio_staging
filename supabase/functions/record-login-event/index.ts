// record-login-event — Settings → Account login-activity feed.
//
// Fired (fire-and-forget) by the frontend immediately after a successful
// password sign-in. Records who signed in, from which IP (taken from the
// edge runtime's forwarded headers — never client-supplied), and with
// which user agent. Each insert prunes the user's history to the most
// recent 25 rows so the table can't grow unbounded.
//
// AUTHORIZATION
//   - Bearer JWT; the row is written for the authenticated user only.
//     The client cannot specify a target user.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

const KEEP_ROWS = 25;
const MAX_UA_LENGTH = 512;

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication" }, 401, origin);
  }
  const userId = userData.user.id;

  // x-forwarded-for is set by the platform; the first hop is the client.
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : null;
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, MAX_UA_LENGTH) || null;

  const { error: insertError } = await supabaseAdmin.from("login_events").insert({
    user_id: userId,
    ip,
    user_agent: userAgent,
  });
  if (insertError) {
    console.error("login_events insert failed:", insertError.message);
    return jsonResponse({ ok: false, error: "Failed to record login" }, 500, origin);
  }

  // Retention: keep only the most recent KEEP_ROWS rows for this user.
  const { data: cutoffRows } = await supabaseAdmin
    .from("login_events")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(KEEP_ROWS - 1, KEEP_ROWS - 1);
  const cutoff = cutoffRows?.[0]?.created_at;
  if (cutoff) {
    await supabaseAdmin
      .from("login_events")
      .delete()
      .eq("user_id", userId)
      .lt("created_at", cutoff);
  }

  return jsonResponse({ ok: true }, 200, origin);
});
