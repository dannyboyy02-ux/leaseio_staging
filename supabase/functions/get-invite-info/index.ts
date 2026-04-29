import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    );

    const { token } = await req.json();

    if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
      return new Response(
        JSON.stringify({ ok: false, code: 'INVALID_TOKEN', message: 'Invalid token format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('invite_tokens')
      .select('email, first_name, last_name, role, expires_at, accepted_at, workspace_id')
      .eq('token', token)
      .maybeSingle();

    if (inviteError || !invite) {
      return new Response(
        JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Invitation not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: workspace } = await supabaseAdmin
      .from('workspaces').select('name').eq('id', invite.workspace_id).single();

    const expired  = new Date(invite.expires_at) < new Date();
    const accepted = invite.accepted_at !== null;

    // Check if the invited email already has a LeaseIO account
    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const userExists = users.some(
      (u) => u.email?.toLowerCase() === invite.email.toLowerCase()
    );

    return new Response(
      JSON.stringify({
        ok: true,
        email:         invite.email,
        first_name:    invite.first_name ?? null,
        last_name:     invite.last_name  ?? null,
        workspaceName: workspace?.name ?? 'a workspace',
        role:          invite.role,
        expired,
        accepted,
        user_exists:   userExists,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[get-invite-info] error:', msg);
    return new Response(
      JSON.stringify({ ok: false, code: 'SERVER_ERROR', message: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
