// sweep-pending-workspaces — abandonment cleanup for create-workspace
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §4.3 (blocking Phase 1 deliverable).
//
// When a user starts creating a Business workspace but never completes payment
// (closes the tab mid-3DS, abandons the confirm), the workspace row was inserted
// at the Starter baseline and its Stripe subscription is `incomplete`. Such a
// row counts toward the owner's 10-cap and is a usable-but-unpaid ghost. The
// `cancel` mode of create-workspace handles the common explicit-decline case;
// this cron is the backstop for true abandonment.
//
// Sweeps workspace_creation_requests rows still `pending` and older than 2h:
//   - If the workspace activated (plan='business', sub active/trialing) → mark
//     the request `active` and leave it.
//   - Else cancel any incomplete Stripe subscription, delete the (lease-free)
//     workspace, write the durable deleted_workspaces forensic row stamped as a
//     system sweep, and mark the request `canceled`.
//
// Auth: cron-only via x-cron-secret (verify_jwt = false). No human caller.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const jsonHeaders = { "Content-Type": "application/json" };

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!supabaseUrl || !serviceRoleKey || !stripeKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: jsonHeaders });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabaseAdmin
    .from("workspace_creation_requests")
    .select("idempotency_key, owner_id, workspace_id, created_at")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .limit(200);

  if (error) {
    console.error("[sweep-pending-workspaces] query error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonHeaders });
  }

  let activated = 0;
  let swept = 0;
  let skipped = 0;

  for (const row of (pending ?? []) as Array<{ idempotency_key: string; owner_id: string; workspace_id: string | null }>) {
    const workspaceId = row.workspace_id;
    if (!workspaceId) {
      // No workspace was ever linked; mark failed and move on.
      await supabaseAdmin
        .from("workspace_creation_requests")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("idempotency_key", row.idempotency_key);
      continue;
    }

    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, name, plan, subscription_status")
      .eq("id", workspaceId)
      .maybeSingle();
    const w = ws as { id: string; owner_id: string; name: string | null; plan: string | null; subscription_status: string | null } | null;

    // Workspace was deleted out from under us (cancel mode already ran).
    if (!w) {
      await supabaseAdmin
        .from("workspace_creation_requests")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("idempotency_key", row.idempotency_key);
      skipped++;
      continue;
    }

    // Activated in the meantime → finalize the request, leave the workspace.
    if (w.plan === "business" && w.subscription_status && ["active", "trialing"].includes(w.subscription_status)) {
      await supabaseAdmin
        .from("workspace_creation_requests")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("idempotency_key", row.idempotency_key);
      activated++;
      continue;
    }

    // Still pending/unpaid → cancel any incomplete sub, delete the workspace.
    try {
      const subs = await stripe.subscriptions.list({ status: "incomplete", limit: 100 });
      for (const s of subs.data) {
        if (s.metadata?.workspace_id === workspaceId) {
          await stripe.subscriptions.cancel(s.id).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[sweep-pending-workspaces] stripe cleanup failed:", (e as Error)?.message);
    }

    await supabaseAdmin.from("workspaces").delete().eq("id", workspaceId);
    await supabaseAdmin.from("deleted_workspaces").insert({
      original_workspace_id: workspaceId,
      owner_id: w.owner_id,
      workspace_name: w.name,
      workspace_plan: w.plan,
      lease_count_at_deletion: 0,
      member_count_at_deletion: 1,
      storage_objects_purged: 0,
      deleted_by: null, // system sweep — no human actor
    });
    await supabaseAdmin
      .from("workspace_creation_requests")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("idempotency_key", row.idempotency_key);
    swept++;
  }

  return new Response(
    JSON.stringify({ ok: true, examined: pending?.length ?? 0, activated, swept, skipped }),
    { status: 200, headers: jsonHeaders },
  );
});
