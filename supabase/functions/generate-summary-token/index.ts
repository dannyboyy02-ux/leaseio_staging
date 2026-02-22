import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const ALLOWED_ORIGINS = [
  'https://theleaseio.com',
  'https://www.theleaseio.com',
  'https://app.theleaseio.com',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(origin: string | null): Record<string, string> {
  const isAllowed = origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    origin.includes('lovableproject.com') ||
    origin.includes('lovable.app')
  );
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const appUrl = Deno.env.get('APP_URL') || 'https://theleaseio.com';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify the requesting user via JWT
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const body = await req.json();
    const { lease_id, send_email } = body;
    if (!lease_id) {
      return new Response(JSON.stringify({ error: 'lease_id required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Fetch lease
    const { data: lease, error: leaseError } = await supabase
      .from('leases')
      .select('id, workspace_id, summary_share_token, summary_shared_at, request_title, requesting_department, lifecycle_status, requestor_id')
      .eq('id', lease_id)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Verify user is workspace member or owner
    const { data: wsRow } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', lease.workspace_id)
      .single();

    const isOwner = wsRow?.owner_id === user.id;
    if (!isOwner) {
      const { data: memberRow } = await supabase
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', lease.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!memberRow) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Get or generate token — never regenerate if one exists
    let token: string = lease.summary_share_token;
    let generated_at: string = lease.summary_shared_at;
    if (!token) {
      const uuid1 = crypto.randomUUID().replace(/-/g, '');
      const uuid2 = crypto.randomUUID().replace(/-/g, '');
      token = (uuid1 + uuid2).slice(0, 48);
      generated_at = new Date().toISOString();
      await supabase
        .from('leases')
        .update({ summary_share_token: token, summary_shared_at: generated_at })
        .eq('id', lease_id);
    }

    // Get view count
    const { count: viewCount } = await supabase
      .from('summary_views')
      .select('id', { count: 'exact', head: true })
      .eq('lease_id', lease_id);

    const shareUrl = `${appUrl}/share/${token}`;

    // Optionally send approval email
    if (send_email) {
      try {
        const resendKey = Deno.env.get('RESEND_API_KEY');
        if (resendKey && lease.requestor_id) {
          const resend = new Resend(resendKey);
          const { data: submitterProfile } = await supabase
            .from('profiles')
            .select('email, first_name, last_name')
            .eq('id', lease.requestor_id)
            .single();

          if (submitterProfile?.email) {
            const submitterName = [submitterProfile.first_name, submitterProfile.last_name]
              .filter(Boolean).join(' ') || 'Team';
            await resend.emails.send({
              from: 'LeaseIO <notifications@resend.dev>',
              to: [submitterProfile.email],
              subject: `\u2705 Commitment Approved: ${lease.request_title || 'Your Request'}`,
              html: generateApprovalEmailHtml({
                requestTitle: lease.request_title || 'Lease Commitment',
                requestingDepartment: lease.requesting_department || '',
                submitterName,
                shareUrl,
              }),
            });
          }
        }
      } catch (emailErr) {
        console.error('Failed to send approval email (non-fatal):', emailErr);
      }
    }

    return new Response(
      JSON.stringify({ url: shareUrl, token, generated_at, view_count: viewCount || 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (err: any) {
    console.error('Error in generate-summary-token:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
});

function generateApprovalEmailHtml({
  requestTitle,
  requestingDepartment,
  submitterName,
  shareUrl,
}: {
  requestTitle: string;
  requestingDepartment: string;
  submitterName: string;
  shareUrl: string;
}): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f9fafb; padding: 20px; color: #111827; line-height: 1.6;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-block; background: #dcfce7; border-radius: 50%; width: 64px; height: 64px; line-height: 64px; text-align: center; font-size: 32px;">\u2705</div>
        </div>
        <h1 style="font-size: 22px; font-weight: 700; color: #111827; margin: 0 0 8px;">Commitment Approved</h1>
        <p style="color: #6b7280; margin: 0 0 24px;">Hi ${submitterName}, your lease commitment request has been approved and is ready to move forward.</p>
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="margin: 0 0 6px; font-size: 14px;"><strong>Request:</strong> ${requestTitle}</p>
          <p style="margin: 0; font-size: 14px;"><strong>Department:</strong> ${requestingDepartment}</p>
        </div>
        <p style="color: #374151; margin: 0 0 16px;">View the complete Financial Impact Summary including total commitment, estimated lease liability, and P&amp;L impact:</p>
        <div style="text-align: center; margin-bottom: 28px;">
          <a href="${shareUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 15px;">View Financial Impact Summary \u2192</a>
        </div>
        <p style="color: #9ca3af; font-size: 13px; word-break: break-all;">Or copy this link: <a href="${shareUrl}" style="color: #6b7280;">${shareUrl}</a></p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;">
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">Generated by LeaseIO \u2014 Pre-signing financial intelligence</p>
      </div>
    </body>
    </html>
  `;
}
