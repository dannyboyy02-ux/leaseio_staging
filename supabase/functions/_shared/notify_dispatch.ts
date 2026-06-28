// ============================================================================
// Approval-notification dispatcher (KNOWN_ISSUES #109).
// ----------------------------------------------------------------------------
// The approval workflow writes `lease_activity_log` rows with
// activity_type='comment' + details.{notification_type, recipient_ids, message}.
// Historically NOTHING delivered them. dispatchNotificationRow() delivers one
// such row by EMAIL to each recipient exactly once — idempotent via the
// notification_deliveries table (a SENT row is never re-sent; a FAILED row is
// retried + upserted, so a vendor failure is queryable per hard rule #9).
//
// Used by: dispatch-notifications (cron, sweeps recent rows) + send-nudge
// (dispatches its own row immediately for instant feedback).
// ============================================================================
import { escapeHtml, sendEmail } from "./resend.ts";
import { checkWorkspaceLive } from "./workspace_live.ts";

const APP_URL = "https://app.theleaseio.com";

export interface NotificationRow {
  id: string; // lease_activity_log.id
  lease_id: string;
  details: {
    notification_type?: string;
    recipient_ids?: string[];
    message?: string;
  } | null;
}

export interface DispatchResult { sent: number; failed: number; skipped: number }

// notification_type → subject + heading. Approver-facing types prompt action;
// submitter-facing types report an outcome; unknown 'notify_*' fall back to a
// generic approval prompt.
function copyForType(type: string | undefined): { subject: string; heading: string } {
  switch (type) {
    case "approver_nudge":
      return { subject: "Reminder: a lease is awaiting your approval", heading: "A lease is awaiting your approval" };
    case "notify_manager_approver":
    case "notify_financial_approver":
    case "notify_chain_step_users":
    case "concept_re_review_required":
      return { subject: "Action needed: a lease is awaiting your approval", heading: "A lease needs your approval" };
    case "notify_submitter_approved":
      return { subject: "Your lease was approved", heading: "Your lease was approved" };
    case "notify_submitter_returned":
      return { subject: "Your lease was returned for revision", heading: "Your lease was returned for revision" };
    case "notify_submitter_rejected":
      return { subject: "Your lease request was rejected", heading: "Your lease request was rejected" };
    case "notify_change_set_rejected":
      return { subject: "Your proposed lease changes were declined", heading: "Your proposed changes were declined" };

    // Counter-signature chase
    case "counter_signature_reminder":
      return { subject: "Reminder: a lease is awaiting counter-signature", heading: "A lease is awaiting counter-signature" };
    case "counter_signature_received":
      return { subject: "A lease was counter-signed", heading: "A lease was counter-signed" };

    // Final review / signator
    case "signator_review_required":
      return { subject: "Action needed: a lease is ready for final signature", heading: "A lease is ready for your final review" };

    // Execution owner
    case "execution_owner_assigned":
    case "execution_owner_reassigned":
      return { subject: "You're the execution owner for a lease", heading: "You've been assigned to execute a lease" };

    // An approval was routed TO you (delegation / OOO / reassignment / policy timeout) — action needed
    case "voluntary_delegation_received":
    case "ooo_delegated_steps":
    case "admin_reassignment_received":
    case "deactivated_approver_reassigned":
    case "admin_override_notice":
    case "policy_delegate_activated":
      return { subject: "Action needed: an approval was assigned to you", heading: "An approval was assigned to you" };

    // Delegation status (informational)
    case "voluntary_delegation_revoked":
      return { subject: "A delegated approval was returned to you", heading: "A delegated approval was returned to you" };
    case "voluntary_delegation_chain_notified":
      return { subject: "A lease approval was delegated", heading: "A lease approval was delegated" };

    // Admin / governance alerts
    case "stuck_chain_detected":
      return { subject: "A lease approval is stuck", heading: "A lease approval is stuck" };
    case "policy_assignee_validation_failed":
      return { subject: "A lease approval needs attention", heading: "A lease approval needs attention" };

    default:
      if (type && type.startsWith("notify_")) {
        return { subject: "A lease is awaiting your approval", heading: "A lease needs your approval" };
      }
      return { subject: "Lease update — LeaseIO", heading: "Lease update" };
  }
}

function emailHtml(heading: string, message: string, leaseName: string, leaseLink: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9fafb; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <h2 style="color: #2563eb; margin-top: 0;">${escapeHtml(heading)}</h2>
        <p><strong>Lease:</strong> ${escapeHtml(leaseName)}</p>
        <p>${escapeHtml(message)}</p>
        <p style="margin: 24px 0;">
          <a href="${leaseLink}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Open in LeaseIO</a>
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #6b7280; font-size: 14px;">You received this because you're part of this lease's approval workflow in LeaseIO.</p>
      </div>
    </div>
  `;
}

/**
 * Deliver one notification row to each recipient by email, exactly once.
 * Non-throwing: per-recipient failures are recorded (status='failed') and
 * counted, never thrown. Skips non-live workspaces (Vault V1 parity).
 */
export async function dispatchNotificationRow(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  resendApiKey: string,
  row: NotificationRow,
): Promise<DispatchResult> {
  const out: DispatchResult = { sent: 0, failed: 0, skipped: 0 };
  const details = row.details ?? {};
  const recipientIds = Array.isArray(details.recipient_ids)
    ? Array.from(new Set(details.recipient_ids.filter((x): x is string => Boolean(x))))
    : [];
  if (recipientIds.length === 0) return out;

  const { data: lease } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, request_title, filename, extracted_json")
    .eq("id", row.lease_id)
    .maybeSingle();
  if (!lease) return out;

  // Vault V1: never email on behalf of a canceled / soft-deleted / vault workspace.
  const liveness = await checkWorkspaceLive(supabaseAdmin, lease.workspace_id);
  if (!liveness.live) return out;

  const extracted = (lease.extracted_json ?? {}) as { property_address?: string };
  const leaseName = lease.request_title || extracted.property_address || lease.filename || "a lease";
  const { subject, heading } = copyForType(details.notification_type);
  const message = typeof details.message === "string" && details.message.length > 0
    ? details.message
    : `${leaseName} needs your attention in LeaseIO.`;
  const leaseLink = `${APP_URL}/app/leases/${lease.id}`;
  const html = emailHtml(heading, message, leaseName, leaseLink);

  for (const userId of recipientIds) {
    // Idempotency: a prior SENT row means already delivered — skip.
    const { data: existing } = await supabaseAdmin
      .from("notification_deliveries")
      .select("status")
      .eq("activity_log_id", row.id)
      .eq("recipient_user_id", userId)
      .eq("channel", "email")
      .maybeSingle();
    if ((existing as { status?: string } | null)?.status === "sent") { out.skipped++; continue; }

    const { data: profile } = await supabaseAdmin
      .from("profiles").select("email").eq("id", userId).maybeSingle();
    const email = (profile as { email?: string } | null)?.email;

    let status = "failed";
    let error: string | null = null;
    if (!email) {
      error = "no_email";
    } else {
      const r = await sendEmail({ resendApiKey, to: email, subject: `${subject} — ${leaseName}`, html });
      status = r.sent ? "sent" : "failed";
      error = r.error ?? null;
    }

    await supabaseAdmin.from("notification_deliveries").upsert({
      activity_log_id: row.id,
      lease_id: lease.id,
      recipient_user_id: userId,
      channel: "email",
      status,
      error,
      updated_at: new Date().toISOString(),
    }, { onConflict: "activity_log_id,recipient_user_id,channel" });

    if (status === "sent") out.sent++; else out.failed++;
  }
  return out;
}
