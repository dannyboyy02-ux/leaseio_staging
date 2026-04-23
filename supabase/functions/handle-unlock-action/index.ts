/**
 * handle-unlock-action
 *
 * Handles GET requests from approve/reject links in the unlock request email.
 * verify_jwt = false (public endpoint, token-based auth).
 *
 * Query params: token (64-char hex), action ('approve' | 'reject')
 *
 * On approve: unlocks lease (model_locked = false), clears unlock fields, emails requester.
 * On reject:  clears unlock fields (stays locked), emails requester.
 * Either way: redirects admin's browser to the lease page.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function htmlPage(title: string, message: string, redirectUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="3;url=${escapeHtml(redirectUrl)}" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: white; border-radius: 8px; padding: 32px 40px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.1); max-width: 420px; }
    h2 { margin: 0 0 12px; }
    p { color: #555; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(message)}</p>
    <p><a href="${escapeHtml(redirectUrl)}">Click here if you are not redirected automatically.</a></p>
  </div>
</body>
</html>`;
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token  = url.searchParams.get('token') ?? '';
    const action = url.searchParams.get('action') ?? '';

    const supabaseUrl            = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey           = Deno.env.get('RESEND_API_KEY') ?? '';
    const appUrl                 = Deno.env.get('APP_URL') ?? 'https://app.theleaseio.com';
    const fromAddress            = Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <noreply@notifications.theleaseio.com>';

    // Validate inputs
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      return new Response(
        htmlPage('Invalid Link', 'This link is invalid or malformed.', appUrl),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    if (action !== 'approve' && action !== 'reject') {
      return new Response(
        htmlPage('Invalid Action', 'The action in this link is not recognized.', appUrl),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // Look up lease by token
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .select('id, name, workspace_id, model_locked, unlock_requested, unlock_requested_by, unlock_requested_at, unlock_action_token, unlock_token_expires_at')
      .eq('unlock_action_token', token)
      .maybeSingle();

    if (leaseError || !lease) {
      return new Response(
        htmlPage('Link Not Found', 'This unlock link is not recognized or has already been used.', appUrl),
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Validate state
    if (!(lease as any).unlock_requested) {
      return new Response(
        htmlPage('Already Resolved', 'This unlock request has already been handled.', `${appUrl}/app/leases/${(lease as any).id}`),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

    if (new Date((lease as any).unlock_token_expires_at) < new Date()) {
      // Clean up expired token
      await supabaseAdmin.from('leases').update({
        unlock_requested: false,
        unlock_requested_by: null,
        unlock_requested_at: null,
        unlock_action_token: null,
        unlock_token_expires_at: null,
      } as any).eq('id', (lease as any).id);

      return new Response(
        htmlPage('Link Expired', 'This unlock request link has expired. The requester will need to submit a new request.', `${appUrl}/app/leases/${(lease as any).id}`),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const leaseId   = (lease as any).id as string;
    const leaseName = (lease as any).name ?? 'Unnamed Lease';
    const leaseUrl  = `${appUrl}/app/leases/${leaseId}`;
    const requesterId = (lease as any).unlock_requested_by as string | null;

    if (action === 'approve') {
      // Unlock the lease, clear all unlock fields
      await supabaseAdmin.from('leases').update({
        model_locked: false,
        unlock_requested: false,
        unlock_requested_by: null,
        unlock_requested_at: null,
        unlock_action_token: null,
        unlock_token_expires_at: null,
      } as any).eq('id', leaseId);

      // Activity log
      await supabaseAdmin.from('lease_approval_actions').insert({
        lease_id: leaseId,
        action: 'unlock_approved',
        notes: 'Admin approved unlock via email link',
      } as any).catch(() => {/* non-critical */});

      // Email the requester
      if (resendApiKey && requesterId) {
        const { data: requesterProfile } = await supabaseAdmin
          .from('profiles').select('email, first_name').eq('id', requesterId).single();
        if (requesterProfile?.email) {
          const firstName = requesterProfile.first_name ? `, ${requesterProfile.first_name}` : '';
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: fromAddress,
              to: [requesterProfile.email],
              subject: `Your unlock request for "${leaseName}" was approved`,
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Unlock Request Approved</h2>
                  <p>Hi${escapeHtml(firstName)},</p>
                  <p>Your request to unlock <strong>${escapeHtml(leaseName)}</strong> has been <strong style="color: #16a34a;">approved</strong>. The lease is now available for editing.</p>
                  <p style="margin: 24px 0;">
                    <a href="${leaseUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">
                      Open Lease
                    </a>
                  </p>
                </div>
              `,
              text: `Your unlock request for "${leaseName}" was approved. The lease is now available for editing.\n\n${leaseUrl}`,
            }),
          }).catch((err) => console.error('[handle-unlock-action] approve email error:', err));
        }
      }

      return new Response(
        htmlPage('Unlock Approved', `The lease "${leaseName}" has been unlocked for editing. The requester has been notified.`, leaseUrl),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );

    } else {
      // reject — clear unlock fields, leave model_locked = true
      await supabaseAdmin.from('leases').update({
        unlock_requested: false,
        unlock_requested_by: null,
        unlock_requested_at: null,
        unlock_action_token: null,
        unlock_token_expires_at: null,
      } as any).eq('id', leaseId);

      // Activity log
      await supabaseAdmin.from('lease_approval_actions').insert({
        lease_id: leaseId,
        action: 'unlock_rejected',
        notes: 'Admin rejected unlock via email link',
      } as any).catch(() => {/* non-critical */});

      // Email the requester
      if (resendApiKey && requesterId) {
        const { data: requesterProfile } = await supabaseAdmin
          .from('profiles').select('email, first_name').eq('id', requesterId).single();
        if (requesterProfile?.email) {
          const firstName = requesterProfile.first_name ? `, ${requesterProfile.first_name}` : '';
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: fromAddress,
              to: [requesterProfile.email],
              subject: `Your unlock request for "${leaseName}" was not approved`,
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Unlock Request Not Approved</h2>
                  <p>Hi${escapeHtml(firstName)},</p>
                  <p>Your request to unlock <strong>${escapeHtml(leaseName)}</strong> was <strong style="color: #dc2626;">not approved</strong>. The lease remains locked. Please contact your workspace administrator if you need to discuss further.</p>
                  <p style="margin: 24px 0;">
                    <a href="${leaseUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">
                      View Lease
                    </a>
                  </p>
                </div>
              `,
              text: `Your unlock request for "${leaseName}" was not approved. The lease remains locked.\n\n${leaseUrl}`,
            }),
          }).catch((err) => console.error('[handle-unlock-action] reject email error:', err));
        }
      }

      return new Response(
        htmlPage('Request Rejected', `The unlock request for "${leaseName}" has been denied. The lease remains locked. The requester has been notified.`, leaseUrl),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[handle-unlock-action] Error:', msg);
    const appUrl = Deno.env.get('APP_URL') ?? 'https://app.theleaseio.com';
    return new Response(
      htmlPage('Error', 'An unexpected error occurred. Please try again or contact support.', appUrl),
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    );
  }
});
