import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

async function sendInviteEmail(opts: {
  resendApiKey: string;
  to: string;
  firstName: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const { resendApiKey, to, firstName, workspaceName, role, inviteUrl } = opts;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  const greetingText = firstName ? `Hi ${firstName},` : 'Hi,';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: Deno.env.get('RESEND_INVITES_FROM_EMAIL') ?? Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <noreply@notifications.theleaseio.com>',
        to: [to],
        subject: `You've been invited to join ${escapeHtml(workspaceName)} on LeaseIO`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>${greeting}</h2>
            <p>You've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on LeaseIO as a <strong>${escapeHtml(role)}</strong>.</p>
            <p>Click the button below to accept your invitation and create your account.</p>
            <p style="margin: 24px 0;">
              <a href="${inviteUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
                Accept Invitation
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This invitation expires in 7 days.</p>
            <p style="color: #666; font-size: 14px;">If you didn't expect this invitation, you can safely ignore this email.</p>
          </div>
        `,
        text: `${greetingText}\n\nYou've been invited to join ${workspaceName} on LeaseIO as a ${role}.\n\nAccept your invitation here: ${inviteUrl}\n\nThis invitation expires in 7 days.`,
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

function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CORS helpers inlined (MCP deploy cannot resolve ../_shared/ imports).
// Strict hostname-suffix match to prevent origins like `lovable.app.evil.com`.
const ALLOWED_ORIGINS = [
  'https://theleaseio.com', 'https://www.theleaseio.com', 'https://app.theleaseio.com',
  'https://theleaseio.lovable.app', 'http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173',
];
const ALLOWED_HOST_SUFFIXES = ['.lovableproject.com', '.lovable.app', '.vercel.app'];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  let isAllowed = false;
  if (requestOrigin) {
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
      isAllowed = true;
    } else {
      try {
        const host = new URL(requestOrigin).hostname;
        isAllowed = ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
      } catch {
        isAllowed = false;
      }
    }
  }
  return {
    'Access-Control-Allow-Origin': isAllowed ? requestOrigin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function okRes(corsHeaders: Record<string, string>, code: string, message: string, data: unknown = {}) {
  return new Response(JSON.stringify({ ok: true, code, message, data }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errRes(corsHeaders: Record<string, string>, code: string, message: string, status = 200) {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) return errRes(corsHeaders, 'DB_ERROR', 'RESEND_API_KEY not set', 500);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errRes(corsHeaders, 'UNAUTHORIZED', 'No authorization header', 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData.user) return errRes(corsHeaders, 'UNAUTHORIZED', 'Invalid token', 401);
    const user = userData.user;

    const body = await req.json();
    const { email: rawEmail, first_name, last_name, role, workspaceId, workspaceName } = body;

    if (!rawEmail || typeof rawEmail !== 'string')
      return errRes(corsHeaders, 'INVALID_REQUEST', 'email is required', 400);
    if (!workspaceId)
      return errRes(corsHeaders, 'INVALID_REQUEST', 'workspaceId required', 400);

    const email = rawEmail.trim().toLowerCase();
    const firstName = (first_name ?? '').trim();
    const lastName  = (last_name  ?? '').trim();

    // Authorize: owner OR admin
    const { data: workspace, error: wsError } = await supabaseAdmin
      .from('workspaces').select('owner_id, name, canceled_at, soft_deleted_at, plan').eq('id', workspaceId).single();
    if (wsError || !workspace) return errRes(corsHeaders, 'NOT_FOUND', 'Workspace not found', 404);

    const isOwner = workspace.owner_id === user.id;
    if (!isOwner) {
      const { data: membership } = await supabaseAdmin
        .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
      if (membership?.role !== 'admin')
        return errRes(corsHeaders, 'UNAUTHORIZED', 'Only workspace owners or admins may send invitations', 403);
    }

    // Vault V1 liveness gate — inlined mirror of _shared/workspace_live.ts
    // (this function cannot resolve ../_shared/ imports; keep semantics in
    // sync). A canceled, soft-deleted, or vault-plan workspace is read-only
    // and must not grow its membership or send invite emails.
    const livenessReason = workspace.soft_deleted_at
      ? 'soft_deleted'
      : workspace.canceled_at
        ? 'canceled'
        : workspace.plan === 'vault'
          ? 'vault'
          : null;
    if (livenessReason) {
      return new Response(JSON.stringify({ ok: false, error: 'subscription_inactive', reason: livenessReason }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const wsName = workspaceName ?? workspace.name ?? 'Workspace';
    // P1-08: build invite URLs from a deploy-time canonical APP_URL,
    // never from the request Origin header. An authenticated workspace
    // owner/admin calling this function outside the browser could
    // otherwise spoof the Origin and send a real LeaseIO-branded
    // invite email whose accept-link points at a hostile domain that
    // captures the token. APP_URL defaults to the production landing
    // domain — accept-invite is served at the root path.
    const appUrl = (Deno.env.get('APP_URL') ?? 'https://theleaseio.com').replace(/\/$/, '');
    const results: Array<{ email: string; ok: boolean; code: string; message: string }> = [];

    try {
      // 1. Already a member?
      const { data: activeMemberByEmail } = await supabaseAdmin
        .from('workspace_members').select('id')
        .eq('workspace_id', workspaceId).eq('invited_email', email)
        .filter('user_id', 'not.is', 'null').maybeSingle();
      if (activeMemberByEmail) {
        results.push({ email, ok: false, code: 'ALREADY_MEMBER', message: 'Already a member' });
      } else {
        // 2. Existing pending invite? → resend
        const { data: existingInvite } = await supabaseAdmin
          .from('invite_tokens').select('id, token, expires_at')
          .eq('workspace_id', workspaceId).eq('email', email).is('accepted_at', null).maybeSingle();

        if (existingInvite) {
          const inviteUrl = `${appUrl}/accept-invite?token=${existingInvite.token}`;
          const sendResult = await sendInviteEmail({ resendApiKey, to: email, firstName, workspaceName: wsName, role, inviteUrl });
          if (!sendResult.sent) {
            results.push({ email, ok: false, code: 'API_ERROR', message: sendResult.error ?? 'Email send failed' });
          } else {
            await supabaseAdmin.from('invite_tokens').update({
              expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              first_name: firstName || null,
              last_name:  lastName  || null,
            }).eq('id', existingInvite.id);
            results.push({ email, ok: true, code: 'INVITE_RESENT', message: 'Invitation resent' });
          }
        } else {
          // 3. User has existing LeaseIO account? → add directly
          const { data: existingProfile } = await supabaseAdmin
            .from('profiles').select('id').eq('email', email).maybeSingle();
          if (existingProfile) {
            const { data: existingMemberById } = await supabaseAdmin
              .from('workspace_members').select('id')
              .eq('workspace_id', workspaceId).eq('user_id', existingProfile.id).maybeSingle();
            if (existingMemberById) {
              results.push({ email, ok: false, code: 'ALREADY_MEMBER', message: 'Already a member' });
            } else {
              const { error: memberError } = await supabaseAdmin.from('workspace_members').insert({
                workspace_id: workspaceId, user_id: existingProfile.id, role,
                invited_email: email, invited_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
              });
              results.push(memberError
                ? { email, ok: false, code: 'DB_ERROR', message: memberError.message }
                : { email, ok: true,  code: 'MEMBER_ADDED', message: 'User added directly' });
            }
          } else {
            // 4. New invite
            const inviteToken = generateInviteToken();
            const inviteUrl   = `${appUrl}/accept-invite?token=${inviteToken}`;
            const sendResult  = await sendInviteEmail({ resendApiKey, to: email, firstName, workspaceName: wsName, role, inviteUrl });
            if (!sendResult.sent) {
              results.push({ email, ok: false, code: 'API_ERROR', message: sendResult.error ?? 'Email send failed' });
            } else {
              const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
              const { error: insertError } = await supabaseAdmin.from('invite_tokens').insert({
                workspace_id: workspaceId, email, role, token: inviteToken, expires_at: expiresAt,
                first_name: firstName || null, last_name: lastName || null,
              });
              results.push(insertError
                ? { email, ok: false, code: 'DB_COMMIT_FAILED_AFTER_SEND', message: 'Email sent but invite record could not be saved' }
                : { email, ok: true,  code: 'INVITE_SENT', message: 'Invitation sent' });
            }
          }
        }
      }
    } catch (innerErr) {
      const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      results.push({ email, ok: false, code: 'DB_ERROR', message: msg });
    }

    const successCount = results.filter((r) => r.ok).length;
    return new Response(JSON.stringify({
      ok: successCount > 0,
      code: successCount > 0 ? 'PARTIAL_SUCCESS' : 'ALL_FAILED',
      message: `${successCount} of 1 invitation processed`,
      data: { results },
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[send-invite] Unhandled error:', msg);
    return new Response(JSON.stringify({ ok: false, code: 'DB_ERROR', message: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
