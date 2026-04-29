import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Default CORS headers for backwards compatibility
const corsHeaders = getCorsHeaders(null);

// Stripe price IDs for each plan
const PRICE_IDS: Record<string, string> = {
  starter:  "price_1SntpyH03PByDjY31dGmC0E2",
  business: "price_1SntqQH03PByDjY3MrvOjOsu",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const { planId, workspaceId } = await req.json();
    
    if (!planId || !PRICE_IDS[planId]) {
      throw new Error(`Invalid plan: ${planId}`);
    }
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }

    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");

    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from("workspaces")
      .select("id, owner_id")
      .eq("id", workspaceId)
      .maybeSingle();

    if (workspaceError || !workspace) {
      throw new Error("Workspace not found");
    }

    let canManageBilling = workspace.owner_id === user.id;
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
      throw new Error("You do not have permission to manage billing for this workspace");
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Check if a Stripe customer record exists for this user
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }

    const origin = req.headers.get("origin") || "http://localhost:5173";
    
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price: PRICE_IDS[planId],
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${origin}/app/settings/account?tab=subscription&checkout=success`,
      cancel_url: `${origin}/app/settings/account?tab=subscription&checkout=canceled`,
      metadata: {
        plan_id: planId,
      },
      subscription_data: {
        metadata: {
          workspace_id: workspaceId,
          plan_id: planId,
        },
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[CREATE-CHECKOUT] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
