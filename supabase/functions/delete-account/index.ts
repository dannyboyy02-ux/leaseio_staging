import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Default CORS headers for backwards compatibility
const corsHeaders = getCorsHeaders(null);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    console.log(`[DELETE-ACCOUNT] Starting deletion for user ${user.id}`);

    // 0. Delete all lease files from Storage before removing DB records
    const { data: ownedWorkspaces } = await supabaseClient
      .from("workspaces")
      .select("id")
      .eq("owner_id", user.id);

    const ownedWorkspaceIds = (ownedWorkspaces || []).map((w: { id: string }) => w.id);

    const leaseResults = await Promise.all([
      supabaseClient.from("leases").select("id").eq("user_id", user.id),
      ...(ownedWorkspaceIds.length > 0
        ? [supabaseClient.from("leases").select("id").in("workspace_id", ownedWorkspaceIds)]
        : []),
    ]);
    const allLeaseIds = [
      ...new Set(leaseResults.flatMap(r => (r.data || []).map((l: { id: string }) => l.id))),
    ];

    for (const leaseId of allLeaseIds) {
      for (const bucket of ["leases", "executed-leases"]) {
        const { data: files } = await supabaseClient.storage
          .from(bucket)
          .list(`${user.id}/${leaseId}`);
        if (files && files.length > 0) {
          await supabaseClient.storage
            .from(bucket)
            .remove(files.map((f: { name: string }) => `${user.id}/${leaseId}/${f.name}`));
        }
      }
    }
    console.log(`[DELETE-ACCOUNT] Storage cleanup complete for ${allLeaseIds.length} lease(s)`);

    // 1. Delete user's workspaces (will cascade to workspace_members, leases, etc.)
    const { error: workspaceError } = await supabaseClient
      .from("workspaces")
      .delete()
      .eq("owner_id", user.id);

    if (workspaceError) {
      console.error("[DELETE-ACCOUNT] Workspace deletion error:", workspaceError);
    }

    // 2. Remove user from other workspaces they're members of
    const { error: memberError } = await supabaseClient
      .from("workspace_members")
      .delete()
      .eq("user_id", user.id);

    if (memberError) {
      console.error("[DELETE-ACCOUNT] Member cleanup error:", memberError);
    }

    // 3. Delete user's leases (in case any are orphaned)
    const { error: leasesError } = await supabaseClient
      .from("leases")
      .delete()
      .eq("user_id", user.id);

    if (leasesError) {
      console.error("[DELETE-ACCOUNT] Leases deletion error:", leasesError);
    }

    // 4. Delete profile
    const { error: profileError } = await supabaseClient
      .from("profiles")
      .delete()
      .eq("id", user.id);

    if (profileError) {
      console.error("[DELETE-ACCOUNT] Profile deletion error:", profileError);
    }

    // 4a. Purge PII orphans that survive workspace cascades.
    // - invite_tokens: invitations addressed to this user's email in other workspaces
    // - lease_governance_audit: actor_user_id FK + denormalized actor_email
    // - lease_change_sets: drafts the user authored in workspaces they don't own
    //   (committed change sets are part of the audit chain; their `submitted_by`
    //   FK has no ON DELETE clause, which can block auth.admin.deleteUser for
    //   deeply-embedded users — flagged as a follow-up to relax to ON DELETE
    //   SET NULL across audit FKs.)

    if (user.email) {
      const { error: inviteErr } = await supabaseClient
        .from("invite_tokens")
        .delete()
        .eq("email", user.email);
      if (inviteErr) {
        console.error("[DELETE-ACCOUNT] invite_tokens cleanup error:", inviteErr);
      }
    }

    const { error: auditErr } = await supabaseClient
      .from("lease_governance_audit")
      .update({ actor_user_id: null, actor_email: null })
      .eq("actor_user_id", user.id);
    if (auditErr) {
      console.error("[DELETE-ACCOUNT] governance audit anonymization error:", auditErr);
    }

    const { error: changeSetErr } = await supabaseClient
      .from("lease_change_sets")
      .delete()
      .eq("submitted_by", user.id)
      .eq("status", "draft");
    if (changeSetErr) {
      console.error("[DELETE-ACCOUNT] change set draft cleanup error:", changeSetErr);
    }

    // 5. Delete auth user
    const { error: authDeleteError } = await supabaseClient.auth.admin.deleteUser(user.id);

    if (authDeleteError) {
      console.error("[DELETE-ACCOUNT] Auth user deletion error:", authDeleteError);
      throw new Error(`Failed to delete auth user: ${authDeleteError.message}`);
    }

    console.log(`[DELETE-ACCOUNT] Successfully deleted user ${user.id}`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[DELETE-ACCOUNT] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
