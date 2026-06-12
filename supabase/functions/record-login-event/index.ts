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
import { getCorsHeaders as baseCorsHeaders, jsonResponse } from "../_shared/cors.ts";

const KEEP_ROWS = 25;
const MAX_UA_LENGTH = 512;
// Loose IP-literal shape check (IPv4 or IPv6) — display-layer hygiene, not
// security validation.
const IP_PATTERN = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
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

  // The platform APPENDS the real client IP to any client-supplied
  // X-Forwarded-For, so the FIRST entry is client-forgeable — take the LAST
  // (platform-set) entry, preferring the dedicated real-IP headers when
  // present, and only store something that actually parses as an IP.
  const candidate =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
    null;
  const ip = candidate && IP_PATTERN.test(candidate) && candidate.length <= 45 ? candidate : null;
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
