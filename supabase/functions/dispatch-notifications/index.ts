import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { dispatchNotificationRow, type NotificationRow } from "../_shared/notify_dispatch.ts";

// ============================================================================
// dispatch-notifications — cron (KNOWN_ISSUES #109).
// ----------------------------------------------------------------------------
// Sweeps RECENT `lease_activity_log` 'comment' rows that carry
// details.recipient_ids and delivers each by email (idempotent via
// notification_deliveries). This is what makes the whole approval-notification
// system actually deliver — every submit / approve / reject / escalate / nudge
// row written across the app is picked up here.
//
// Auth: shared x-cron-secret (verify_jwt=false). Schedule every ~5-15 min.
// LOOKBACK is intentionally short so a first run (or a backlog after downtime)
// can only ever email the last couple hours of notifications, never the whole
// history. The notification_deliveries dedupe means overlapping runs are safe.
// ============================================================================
const jsonHeaders = { "Content-Type": "application/json" };
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_ROWS = 500;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }

  const cronSecret = Deno.env.get("NOTIFICATION_DISPATCH_CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: jsonHeaders });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("lease_activity_log")
    .select("id, lease_id, details")
    .eq("activity_type", "comment")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS);
  if (error) {
    console.error("[dispatch-notifications] fetch failed:", error.message);
    return new Response(JSON.stringify({ error: "fetch failed" }), { status: 500, headers: jsonHeaders });
  }

  const totals = { scanned: 0, withRecipients: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of (rows ?? []) as NotificationRow[]) {
    totals.scanned++;
    const recipients = (r.details ?? {}).recipient_ids;
    if (!Array.isArray(recipients) || recipients.length === 0) continue;
    totals.withRecipients++;
    const res = await dispatchNotificationRow(supabaseAdmin, resendApiKey, r);
    totals.sent += res.sent;
    totals.failed += res.failed;
    totals.skipped += res.skipped;
  }

  if (totals.failed > 0) {
    console.warn(`[dispatch-notifications] ${totals.failed} delivery failure(s)`, JSON.stringify(totals));
  }
  if (rows && rows.length === MAX_ROWS) {
    console.warn(`[dispatch-notifications] hit MAX_ROWS=${MAX_ROWS} — newer rows wait for the next run (add pagination before sustained high volume)`);
  }
  return new Response(JSON.stringify({ ok: true, ...totals }), { status: 200, headers: jsonHeaders });
});
