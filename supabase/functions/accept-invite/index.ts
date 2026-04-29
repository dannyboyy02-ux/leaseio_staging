import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

function isValidTokenFormat(token: string): boolean {
  return /^[a-f0-9]{64}$/i.test(token);
}

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl            = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey        = Deno.env.get('SUPABASE_ANON_KEY')!;

    if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
      throw new Error('Missing required environment variables');
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const body = await req.json();
    const { token: inviteToken, password } = body;

    if (!inviteToken || typeof inviteToken !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Invitation token is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!isValidTokenFormat(inviteToken)) {
      return new Response(
        JSON.stringify({ error: 'Invalid token format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── NEW USER PATH: password provided, no auth required ────────────────
    if (password && typeof password === 'string') {
      if (!isStrongPassword(password)) {
        return new Response(
          JSON.stringify({ ok: false, code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters and contain uppercase, lowercase, and a number.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Fetch and validate invite
      const { data: invite, error: inviteError } = await supabaseAdmin
        .from('invite_tokens').select('*').eq('token', inviteToken).maybeSingle();

      if (inviteError || !invite) {
        return new Response(
          JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Invitation not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (invite.accepted_at !== null) {
        return new Response(
          JSON.stringify({ ok: false, code: 'ALREADY_ACCEPTED', message: 'Invitation has already been used' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (new Date(invite.expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ ok: false, code: 'EXPIRED_INVITE', message: 'Invitation has expired' }),
          { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Guard: email must not already have an account (prevent account takeover)
      const { data: { users: existingUsers } } = await supabaseAdmin.auth.admin.listUsers();
      const alreadyExists = existingUsers.some(
        (u) => u.email?.toLowerCase() === invite.email.toLowerCase()
      );
      if (alreadyExists) {
        return new Response(
          JSON.stringify({ ok: false, code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please log in instead.' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Fetch workspace
      const { data: workspace } = await supabaseAdmin
        .from('workspaces').select('id, name').eq('id', invite.workspace_id).single();
      if (!workspace) {
        return new Response(
          JSON.stringify({ error: 'Workspace no longer exists' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Create confirmed user via admin API (no confirmation email sent)
      const { data: newUserData, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,
        user_metadata: {
          first_name: invite.first_name ?? '',
          last_name:  invite.last_name  ?? '',
        },
      });

      if (createError || !newUserData.user) {
        console.error('[accept-invite] createUser error:', createError?.message);
        return new Response(
          JSON.stringify({ ok: false, code: 'CREATE_FAILED', message: createError?.message ?? 'Failed to create account' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const newUser = newUserData.user;

      // Create profile
      await supabaseAdmin.from('profiles').insert({
        id:                   newUser.id,
        email:                invite.email,
        first_name:           invite.first_name ?? null,
        last_name:            invite.last_name  ?? null,
        current_workspace_id: invite.workspace_id,
      });

      // Add to workspace_members
      const { error: memberError } = await supabaseAdmin.from('workspace_members').insert({
        workspace_id:  invite.workspace_id,
        user_id:       newUser.id,
        role:          invite.role,
        invited_email: invite.email,
        invited_at:    invite.created_at,
        accepted_at:   new Date().toISOString(),
      });

      if (memberError) {
        console.error('[accept-invite] workspace_members insert error:', memberError.message);
        return new Response(
          JSON.stringify({ error: 'Failed to join workspace' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Mark invite accepted
      await supabaseAdmin.from('invite_tokens')
        .update({ accepted_at: new Date().toISOString() }).eq('id', invite.id);

      console.log(`[accept-invite] New user ${newUser.id} created and joined workspace ${invite.workspace_id}`);

      return new Response(
        JSON.stringify({ ok: true, code: 'JOINED', message: 'Account created and workspace joined', workspaceId: invite.workspace_id, workspaceName: workspace.name, email: invite.email }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── EXISTING USER PATH: requires Bearer token ─────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: claimsData, error: claimsError } = await supabaseAdmin.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid authentication' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const user      = claimsData.user;
    const userEmail = user.email?.toLowerCase();
    if (!userEmail) {
      return new Response(
        JSON.stringify({ error: 'User email not found' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('invite_tokens').select('*').eq('token', inviteToken).maybeSingle();

    if (inviteError || !invite) {
      return new Response(
        JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Invitation not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (invite.accepted_at !== null) {
      const { data: alreadyMember } = await supabaseAdmin
        .from('workspace_members').select('id')
        .eq('workspace_id', invite.workspace_id).eq('user_id', user.id).maybeSingle();
      if (alreadyMember) {
        return new Response(
          JSON.stringify({ ok: true, code: 'ALREADY_MEMBER', workspaceId: invite.workspace_id }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ ok: false, code: 'ALREADY_ACCEPTED', message: 'Invitation has already been accepted' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (new Date(invite.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ ok: false, code: 'EXPIRED_INVITE', message: 'Invitation has expired' }),
        { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (invite.email.toLowerCase() !== userEmail) {
      return new Response(
        JSON.stringify({ error: 'This invitation was sent to a different email address' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from('workspaces').select('id, name').eq('id', invite.workspace_id).single();
    if (workspaceError || !workspace) {
      return new Response(
        JSON.stringify({ error: 'Workspace no longer exists' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: existingMember } = await supabaseAdmin
      .from('workspace_members').select('id')
      .eq('workspace_id', invite.workspace_id).eq('user_id', user.id).maybeSingle();
    if (existingMember) {
      await supabaseAdmin.from('invite_tokens')
        .update({ accepted_at: new Date().toISOString() }).eq('id', invite.id);
      return new Response(
        JSON.stringify({ ok: true, code: 'ALREADY_MEMBER', message: 'You are already a member of this workspace', workspaceId: invite.workspace_id, workspaceName: workspace.name }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { error: memberError } = await supabaseAdmin.from('workspace_members').insert({
      workspace_id:  invite.workspace_id,
      user_id:       user.id,
      role:          invite.role,
      invited_email: invite.email,
      invited_at:    invite.created_at,
      accepted_at:   new Date().toISOString(),
    });
    if (memberError) {
      return new Response(
        JSON.stringify({ error: 'Failed to join workspace' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    await supabaseAdmin.from('invite_tokens')
      .update({ accepted_at: new Date().toISOString() }).eq('id', invite.id);

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('current_workspace_id').eq('id', user.id).single();
    if (profile && !profile.current_workspace_id) {
      await supabaseAdmin.from('profiles')
        .update({ current_workspace_id: invite.workspace_id }).eq('id', user.id);
    }

    console.log(`[accept-invite] User ${user.id} joined workspace ${invite.workspace_id}`);
    return new Response(
      JSON.stringify({ ok: true, code: 'JOINED', message: 'Successfully joined workspace', workspaceId: invite.workspace_id, workspaceName: workspace.name }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[accept-invite] Error:', errorMessage);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
