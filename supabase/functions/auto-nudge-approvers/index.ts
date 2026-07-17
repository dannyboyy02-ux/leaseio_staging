// auto-nudge-approvers — P1-6 (END_TO_END_REVIEW).
//
// The day-2 / day-5 / day-10 automatic escalation the nudge feature always
// intended (lease_nudges.nudge_type already carries automatic_day2/5/10) but was
// never built. Every active approval frontier step carries pending_since (set by
// resolve-approval-chain / act-on-chain-step / advance-to-final-review when it
// becomes the blocker). This cron finds steps that have sat unanswered past a
// milestone and nudges the CURRENT pending approver(s) once per milestone per
// step-cycle — the same notification the manual send-nudge writes.
//
// Milestone dedup: a lease_nudges row of the matching automatic_dayN type,
// created after the step's pending_since, means that milestone already fired for
// this cycle. A send-back that re-arms the frontier resets pending_since, so the
// milestones fire again for the new cycle (correct — it's a fresh wait).
//
// AUTH: cron-only. Header `x-cron-secret: $AUTO_NUDGE_CRON_SECRET`. No JWT.
//   1. Edge fn env: `supabase secrets set AUTO_NUDGE_CRON_SECRET=<value>`
//   2. Scheduled daily via the companion migration (fail-closed: unset secret
//      → 401 → nothing runs).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";
import { dispatchNotificationRow } from "../_shared/notify_dispatch.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Ordered high→low so we fire the HIGHEST milestone a step has crossed.
const MILESTONES: Array<{ days: number; type: string }> = [
  { days: 10, type: "automatic_day10" },
  { days: 5, type: "automatic_day5" },
  { days: 2, type: "automatic_day2" },
];

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedCronSecret = Deno.env.get("AUTO_NUDGE_CRON_SECRET");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!supabaseUrl || !serviceRoleKey || !expectedCronSecret) {
    return json({ error: "Server configuration error" }, 500);
  }
  if (req.headers.get("x-cron-secret") !== expectedCronSecret) {
    return json({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const now = Date.now();

  // Active frontier steps: pending + required + pending_since set (the ones that
  // are actually the current blocker), at least 2 days old.
  const twoDaysAgoIso = new Date(now - 2 * DAY_MS).toISOString();
  const { data: steps, error: stepsErr } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("id, lease_id, workspace_id, stage, approver_user_id, approver_role, effective_assignee_user_id, pending_since")
    .eq("status", "pending")
    .eq("is_required", true)
    .not("pending_since", "is", null)
    .lte("pending_since", twoDaysAgoIso);
  if (stepsErr) {
    console.error("[auto-nudge-approvers] steps load error:", stepsErr.message);
    return json({ ok: false, error: stepsErr.message, reason: "internal" }, 500);
  }

  const totals = { scanned: 0, nudged: 0, skipped: 0, delivered: 0 };
  const liveCache = new Map<string, boolean>();
  // Group steps by lease so multiple pending steps of one lease nudge once.
  const byLease = new Map<string, typeof steps>();
  for (const s of (steps ?? []) as any[]) {
    const arr = byLease.get(s.lease_id) ?? [];
    (arr as any[]).push(s);
    byLease.set(s.lease_id, arr as any);
  }

  for (const [leaseId, leaseSteps] of byLease.entries()) {
    totals.scanned++;
    const group = leaseSteps as any[];
    // Oldest pending_since across the lease's frontier steps drives the milestone.
    const oldestPendingSince = group
      .map((s) => new Date(s.pending_since).getTime())
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const daysPending = (now - oldestPendingSince) / DAY_MS;
    const milestone = MILESTONES.find((m) => daysPending >= m.days);
    if (!milestone) { totals.skipped++; continue; }

    const workspaceId = group[0].workspace_id as string;

    // Load lease (liveness/soft-delete gate + naming) — skip if hidden.
    const { data: lease } = await supabaseAdmin
      .from("leases")
      .select("id, workspace_id, lifecycle_status, request_title, filename, deleted_at")
      .eq("id", leaseId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!lease) { totals.skipped++; continue; }

    // Workspace liveness (canceled / vault / soft-deleted) — cached per run.
    let live = liveCache.get(workspaceId);
    if (live === undefined) {
      const res = await checkWorkspaceLive(supabaseAdmin, workspaceId);
      live = res.live;
      liveCache.set(workspaceId, live);
    }
    if (!live) { totals.skipped++; continue; }

    // Milestone dedup: already nudged this milestone since the wait began?
    const { data: prior } = await supabaseAdmin
      .from("lease_nudges")
      .select("id")
      .eq("lease_id", leaseId)
      .eq("nudge_type", milestone.type)
      .gte("sent_at", new Date(oldestPendingSince).toISOString())
      .limit(1);
    if ((prior as unknown[] | null)?.length) { totals.skipped++; continue; }

    // Resolve the current pending approver(s) — mirror send-nudge.
    const recipientSet = new Set<string>();
    const roles = new Set<string>();
    for (const s of group) {
      const direct = s.effective_assignee_user_id || s.approver_user_id;
      if (direct) recipientSet.add(direct);
      else if (s.approver_role) roles.add(s.approver_role);
    }
    if (recipientSet.size === 0 && roles.size === 0) {
      roles.add("manager_approver");
      roles.add("financial_approver");
    }
    if (roles.size > 0) {
      const { data: roleMembers } = await supabaseAdmin
        .from("workspace_roles").select("user_id").eq("workspace_id", workspaceId).in("role", Array.from(roles));
      for (const m of (roleMembers ?? []) as Array<{ user_id: string | null }>) if (m.user_id) recipientSet.add(m.user_id);
    }
    const recipientIds = Array.from(recipientSet);
    if (recipientIds.length === 0) { totals.skipped++; continue; }

    const leaseName = (lease as any).request_title || (lease as any).filename || "a lease";
    const dayN = milestone.days;
    const message = `Reminder: "${leaseName}" has been awaiting your approval for ${dayN} days.`;
    const details = { notification_type: "approver_nudge", recipient_ids: recipientIds, message };

    const { data: activityRow, error: insErr } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({ lease_id: leaseId, user_id: null, activity_type: "comment", details })
      .select("id")
      .single();
    if (insErr || !activityRow) {
      console.error("[auto-nudge-approvers] activity insert failed:", insErr?.message);
      totals.skipped++;
      continue;
    }
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: leaseId, user_id: null, activity_type: "nudge_sent",
      details: { recipient_count: recipientIds.length, channel: "email", auto: true, milestone_days: dayN },
    });
    await supabaseAdmin.from("lease_nudges").insert({ lease_id: leaseId, sent_by: null, nudge_type: milestone.type, channel: "email" });
    totals.nudged++;

    if (resendApiKey) {
      const res = await dispatchNotificationRow(supabaseAdmin, resendApiKey, { id: (activityRow as { id: string }).id, lease_id: leaseId, details });
      totals.delivered += res.sent;
    }
  }

  return json({ ok: true, ...totals });
});
