// process-alerts — daily alert-evaluation cron
//
// Reads active rows from public.alert_rules, joins against
// public.leases, and inserts public.notifications rows for any
// newly-triggered conditions (expiry approaching, approval pending,
// covenant breach, variance over threshold). Idempotent within a
// 24-hour window via the wasRecentlyAlerted dedup check.
//
// History: originally landed via Studio in early 2026 under migration
// `phase5_process_alerts_cron` that was never carried into the repo.
// The function source was likewise off-repo, the cron POST had no
// auth header, and the function did no auth check of its own — flagged
// as P2-01 follow-up (KNOWN_ISSUES #15) on 2026-05-15.
//
// This version pulls the source into the repo and adds the canonical
// x-cron-secret pattern used by cleanup-expired-reports,
// send-counter-signature-reminder, etc. Cron migration
// `20260515040000_process_alerts_cron_secret.sql` reschedules the
// existing job to forward `x-cron-secret` from `private.cron_secrets`.
//
// AUTH: verify_jwt = false (config.toml). Caller must present
//   `x-cron-secret: $PROCESS_ALERTS_CRON_SECRET`
// Both edge env and the private.cron_secrets row must match.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

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

const DEDUP_HOURS = 24;

interface AlertRule {
  workspace_id: string;
  alert_type: string;
  threshold_days: number | null;
  threshold_value: number | null;
  is_active: boolean;
}

interface Lease {
  id: string;
  workspace_id: string;
  user_id: string | null;
  filename: string | null;
  tenant_name: string | null;
  lifecycle_status: string | null;
  executed_expiry_date: string | null;
  covenant_flagged: boolean | null;
  monthly_payment: number | null;
  executed_monthly_payment: number | null;
  submitted_for_approval_at: string | null;
}

interface NotificationRow {
  workspace_id: string;
  lease_id: string;
  alert_type: string;
  title: string;
  body: string;
}

// A NotificationRow plus the lease owner to email (stripped before the DB insert).
type EmailableAlert = NotificationRow & { ownerId: string | null };

async function wasRecentlyAlerted(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string,
  leaseId: string,
  alertType: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUP_HOURS * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("lease_id", leaseId)
    .eq("alert_type", alertType)
    .gte("created_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function evaluate(
  supabase: ReturnType<typeof createClient>,
  rules: AlertRule[],
  leases: Lease[],
): Promise<EmailableAlert[]> {
  const toInsert: EmailableAlert[] = [];
  const now = new Date();

  for (const rule of rules) {
    const workspaceLeases = leases.filter((l) => l.workspace_id === rule.workspace_id);

    for (const lease of workspaceLeases) {
      let triggered = false;
      let title = "";
      let body = "";
      const label = lease.filename || lease.tenant_name || "Unnamed lease";

      // --- expiry_approaching ---
      if (rule.alert_type === "expiry_approaching") {
        const expiryDate = lease.executed_expiry_date ? new Date(lease.executed_expiry_date) : null;
        if (!expiryDate || lease.lifecycle_status !== "active") continue;
        const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / 86_400_000);
        const threshold = rule.threshold_days ?? 90;
        if (daysLeft > 0 && daysLeft <= threshold) {
          triggered = true;
          title = `Lease expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
          body = `${label} expires on ${expiryDate.toLocaleDateString("en-AU")}.`;
        }
      }

      // --- approval_pending ---
      if (rule.alert_type === "approval_pending") {
        if (lease.lifecycle_status === "under_review" && lease.submitted_for_approval_at) {
          const daysPending = Math.ceil(
            (now.getTime() - new Date(lease.submitted_for_approval_at).getTime()) / 86_400_000,
          );
          const threshold = rule.threshold_days ?? 7;
          if (daysPending >= threshold) {
            triggered = true;
            title = `Approval pending for ${daysPending} day${daysPending === 1 ? "" : "s"}`;
            body = `${label} has been awaiting approval for ${daysPending} days.`;
          }
        }
      }

      // --- covenant_breach ---
      if (rule.alert_type === "covenant_breach") {
        if (lease.covenant_flagged && ["active", "executed"].includes(lease.lifecycle_status ?? "")) {
          triggered = true;
          title = "Covenant breach flagged";
          body = `${label} has been flagged for a potential covenant breach.`;
        }
      }

      // --- variance_high ---
      if (rule.alert_type === "variance_high") {
        const pipeline = Number(lease.monthly_payment) || 0;
        const executed = Number(lease.executed_monthly_payment) || 0;
        if (pipeline > 0 && executed > 0) {
          const pct = Math.abs((executed - pipeline) / pipeline) * 100;
          const threshold = rule.threshold_value ?? 10;
          if (pct >= threshold) {
            triggered = true;
            title = `High variance detected (${pct.toFixed(1)}%)`;
            body = `${label} shows a ${pct.toFixed(1)}% variance between pipeline and executed monthly payment.`;
          }
        }
      }

      if (triggered) {
        const alreadySent = await wasRecentlyAlerted(supabase, rule.workspace_id, lease.id, rule.alert_type);
        if (!alreadySent) {
          toInsert.push({
            workspace_id: rule.workspace_id,
            lease_id: lease.id,
            alert_type: rule.alert_type,
            title,
            body,
            ownerId: lease.user_id,
          });
        }
      }
    }
  }

  return toInsert;
}

// P2-05: inline escapeHtml (matches send-lease-notifications' choice — keeps the
// email path free of a shared-module import).
function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return "";
  const s = typeof text === "string" ? text : String(text);
  const map: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  };
  return s.replace(/[&<>"']/g, (m) => map[m]);
}

// Email each newly-created alert to its lease owner. Best-effort: per-recipient
// failures are logged + skipped, never thrown — an email failure must not fail
// the cron or undo the in-app notifications that already landed. Respects the
// owner's profiles.email_notifications_enabled (default true; the AccountSettings
// "Email notifications" toggle). Recipient = the lease owner only (conservative
// for a new outbound-email behavior; the in-app alert still broadcasts to all
// members). Returns the count actually sent.
async function sendAlertEmails(
  supabase: ReturnType<typeof createClient>,
  alerts: EmailableAlert[],
): Promise<number> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.warn("[process-alerts] RESEND_API_KEY unset — skipping alert emails");
    return 0;
  }
  const ownerIds = [
    ...new Set(alerts.map((a) => a.ownerId).filter((id): id is string => Boolean(id))),
  ];
  if (ownerIds.length === 0) return 0;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email, email_notifications_enabled")
    .in("id", ownerIds);
  const profileMap = new Map(
    ((profiles ?? []) as Array<{ id: string; email: string | null; email_notifications_enabled: boolean | null }>)
      .map((p) => [p.id, p]),
  );

  const resend = new Resend(resendApiKey);
  const from = Deno.env.get("RESEND_ALERTS_FROM_EMAIL")
    ?? Deno.env.get("RESEND_FROM_EMAIL")
    ?? "LeaseIO <noreply@notifications.theleaseio.com>";

  let sent = 0;
  for (const alert of alerts) {
    if (!alert.ownerId) continue;
    const profile = profileMap.get(alert.ownerId);
    if (!profile?.email) continue;
    if (profile.email_notifications_enabled === false) continue; // opt-out respected
    const leaseLink = `https://app.theleaseio.com/app/leases/${alert.lease_id}`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="font-size: 18px;">${escapeHtml(alert.title)}</h2>
        <p style="color: #374151;">${escapeHtml(alert.body)}</p>
        <p style="margin-top: 24px;"><a href="${leaseLink}" style="color: #2563eb;">View in LeaseIO</a></p>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">You're receiving this because lease alerts are enabled for your account. Manage this in Account Settings → Notifications.</p>
      </div>`;
    try {
      const { error } = await resend.emails.send({
        from,
        to: [profile.email],
        subject: alert.title,
        html,
        text: `${alert.title}\n\n${alert.body}\n\nView: ${leaseLink}`,
      });
      if (error) {
        console.error("[process-alerts] alert email failed:", (error as { message?: string }).message ?? error);
        continue;
      }
      sent++;
    } catch (e) {
      console.error("[process-alerts] alert email threw:", e instanceof Error ? e.message : String(e));
    }
  }
  return sent;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("PROCESS_ALERTS_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const providedCronSecret = req.headers.get("x-cron-secret");
  if (providedCronSecret !== expectedCronSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const { data: rules, error: rulesErr } = await supabase
      .from("alert_rules")
      .select("workspace_id, alert_type, threshold_days, threshold_value, is_active")
      .eq("is_active", true);

    if (rulesErr) throw rulesErr;
    if (!rules?.length) {
      return jsonResponse({ processed: 0 }, 200, origin);
    }

    // Vault V1: this cron runs service-role across all workspaces — skip
    // non-live workspaces (canceled / soft-deleted / vault) instead of
    // failing the run. One batched lookup; semantics mirror
    // _shared/workspace_live.ts (missing workspace rows fail closed).
    const typedRules = rules as unknown as AlertRule[];
    const ruleWorkspaceIds = [...new Set(typedRules.map((r) => r.workspace_id))];
    const { data: wsRows, error: wsErr } = await supabase
      .from("workspaces")
      .select("id, canceled_at, soft_deleted_at, plan")
      .in("id", ruleWorkspaceIds);
    if (wsErr) throw wsErr;
    const liveWorkspaceIds = new Set(
      ((wsRows ?? []) as Array<{ id: string; canceled_at: string | null; soft_deleted_at: string | null; plan: string | null }>)
        .filter((w) => !w.canceled_at && !w.soft_deleted_at && w.plan !== "vault")
        .map((w) => w.id),
    );
    const liveRules = typedRules.filter((r) => liveWorkspaceIds.has(r.workspace_id));
    if (!liveRules.length) {
      return jsonResponse({ processed: 0 }, 200, origin);
    }

    const { data: leases, error: leasesErr } = await supabase
      .from("leases")
      .select(
        "id, workspace_id, user_id, filename, tenant_name, lifecycle_status, executed_expiry_date, covenant_flagged, monthly_payment, executed_monthly_payment, submitted_for_approval_at",
      )
      .not("lifecycle_status", "is", null);

    if (leasesErr) throw leasesErr;

    const alerts = await evaluate(
      supabase,
      liveRules,
      (leases ?? []) as unknown as Lease[],
    );

    if (alerts.length > 0) {
      // Strip the local-only ownerId before the DB insert (not a notifications column).
      const rows = alerts.map(({ ownerId: _ownerId, ...row }) => row);
      const { error: insertErr } = await supabase.from("notifications").insert(rows);
      if (insertErr) throw insertErr;
    }

    // Email each new alert to the lease owner (best-effort; respects the owner's
    // email_notifications_enabled preference). Only newly-created alerts reach
    // here (the evaluate dedup), so this never re-emails a recently-alerted lease.
    const emailed = await sendAlertEmails(supabase, alerts);

    return jsonResponse(
      { processed: alerts.length, emailed, timestamp: new Date().toISOString() },
      200,
      origin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[process-alerts] error:", msg);
    return jsonResponse({ error: msg }, 500, origin);
  }
});
