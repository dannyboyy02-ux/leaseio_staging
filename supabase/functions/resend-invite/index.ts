import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
// --- Inlined helpers (no ../_shared/ import — MCP deploy cannot resolve relative paths) ---

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

async function sendInviteEmail(opts: {
  resendApiKey: string;
  to: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const { resendApiKey, to, workspaceName, role, inviteUrl } = opts;
  try {
    console.log('[resend] send-attempt', { to, hasInviteUrl: !!inviteUrl && inviteUrl.length > 0 });
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
        text: `You've been invited to join ${workspaceName} on LeaseIO as a ${role}.\n\nAccept your invitation here: ${inviteUrl}\n\nThis invitation expires in 7 days.`,
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

// CORS helpers inlined (MCP deploy cannot resolve ../_shared/ imports).
// Strict hostname-suffix match to prevent origins like `lovable.app.evil.com`.
const ALLOWED_ORIGINS = [
  'https://theleaseio.com',
  'https://www.theleaseio.com',
  'https://app.theleaseio.com',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
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

function okRes(corsHeaders: Record<string, string>, code: string, message: string) {
  return new Response(JSON.stringify({ ok: true, code, message }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errRes(corsHeaders: Record<string, string>, code: string, message: string, status = 200) {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      return errRes(corsHeaders, 'DB_ERROR', 'RESEND_API_KEY not set', 500);
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    );

    // --- Authenticate caller ---
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errRes(corsHeaders, 'UNAUTHORIZED', 'No authorization header', 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData.user) return errRes(corsHeaders, 'UNAUTHORIZED', 'Invalid token', 401);
    const user = userData.user;

    const { id: inviteId } = await req.json();

    if (!inviteId) return errRes(corsHeaders, 'INVALID_REQUEST', 'id required', 400);

    // --- Fetch invite by id (derive workspace_id from row — never trust client) ---
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('invite_tokens')
      .select('id, workspace_id, email, role, token, expires_at, accepted_at')
      .eq('id', inviteId)
      .maybeSingle();

    if (inviteError || !invite) {
      return errRes(corsHeaders, 'NOT_FOUND', 'Invitation not found', 404);
    }

    if (invite.accepted_at !== null) {
      return errRes(corsHeaders, 'ALREADY_ACCEPTED', 'Invitation has already been accepted', 409);
    }

    // --- Authorize: owner OR admin (workspace_id derived from invite row) ---
    const { data: workspace, error: wsError } = await supabaseAdmin
      .from('workspaces')
      .select('owner_id, name, canceled_at, soft_deleted_at, plan')
      .eq('id', invite.workspace_id)
      .single();

    if (wsError || !workspace) return errRes(corsHeaders, 'NOT_FOUND', 'Workspace not found', 404);

    const isOwner = workspace.owner_id === user.id;
    console.log('[resend-invite] auth-check', { userId: user.id, ownerId: workspace.owner_id, isOwner });
    if (!isOwner) {
      const { data: membership } = await supabaseAdmin
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', invite.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle();
      console.log('[resend-invite] membership-check', { role: membership?.role ?? 'none' });
      if (membership?.role !== 'admin') {
        return errRes(corsHeaders, 'UNAUTHORIZED', 'Only workspace owners or admins may resend invitations', 403);
      }
    }

    // Vault V1 liveness gate — inlined mirror of _shared/workspace_live.ts
    // (this function cannot resolve ../_shared/ imports; keep semantics in
    // sync). A canceled, soft-deleted, or vault-plan workspace is read-only
    // and must not extend invites or send invite emails.
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

    // --- Build invite URL using existing token — no new token generated ---
    // P1-08: APP_URL is a deploy-time canonical, not request Origin.
    // See send-invite/index.ts for the rationale.
    const appUrl = (Deno.env.get('APP_URL') ?? 'https://theleaseio.com').replace(/\/$/, '');
    const inviteUrl = `${appUrl}/accept-invite?token=${invite.token}`;

    // --- SEND EMAIL FIRST ---
    const sendResult = await sendInviteEmail({
      resendApiKey,
      to: invite.email,
      workspaceName: workspace.name ?? 'Workspace',
      role: invite.role,
      inviteUrl,
    });

    if (!sendResult.sent) {
      return errRes(corsHeaders, 'API_ERROR', sendResult.error ?? 'Email send failed');
    }

    // --- Email confirmed — now extend expiry ---
    await supabaseAdmin
      .from('invite_tokens')
      .update({ expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
      .eq('id', invite.id);

    return okRes(corsHeaders, 'INVITE_RESENT', 'Invitation resent');

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[resend-invite] Unhandled error:', msg);
    return new Response(JSON.stringify({ ok: false, code: 'DB_ERROR', message: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
