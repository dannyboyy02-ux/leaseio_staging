/**
 * Shared Resend email helper.
 * Single source of truth for all invite email sending.
 * Never throws — returns { sent, error } so callers decide how to surface failures.
 */

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

export interface SendInviteEmailOpts {
  resendApiKey: string;
  to: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

export async function sendInviteEmail(opts: SendInviteEmailOpts): Promise<SendResult> {
  const { resendApiKey, to, workspaceName, role, inviteUrl } = opts;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <notifications@theleaseio.com>',
        to: [to],
        subject: `You've been invited to join ${escapeHtml(workspaceName)} on LeaseIO`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>You've been invited to join a workspace</h2>
            <p>You've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on LeaseIO as a ${escapeHtml(role)}.</p>
            <p style="margin: 24px 0;">
              <a href="${inviteUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
                Accept Invitation
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This invitation expires in 7 days.</p>
            <p style="color: #666; font-size: 14px;">If you didn't expect this invitation, you can ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      console.error('[resend] API error:', res.status, body);
      return { sent: false, error: `Resend returned ${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[resend] fetch error:', msg);
    return { sent: false, error: msg };
  }
}

/** Generate a cryptographically random 64-char hex token (matches DB DEFAULT format). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
