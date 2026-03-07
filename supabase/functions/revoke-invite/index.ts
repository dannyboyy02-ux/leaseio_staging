import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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
      .select('id, workspace_id, accepted_at')
      .eq('id', inviteId)
      .maybeSingle();

    if (inviteError || !invite) {
      return errRes(corsHeaders, 'NOT_FOUND', 'Invitation not found', 404);
    }

    if (invite.accepted_at !== null) {
      return errRes(corsHeaders, 'ALREADY_ACCEPTED', 'Invitation has already been accepted and cannot be revoked', 409);
    }

    // --- Authorize: owner OR admin (workspace_id derived from invite row) ---
    const { data: workspace, error: wsError } = await supabaseAdmin
      .from('workspaces')
      .select('owner_id')
      .eq('id', invite.workspace_id)
      .single();

    if (wsError || !workspace) return errRes(corsHeaders, 'NOT_FOUND', 'Workspace not found', 404);

    const isOwner = workspace.owner_id === user.id;
    if (!isOwner) {
      const { data: membership } = await supabaseAdmin
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', invite.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (membership?.role !== 'admin') {
        return errRes(corsHeaders, 'UNAUTHORIZED', 'Only workspace owners or admins may revoke invitations', 403);
      }
    }

    // --- Delete the pending invite row ---
    const { error: deleteError } = await supabaseAdmin
      .from('invite_tokens')
      .delete()
      .eq('id', invite.id);

    if (deleteError) {
      console.error('[revoke-invite] Delete failed:', deleteError);
      return errRes(corsHeaders, 'DB_ERROR', deleteError.message, 500);
    }

    return okRes(corsHeaders, 'INVITE_REVOKED', 'Invitation revoked');

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[revoke-invite] Unhandled error:', msg);
    return new Response(JSON.stringify({ ok: false, code: 'DB_ERROR', message: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
