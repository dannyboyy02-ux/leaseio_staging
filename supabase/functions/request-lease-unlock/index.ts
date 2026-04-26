import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const ALLOWED_ORIGINS = [
  'https://theleaseio.com', 'https://www.theleaseio.com', 'https://app.theleaseio.com',
  'https://theleaseio.lovable.app', 'http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173',
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isLovablePreview = requestOrigin && (
    requestOrigin.includes('lovableproject.com') || requestOrigin.includes('lovable.app')
  );
  const isAllowed = (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) || isLovablePreview;
  return {
    'Access-Control-Allow-Origin': isAllowed ? requestOrigin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl            = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Authenticate the requesting user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(bearerToken);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid authentication' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const requestingUser = userData.user;

    const body = await req.json();
    const { leaseId, reason } = body as { leaseId?: string; reason?: string };
    if (!leaseId || typeof leaseId !== 'string') {
      return new Response(JSON.stringify({ error: 'leaseId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the lease
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .select('id, request_title, filename, workspace_id, model_locked, lifecycle_status')
      .eq('id', leaseId)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify user is a member of the lease's workspace
    const { data: membership } = await supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', (lease as any).workspace_id)
      .eq('user_id', requestingUser.id)
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Only locked active leases can be unlock-requested
    if (!(lease as any).model_locked || (lease as any).lifecycle_status !== 'active') {
      return new Response(JSON.stringify({ error: 'Lease is not locked or not active' }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Prevent duplicate pending requests
    const { data: existingRequest } = await supabaseAdmin
      .from('lease_unlock_requests')
      .select('id')
      .eq('lease_id', leaseId)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingRequest) {
      return new Response(JSON.stringify({ error: 'An unlock request is already pending for this lease' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create the unlock request
    const requestReason = reason?.trim() || 'No reason provided';
    const { data: unlockRequest, error: insertError } = await supabaseAdmin
      .from('lease_unlock_requests')
      .insert({
        lease_id: leaseId,
        workspace_id: (lease as any).workspace_id,
        requested_by: requestingUser.id,
        request_reason: requestReason,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertError || !unlockRequest) {
      console.error('[request-lease-unlock] insert error:', insertError?.message);
      return new Response(JSON.stringify({ error: 'Failed to create unlock request' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const requestId = (unlockRequest as any).id;

    // Log to activity log
    await supabaseAdmin.from('lease_activity_log').insert({
      lease_id: leaseId,
      user_id: requestingUser.id,
      activity_type: 'unlock_requested',
      details: { unlock_request_id: requestId, reason: requestReason },
    }).catch((err: any) => console.error('[request-lease-unlock] activity log error:', err));

    // Log to governance audit (append-only, denormalized)
    await supabaseAdmin.from('lease_governance_audit').insert({
      lease_id: leaseId,
      workspace_id: (lease as any).workspace_id,
      event_type: 'unlock_requested',
      actor_user_id: requestingUser.id,
      actor_email: requestingUser.email ?? null,
      related_unlock_request_id: requestId,
      change_summary: requestReason,
    }).catch((err: any) => console.error('[request-lease-unlock] governance audit error:', err));

    return new Response(JSON.stringify({ ok: true, requestId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[request-lease-unlock] Error:', msg);
    return new Response(JSON.stringify({ error: 'An unexpected error occurred' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
