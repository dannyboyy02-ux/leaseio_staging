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
    // Service role client — bypasses owner-only RLS on invite_tokens
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

    const { workspaceId } = await req.json();

    if (!workspaceId) return errRes(corsHeaders, 'INVALID_REQUEST', 'workspaceId required', 400);

    // --- Authorize: owner OR admin ---
    const { data: workspace, error: wsError } = await supabaseAdmin
      .from('workspaces')
      .select('owner_id')
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
        return errRes(corsHeaders, 'UNAUTHORIZED', 'Only workspace owners or admins may view pending invitations', 403);
      }
    }

    // --- Fetch pending invites via service role (bypasses owner-only RLS) ---
    const { data: invites, error: invitesError } = await supabaseAdmin
      .from('invite_tokens')
      .select('id, email, role, expires_at, created_at')
      .eq('workspace_id', workspaceId)
      .is('accepted_at', null)
      .order('created_at', { ascending: false });

    if (invitesError) {
      console.error('[list-pending-invites] Query error:', invitesError);
      return errRes(corsHeaders, 'DB_ERROR', invitesError.message, 500);
    }

    return new Response(
      JSON.stringify({ ok: true, code: 'OK', data: { invites: invites ?? [] } }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[list-pending-invites] Unhandled error:', msg);
    return new Response(JSON.stringify({ ok: false, code: 'DB_ERROR', message: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
