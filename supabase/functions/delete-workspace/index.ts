// delete-workspace — Owner Workspace Management Checkpoint 1
//
// Permanently deletes a workspace and every piece of data it owns:
//   - All leases (cascades to lease_activity_log, lease_approval_chain,
//     risks, rent_schedules, and every other ON DELETE CASCADE child)
//   - The workspace itself (cascades to workspace_members, workspace_roles,
//     approval_policies, invite_tokens, etc.)
//   - All storage objects across all four buckets ('leases',
//     'executed-leases', 'lease-documents', 'lease-reports'), recursively,
//     via the shared purgeWorkspaceStorage helper
//   - Every Stripe subscription tagged to this workspace (plan + document
//     packs), via the shared cancelWorkspaceSubscriptions helper
//
// The Stripe cancel + four-bucket purge are shared verbatim with the
// cancellation-lifecycle cron (supabase/functions/_shared/workspace_purge.ts,
// KNOWN_ISSUES #74) so the two destruction paths can't drift.
//
// Captures forensic counts to public.deleted_workspaces BEFORE the delete
// so the audit row survives the deletion of the workspaces row itself.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true at deploy)
//   - Caller's user.id MUST equal workspaces.owner_id for the target
//   - Request body MUST include `confirmName` matching the workspace's
//     current `name` exactly (defense in depth — the UI also enforces)
//
// CRITICAL ORDER NOTE
//   leases.workspace_id is FK ON DELETE SET NULL, NOT CASCADE. If we
//   relied on the workspace cascade alone, leases would orphan with
//   workspace_id=NULL (hidden by RLS but still consuming storage and
//   billing entries). We therefore explicitly DELETE FROM leases
//   WHERE workspace_id = X BEFORE deleting the workspace. This triggers
//   each lease's CASCADE child rows. Then DELETE FROM workspaces handles
//   the rest (members, policies, invites, etc.) via their CASCADE FKs.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import { syncFirmSubscriptionQuantity } from "../_shared/firm_billing.ts";
import {
  cancelWorkspaceSubscriptions,
  purgeWorkspaceStorage,
} from "../_shared/workspace_purge.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

interface RequestBody {
  workspaceId: string;
  confirmName: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { ok: false, error: "Unauthorized", reason: "no_auth" },
      401,
      origin,
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse(
      { ok: false, error: "Invalid authentication", reason: "invalid_auth" },
      401,
      origin,
    );
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body", reason: "bad_request" },
      400,
      origin,
    );
  }

  const workspaceId = body?.workspaceId;
  const confirmName = body?.confirmName;
  if (!workspaceId || typeof workspaceId !== "string") {
    return jsonResponse(
      { ok: false, error: "workspaceId is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!confirmName || typeof confirmName !== "string") {
    return jsonResponse(
      { ok: false, error: "confirmName is required", reason: "bad_request" },
      400,
      origin,
    );
  }

  // ── Authorization: load workspace, verify owner ─────────────────────
  const { data: workspace, error: wsError } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id, name, plan, stripe_customer_id, firm_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (wsError) {
    console.error("[delete-workspace] load workspace error:", wsError.message);
    return jsonResponse(
      { ok: false, error: "Failed to load workspace", reason: "internal" },
      500,
      origin,
    );
  }
  if (!workspace) {
    return jsonResponse(
      { ok: false, error: "Workspace not found", reason: "not_found" },
      404,
      origin,
    );
  }
  const ws = workspace as {
    id: string;
    owner_id: string;
    name: string | null;
    plan: string | null;
    stripe_customer_id: string | null;
    firm_id: string | null;
  };
  if (ws.owner_id !== user.id) {
    // Don't leak whether the workspace exists vs. user lacks access; both
    // are answered the same way to a non-owner caller.
    return jsonResponse(
      { ok: false, error: "Forbidden", reason: "not_owner" },
      403,
      origin,
    );
  }

  // ── Confirm-name guard (defense in depth; UI enforces too) ──────────
  if (confirmName !== (ws.name ?? "")) {
    return jsonResponse(
      {
        ok: false,
        error:
          "confirmName does not match the workspace's current name. Type it exactly to confirm.",
        reason: "name_mismatch",
      },
      400,
      origin,
    );
  }

  // ── Rate limit ──────────────────────────────────────────────────────
  // Low ceiling — workspace deletes are rare and irreversible.
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "delete-workspace",
    origin,
    5,
  );
  if (rateLimitResponse) return rateLimitResponse;

  console.log(`[delete-workspace] Owner ${user.id} deleting workspace ${workspaceId}`);

  // ── Capture forensic metadata for the audit row ─────────────────────
  const [{ count: leaseCount }, { count: memberCount }] = await Promise.all([
    supabaseAdmin
      .from("leases")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    supabaseAdmin
      .from("workspace_members")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
  ]);

  // ── Capture storage prefixes for every lease in the workspace ───────
  // Captured BEFORE the lease rows are deleted (the prefixes are derived
  // from lease ids). Same convention the cancellation cron uses:
  //   leases / executed-leases: {uploader_user_id}/{lease_id}.
  const { data: leasesForStorage } = await supabaseAdmin
    .from("leases")
    .select("id, user_id, requestor_id")
    .eq("workspace_id", workspaceId);

  const storageTargets = new Set<string>();
  for (const l of (leasesForStorage ?? []) as Array<{
    id: string;
    user_id: string | null;
    requestor_id: string | null;
  }>) {
    if (l.user_id) storageTargets.add(`${l.user_id}/${l.id}`);
    if (l.requestor_id && l.requestor_id !== l.user_id) {
      storageTargets.add(`${l.requestor_id}/${l.id}`);
    }
  }

  // ── Cancel Stripe subscriptions tagged to this workspace ────────────
  // Document packs are independent subscriptions — without this they bill
  // forever against a deleted workspace. Mirrors the cancellation cron.
  // Unlike the cron (which DEFERS the purge on any Stripe trouble), an
  // owner-initiated delete is a one-shot human action with no retry loop,
  // so a missing key is logged-and-continued rather than failing the whole
  // delete; the forensic row records exactly what we canceled.
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" }) : null;
  let stripeCanceled: string[] = [];
  if (stripe && ws.stripe_customer_id) {
    try {
      stripeCanceled = await cancelWorkspaceSubscriptions(stripe, ws.stripe_customer_id, ws.id);
    } catch (err) {
      console.error(
        `[delete-workspace] stripe cleanup failed for ${workspaceId}: ${(err as Error)?.message}`,
      );
    }
  } else if (!stripe) {
    console.error("[delete-workspace] STRIPE_SECRET_KEY not set — subscriptions NOT canceled:", workspaceId);
  }

  // ── Forensic row FIRST — before any destruction (#93) ───────────────
  // Mirrors the cancellation cron: write deleted_workspaces BEFORE deleting
  // anything, and ABORT if it fails, so a destroyed workspace can never lack
  // its forensic record. storage_objects_purged is backfilled after the
  // storage purge (which runs LAST). UNIQUE(original_workspace_id): a
  // duplicate means a prior partial delete — resume destruction against the
  // existing row rather than re-recording.
  const { error: forensicError } = await supabaseAdmin
    .from("deleted_workspaces")
    .insert({
      original_workspace_id: workspaceId,
      owner_id: ws.owner_id,
      workspace_name: ws.name,
      workspace_plan: ws.plan,
      lease_count_at_deletion: leaseCount ?? 0,
      member_count_at_deletion: memberCount ?? 0,
      storage_objects_purged: 0,
      deleted_by: user.id,
      details: {
        purge_source: "owner_delete_workspace",
        stripe_subscriptions_canceled: stripeCanceled,
      },
    });
  if (forensicError && !/duplicate|unique/i.test(forensicError.message)) {
    console.error("[delete-workspace] forensic insert failed — delete ABORTED:", forensicError.message);
    return jsonResponse(
      {
        ok: false,
        error: `Failed to record deletion: ${forensicError.message}`,
        reason: "forensic_insert_failed",
      },
      500,
      origin,
    );
  }

  // ── Delete leases first (avoids workspace_id SET NULL orphaning) ────
  // Cascades to: lease_activity_log, lease_approval_chain (via lease_id),
  // lease_approval_actions, lease_approvers, lease_change_sets,
  // lease_field_confidence, lease_governance_audit (via lease_id),
  // lease_notifications, lease_nudges, lease_state_transitions,
  // lease_unlock_requests (via lease_id), executed_term_edits,
  // field_corrections, rent_schedules, risks, summary_views.
  const { error: leasesError } = await supabaseAdmin
    .from("leases")
    .delete()
    .eq("workspace_id", workspaceId);
  if (leasesError) {
    console.error("[delete-workspace] leases delete error:", leasesError.message);
    return jsonResponse(
      {
        ok: false,
        error: `Failed to delete leases: ${leasesError.message}`,
        reason: "lease_delete_failed",
      },
      500,
      origin,
    );
  }

  // ── Delete the workspace itself ─────────────────────────────────────
  // Cascades to: alert_rules, approval_policies (and approval_chain_steps
  // via policy_id CASCADE), dismissed_events, invite_tokens,
  // lease_approval_chain (via workspace_id; redundant after lease delete),
  // lease_change_sets (via workspace_id; redundant), lease_governance_audit
  // (via workspace_id; redundant), lease_unlock_requests (redundant),
  // notifications, processing_rate_limits, risk_templates, user_preferences,
  // workspace_approvers, workspace_members, workspace_roles.
  const { error: wsDeleteError } = await supabaseAdmin
    .from("workspaces")
    .delete()
    .eq("id", workspaceId);
  if (wsDeleteError) {
    console.error("[delete-workspace] workspace delete error:", wsDeleteError.message);
    return jsonResponse(
      {
        ok: false,
        error: `Failed to delete workspace: ${wsDeleteError.message}`,
        reason: "workspace_delete_failed",
      },
      500,
      origin,
    );
  }

  // ── #112: firm billing resync ───────────────────────────────────────
  // The deleted workspace's child-counter decrement is handled by the
  // maintain_firm_child_workspace_counter trigger (DELETE branch). If this was
  // a firm child, also resync the firm's Stripe quantity NOW so it isn't
  // over-billed until the next bind/release or the firm-billing-reconcile cron.
  // Best-effort + self-healing (the cron is the backstop); recompute is from the
  // live child count, which is already correct now that the row is gone.
  if (ws.firm_id && stripe) {
    try {
      await syncFirmSubscriptionQuantity(stripe, supabaseAdmin, ws.firm_id);
    } catch (e) {
      console.error("[delete-workspace] firm billing resync failed (self-heals on next op / reconcile):", e instanceof Error ? e.message : String(e));
    }
  }

  // ── Storage purge LAST — files are unreachable once the rows are gone;
  // an abort before this point left the workspace fully recoverable. The
  // forensic row was already written (#93); backfill its purged count. ──
  const storageObjectsPurged = await purgeWorkspaceStorage(supabaseAdmin, {
    workspaceId,
    uploaderPrefixes: Array.from(storageTargets),
  });
  const { error: countUpdateError } = await supabaseAdmin
    .from("deleted_workspaces")
    .update({ storage_objects_purged: storageObjectsPurged })
    .eq("original_workspace_id", workspaceId);
  if (countUpdateError) {
    console.error("[delete-workspace] forensic count backfill failed:", countUpdateError.message);
  }

  return jsonResponse(
    {
      ok: true,
      workspaceId,
      leaseCount: leaseCount ?? 0,
      memberCount: memberCount ?? 0,
      storageObjectsPurged,
      stripeSubscriptionsCanceled: stripeCanceled.length,
    },
    200,
    origin,
  );
});
