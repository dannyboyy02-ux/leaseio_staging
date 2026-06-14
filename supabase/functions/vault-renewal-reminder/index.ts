// Vault renewal reminder (VAULT_TIER_SPEC.md V4 — no-surprise-billing rule).
//
// Daily cron. Emails the OWNER of each Vault workspace ~14 days before the
// annual $249 subscription renews, so the charge is never a surprise. A failed
// renewal is NOT handled here — it flows through normal Stripe dunning into the
// existing cancellation lifecycle (process-cancellation-lifecycle).
//
// Idempotency: the public.vault_renewal_reminders ledger (UNIQUE
// workspace_id+period_end) is claimed BEFORE sending, mirroring the
// cancellation cron's cancellation_notices gate — so a daily run inside the
// 14-day window sends exactly once per renewal period.
//
// Zero-AI-spend invariant: this function calls Resend + Supabase only; no
// Anthropic. Auth is the shared x-cron-secret pattern (verify_jwt=false).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const jsonHeaders = { "Content-Type": "application/json" };

// Send when the renewal is this many days out or nearer (and still in the
// future). The ledger prevents repeats, so a wide window just means "remind
// once, as soon as we're within 14 days."
const REMINDER_WINDOW_DAYS = 14;
const MAX_EMAILS_PER_RUN = 200;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }

  const cronSecret = Deno.env.get("VAULT_RENEWAL_CRON_SECRET");
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
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 86_400_000);
  const stats = { candidates: 0, sent: 0, skipped: 0, emailFailures: 0 };
  let emailBudget = MAX_EMAILS_PER_RUN;

  // Vault workspaces whose ACTIVE subscription renews within the window.
  const { data: workspaces, error: wsErr } = await supabaseAdmin
    .from("workspaces")
    .select("id, name, owner_id, subscription_period_end")
    .eq("plan", "vault")
    .eq("subscription_status", "active")
    .not("subscription_period_end", "is", null)
    .gte("subscription_period_end", now.toISOString())
    .lte("subscription_period_end", windowEnd.toISOString());

  if (wsErr) {
    console.error("[vault-renewal-reminder] workspace fetch failed:", wsErr.message);
    return new Response(JSON.stringify({ error: "workspace fetch failed" }), { status: 500, headers: jsonHeaders });
  }

  for (const ws of (workspaces ?? []) as Array<{ id: string; name: string; owner_id: string; subscription_period_end: string }>) {
    stats.candidates++;
    if (emailBudget <= 0) {
      console.warn("[vault-renewal-reminder] email budget exhausted; deferring to next run");
      break;
    }

    // Owner email (Vault is owner-only — only the owner is billed/can react).
    const { data: ownerProfile } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", ws.owner_id)
      .maybeSingle();
    const ownerEmail = (ownerProfile as { email: string | null } | null)?.email ?? null;
    if (!ownerEmail) {
      // No address yet — don't claim the ledger row, so a later run can send.
      console.warn("[vault-renewal-reminder] no owner email for", ws.id);
      continue;
    }

    // Claim the idempotency row FIRST (UNIQUE workspace_id+period_end). A
    // concurrent/retried run that already claimed it conflicts and we skip.
    const { error: ledgerErr } = await supabaseAdmin
      .from("vault_renewal_reminders")
      .insert({
        workspace_id: ws.id,
        period_end: ws.subscription_period_end,
        recipients: [ownerEmail],
      });
    if (ledgerErr) {
      if (!/duplicate|unique/i.test(ledgerErr.message)) {
        console.error("[vault-renewal-reminder] ledger insert failed:", ws.id, ledgerErr.message);
      } else {
        stats.skipped++;
      }
      continue;
    }

    if (!resendApiKey) {
      console.error("[vault-renewal-reminder] RESEND_API_KEY not set — reminder skipped:", ws.id);
      stats.emailFailures++;
      continue;
    }

    const wsName = ws.name ?? "your workspace";
    const renewDate = new Date(ws.subscription_period_end).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const billingUrl = `${appUrl}/app/settings/account?tab=billing`;
    // Subject is a plain-text header — escapeHtml would render entities
    // literally (e.g. "Tom&#39;s Leases"). HTML escaping is only for the body.
    const subject = `Your LeaseIO Vault for "${wsName}" renews on ${renewDate}`;
    const html = `<p>Your <strong>Vault</strong> retention plan for <strong>${escapeHtml(wsName)}</strong> renews on <strong>${renewDate}</strong> at <strong>$249/year</strong>.</p>
<p>No action is needed — your read-only repository stays available and fully exportable. We're sending this so the renewal is never a surprise.</p>
<p>Want a full plan back instead? You can <a href="${billingUrl}">reactivate Starter or Business</a> any time to resume editing and AI features. To stop the renewal, manage your subscription from the same billing page.</p>
<p style="color:#6b7280;font-size:12px">You're receiving this because you're the owner of the LeaseIO workspace "${escapeHtml(wsName)}".</p>`;

    emailBudget--;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
        body: JSON.stringify({
          from: Deno.env.get("RESEND_FROM_EMAIL") ?? "LeaseIO <noreply@notifications.theleaseio.com>",
          to: ownerEmail,
          subject,
          html,
        }),
      });
      if (res.ok) {
        stats.sent++;
      } else {
        stats.emailFailures++;
        console.error("[vault-renewal-reminder] resend error:", res.status, await res.text());
        // The claim-first ledger row prevents double-sends, but a failed send
        // would otherwise leave the row claimed forever → the owner never gets
        // the no-surprise reminder. Release the claim so a later run retries.
        // (Trade-off: a transient failure on an actually-delivered email could
        // re-send next run — a duplicate courtesy email, far less bad than a
        // silently-missed billing warning.)
        await releaseLedgerClaim(supabaseAdmin, ws.id, ws.subscription_period_end);
      }
    } catch (err) {
      stats.emailFailures++;
      console.error("[vault-renewal-reminder] resend fetch error:", (err as Error)?.message);
      await releaseLedgerClaim(supabaseAdmin, ws.id, ws.subscription_period_end);
    }
  }

  return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers: jsonHeaders });
});

// Release a claimed idempotency row after a failed send so a later run can
// retry. Best-effort — a failure here just means the reminder waits for a
// future run that finds the row still present.
// deno-lint-ignore no-explicit-any
async function releaseLedgerClaim(supabaseAdmin: any, workspaceId: string, periodEnd: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("vault_renewal_reminders")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("period_end", periodEnd);
  if (error) {
    console.error("[vault-renewal-reminder] ledger release failed:", workspaceId, error.message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
