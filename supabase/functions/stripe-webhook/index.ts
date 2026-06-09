import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const PRICE_IDS: Record<string, string> = {
  starter: "price_1SntpyH03PByDjY31dGmC0E2",
  business: "price_1SntqQH03PByDjY3MrvOjOsu",
};

const DOCUMENT_LIMITS: Record<string, number> = {
  starter: 15,
  business: 50,
};

const jsonHeaders = { "Content-Type": "application/json" };

function validPlan(plan: unknown): plan is "starter" | "business" {
  return plan === "starter" || plan === "business";
}

function resolvePlan(subscription: Stripe.Subscription): "starter" | "business" {
  const metadataPlan = subscription.metadata?.plan_id;
  if (validPlan(metadataPlan)) return metadataPlan;

  const priceId = subscription.items.data[0]?.price?.id;
  const matchedPlan = Object.entries(PRICE_IDS).find(([, id]) => id === priceId)?.[0];
  return validPlan(matchedPlan) ? matchedPlan : "starter";
}

function resolveInterval(subscription: Stripe.Subscription): "monthly" | "annual" {
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  return interval === "year" ? "annual" : "monthly";
}

function resolveCustomerId(subscription: Stripe.Subscription): string | null {
  const customer = subscription.customer;
  if (typeof customer === "string") return customer;
  return customer?.id ?? null;
}

function resolvePeriodEnd(subscription: Stripe.Subscription): string | null {
  const periodEnd = (subscription as any).current_period_end;
  return typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing Stripe signature" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Invalid signature:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Invalid Stripe signature" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  async function applySubscription(subscription: Stripe.Subscription, workspaceIdOverride?: string | null) {
    const workspaceId = workspaceIdOverride || subscription.metadata?.workspace_id;
    if (!workspaceId) {
      console.warn("[stripe-webhook] Subscription event missing workspace_id", subscription.id);
      return;
    }

    const requestedPlan = resolvePlan(subscription);
    const entitled = subscription.status === "active" || subscription.status === "trialing";
    const effectivePlan = entitled ? requestedPlan : "starter";

    const { error } = await supabaseAdmin
      .from("workspaces")
      .update({
        plan: effectivePlan,
        document_limit: DOCUMENT_LIMITS[effectivePlan],
        billing_interval: resolveInterval(subscription),
        stripe_customer_id: resolveCustomerId(subscription),
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        subscription_period_end: resolvePeriodEnd(subscription),
      })
      .eq("id", workspaceId);

    if (error) throw new Error(`Failed to update workspace subscription: ${error.message}`);

    // Reconcile the multi-workspace creation request and log the activation
    // exactly once, on the pending -> active transition. The first/onboarding
    // workspace has no workspace_creation_requests row, so this is naturally
    // scoped to additional workspaces created via create-workspace. The webhook
    // remains the SOLE entitlement writer; this only records the activation
    // event (append-only audit) and advances the request state machine off
    // 'pending' (which nothing else does on the happy path).
    if (entitled) {
      // Best-effort audit/state reconciliation — NOT entitlement-critical (the
      // entitlement update above already committed). Wrapped so a transient
      // failure here can never 500 the webhook and force needless Stripe
      // retries of a successful entitlement write.
      try {
        const { data: reqRow } = await supabaseAdmin
          .from("workspace_creation_requests")
          .select("idempotency_key, status")
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        if (reqRow && (reqRow as { status: string }).status === "pending") {
          await supabaseAdmin
            .from("workspace_creation_requests")
            .update({ status: "active", updated_at: new Date().toISOString() })
            .eq("workspace_id", workspaceId);
          const { data: wsRow } = await supabaseAdmin
            .from("workspaces")
            .select("owner_id")
            .eq("id", workspaceId)
            .maybeSingle();
          const ownerId = (wsRow as { owner_id: string } | null)?.owner_id ?? null;
          if (!ownerId) {
            console.warn("[stripe-webhook] activated event: owner lookup missed for", workspaceId);
          }
          await supabaseAdmin.from("workspace_activity_log").insert({
            workspace_id: workspaceId,
            user_id: ownerId,
            event_type: "activated",
            details: {
              subscription_id: subscription.id,
              status: subscription.status,
              idempotency_key: (reqRow as { idempotency_key: string }).idempotency_key,
            },
          });
        }
      } catch (reconErr) {
        console.error(
          "[stripe-webhook] reconciliation (non-fatal) failed for",
          workspaceId,
          reconErr instanceof Error ? reconErr.message : reconErr,
        );
      }
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const workspaceId = session.metadata?.workspace_id ?? null;
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
        if (!subscriptionId) break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await applySubscription(subscription, workspaceId);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      }

      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error("[stripe-webhook] Handler error:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Webhook handler failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
