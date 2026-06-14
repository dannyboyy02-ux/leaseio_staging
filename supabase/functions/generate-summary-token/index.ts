import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

function getCorsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
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
    const { lease_id, send_email, action } = body;
    if (!lease_id) {
      return new Response(JSON.stringify({ error: 'lease_id required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Fetch lease
    const { data: lease, error: leaseError } = await supabase
      .from('leases')
      .select('id, workspace_id, summary_share_token, summary_shared_at, summary_share_token_expires_at, request_title, requesting_department, lifecycle_status, requestor_id')
      .eq('id', lease_id)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Phase 3: include chain post_concept_pre_signator + signator stages +
    // executed equivalent (active is identical in both vocabularies).
    const allowedLifecycleStates = new Set([
      'approved', 'executed', 'active',
      'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
    ]);
    if (!allowedLifecycleStates.has(lease.lifecycle_status)) {
      return new Response(JSON.stringify({ error: 'Financial summaries can only be shared after approval.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Verify user is workspace owner or admin. Any member can view inside the
    // app, but publishing a no-login financial link is an admin action.
    const { data: wsRow } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', lease.workspace_id)
      .single();

    const isOwner = wsRow?.owner_id === user.id;
    let isAdminMember = false;
    if (!isOwner) {
      const { data: memberRow } = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', lease.workspace_id)
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .maybeSingle();
      isAdminMember = Boolean(memberRow);
    }

    if (!isOwner && !isAdminMember) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Revoke action: clear token + expiry. Existing share links 404 immediately.
    if (action === 'revoke') {
      await supabase
        .from('leases')
        .update({
          summary_share_token: null,
          summary_shared_at: null,
          summary_share_token_expires_at: null,
        })
        .eq('id', lease_id);
      return new Response(
        JSON.stringify({ revoked: true }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Vault V1: never mint (or hand back) an anonymous share link for a
    // non-live workspace (canceled / soft-deleted / vault). Revoke above is
    // intentionally NOT gated — shutting down an existing link reduces
    // exposure and must stay possible in read-only mode.
    const liveness = await checkWorkspaceLive(supabase, lease.workspace_id);
    if (!liveness.live) {
      return new Response(
        JSON.stringify({ ok: false, error: 'subscription_inactive', reason: liveness.reason }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Get or generate token. Regenerate if missing OR expired.
    const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const expiresAtRaw = (lease as { summary_share_token_expires_at?: string | null }).summary_share_token_expires_at;
    const isExpired = expiresAtRaw ? new Date(expiresAtRaw).getTime() <= Date.now() : false;

    let token: string = lease.summary_share_token;
    let generated_at: string = lease.summary_shared_at;
    let expires_at: string = expiresAtRaw ?? '';
    if (!token || isExpired) {
      const uuid1 = crypto.randomUUID().replace(/-/g, '');
      const uuid2 = crypto.randomUUID().replace(/-/g, '');
      token = (uuid1 + uuid2).slice(0, 48);
      generated_at = new Date().toISOString();
      expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
      await supabase
        .from('leases')
        .update({
          summary_share_token: token,
          summary_shared_at: generated_at,
          summary_share_token_expires_at: expires_at,
        })
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
            // Subject and body intentionally omit request title and department
            // to minimize deal-level metadata exposed to the email provider.
            await resend.emails.send({
              from: Deno.env.get('RESEND_APPROVALS_FROM_EMAIL') ?? Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <noreply@notifications.theleaseio.com>',
              to: [submitterProfile.email],
              subject: '\u2705 Your lease commitment request has been approved',
              html: generateApprovalEmailHtml({
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
      JSON.stringify({ url: shareUrl, token, generated_at, expires_at, view_count: viewCount || 0 }),
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

// P2-05: submitterName is first_name + last_name from the profile.
// Escape before interpolating into the email HTML \u2014 these are
// user-supplied fields that could contain HTML/script that some email
// clients would render.
function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return '';
  const s = typeof text === 'string' ? text : String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return s.replace(/[&<>"']/g, (m) => map[m]);
}

function generateApprovalEmailHtml({
  submitterName,
  shareUrl,
}: {
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
        <p style="color: #6b7280; margin: 0 0 24px;">Hi ${escapeHtml(submitterName)}, your lease commitment request has been approved and is ready to move forward.</p>
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
