// ============================================================================
// send-nudge — KNOWN_ISSUES #109.
// ----------------------------------------------------------------------------
// Replaces the dead `NudgeApproverButton` (which only stamped
// leases.last_nudged_at and toasted a lie). Resolves the lease's CURRENT
// pending approver(s), writes the canonical notification row
// (lease_activity_log 'comment' + details.recipient_ids), records the nudge
// (lease_nudges + last_nudged_at), and DISPATCHES it immediately (email) so the
// approver actually hears about it and the caller learns who was nudged.
//
// AUTH: Bearer JWT. Caller must be the lease submitter (requestor_id/user_id)
// OR a workspace owner/admin. Server-side cooldown (the client countdown is
// only UX). Guards: checkWorkspaceLive + enforceWorkspaceRateLimit.
// ============================================================================
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import { dispatchNotificationRow } from "../_shared/notify_dispatch.ts";

const COOLDOWN_MINUTES = 30;

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}
function json(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: "Server configuration error" }, 500, origin);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) return json({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  const user = userData.user;

  let body: { leaseId?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin); }
  const leaseId = body?.leaseId;
  if (!leaseId || typeof leaseId !== "string") return json({ ok: false, error: "leaseId is required", reason: "bad_request" }, 400, origin);

  const { data: lease } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lifecycle_status, requestor_id, user_id, last_nudged_at, request_title, filename")
    .eq("id", leaseId)
    .maybeSingle();
  if (!lease) return json({ ok: false, error: "Lease not found", reason: "not_found" }, 404, origin);

  const liveness = await checkWorkspaceLive(supabaseAdmin, lease.workspace_id);
  if (!liveness.live) return json({ ok: false, error: "subscription_inactive", reason: liveness.reason }, 403, origin);

  // ── Authorization: submitter OR workspace owner/admin ────────────────
  let authorized = lease.requestor_id === user.id || lease.user_id === user.id;
  if (!authorized) {
    const { data: ws } = await supabaseAdmin.from("workspaces").select("owner_id").eq("id", lease.workspace_id).maybeSingle();
    if ((ws as { owner_id?: string } | null)?.owner_id === user.id) authorized = true;
    if (!authorized) {
      const { data: member } = await supabaseAdmin.from("workspace_members")
        .select("role").eq("workspace_id", lease.workspace_id).eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (member) authorized = true;
    }
  }
  if (!authorized) return json({ ok: false, error: "Only the requester or a workspace admin can nudge", reason: "not_authorized" }, 403, origin);

  // ── Server-side cooldown ─────────────────────────────────────────────
  if (lease.last_nudged_at) {
    const elapsedMs = Date.now() - new Date(lease.last_nudged_at).getTime();
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
    if (elapsedMs < cooldownMs) {
      const retryAfterSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return json({ ok: false, reason: "cooldown", retryAfterSeconds, error: `Already nudged recently — try again in ${Math.ceil(retryAfterSeconds / 60)} min.` }, 200, origin);
    }
  }

  const rl = await enforceWorkspaceRateLimit(supabaseAdmin, lease.workspace_id, "send-nudge", origin, 20);
  if (rl) return rl;

  // ── Resolve current pending approver(s) ──────────────────────────────
  const { data: pendingSteps } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("approver_user_id, approver_role, effective_assignee_user_id")
    .eq("lease_id", lease.id)
    .eq("status", "pending")
    .eq("is_required", true);

  const recipientSet = new Set<string>();
  const roles = new Set<string>();
  for (const s of (pendingSteps ?? []) as Array<{ approver_user_id: string | null; approver_role: string | null; effective_assignee_user_id: string | null }>) {
    const direct = s.effective_assignee_user_id || s.approver_user_id;
    if (direct) recipientSet.add(direct);
    else if (s.approver_role) roles.add(s.approver_role);
  }
  // Legacy fallback: no resolved chain → the workspace's manager/financial approvers.
  if (recipientSet.size === 0 && roles.size === 0) {
    roles.add("manager_approver");
    roles.add("financial_approver");
  }
  if (roles.size > 0) {
    const { data: roleMembers } = await supabaseAdmin
      .from("workspace_roles").select("user_id").eq("workspace_id", lease.workspace_id).in("role", Array.from(roles));
    for (const m of (roleMembers ?? []) as Array<{ user_id: string | null }>) if (m.user_id) recipientSet.add(m.user_id);
  }
  recipientSet.delete(user.id); // never nudge yourself
  const recipientIds = Array.from(recipientSet);
  if (recipientIds.length === 0) return json({ ok: false, reason: "no_approver", error: "No pending approver to nudge." }, 200, origin);

  // ── Compose + record the notification ────────────────────────────────
  const { data: requester } = await supabaseAdmin.from("profiles").select("first_name, last_name, email").eq("id", user.id).maybeSingle();
  const rq = requester as { first_name?: string | null; last_name?: string | null; email?: string | null } | null;
  const requesterName = [rq?.first_name, rq?.last_name].filter(Boolean).join(" ") || rq?.email || "A colleague";
  const leaseName = lease.request_title || lease.filename || "a lease";
  const message = `${requesterName} sent a reminder: "${leaseName}" is awaiting your approval.`;
  const details = { notification_type: "approver_nudge", recipient_ids: recipientIds, message };

  const { data: activityRow, error: insErr } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({ lease_id: lease.id, user_id: user.id, activity_type: "comment", details })
    .select("id")
    .single();
  if (insErr || !activityRow) {
    console.error("[send-nudge] activity insert failed:", insErr?.message);
    return json({ ok: false, error: "Could not record the nudge", reason: "insert_failed" }, 500, origin);
  }

  // Human-readable timeline entry + structured nudge record.
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: lease.id, user_id: user.id, activity_type: "nudge_sent",
    details: { recipient_count: recipientIds.length, channel: "email" },
  });
  await supabaseAdmin.from("lease_nudges").insert({ lease_id: lease.id, sent_by: user.id, nudge_type: "manual", channel: "email" });
  await supabaseAdmin.from("leases").update({ last_nudged_at: new Date().toISOString() }).eq("id", lease.id);

  // ── Immediate delivery (the cron is the backstop for everything else) ─
  let sent = 0;
  if (resendApiKey) {
    const res = await dispatchNotificationRow(supabaseAdmin, resendApiKey, { id: (activityRow as { id: string }).id, lease_id: lease.id, details });
    sent = res.sent;
  }

  // Names for the caller's confirmation toast.
  const { data: recProfiles } = await supabaseAdmin.from("profiles").select("first_name, last_name, email").in("id", recipientIds);
  const recipients = ((recProfiles ?? []) as Array<{ first_name?: string | null; last_name?: string | null; email?: string | null }>)
    .map((p) => [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "approver");

  return json({ ok: true, recipientCount: recipientIds.length, recipients, notificationsSent: sent }, 200, origin);
});
