// send-counter-signature-reminder — Phase 5 Checkpoint 3
//
// Codebase's first scheduled function. Runs daily, scans leases in
// pending_counter_signature, and fires tiered reminders to chase the
// counter-signed document.
//
// Reminder tiers (per spec):
//   tier 1: -7 to -1 days before due  → execution_owner only
//   tier 2: 0 (due today)             → execution_owner + submitter
//   tier 3: +7 to +13 overdue         → owner + submitter + admins
//                                        + counter_signature_overdue
//                                        audit row
//   tier 4: +14 to +27 overdue        → same recipients (tier 3 audit
//                                        row stays the marker — only
//                                        one overdue audit per lease)
//   tier 5: +28+ overdue              → same recipients
//
// IDEMPOTENCY
//   leases.counter_signature_reminder_count tracks how many tier
//   thresholds have been passed (0..5). Each run computes the current
//   tier from days-from-due and sends a reminder ONLY if the current
//   tier > stored count, then bumps the count up to the current tier.
//   Running twice in the same day = no-op for the second run because
//   tier === stored count.
//
//   Missed-run resilience: if the scheduler skips a day and the lease
//   has crossed multiple tiers since the last run, we send ONE
//   reminder for the current tier and bump the count to that tier
//   (skipping intermediate tiers — the louder current-tier reminder
//   covers the gap; redundant retro-reminders would just add noise).
//
// AUTHORIZATION
//   verify_jwt = false (config.toml override). Caller must present
//   `x-cron-secret: $SEND_COUNTER_SIGNATURE_REMINDER_CRON_SECRET`.
//   Secret is set in two places at deploy time:
//     1. Edge function env: `supabase secrets set SEND_COUNTER_SIGNATURE_REMINDER_CRON_SECRET=<value>`
//     2. Database setting:  `ALTER DATABASE postgres SET app.send_counter_signature_reminder_cron_secret = '<value>';`
//   Schedule: daily 08:15 UTC via pg_cron in
//   `20260507220000_phase567_crons.sql`.

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

interface PendingLease {
  id: string;
  workspace_id: string;
  requestor_id: string | null;
  user_id: string | null;
  execution_owner_id: string | null;
  counter_signature_due_date: string | null;
  counter_signature_reminder_count: number;
}

/**
 * Returns the reminder tier index (0..5) for a lease given today's
 * date and the lease's due date.
 *   0 = no tier crossed yet (>7 days before due, or no due date)
 *   1 = within -7..-1 days of due (approaching)
 *   2 = due today
 *   3 = +7..+13 overdue
 *   4 = +14..+27 overdue
 *   5 = +28+ overdue
 */
function currentReminderTier(dueDate: Date, today: Date): number {
  const dueDay = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysFromDue = Math.floor((todayDay - dueDay) / (1000 * 60 * 60 * 24));

  if (daysFromDue >= 28) return 5;
  if (daysFromDue >= 14) return 4;
  if (daysFromDue >= 7) return 3;
  if (daysFromDue >= 0) return 2;
  if (daysFromDue >= -7) return 1;
  return 0;
}

function tierMessage(tier: number, dueDateStr: string): string {
  switch (tier) {
    case 1:
      return `Counter-signed document is due ${dueDateStr}. Please follow up with the counterparty.`;
    case 2:
      return `Counter-signed document is due TODAY (${dueDateStr}). Please follow up with the counterparty.`;
    case 3:
      return `Counter-signed document is overdue (was due ${dueDateStr}). Please escalate with the counterparty.`;
    case 4:
      return `Counter-signed document is 14+ days overdue (was due ${dueDateStr}). Critical follow-up needed.`;
    case 5:
      return `Counter-signed document is 28+ days overdue (was due ${dueDateStr}). Consider escalation to leadership or cancellation.`;
    default:
      return `Counter-signed document reminder.`;
  }
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  // Allow GET so a cron service can hit it without a JSON body.
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("SEND_COUNTER_SIGNATURE_REMINDER_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const providedCronSecret = req.headers.get("x-cron-secret");
  if (providedCronSecret !== expectedCronSecret) {
    return jsonResponse(
      { ok: false, error: "Unauthorized", reason: "no_auth" },
      401,
      origin,
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Pull every lease in pending_counter_signature ──────────────────
  const { data: leases, error: leasesError } = await supabaseAdmin
    .from("leases")
    .select(
      "id, workspace_id, requestor_id, user_id, execution_owner_id, counter_signature_due_date, counter_signature_reminder_count",
    )
    .eq("lifecycle_status", "pending_counter_signature");

  if (leasesError) {
    console.error("[send-counter-signature-reminder] leases load error:", leasesError.message);
    return jsonResponse(
      { ok: false, error: leasesError.message, reason: "internal" },
      500,
      origin,
    );
  }

  const pendingLeases = (leases ?? []) as PendingLease[];

  // Vault V1: this cron runs service-role across all workspaces — skip
  // non-live workspaces (canceled / soft-deleted / vault) instead of
  // failing the run. One batched lookup; semantics mirror
  // _shared/workspace_live.ts (missing workspace rows fail closed).
  let liveWorkspaceIds = new Set<string>();
  if (pendingLeases.length > 0) {
    const workspaceIds = [...new Set(pendingLeases.map((l) => l.workspace_id))];
    const { data: wsRows, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .select("id, canceled_at, soft_deleted_at, plan")
      .in("id", workspaceIds);
    if (wsErr) {
      console.error("[send-counter-signature-reminder] workspace liveness load error:", wsErr.message);
      return jsonResponse(
        { ok: false, error: wsErr.message, reason: "internal" },
        500,
        origin,
      );
    }
    liveWorkspaceIds = new Set(
      ((wsRows ?? []) as Array<{ id: string; canceled_at: string | null; soft_deleted_at: string | null; plan: string | null }>)
        .filter((w) => !w.canceled_at && !w.soft_deleted_at && w.plan !== "vault")
        .map((w) => w.id),
    );
  }

  const today = new Date();
  let processedCount = 0;
  let remindersSent = 0;
  const skippedDetails: Array<{ leaseId: string; reason: string }> = [];

  for (const lease of pendingLeases) {
    processedCount++;

    if (!liveWorkspaceIds.has(lease.workspace_id)) {
      console.log(
        `[send-counter-signature-reminder] skipping lease ${lease.id}: workspace ${lease.workspace_id} not live`,
      );
      skippedDetails.push({ leaseId: lease.id, reason: "workspace_not_live" });
      continue;
    }

    if (!lease.counter_signature_due_date) {
      skippedDetails.push({ leaseId: lease.id, reason: "no_due_date" });
      continue;
    }

    const dueDate = new Date(lease.counter_signature_due_date);
    if (Number.isNaN(dueDate.getTime())) {
      skippedDetails.push({ leaseId: lease.id, reason: "invalid_due_date" });
      continue;
    }

    const tier = currentReminderTier(dueDate, today);
    const sentTier = lease.counter_signature_reminder_count ?? 0;

    if (tier <= sentTier) {
      // Already sent this tier (or no tier crossed yet). Idempotent skip.
      skippedDetails.push({
        leaseId: lease.id,
        reason: `tier_already_sent (current=${tier}, sent=${sentTier})`,
      });
      continue;
    }

    // Build recipient set per tier
    const recipientIds = new Set<string>();
    if (lease.execution_owner_id) recipientIds.add(lease.execution_owner_id);

    if (tier >= 2) {
      // Due day and beyond: also notify submitter
      const submitterId = lease.requestor_id ?? lease.user_id;
      if (submitterId) recipientIds.add(submitterId);
    }

    if (tier >= 3) {
      // Overdue: also notify workspace admins + workspace owner
      const { data: adminMembers } = await supabaseAdmin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", lease.workspace_id)
        .eq("role", "admin");
      for (const m of (adminMembers ?? []) as Array<{ user_id: string }>) {
        recipientIds.add(m.user_id);
      }
      const { data: ownerRow } = await supabaseAdmin
        .from("workspaces")
        .select("owner_id")
        .eq("id", lease.workspace_id)
        .maybeSingle();
      if ((ownerRow as { owner_id: string } | null)?.owner_id) {
        recipientIds.add((ownerRow as { owner_id: string }).owner_id);
      }
    }

    if (recipientIds.size === 0) {
      // Nothing we can do — no recipients. Bump the count anyway so we
      // don't re-evaluate this lease at the same tier on the next run.
      console.warn(
        `[send-counter-signature-reminder] lease ${lease.id} at tier ${tier} has no recipients; skipping notification but bumping count`,
      );
      await supabaseAdmin
        .from("leases")
        .update({ counter_signature_reminder_count: tier })
        .eq("id", lease.id);
      skippedDetails.push({ leaseId: lease.id, reason: "no_recipients" });
      continue;
    }

    // ── Send the reminder via comment activity log ────────────────────
    const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: null,
      activity_type: "comment",
      details: {
        notification_type: "counter_signature_reminder",
        tier,
        recipient_ids: Array.from(recipientIds),
        message: tierMessage(tier, lease.counter_signature_due_date),
      },
    });
    if (auditErr) console.error("lease_activity_log insert failed (comment/counter_signature_reminder notification):", auditErr.message);

    // Audit row capturing the reminder send (Phase 5 spec)
    const { error: auditErr2 } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: lease.id,
      user_id: null,
      activity_type: "counter_signature_reminder_sent",
      details: {
        tier,
        prior_count: sentTier,
        new_count: tier,
        due_date: lease.counter_signature_due_date,
        recipient_count: recipientIds.size,
      },
    });
    if (auditErr2) console.error("lease_activity_log insert failed (counter_signature_reminder_sent):", auditErr2.message);

    // Tier 3+: also write the counter_signature_overdue audit row.
    // We only write it ONCE per lease (when the tier first crosses 3),
    // not every subsequent overdue tier — the audit shouldn't have
    // three separate "overdue" rows for the same lease.
    if (tier === 3 && sentTier < 3) {
      const { error: auditErr3 } = await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: lease.id,
        user_id: null,
        activity_type: "counter_signature_overdue",
        details: {
          due_date: lease.counter_signature_due_date,
          first_overdue_at: today.toISOString(),
        },
      });
      if (auditErr3) console.error("lease_activity_log insert failed (counter_signature_overdue):", auditErr3.message);
    }

    // Bump the reminder count to the current tier (NOT just +1 — handles
    // the missed-run case where multiple tiers crossed since last send)
    const { error: updateError } = await supabaseAdmin
      .from("leases")
      .update({ counter_signature_reminder_count: tier })
      .eq("id", lease.id);
    if (updateError) {
      console.error(
        `[send-counter-signature-reminder] failed to bump count for lease ${lease.id}:`,
        updateError.message,
      );
    } else {
      remindersSent++;
    }
  }

  return jsonResponse(
    {
      ok: true,
      ranAt: today.toISOString(),
      processedCount,
      remindersSent,
      skippedCount: skippedDetails.length,
      // Truncate skip details to keep response payload bounded.
      skippedSample: skippedDetails.slice(0, 20),
    },
    200,
    origin,
  );
});
