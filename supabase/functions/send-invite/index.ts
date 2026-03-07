import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { sendInviteEmail, generateInviteToken } from "../_shared/resend.ts";

const ALLOWED_ORIGINS = [
  'https://theleaseio.com',
  'https://www.theleaseio.com',
  'https://app.theleaseio.com',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isAllowed =
    requestOrigin &&
    (ALLOWED_ORIGINS.includes(requestOrigin) ||
      requestOrigin.includes('lovableproject.com') ||
      requestOrigin.includes('lovable.app'));
  const origin = isAllowed ? requestOrigin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function okRes(corsHeaders: Record<string, string>, code: string, message: string, data: unknown = {}) {
  return new Response(JSON.stringify({ ok: true, code, message, data }), {
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

    const { emails, role, workspaceId, workspaceName } = await req.json();

    if (!Array.isArray(emails) || emails.length === 0)
      return errRes(corsHeaders, 'INVALID_REQUEST', 'At least one email required', 400);
    if (!workspaceId)
      return errRes(corsHeaders, 'INVALID_REQUEST', 'workspaceId required', 400);

    // --- Authorize: owner OR admin ---
    const { data: workspace, error: wsError } = await supabaseAdmin
      .from('workspaces')
      .select('owner_id, name')
      .eq('id', workspaceId)
      .single();
    if (wsError || !workspace) return errRes(corsHeaders, 'NOT_FOUND', 'Workspace not found', 404);

    const isOwner = workspace.owner_id === user.id;
    if (!isOwner) {
      const { data: membership } = await supabaseAdmin
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (membership?.role !== 'admin') {
        return errRes(corsHeaders, 'UNAUTHORIZED', 'Only workspace owners or admins may send invitations', 403);
      }
    }

    const wsName = workspaceName ?? workspace.name ?? 'Workspace';
    const origin = req.headers.get('origin') || 'https://theleaseio.com';

    const results: Array<{ email: string; ok: boolean; code: string; message: string }> = [];

    for (const rawEmail of emails) {
      const email = String(rawEmail).trim().toLowerCase();

      try {
        // 1. Fast-path: check for active membership by invited_email.
        //    Catches the common case where a known email was previously invited.
        //    Uses .filter() — safe PostgREST not.is serialization.
        const { data: activeMemberByEmail } = await supabaseAdmin
          .from('workspace_members')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('invited_email', email)
          .filter('user_id', 'not.is', 'null')
          .maybeSingle();

        if (activeMemberByEmail) {
          results.push({ email, ok: false, code: 'ALREADY_MEMBER', message: 'Already a member' });
          continue;
        }

        // 2. Check for existing pending invite in invite_tokens
        const { data: existingInvite } = await supabaseAdmin
          .from('invite_tokens')
          .select('id, token, expires_at')
          .eq('workspace_id', workspaceId)
          .eq('email', email)
          .is('accepted_at', null)
          .maybeSingle();

        if (existingInvite) {
          // RESEND path — email FIRST, update DB only after confirmed send
          const inviteUrl = `${origin}/accept-invite?token=${existingInvite.token}`;
          const sendResult = await sendInviteEmail({ resendApiKey, to: email, workspaceName: wsName, role, inviteUrl });
          if (!sendResult.sent) {
            results.push({ email, ok: false, code: 'API_ERROR', message: sendResult.error ?? 'Email send failed' });
            continue;
          }
          // Email confirmed — now extend expiry
          await supabaseAdmin
            .from('invite_tokens')
            .update({ expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
            .eq('id', existingInvite.id);
          results.push({ email, ok: true, code: 'INVITE_RESENT', message: 'Invitation resent' });
          continue;
        }

        // 3. Check if user already has a profile (existing LeaseIO account)
        const { data: existingProfile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('email', email)
          .maybeSingle();

        if (existingProfile) {
          // Guard: check for existing membership by user_id — more reliable than invited_email,
          // which may be null, stale, or absent for members added via other paths.
          const { data: existingMemberById } = await supabaseAdmin
            .from('workspace_members')
            .select('id')
            .eq('workspace_id', workspaceId)
            .eq('user_id', existingProfile.id)
            .maybeSingle();

          if (existingMemberById) {
            results.push({ email, ok: false, code: 'ALREADY_MEMBER', message: 'Already a member' });
            continue;
          }

          // Add directly as member — no email needed
          const { error: memberError } = await supabaseAdmin
            .from('workspace_members')
            .insert({
              workspace_id: workspaceId,
              user_id: existingProfile.id,
              role,
              invited_email: email,
              invited_at: new Date().toISOString(),
              accepted_at: new Date().toISOString(),
            });

          if (memberError) {
            results.push({ email, ok: false, code: 'DB_ERROR', message: memberError.message });
          } else {
            results.push({ email, ok: true, code: 'MEMBER_ADDED', message: 'User added directly' });
          }
          continue;
        }

        // 4. NEW INVITE path — generate token in app code, send email FIRST, write DB after
        const inviteToken = generateInviteToken();
        const inviteUrl = `${origin}/accept-invite?token=${inviteToken}`;

        const sendResult = await sendInviteEmail({ resendApiKey, to: email, workspaceName: wsName, role, inviteUrl });
        if (!sendResult.sent) {
          results.push({ email, ok: false, code: 'API_ERROR', message: sendResult.error ?? 'Email send failed' });
          continue;
        }

        // Email confirmed — now write the DB row
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const { error: insertError } = await supabaseAdmin
          .from('invite_tokens')
          .insert({ workspace_id: workspaceId, email, role, token: inviteToken, expires_at: expiresAt });

        if (insertError) {
          console.error('[send-invite] DB insert failed after confirmed send:', insertError);
          results.push({
            email,
            ok: false,
            code: 'DB_COMMIT_FAILED_AFTER_SEND',
            message: 'Email sent but invite record could not be saved',
          });
          continue;
        }

        results.push({ email, ok: true, code: 'INVITE_SENT', message: 'Invitation sent' });

      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        console.error(`[send-invite] Error processing ${email}:`, msg);
        results.push({ email, ok: false, code: 'DB_ERROR', message: msg });
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    return new Response(
      JSON.stringify({
        ok: successCount > 0,
        code: successCount > 0 ? 'PARTIAL_SUCCESS' : 'ALL_FAILED',
        message: `${successCount} of ${emails.length} invitations processed`,
        data: { results },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[send-invite] Unhandled error:', msg);
    return new Response(JSON.stringify({ ok: false, code: 'DB_ERROR', message: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
