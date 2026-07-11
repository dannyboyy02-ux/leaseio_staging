import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";
import { resolvePeriodEndIso } from "../_shared/stripe_subscription.ts";

// In-app subscription cancel / resume for the workspace plan subscription.
//
// Why this exists: the core subscription used to be canceled by bouncing the
// user to the Stripe billing portal — a second confirmation for one intent,
// with no return feedback, while document packs (manage-document-pack) and
// firm billing (_shared/firm_billing.ts) already cancel in-app. This function
// closes that gap: it flips `cancel_at_period_end` on the workspace's own
// subscription (never immediate — access is kept until period end, matching
// the pack pattern) and returns the resulting state so the Billing tab can
// render "Scheduled to cancel on {date}" + a Resume affordance.
//
// Auth/gating mirrors customer-portal EXACTLY (owner-OR-admin, workspace-scoped,
// firm-bound rejected fail-closed) — a member must never be able to cancel a
// workspace's subscription. This is the service-role authorization boundary.
//
// resume:false (default) → cancel_at_period_end = true  (schedule cancellation)
// resume:true            → cancel_at_period_end = false (undo a scheduled cancel)

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status,
    });

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header provided", reason: "no_auth" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return json({ error: "User not authenticated", reason: "invalid_auth" }, 401);
    }
    const user = userData.user;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const workspaceId = (body as { workspaceId?: string }).workspaceId;
    const resume = (body as { resume?: boolean }).resume === true;
    if (!workspaceId || typeof workspaceId !== "string") {
      return json({ error: "workspaceId is required", reason: "bad_request" }, 400);
    }

    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id, stripe_subscription_id, firm_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (wsErr || !workspace) {
      return json({ error: "Workspace not found", reason: "not_found" }, 404);
    }

    // Firm-bound workspaces have no own subscription (the firm sub carries
    // metadata.firm_id) — cancellation is a firm-level action. Reject fail-closed,
    // same boundary as customer-portal / create-checkout (#103).
    if ((workspace as { firm_id: string | null }).firm_id) {
      return json(
        {
          error: "Billing for this workspace is managed at the firm level.",
          reason: "firm_managed",
        },
        403,
      );
    }

    // Owner-OR-admin gate — identical to customer-portal.
    let canManageBilling = (workspace as any).owner_id === user.id;
    if (!canManageBilling) {
      const { data: membership } = await supabaseAdmin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      canManageBilling = Boolean(membership);
    }
    if (!canManageBilling) {
      return json(
        {
          error: "Only workspace owners or admins can change the subscription.",
          reason: "not_authorized",
        },
        403,
      );
    }

    const subscriptionId = (workspace as any).stripe_subscription_id as string | null;
    if (!subscriptionId) {
      return json(
        {
          error: "This workspace has no active subscription to change.",
          reason: "no_subscription",
        },
        409,
      );
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    try {
      const updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: !resume,
      });
      // Items-aware read — Basil removed top-level current_period_end
      // (_shared/stripe_subscription.ts).
      const currentPeriodEnd = resolvePeriodEndIso(updated);

      // Audit — best-effort, never fail the user's action on an audit hiccup
      // (the Stripe mutation already committed; failing here would show "failed"
      // over a change that happened). This is the SOLE attribution writer for a
      // cancel_at_period_end toggle — the webhook logs nothing for it (plan is
      // unchanged) — so we must inspect BOTH the returned { error } (supabase-js
      // returns a Postgres/RLS rejection rather than throwing) AND thrown
      // network faults, mirroring the webhook's plan_changed pattern. A silently
      // dropped row would lose "who scheduled/reverted the cancel" permanently.
      try {
        const { error: auditErr } = await supabaseAdmin.from("workspace_activity_log").insert({
          workspace_id: workspaceId,
          user_id: user.id,
          event_type: resume ? "subscription_cancel_reverted" : "subscription_cancel_scheduled",
          details: {
            subscription_id: subscriptionId,
            cancel_at_period_end: !resume,
            current_period_end: currentPeriodEnd,
            source: "cancel-subscription",
          },
        });
        if (auditErr) {
          console.error(
            "[cancel-subscription] audit insert rejected (Stripe update already committed):",
            auditErr.message,
          );
        }
      } catch (auditErr) {
        console.error(
          "[cancel-subscription] audit insert failed (Stripe update already committed):",
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }

      return json(
        {
          ok: true,
          cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
          currentPeriodEnd,
          status: updated.status,
        },
        200,
      );
    } catch (stripeErr) {
      const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
      console.error("[cancel-subscription] Stripe error:", msg);
      return json({ error: msg, reason: "stripe_error" }, 502);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[cancel-subscription] Error:", errorMessage);
    return json({ error: errorMessage }, 500);
  }
});
