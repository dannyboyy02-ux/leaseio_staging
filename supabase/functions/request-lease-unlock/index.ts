import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { generateInviteToken } from "../_shared/resend.ts";

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

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl            = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey           = Deno.env.get('RESEND_API_KEY') ?? '';
    const appUrl                 = Deno.env.get('APP_URL') ?? 'https://app.theleaseio.com';

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
    const { leaseId } = body;
    if (!leaseId || typeof leaseId !== 'string') {
      return new Response(JSON.stringify({ error: 'leaseId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the lease
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .select('id, name, workspace_id, model_locked, unlock_requested')
      .eq('id', leaseId)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!(lease as any).model_locked) {
      return new Response(JSON.stringify({ error: 'Lease is not locked' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if ((lease as any).unlock_requested) {
      return new Response(JSON.stringify({ error: 'Unlock already requested' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate token + set unlock request fields
    const actionToken = generateInviteToken();
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabaseAdmin
      .from('leases')
      .update({
        unlock_requested: true,
        unlock_requested_by: requestingUser.id,
        unlock_requested_at: new Date().toISOString(),
        unlock_action_token: actionToken,
        unlock_token_expires_at: tokenExpiry,
      } as any)
      .eq('id', leaseId);

    if (updateError) {
      console.error('[request-lease-unlock] update error:', updateError.message);
      return new Response(JSON.stringify({ error: 'Failed to record unlock request' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch requester profile for display name
    const { data: requesterProfile } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', requestingUser.id)
      .single();

    const requesterName = requesterProfile?.first_name && requesterProfile?.last_name
      ? `${requesterProfile.first_name} ${requesterProfile.last_name}`
      : requesterProfile?.email ?? requestingUser.email ?? 'A team member';

    // Fetch workspace admin emails
    const { data: adminMembers } = await supabaseAdmin
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', (lease as any).workspace_id)
      .eq('role', 'admin');

    const adminUserIds = (adminMembers || []).map((m: any) => m.user_id);
    let adminEmails: string[] = [];
    if (adminUserIds.length > 0) {
      const { data: adminProfiles } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .in('id', adminUserIds);
      adminEmails = (adminProfiles || []).map((p: any) => p.email).filter(Boolean);
    }

    // Build action URLs
    // Action links go directly to the edge function (self-contained HTML handler with redirect)
    const leaseUrl = `${appUrl}/app/leases/${leaseId}`;
    const functionsBaseUrl = `${supabaseUrl}/functions/v1`;
    const approveUrl = `${functionsBaseUrl}/handle-unlock-action?token=${actionToken}&action=approve`;
    const rejectUrl = `${functionsBaseUrl}/handle-unlock-action?token=${actionToken}&action=reject`;
    const leaseName = escapeHtml((lease as any).name ?? 'Unnamed Lease');

    // Send email to each admin
    if (resendApiKey && adminEmails.length > 0) {
      const fromAddress = Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <noreply@notifications.theleaseio.com>';
      const emailBody = JSON.stringify({
        from: fromAddress,
        to: adminEmails,
        subject: `Unlock request for ${(lease as any).name ?? 'a lease'}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Lease Unlock Request</h2>
            <p><strong>${escapeHtml(requesterName)}</strong> has requested to unlock the lease <strong>${leaseName}</strong> for editing.</p>
            <p><a href="${leaseUrl}" style="color: #2563eb;">View lease</a></p>
            <p style="margin: 24px 0;">Please review and take action:</p>
            <p>
              <a href="${approveUrl}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; margin-right: 12px;">
                Approve Unlock
              </a>
              <a href="${rejectUrl}" style="background-color: #dc2626; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">
                Reject Request
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">These links expire in 7 days.</p>
          </div>
        `,
        text: `${requesterName} has requested to unlock "${(lease as any).name}" for editing.\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nLinks expire in 7 days.`,
      });

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendApiKey}`,
        },
        body: emailBody,
      }).catch((err) => console.error('[request-lease-unlock] email error:', err));
    } else {
      console.warn('[request-lease-unlock] No admin emails found or no RESEND_API_KEY');
    }

    // Log activity
    await supabaseAdmin.from('lease_approval_actions').insert({
      lease_id: leaseId,
      action: 'unlock_requested',
      actor_id: requestingUser.id,
      notes: 'Unlock request submitted',
    } as any).catch(() => {/* non-critical */});

    return new Response(JSON.stringify({ ok: true }), {
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
