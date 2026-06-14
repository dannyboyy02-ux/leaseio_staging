// process-cancellation-lifecycle — daily cron for the canceled-workspace
// lifecycle (ratified 2026-06-12). Spec: docs/CANCELLATION_LIFECYCLE_SPEC.md.
//
// Three duties, in order, all idempotent:
//   1. REMINDERS — workspaces in grace get renewal/export emails at days
//      0/7/14/21/27 and a final notice on the last day of access. The
//      cancellation_notices ledger (UNIQUE per workspace × cycle × type)
//      makes retries and catch-up runs double-send-proof.
//   2. SOFT-DELETE — grace expired → stamp soft_deleted_at + purge_after
//      (+10 days), log to workspace_activity_log, send the soft_deleted
//      notice ("access has ended; renew within 10 days to restore").
//   3. PURGE — purge_after passed → re-verify the subscription is still
//      not entitled (race guard), write the durable deleted_workspaces
//      forensic row, purge storage, delete leases then the workspace row.
//
// Every step re-checks subscription_status: a renewal at ANY point clears
// the lifecycle (the webhook does this too; the cron self-heals rows the
// webhook missed). Email volume is bounded (MAX_EMAILS_PER_RUN) per the
// paid-API cost rule.
//
// Auth: cron-only via x-cron-secret (verify_jwt = false). No human caller.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import {
  PURGE_BUFFER_DAYS,
  dueNotices,
  graceDaysRemaining,
} from "../_shared/cancellation_lifecycle.ts";
import {
  cancelWorkspaceSubscriptions,
  purgeWorkspaceStorage,
} from "../_shared/workspace_purge.ts";

const jsonHeaders = { "Content-Type": "application/json" };
const MAX_EMAILS_PER_RUN = 200;

// Workspace names are admin-editable free text rendered into email HTML —
// escape so a renamed workspace can't inject markup into lifecycle emails
// sent from a trusted address (security review 2026-06-12).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type NoticeKind =
  | "day0"
  | "day7"
  | "day14"
  | "day21"
  | "day27"
  | "day30_final"
  | "soft_deleted";

function noticeCopy(kind: NoticeKind, rawWorkspaceName: string, daysLeft: number, appUrl: string) {
  const workspaceName = escapeHtml(rawWorkspaceName);
  const renewUrl = `${appUrl}/app/settings/account?tab=billing`;
  const exportUrl = `${appUrl}/app/reports`;
  const footer = `
    <p style="margin-top:24px">
      <a href="${renewUrl}" style="background:#1a56db;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Renew subscription</a>
      &nbsp;&nbsp;<a href="${exportUrl}">Export your data</a>
    </p>
    <p style="margin-top:8px;color:#374151">Don't need an active plan but want to keep the records? The workspace owner can switch to <strong>Vault</strong> — read-only retention with full export, $249/year — from the <a href="${renewUrl}">billing page</a>. Your data stays; deletion is canceled.</p>
    <p style="color:#6b7280;font-size:12px">You're receiving this because you're an owner or admin of the LeaseIO workspace "${workspaceName}".</p>`;

  if (kind === "day0") {
    return {
      subject: `Your LeaseIO subscription for "${workspaceName}" has ended`,
      html: `<p>Your subscription for <strong>${workspaceName}</strong> has ended.</p>
<p>For the next <strong>${daysLeft} days</strong> you can still sign in to view and export everything — leases, documents, and reports. After that, access ends and the workspace and its data are scheduled for permanent deletion.</p>
<p>Renew at any time before then and nothing is lost — your full workspace is restored exactly as you left it.</p>${footer}`,
    };
  }
  if (kind === "day30_final") {
    return {
      subject: `Final notice: access to "${workspaceName}" ends today`,
      html: `<p>Today is the <strong>last day</strong> of view-and-export access to <strong>${workspaceName}</strong>.</p>
<p>After today, access ends and the workspace and all of its data are scheduled for permanent deletion. Lease agreements are financial records — if you need them for your books or your auditors, export them now.</p>
<p>Renewing today restores everything instantly.</p>${footer}`,
    };
  }
  if (kind === "soft_deleted") {
    return {
      subject: `Access to "${workspaceName}" has ended — deletion scheduled`,
      html: `<p>The 30-day access window for <strong>${workspaceName}</strong> has ended and the workspace is now scheduled for permanent deletion in about ${PURGE_BUFFER_DAYS} days.</p>
<p>This is the last chance to recover it: renewing before deletion restores the workspace and all of its data in full. After deletion, recovery is impossible.</p>${footer}`,
    };
  }
  return {
    subject: `${daysLeft} days left to export your LeaseIO data ("${workspaceName}")`,
    html: `<p>A reminder that your subscription for <strong>${workspaceName}</strong> has ended.</p>
<p>You have <strong>${daysLeft} days</strong> of view-and-export access left. After that, the workspace and its data — every lease, document, and report — are permanently deleted.</p>
<p>Renew before then and everything stays exactly as you left it.</p>${footer}`,
  };
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }

  const cronSecret = Deno.env.get("CANCELLATION_LIFECYCLE_CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const appUrl = Deno.env.get("APP_BASE_URL") ?? "https://theleaseio.com";
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: jsonHeaders });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" }) : null;
  const now = new Date();
  const stats = { reminders: 0, softDeleted: 0, purged: 0, healed: 0, emailFailures: 0 };
  let emailBudget = MAX_EMAILS_PER_RUN;

  // ── Recipient + send helpers ─────────────────────────────────────────
  async function ownerAdminEmails(workspaceId: string, ownerId: string): Promise<string[]> {
    const ids = new Set<string>([ownerId]);
    const { data: admins } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("role", "admin")
      .not("accepted_at", "is", null);
    for (const a of admins ?? []) ids.add((a as { user_id: string }).user_id);
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, email")
      .in("id", Array.from(ids));
    return (profiles ?? [])
      .map((p) => (p as { email: string | null }).email)
      .filter((e): e is string => !!e);
  }

  async function sendNotice(
    workspaceId: string,
    workspaceName: string,
    ownerId: string,
    cycleStartedAt: string,
    kind: NoticeKind,
    daysLeft: number,
  ): Promise<void> {
    if (!resendApiKey) {
      console.error("[cancellation-lifecycle] RESEND_API_KEY not set — notice skipped:", kind, workspaceId);
      stats.emailFailures++;
      return;
    }
    if (emailBudget <= 0) {
      console.warn("[cancellation-lifecycle] email budget exhausted; deferring to next run");
      return;
    }
    const recipients = await ownerAdminEmails(workspaceId, ownerId);
    if (recipients.length === 0) {
      // Don't burn the ledger row when there is nobody to notify — a later
      // run (after a profile email lands) can still send it.
      console.warn("[cancellation-lifecycle] no recipients for", workspaceId);
      return;
    }

    // Claim the ledger row FIRST — the unique constraint is the idempotency
    // gate. If a concurrent/retried run already claimed it, skip silently.
    // Trade-off (documented in the spec): a crash between claim and send
    // swallows the notice; per-recipient outcomes are recorded on the row
    // below so the load-bearing finals are auditable.
    const { data: ledgerRow, error: ledgerErr } = await supabaseAdmin
      .from("cancellation_notices")
      .insert({
        workspace_id: workspaceId,
        cycle_started_at: cycleStartedAt,
        notice_type: kind,
        recipients,
      })
      .select("id")
      .maybeSingle();
    if (ledgerErr) {
      if (!/duplicate|unique/i.test(ledgerErr.message)) {
        console.error("[cancellation-lifecycle] ledger insert failed:", ledgerErr.message);
      }
      return;
    }

    const { subject, html } = noticeCopy(kind, workspaceName, daysLeft, appUrl);
    const outcomes: Array<{ email: string; ok: boolean }> = [];
    for (const to of recipients) {
      if (emailBudget <= 0) break;
      emailBudget--;
      let ok = false;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
          body: JSON.stringify({
            from: Deno.env.get("RESEND_FROM_EMAIL") ?? "LeaseIO <noreply@notifications.theleaseio.com>",
            to,
            subject,
            html,
          }),
        });
        ok = res.ok;
        if (!res.ok) {
          stats.emailFailures++;
          console.error("[cancellation-lifecycle] resend error:", res.status, await res.text());
        }
      } catch (err) {
        stats.emailFailures++;
        console.error("[cancellation-lifecycle] resend fetch error:", (err as Error)?.message);
      }
      outcomes.push({ email: to, ok });
    }
    // Record delivery outcome on the ledger row — "we notified them" must be
    // provable per-recipient, especially for day30_final / soft_deleted.
    if (ledgerRow) {
      await supabaseAdmin
        .from("cancellation_notices")
        .update({ recipients: outcomes })
        .eq("id", (ledgerRow as { id: string }).id);
    }
    stats.reminders++;
  }

  // A renewal any time before purge clears the lifecycle. The webhook
  // normally does this; the cron self-heals rows the webhook missed.
  function isEntitled(ws: { subscription_status: string | null }): boolean {
    return ws.subscription_status === "active" || ws.subscription_status === "trialing";
  }
  async function healRenewed(workspaceId: string): Promise<void> {
    await supabaseAdmin
      .from("workspaces")
      .update({ canceled_at: null, grace_expires_at: null, soft_deleted_at: null, purge_after: null })
      .eq("id", workspaceId);
    stats.healed++;
  }

  try {
    // ── 1 + 2. Grace workspaces: reminders, then soft-delete at expiry ──
    const { data: graceRows } = await supabaseAdmin
      .from("workspaces")
      .select("id, name, owner_id, canceled_at, grace_expires_at, subscription_status")
      .not("canceled_at", "is", null)
      .is("soft_deleted_at", null)
      .limit(500);

    for (const ws of (graceRows ?? []) as Array<{
      id: string; name: string | null; owner_id: string;
      canceled_at: string; grace_expires_at: string; subscription_status: string | null;
    }>) {
      if (isEntitled(ws)) {
        await healRenewed(ws.id);
        continue;
      }
      const wsName = ws.name ?? "your workspace";
      const daysLeft = graceDaysRemaining(ws.grace_expires_at, now);

      const { data: sentRows } = await supabaseAdmin
        .from("cancellation_notices")
        .select("notice_type")
        .eq("workspace_id", ws.id)
        .eq("cycle_started_at", ws.canceled_at);
      const sent = new Set((sentRows ?? []).map((r) => (r as { notice_type: string }).notice_type));

      for (const kind of dueNotices(ws.canceled_at, sent, now)) {
        await sendNotice(ws.id, wsName, ws.owner_id, ws.canceled_at, kind, daysLeft);
      }

      // Soft-delete at grace expiry — only after the final notice has had
      // a cron cycle to land (day30_final arms at day 29; expiry is day 30).
      if (now.getTime() >= new Date(ws.grace_expires_at).getTime()) {
        const purgeAfter = new Date(now.getTime() + PURGE_BUFFER_DAYS * 86_400_000).toISOString();
        // Conditional on canceled_at STILL set: a renewal webhook landing
        // between our SELECT and this UPDATE clears the lifecycle, and this
        // guard makes the soft-delete match zero rows instead of stamping a
        // paying workspace (integrity review 2026-06-12).
        const { error: sdErr } = await supabaseAdmin
          .from("workspaces")
          .update({ soft_deleted_at: now.toISOString(), purge_after: purgeAfter })
          .eq("id", ws.id)
          .is("soft_deleted_at", null)
          .not("canceled_at", "is", null);
        if (sdErr) {
          console.error("[cancellation-lifecycle] soft-delete failed:", ws.id, sdErr.message);
          continue;
        }
        await supabaseAdmin.from("workspace_activity_log").insert({
          workspace_id: ws.id,
          user_id: null,
          event_type: "soft_deleted",
          details: { reason: "grace_expired", canceled_at: ws.canceled_at, purge_after: purgeAfter },
        });
        await sendNotice(ws.id, wsName, ws.owner_id, ws.canceled_at, "soft_deleted", 0);
        stats.softDeleted++;
      }
    }

    // ── 3. Purge workspaces past the buffer ─────────────────────────────
    // Order (integrity review 2026-06-12): re-verify fresh state → cancel
    // Stripe subscriptions → forensic row (with lifecycle + notice-history
    // snapshot — the ledger CASCADEs away with the workspace) → conditional
    // row deletes (a concurrent renewal heal makes them match zero rows) →
    // storage purge LAST (files are unreachable once rows are gone; an
    // abort before this point leaves the workspace fully recoverable).
    const { data: purgeRows } = await supabaseAdmin
      .from("workspaces")
      .select("id")
      .not("soft_deleted_at", "is", null)
      .lt("purge_after", now.toISOString())
      .limit(50);

    for (const candidate of (purgeRows ?? []) as Array<{ id: string }>) {
      // Re-fetch fresh at the moment of destruction — the loop above may
      // have run for minutes.
      const { data: fresh } = await supabaseAdmin
        .from("workspaces")
        .select(
          "id, name, owner_id, plan, subscription_status, stripe_customer_id, canceled_at, grace_expires_at, soft_deleted_at, purge_after",
        )
        .eq("id", candidate.id)
        .maybeSingle();
      const ws = fresh as {
        id: string; name: string | null; owner_id: string; plan: string | null;
        subscription_status: string | null; stripe_customer_id: string | null;
        canceled_at: string | null; grace_expires_at: string | null;
        soft_deleted_at: string | null; purge_after: string | null;
      } | null;
      if (!ws || !ws.soft_deleted_at || !ws.purge_after || now.getTime() < new Date(ws.purge_after).getTime()) {
        continue;
      }
      // Race guard: a renewal between soft-delete and purge wins.
      if (isEntitled(ws)) {
        await healRenewed(ws.id);
        continue;
      }

      // Cancel every surviving Stripe subscription tagged to this workspace
      // (document packs are independent subscriptions — without this they
      // bill forever against a deleted workspace; security review HIGH).
      let stripeCanceled: string[] = [];
      if (stripe && ws.stripe_customer_id) {
        try {
          stripeCanceled = await cancelWorkspaceSubscriptions(stripe, ws.stripe_customer_id, ws.id);
        } catch (err) {
          console.error("[cancellation-lifecycle] stripe cleanup failed — purge deferred:", ws.id, (err as Error)?.message);
          continue; // never purge while billing cleanup is unconfirmed
        }
      } else if (!stripe) {
        console.error("[cancellation-lifecycle] STRIPE_SECRET_KEY not set — purge deferred:", ws.id);
        continue;
      }

      const [{ count: leaseCount }, { count: memberCount }, { data: noticeRows }] = await Promise.all([
        supabaseAdmin.from("leases").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id),
        supabaseAdmin.from("workspace_members").select("user_id", { count: "exact", head: true }).eq("workspace_id", ws.id),
        supabaseAdmin.from("cancellation_notices").select("notice_type, sent_at, recipients").eq("workspace_id", ws.id),
      ]);

      // Storage prefixes — captured BEFORE the lease rows are deleted.
      //   leases / executed-leases: {uploader_user_id}/{lease_id} (same
      //   convention delete-workspace purges); lease-documents and
      //   lease-reports: {workspace_id}/{child}/... (verified against
      //   UploadDocumentDialog + generate-lease-report).
      const { data: leaseRows } = await supabaseAdmin
        .from("leases")
        .select("id, user_id, requestor_id")
        .eq("workspace_id", ws.id);
      const uploaderPrefixes = new Set<string>();
      for (const l of (leaseRows ?? []) as Array<{ id: string; user_id: string | null; requestor_id: string | null }>) {
        if (l.user_id) uploaderPrefixes.add(`${l.user_id}/${l.id}`);
        if (l.requestor_id && l.requestor_id !== l.user_id) {
          uploaderPrefixes.add(`${l.requestor_id}/${l.id}`);
        }
      }

      // Forensic row BEFORE any destruction. UNIQUE(original_workspace_id):
      // a duplicate means a previous partial purge — resume the deletes
      // against the existing record instead of re-recording.
      const { error: forensicErr } = await supabaseAdmin.from("deleted_workspaces").insert({
        original_workspace_id: ws.id,
        owner_id: ws.owner_id,
        workspace_name: ws.name,
        workspace_plan: ws.plan,
        lease_count_at_deletion: leaseCount ?? 0,
        member_count_at_deletion: memberCount ?? 0,
        storage_objects_purged: 0,
        deleted_by: null,
        details: {
          purge_source: "cancellation_lifecycle_cron",
          canceled_at: ws.canceled_at,
          grace_expires_at: ws.grace_expires_at,
          soft_deleted_at: ws.soft_deleted_at,
          purge_after: ws.purge_after,
          stripe_subscriptions_canceled: stripeCanceled,
          notices: noticeRows ?? [],
        },
      });
      if (forensicErr && !/duplicate|unique/i.test(forensicErr.message)) {
        console.error("[cancellation-lifecycle] forensic insert failed — purge ABORTED:", ws.id, forensicErr.message);
        continue;
      }

      const { error: leasesErr } = await supabaseAdmin.from("leases").delete().eq("workspace_id", ws.id);
      if (leasesErr) {
        console.error("[cancellation-lifecycle] lease delete failed:", ws.id, leasesErr.message);
        continue;
      }
      // Conditional: a concurrent webhook heal (lifecycle nulled) wins.
      const { error: wsErr } = await supabaseAdmin
        .from("workspaces")
        .delete()
        .eq("id", ws.id)
        .not("soft_deleted_at", "is", null);
      if (wsErr) {
        console.error("[cancellation-lifecycle] workspace delete failed:", ws.id, wsErr.message);
        continue;
      }

      // Storage purge LAST — all four buckets, correct conventions.
      const storagePurged = await purgeWorkspaceStorage(supabaseAdmin, {
        workspaceId: ws.id,
        uploaderPrefixes: Array.from(uploaderPrefixes),
      });

      await supabaseAdmin
        .from("deleted_workspaces")
        .update({ storage_objects_purged: storagePurged })
        .eq("original_workspace_id", ws.id);
      stats.purged++;
    }

    // Self-heal orphans: soft_deleted set but canceled_at cleared (renewal
    // raced an older code path) — restore access immediately.
    const { data: orphans } = await supabaseAdmin
      .from("workspaces")
      .select("id")
      .not("soft_deleted_at", "is", null)
      .is("canceled_at", null)
      .limit(100);
    for (const o of (orphans ?? []) as Array<{ id: string }>) {
      await healRenewed(o.id);
    }

    return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.error("[cancellation-lifecycle] fatal:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Lifecycle run failed", ...stats }), { status: 500, headers: jsonHeaders });
  }
});
