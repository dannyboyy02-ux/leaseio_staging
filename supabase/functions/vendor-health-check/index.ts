// vendor-health-check — Operational Monitoring Phase 2
//
// Daily scheduled function. Runs each adapter, writes snapshots,
// evaluates threshold ladders, fires alert emails for newly-crossed
// thresholds (deduped per day per metric), and surfaces upcoming
// renewals from vendor_renewal_calendar.
//
// AUTH: verify_jwt = false (config.toml override). Uses x-cron-secret
// header pattern matching cleanup-expired-reports / etc. Manual
// invocation works with the same secret. Production cron supplies
// the secret via the existing private.cron_secrets table.
//
// Scheduling: 06:00 UTC daily. Registered separately in
// 20260509000001_vendor_health_check_cron.sql.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import {
  type MonitoringAdapter,
  type VendorUsageSnapshot,
  thresholdCrossed,
} from "../_shared/monitoring/types.ts";
import { ResendAdapter } from "../_shared/monitoring/resend.ts";
import { SupabaseAdapter } from "../_shared/monitoring/supabase.ts";
import { VercelAdapter } from "../_shared/monitoring/vercel.ts";
import {
  dispatchAlertEmail,
  renderRenewalEmail,
  renderThresholdEmail,
} from "../_shared/alerts/dispatch.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...baseCorsHeaders(origin, "POST, GET, OPTIONS"),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret",
  };
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const OPS_DASHBOARD_URL = "https://app.theleaseio.com/app/admin/operations";

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("VENDOR_HEALTH_CHECK_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }
  const providedCronSecret = req.headers.get("x-cron-secret");
  if (providedCronSecret !== expectedCronSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const ranAt = new Date().toISOString();

  // ── Build adapters from configured env vars ──────────────────────
  // Each adapter is independent. If credentials are missing for one,
  // skip it; don't fail the whole run.
  const adapters: MonitoringAdapter[] = [];

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey) {
    adapters.push(new ResendAdapter({ apiKey: resendKey, tier: "free" }));
  } else {
    console.warn("[vendor-health-check] RESEND_API_KEY not set; skipping Resend adapter");
  }

  const sbMgmtToken = Deno.env.get("SUPABASE_MANAGEMENT_TOKEN");
  const sbProjectRef = Deno.env.get("SUPABASE_PROJECT_REF") ?? "wwkwoxxcprnjjufkbzac";
  if (sbMgmtToken) {
    adapters.push(new SupabaseAdapter({
      managementToken: sbMgmtToken,
      projectRef: sbProjectRef,
      tier: "pro",
    }));
  } else {
    console.warn("[vendor-health-check] SUPABASE_MANAGEMENT_TOKEN not set; skipping Supabase adapter");
  }

  const vercelToken = Deno.env.get("VERCEL_ACCESS_TOKEN");
  const vercelTeamId = Deno.env.get("VERCEL_TEAM_ID");
  if (vercelToken) {
    adapters.push(new VercelAdapter({
      accessToken: vercelToken,
      teamId: vercelTeamId,
      tier: "pro",
    }));
  } else {
    console.warn("[vendor-health-check] VERCEL_ACCESS_TOKEN not set; skipping Vercel adapter");
  }

  // ── Fetch snapshots from each adapter ────────────────────────────
  const allSnapshots: VendorUsageSnapshot[] = [];
  const adapterErrors: Array<{ vendor: string; error: string }> = [];

  for (const adapter of adapters) {
    try {
      const snapshots = await adapter.fetchSnapshots();
      allSnapshots.push(...snapshots);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[vendor-health-check] ${adapter.vendor} adapter failed:`, message);
      adapterErrors.push({ vendor: adapter.vendor, error: message });
    }
  }

  // ── Persist snapshots ─────────────────────────────────────────────
  let snapshotsWritten = 0;
  if (allSnapshots.length > 0) {
    const rows = allSnapshots.map((s) => ({
      vendor: s.vendor,
      metric: s.metric,
      current_value: s.current_value,
      limit_value: s.limit_value,
      pct_of_limit: s.limit_value && s.limit_value > 0
        ? Math.round((s.current_value / s.limit_value) * 10000) / 100
        : null,
      tier: s.tier,
      category: s.category,
      metadata: s.metadata ?? {},
    }));
    const { error: insertErr, count } = await supabaseAdmin
      .from("vendor_usage_snapshots")
      .insert(rows, { count: "exact" });
    if (insertErr) {
      console.error("[vendor-health-check] snapshot insert failed:", insertErr.message);
    } else {
      snapshotsWritten = count ?? rows.length;
    }
  }

  // ── Evaluate thresholds + dispatch threshold alerts ──────────────
  const recipientsResult = await supabaseAdmin
    .from("vendor_alert_recipients")
    .select("email")
    .eq("enabled", true);
  const recipients = (recipientsResult.data ?? []).map((r: any) => r.email as string);

  let alertsFired = 0;
  let alertEmailsSent = 0;
  for (const snapshot of allSnapshots) {
    const threshold = thresholdCrossed(snapshot);
    if (!threshold) continue;

    const pct = snapshot.limit_value && snapshot.limit_value > 0
      ? (snapshot.current_value / snapshot.limit_value) * 100
      : null;

    // Insert; the unique index on (vendor, metric, threshold, day)
    // makes a duplicate cross on the same day a no-op.
    const { error: alertInsertErr } = await supabaseAdmin
      .from("vendor_alert_log")
      .insert({
        vendor: snapshot.vendor,
        metric: snapshot.metric,
        threshold_crossed: threshold,
        current_value: snapshot.current_value,
        limit_value: snapshot.limit_value,
        pct_of_limit: pct !== null ? Math.round(pct * 100) / 100 : null,
        upgrade_suggestion: null, // future enhancement: per-vendor copy
        upgrade_url: null,
      });

    if (alertInsertErr) {
      // Likely a unique-violation (already alerted today) — that's
      // the expected dedup path, log and continue.
      const code = (alertInsertErr as any).code;
      if (code === "23505") {
        // Dedup — skip email send.
        continue;
      }
      console.error("[vendor-health-check] alert insert failed:", alertInsertErr.message);
      continue;
    }

    alertsFired++;

    // Dispatch the email (best-effort)
    if (recipients.length > 0 && resendKey) {
      const { subject, body_text } = renderThresholdEmail({
        vendor: snapshot.vendor,
        metric: snapshot.metric,
        threshold,
        current_value: snapshot.current_value,
        limit_value: snapshot.limit_value,
        pct_of_limit: pct,
        tier: snapshot.tier,
        ops_dashboard_url: OPS_DASHBOARD_URL,
      });
      const sent = await dispatchAlertEmail(
        { recipients, subject, body_text },
        { resendApiKey: resendKey },
      );
      if (sent.ok) alertEmailsSent++;
    }
  }

  // ── Renewal calendar pass ────────────────────────────────────────
  const today = new Date(ranAt.slice(0, 10));
  const { data: renewals } = await supabaseAdmin
    .from("vendor_renewal_calendar")
    .select("id, vendor, item, renewal_date, amount_estimate, reminder_days_before, auto_renew, account_url, notes, last_alerted_at");

  let renewalsAlerted = 0;
  for (const r of (renewals ?? []) as any[]) {
    const renewalDate = new Date(r.renewal_date);
    const daysRemaining = Math.ceil((renewalDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    const reminderDays: number[] = Array.isArray(r.reminder_days_before) ? r.reminder_days_before : [60, 30, 14, 7, 1];
    if (!reminderDays.includes(daysRemaining)) continue;

    // Per-day dedup via last_alerted_at column (different mechanism
    // than vendor_alert_log unique index because renewals are
    // singleton-per-row, not per-threshold-per-day).
    if (r.last_alerted_at) {
      const lastAlertDay = String(r.last_alerted_at).slice(0, 10);
      if (lastAlertDay === ranAt.slice(0, 10)) continue;
    }

    if (recipients.length > 0 && resendKey) {
      const { subject, body_text } = renderRenewalEmail({
        vendor: r.vendor,
        item: r.item,
        renewal_date: r.renewal_date,
        days_remaining: daysRemaining,
        amount_estimate: r.amount_estimate ?? null,
        auto_renew: !!r.auto_renew,
        account_url: r.account_url ?? undefined,
        notes: r.notes ?? undefined,
      });
      await dispatchAlertEmail(
        { recipients, subject, body_text },
        { resendApiKey: resendKey },
      );
    }

    await supabaseAdmin
      .from("vendor_renewal_calendar")
      .update({ last_alerted_at: ranAt })
      .eq("id", r.id);
    renewalsAlerted++;
  }

  return jsonResponse(
    {
      ok: true,
      ranAt,
      adaptersConfigured: adapters.map((a) => a.vendor),
      adapterErrors,
      snapshotsWritten,
      alertsFired,
      alertEmailsSent,
      renewalsAlerted,
      recipientCount: recipients.length,
    },
    200,
    origin,
  );
});
