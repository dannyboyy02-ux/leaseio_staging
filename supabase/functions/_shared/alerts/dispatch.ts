// Alert dispatch helper — used by vendor-health-check (Operational
// Monitoring) and any other internal alert producers. Sends operator
// alerts via the existing Resend transactional rail.
//
// Email rendering is intentionally text-heavy and ugly-but-readable
// per OPERATIONAL_MONITORING_SPEC.md "Notes for Claude Code" — this
// is operator email, not customer email.

const RESEND_API = 'https://api.resend.com/emails';

export interface AlertEmailInput {
  recipients: string[];
  subject: string;
  body_text: string;
}

export async function dispatchAlertEmail(
  input: AlertEmailInput,
  opts: { resendApiKey: string; fromEmail?: string },
): Promise<{ ok: boolean; error?: string; resendId?: string }> {
  if (input.recipients.length === 0) return { ok: true }; // no-op

  const fromEmail = opts.fromEmail
    ?? Deno.env.get('RESEND_ALERTS_FROM_EMAIL')
    ?? Deno.env.get('RESEND_FROM_EMAIL')
    ?? 'LeaseIO Ops <ops@notifications.theleaseio.com>';

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: input.recipients,
        subject: input.subject,
        text: input.body_text,
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[alerts] Resend ${res.status}:`, errorText.slice(0, 200));
      return { ok: false, error: `Resend ${res.status}` };
    }
    const data = await res.json() as { id?: string };
    return { ok: true, resendId: data.id };
  } catch (err) {
    console.error('[alerts] dispatch threw:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ThresholdAlertContext {
  vendor: string;
  metric: string;
  threshold: 'warn' | 'alert' | 'critical';
  current_value: number;
  limit_value: number | null;
  pct_of_limit: number | null;
  tier: string;
  upgrade_suggestion?: string;
  upgrade_url?: string;
  ops_dashboard_url?: string;
}

export function renderThresholdEmail(ctx: ThresholdAlertContext): { subject: string; body_text: string } {
  const pctStr = ctx.pct_of_limit !== null ? `${Math.round(ctx.pct_of_limit)}%` : 'unknown';
  const subject = `[LeaseIO Ops] ${ctx.vendor} ${ctx.metric} at ${pctStr} of ${ctx.tier} limit`;
  const lines = [
    `Vendor:    ${ctx.vendor}`,
    `Metric:    ${ctx.metric}`,
    `Tier:      ${ctx.tier}`,
    `Threshold: ${ctx.threshold} crossed`,
    `Current:   ${ctx.current_value}`,
    `Limit:     ${ctx.limit_value ?? '(no hard limit)'}`,
    `Percent:   ${pctStr}`,
    '',
    ctx.upgrade_suggestion ?? '(no upgrade suggestion provided)',
  ];
  if (ctx.upgrade_url) lines.push('', `Action: ${ctx.upgrade_url}`);
  if (ctx.ops_dashboard_url) lines.push('', `Ops dashboard: ${ctx.ops_dashboard_url}`);
  return { subject, body_text: lines.join('\n') };
}

export interface RenewalAlertContext {
  vendor: string;
  item: string;
  renewal_date: string;
  days_remaining: number;
  amount_estimate: number | null;
  auto_renew: boolean;
  account_url?: string;
  notes?: string;
}

export function renderRenewalEmail(ctx: RenewalAlertContext): { subject: string; body_text: string } {
  const subject = `[LeaseIO Ops] ${ctx.item} renews in ${ctx.days_remaining} day${ctx.days_remaining === 1 ? '' : 's'} (${ctx.renewal_date})`;
  const lines = [
    `Vendor:        ${ctx.vendor}`,
    `Item:          ${ctx.item}`,
    `Renewal date:  ${ctx.renewal_date} (${ctx.days_remaining} days)`,
    `Amount est:    ${ctx.amount_estimate !== null ? `$${ctx.amount_estimate}` : '(unknown)'}`,
    `Auto-renew:    ${ctx.auto_renew ? 'ON' : 'OFF — manual action required'}`,
  ];
  if (ctx.account_url) lines.push('', `Manage: ${ctx.account_url}`);
  if (ctx.notes) lines.push('', `Notes: ${ctx.notes}`);
  return { subject, body_text: lines.join('\n') };
}
