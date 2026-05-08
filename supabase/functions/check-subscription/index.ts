import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Default CORS headers for backwards compatibility
const corsHeaders = getCorsHeaders(null);

// Map Stripe product IDs to plan names
const PRODUCT_TO_PLAN: Record<string, string> = {
  "prod_TlQhMebFLbmsbR": "starter",
  "prod_TlQhRntCDhkxfK": "business",
};

// A subscription is "subscribed" while it's actively granting access —
// active OR trialing. Stripe statuses past_due, unpaid, canceled,
// incomplete, etc. are NOT treated as subscribed; the UI handles them
// as failure or grace states.
const SUBSCRIBED_STATUSES = new Set(["active", "trialing"]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length === 0) {
      return new Response(JSON.stringify({
        subscribed: false,
        plan: "starter",
        status: null,
        billing_interval: null,
        trial_end: null,
        subscription_end: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    // Drop the active-only filter — the previous code missed `trialing`
    // subscriptions, which after the 7-day trial wiring are the
    // most common state for new sign-ups during their first week.
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return new Response(JSON.stringify({
        subscribed: false,
        plan: "starter",
        status: null,
        billing_interval: null,
        trial_end: null,
        subscription_end: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const subscription = subscriptions.data[0];
    const productId = subscription.items.data[0].price.product as string;
    const plan = PRODUCT_TO_PLAN[productId] ?? "starter";
    const recurringInterval = subscription.items.data[0].price.recurring?.interval;
    const billingInterval = recurringInterval === "year" ? "annual" : "monthly";
    const subscribed = SUBSCRIBED_STATUSES.has(subscription.status);
    const subscriptionEnd = (subscription as any).current_period_end
      ? new Date((subscription as any).current_period_end * 1000).toISOString()
      : null;
    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null;

    return new Response(JSON.stringify({
      subscribed,
      plan: subscribed ? plan : "starter",
      status: subscription.status,
      billing_interval: billingInterval,
      trial_end: trialEnd,
      subscription_end: subscriptionEnd,
      subscription_id: subscription.id,
      customer_id: customerId,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[CHECK-SUBSCRIPTION] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
