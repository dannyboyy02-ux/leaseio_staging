// delete-account — permanently delete the caller's account.
//
// REBUILT 2026-07-16 (P0-d) to fix two catastrophic bugs:
//   (1) CROSS-TENANT DATA DESTRUCTION. The old code deleted leases by
//       `user_id = me` AND deleting the profile CASCADE-deleted them too, so a
//       departing employee's account deletion erased every lease they had
//       uploaded into their EMPLOYER's workspace — the employer's
//       audit-defensible repository. Now we delete ONLY the workspaces the user
//       OWNS (explicit, by workspace_id), and the leases.user_id FK is SET NULL
//       (migration 20260716140000) so a deleted uploader's leases in OTHER
//       workspaces survive with the attribution cleared.
//   (2) ZERO STRIPE CANCELLATION. Owned workspaces' subscriptions (plan + packs)
//       were never canceled — the departed customer was billed forever. Now each
//       owned workspace is torn down via the SAME shared purge helpers +
//       forensic record delete-workspace uses (workspace_purge.ts, #74/#93).
//
// AUTHORIZATION: valid Bearer JWT; the caller can only ever delete THEIR OWN
// account (all deletes are keyed on user.id / owner_id = user.id).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  cancelWorkspaceSubscriptions,
  purgeWorkspaceStorage,
} from "../_shared/workspace_purge.ts";
import { syncFirmSubscriptionQuantity } from "../_shared/firm_billing.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    console.log(`[DELETE-ACCOUNT] Starting deletion for user ${user.id}`);

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" }) : null;
    if (!stripe) {
      console.error("[DELETE-ACCOUNT] STRIPE_SECRET_KEY not set — subscriptions will NOT be canceled.");
    }

    // ── Load the workspaces the user OWNS (the only ones we may destroy) ──
    const { data: ownedWorkspaces, error: ownedErr } = await supabaseClient
      .from("workspaces")
      .select("id, name, plan, stripe_customer_id, firm_id")
      .eq("owner_id", user.id);
    if (ownedErr) throw new Error(`Failed to load owned workspaces: ${ownedErr.message}`);

    const owned = (ownedWorkspaces ?? []) as Array<{
      id: string;
      name: string | null;
      plan: string | null;
      stripe_customer_id: string | null;
      firm_id: string | null;
    }>;

    // ── Purge each owned workspace with the SAME sequence as delete-workspace ──
    // Forensic row FIRST → cancel Stripe (record ids) → delete leases BY
    // workspace_id (leases.workspace_id is SET NULL, not CASCADE, so we must
    // delete explicitly or they orphan) → delete workspace → firm resync →
    // storage purge LAST. A workspace that does NOT fully purge sets
    // `purgeIncomplete`, which ABORTS before the terminal auth-delete — because
    // auth.admin.deleteUser CASCADE-destroys workspaces.owner_id, so a
    // silently-skipped workspace would otherwise be destroyed with no forensic
    // record + un-purged storage (security review MEDIUM). The delete is
    // resumable: already-purged workspaces short-circuit on the forensic UNIQUE.
    let purgeIncomplete = false;
    for (const ws of owned) {
      try {
        const [{ count: leaseCount }, { count: memberCount }] = await Promise.all([
          supabaseClient.from("leases").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id),
          supabaseClient.from("workspace_members").select("user_id", { count: "exact", head: true }).eq("workspace_id", ws.id),
        ]);

        // Storage prefixes (derived from lease ids) — captured before delete.
        const { data: leasesForStorage } = await supabaseClient
          .from("leases")
          .select("id, user_id, requestor_id")
          .eq("workspace_id", ws.id);
        const storageTargets = new Set<string>();
        for (const l of (leasesForStorage ?? []) as Array<{ id: string; user_id: string | null; requestor_id: string | null }>) {
          if (l.user_id) storageTargets.add(`${l.user_id}/${l.id}`);
          if (l.requestor_id && l.requestor_id !== l.user_id) storageTargets.add(`${l.requestor_id}/${l.id}`);
        }

        // ── Forensic row FIRST (#93), BEFORE any destruction incl. Stripe.
        // If it fails (non-duplicate), destroy NOTHING for this workspace and
        // mark the purge incomplete so we don't reach the auth-cascade.
        const { error: forensicError } = await supabaseClient.from("deleted_workspaces").insert({
          original_workspace_id: ws.id,
          owner_id: user.id,
          workspace_name: ws.name,
          workspace_plan: ws.plan,
          lease_count_at_deletion: leaseCount ?? 0,
          member_count_at_deletion: memberCount ?? 0,
          storage_objects_purged: 0,
          // deleted_by MUST be null here: deleted_workspaces.deleted_by ->
          // auth.users is ON DELETE NO ACTION, so writing user.id would FK-block
          // the terminal auth.admin.deleteUser(user.id) (integrity review
          // CRITICAL). owner_id already records the identity forensically.
          deleted_by: null,
          details: { purge_source: "account_deletion", deleted_by_user: user.id, stripe_subscriptions_canceled: [] },
        });
        if (forensicError && !/duplicate|unique/i.test(forensicError.message)) {
          console.error(`[DELETE-ACCOUNT] forensic insert failed for ${ws.id} — nothing destroyed:`, forensicError.message);
          purgeIncomplete = true;
          continue;
        }

        // Cancel Stripe subs AFTER the forensic row exists (so a cancel is never
        // unrecorded). Best-effort; record the canceled ids onto the row.
        let stripeCanceled: string[] = [];
        if (stripe && ws.stripe_customer_id) {
          try {
            stripeCanceled = await cancelWorkspaceSubscriptions(stripe, ws.stripe_customer_id, ws.id);
            if (stripeCanceled.length > 0) {
              await supabaseClient.from("deleted_workspaces")
                .update({ details: { purge_source: "account_deletion", deleted_by_user: user.id, stripe_subscriptions_canceled: stripeCanceled } })
                .eq("original_workspace_id", ws.id);
            }
          } catch (err) {
            console.error(`[DELETE-ACCOUNT] stripe cleanup failed for ${ws.id}: ${(err as Error)?.message}`);
          }
        }

        // Delete leases BY workspace_id (safe — owned workspace only), then the
        // workspace (cascades members/policies/etc.).
        const { error: leasesErr } = await supabaseClient.from("leases").delete().eq("workspace_id", ws.id);
        if (leasesErr) {
          console.error(`[DELETE-ACCOUNT] leases delete failed for ${ws.id}:`, leasesErr.message);
          purgeIncomplete = true;
          continue;
        }
        const { error: wsDelErr } = await supabaseClient.from("workspaces").delete().eq("id", ws.id);
        if (wsDelErr) {
          console.error(`[DELETE-ACCOUNT] workspace delete failed for ${ws.id}:`, wsDelErr.message);
          purgeIncomplete = true;
          continue;
        }

        // Firm child resync (#112/#120) so the firm isn't over-billed.
        if (ws.firm_id && stripe) {
          try {
            await syncFirmSubscriptionQuantity(stripe, supabaseClient, ws.firm_id);
          } catch (e) {
            console.error(`[DELETE-ACCOUNT] firm billing resync failed for ${ws.firm_id} (self-heals on reconcile):`, e instanceof Error ? e.message : String(e));
          }
        }

        // Storage LAST.
        const purged = await purgeWorkspaceStorage(supabaseClient, {
          workspaceId: ws.id,
          uploaderPrefixes: Array.from(storageTargets),
        });
        await supabaseClient.from("deleted_workspaces").update({ storage_objects_purged: purged }).eq("original_workspace_id", ws.id);
      } catch (wsErr) {
        console.error(`[DELETE-ACCOUNT] error purging owned workspace ${ws.id}:`, (wsErr as Error)?.message);
        purgeIncomplete = true;
      }
    }
    console.log(`[DELETE-ACCOUNT] Purged ${owned.length} owned workspace(s); incomplete=${purgeIncomplete}`);

    // ── Guard: never reach the auth-delete cascade with a workspace still owned ──
    // auth.admin.deleteUser CASCADE-destroys workspaces.owner_id, which would
    // destroy any workspace we skipped above WITHOUT its forensic record /
    // storage purge. Abort with a retryable error; the caller re-invokes and the
    // forensic UNIQUE lets already-purged workspaces short-circuit.
    if (purgeIncomplete) {
      return new Response(
        JSON.stringify({ error: "Some workspaces could not be fully removed. Please try again.", reason: "purge_incomplete" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
      );
    }

    // ── Remove the user's memberships in workspaces they DON'T own ──────────
    // (Owned-workspace member rows were already cascade-deleted above.)
    const { error: memberError } = await supabaseClient
      .from("workspace_members")
      .delete()
      .eq("user_id", user.id);
    if (memberError) console.error("[DELETE-ACCOUNT] Member cleanup error:", memberError.message);

    // ── Purge PII orphans that survive the cascades ─────────────────────────
    if (user.email) {
      const { error: inviteErr } = await supabaseClient.from("invite_tokens").delete().eq("email", user.email);
      if (inviteErr) console.error("[DELETE-ACCOUNT] invite_tokens cleanup error:", inviteErr.message);
    }
    const { error: auditErr } = await supabaseClient
      .from("lease_governance_audit")
      .update({ actor_user_id: null, actor_email: null })
      .eq("actor_user_id", user.id);
    if (auditErr) console.error("[DELETE-ACCOUNT] governance audit anonymization error:", auditErr.message);

    const { error: changeSetErr } = await supabaseClient
      .from("lease_change_sets")
      .delete()
      .eq("submitted_by", user.id)
      .eq("status", "draft");
    if (changeSetErr) console.error("[DELETE-ACCOUNT] change set draft cleanup error:", changeSetErr.message);

    // ── Reassign the departing user's PENDING chain steps BEFORE the FK SET
    // NULL fires, so a specific-user assignment in a workspace they don't own
    // doesn't orphan invisibly (integrity review MEDIUM). Reassigned to each
    // step's workspace owner, who can act or reassign. Best-effort.
    const { error: reassignErr } = await supabaseClient.rpc("reassign_departing_user_chain_steps", { p_user_id: user.id });
    if (reassignErr) console.error("[DELETE-ACCOUNT] chain-step reassignment error:", reassignErr.message);

    // ── Delete the auth user — CASCADES to profiles (profiles.id -> auth.users
    // ON DELETE CASCADE) and to every other ON-DELETE-CASCADE child. We do NOT
    // delete the profile explicitly first: if the auth delete ever fails (an
    // un-relaxed actor FK, etc.), leaving the profile in place keeps the account
    // intact and retryable rather than stranding a zombie (profile gone, auth
    // alive). All actor/attribution FKs on cross-tenant-surviving rows were
    // relaxed to ON DELETE SET NULL (migration 20260716150000) so the departing
    // user's attribution clears (audit rows survive with a null actor, #90
    // convention) instead of blocking this delete. leases.user_id is likewise
    // SET NULL (20260716140000) — the employer's lease survives, uploader cleared.
    const { error: authDeleteError } = await supabaseClient.auth.admin.deleteUser(user.id);
    if (authDeleteError) {
      console.error("[DELETE-ACCOUNT] Auth user deletion error:", authDeleteError.message);
      throw new Error(`Failed to delete auth user: ${authDeleteError.message}`);
    }

    console.log(`[DELETE-ACCOUNT] Successfully deleted user ${user.id}`);
    return new Response(JSON.stringify({ success: true, ownedWorkspacesPurged: owned.length }), {
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
