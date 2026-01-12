import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// HTML escape function to prevent XSS in email templates
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not set");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { emails, role, workspaceId, workspaceName } = await req.json();
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      throw new Error("At least one email is required");
    }

    if (!workspaceId) {
      throw new Error("Workspace ID is required");
    }

    // SECURITY: Verify the authenticated user is the workspace owner
    // Only workspace owners should be able to send invitations
    const { data: workspace, error: wsError } = await supabaseClient
      .from("workspaces")
      .select("owner_id")
      .eq("id", workspaceId)
      .single();

    if (wsError || !workspace) {
      throw new Error("Workspace not found");
    }

    if (workspace.owner_id !== user.id) {
      throw new Error("Only workspace owners can send invitations");
    }

    const origin = req.headers.get("origin") || "https://leaseio.app";
    const results = [];

    for (const email of emails) {
      try {
        // Check if already invited or member
        const { data: existingInvite } = await supabaseClient
          .from("workspace_members")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("invited_email", email.toLowerCase())
          .maybeSingle();

        if (existingInvite) {
          results.push({ email, success: false, error: "Already invited" });
          continue;
        }

        // Check if user exists
        const { data: existingProfile } = await supabaseClient
          .from("profiles")
          .select("id")
          .eq("email", email.toLowerCase())
          .maybeSingle();

        if (existingProfile) {
          // Add directly as member
          const { error: memberError } = await supabaseClient
            .from("workspace_members")
            .insert({
              workspace_id: workspaceId,
              user_id: existingProfile.id,
              role,
              invited_email: email.toLowerCase(),
              invited_at: new Date().toISOString(),
              accepted_at: new Date().toISOString(),
            });

          if (memberError) throw memberError;
          results.push({ email, success: true, added: true });
        } else {
          // Create pending invite
          const { data: invite, error: inviteError } = await supabaseClient
            .from("invite_tokens")
            .insert({
              workspace_id: workspaceId,
              email: email.toLowerCase(),
              role,
            })
            .select()
            .single();

          if (inviteError) throw inviteError;

          // Send invitation email
          const inviteUrl = `${origin}/accept-invite?token=${invite.token}`;
          
          const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${resendApiKey}`,
            },
            body: JSON.stringify({
              from: "LeaseIO <notifications@theleaseio.com>",
              to: [email],
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
            }),
          });

          if (!emailRes.ok) {
            console.error("Email send error:", await emailRes.text());
            results.push({ email, success: true, emailSent: false });
          } else {
            results.push({ email, success: true, emailSent: true });
          }
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error inviting ${email}:`, errMessage);
        results.push({ email, success: false, error: errMessage });
      }
    }
    const successCount = results.filter(r => r.success).length;
    
    return new Response(JSON.stringify({ 
      success: successCount > 0,
      results,
      message: `${successCount} of ${emails.length} invitations processed`
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[SEND-INVITE] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
