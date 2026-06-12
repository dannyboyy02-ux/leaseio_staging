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
): Promise<NotificationRow[]> {
  const toInsert: NotificationRow[] = [];
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
          });
        }
      }
    }
  }

  return toInsert;
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
        "id, workspace_id, filename, tenant_name, lifecycle_status, executed_expiry_date, covenant_flagged, monthly_payment, executed_monthly_payment, submitted_for_approval_at",
      )
      .not("lifecycle_status", "is", null);

    if (leasesErr) throw leasesErr;

    const notifications = await evaluate(
      supabase,
      liveRules,
      (leases ?? []) as unknown as Lease[],
    );

    if (notifications.length > 0) {
      const { error: insertErr } = await supabase.from("notifications").insert(notifications);
      if (insertErr) throw insertErr;
    }

    return jsonResponse(
      { processed: notifications.length, timestamp: new Date().toISOString() },
      200,
      origin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[process-alerts] error:", msg);
    return jsonResponse({ error: msg }, 500, origin);
  }
});
