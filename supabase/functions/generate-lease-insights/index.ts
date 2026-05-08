// generate-lease-insights — Tier 3 contextual intelligence (Phase 1 v1)
//
// Generates Sonnet-powered insights that compare a single lease against
// the workspace's broader portfolio. Triggered manually for v1; auto-
// trigger on lifecycle events (model_locked, amendment_confirmed) is v2.
//
// Authorization:
//   - Bearer JWT (verify_jwt = true). Caller must be a workspace member.
//   - Business-tier-only. starter-plan workspaces get 403.
//
// Data flow:
//   1. Authenticate caller, verify workspace membership and Business tier
//   2. Load the lease (id, workspace, extracted_json, key fields)
//   3. Load workspace portfolio context (medians, ranges, common patterns
//      across the user's other leases — bounded for prompt size)
//   4. Build a structured Sonnet prompt asking for at most 5 meaningful
//      insights, each with insight_type / severity / title / body / source_data
//   5. Persist the response to lease_insights (workspace_id, lease_id,
//      generated_model, triggered_by). Return generated insights.
//
// Cost (Sonnet 4.6):
//   ~$0.04-0.08 per call depending on portfolio size. Bounded by capping
//   the portfolio context at the most-recent 50 leases' aggregates only
//   (no full extracted_json from siblings — just key numeric fields).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const MAX_PORTFOLIO_LEASES = 50;
const MAX_INSIGHTS_PER_CALL = 5;

const SONNET_SYSTEM = `You are a portfolio analyst for a finance team's commercial lease portfolio. You analyze ONE lease in the context of the team's broader portfolio and identify meaningful contextual insights.

The user provides:
1. The lease being analyzed (key extracted fields)
2. Aggregate statistics for the rest of the workspace's portfolio
3. Optionally: the parent lease (for amendments)

Your job is to surface insights a finance reviewer should know that AREN'T obvious from looking at the lease alone — context that requires comparison with the portfolio.

Generate AT MOST ${MAX_INSIGHTS_PER_CALL} insights. Quality > quantity. If there's nothing notable, return an empty array. Don't pad.

For each insight, output:
- insight_type: one of [portfolio_norm_deviation, amendment_impact, renewal_proximity, risk_pattern_match, general_observation]
- severity: one of [info, notice, concern]
- title: 5-12 words, plain English
- body: 1-3 sentences, plain English explanation grounded in the data
- source_data: object with the specific numbers / fields you cited (so the user can verify)

Severity guidance:
- info: Worth noting but not actionable (e.g., "rent is in line with workspace norm")
- notice: Worth reviewing (e.g., "rent escalation is 50% above workspace median; verify this is intentional")
- concern: Worth flagging to leadership (e.g., "renewal window opens in 60 days; no decision recorded")

Return ONLY valid JSON: { "insights": [...] }`;

async function callSonnet(systemPrompt: string, userContent: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content || typeof content !== "string") {
    throw new Error("Anthropic response missing content");
  }
  return content;
}

function safeJsonParse(text: string): any {
  // Strip leading code-fence wrappers if present
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(trimmed);
}

interface ExtractedField {
  value?: unknown;
}

function extractValue(field: unknown): unknown {
  if (field === null || field === undefined) return null;
  if (typeof field === "object" && "value" in (field as object)) {
    return (field as ExtractedField).value;
  }
  return field;
}

const VALID_INSIGHT_TYPES = new Set([
  "portfolio_norm_deviation",
  "amendment_impact",
  "renewal_proximity",
  "risk_pattern_match",
  "general_observation",
]);
const VALID_SEVERITIES = new Set(["info", "notice", "concern"]);

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey || !ANTHROPIC_API_KEY) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication" }, 401, origin);
  }
  const user = userData.user;

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, origin); }

  const leaseId: string | undefined = body?.leaseId;
  const triggeredBy: string = body?.triggeredBy === "model_locked" ? "model_locked"
    : body?.triggeredBy === "amendment_confirmed" ? "amendment_confirmed"
    : "manual";

  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse({ ok: false, error: "leaseId is required" }, 400, origin);
  }

  // Load the lease
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id, lease_type, parent_lease_id, asset_type, request_title, filename, tenant_name, landlord_name, property_address, lease_start, lease_end, term_months, current_monthly_rent, monthly_payment, escalation_type, escalation_rate, security_deposit, calc_total_commitment, calc_pv_liability, lifecycle_status, model_locked, extracted_json")
    .eq("id", leaseId)
    .maybeSingle();

  if (leaseError || !lease) {
    return jsonResponse({ ok: false, error: "Lease not found" }, 404, origin);
  }

  // Authorize — caller must be a workspace member
  const workspaceId = lease.workspace_id as string;
  const { data: workspace } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id, plan")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    return jsonResponse({ ok: false, error: "Workspace not found" }, 404, origin);
  }

  let isAuthorized = workspace.owner_id === user.id;
  if (!isAuthorized) {
    const { data: membership } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    isAuthorized = Boolean(membership);
  }
  if (!isAuthorized) {
    return jsonResponse({ ok: false, error: "Not a member of this workspace" }, 403, origin);
  }

  // Tier gate — Business plan only.
  if (workspace.plan !== "business") {
    return jsonResponse({
      ok: false,
      error: "Portfolio insights are available on the Business plan.",
      reason: "tier_gate",
    }, 403, origin);
  }

  // Load portfolio context — aggregate stats across other leases in the
  // workspace. Bounded; no full extracted_json from siblings (cost control).
  const { data: portfolioRows } = await supabaseAdmin
    .from("leases")
    .select("id, asset_type, monthly_payment, current_monthly_rent, term_months, lease_start, lease_end, escalation_rate, calc_total_commitment, lifecycle_status")
    .eq("workspace_id", workspaceId)
    .neq("id", leaseId)
    .eq("archived", false)
    .order("created_at", { ascending: false } as any)
    .limit(MAX_PORTFOLIO_LEASES);

  const siblings = (portfolioRows ?? []) as Array<Record<string, any>>;

  // Compute simple aggregates for the prompt
  const monthlyValues = siblings
    .map((s) => Number(s.monthly_payment ?? s.current_monthly_rent))
    .filter((n) => Number.isFinite(n) && n > 0);
  const termValues = siblings.map((s) => Number(s.term_months)).filter((n) => Number.isFinite(n) && n > 0);
  const escalationValues = siblings.map((s) => Number(s.escalation_rate)).filter((n) => Number.isFinite(n) && n > 0);
  const commitmentValues = siblings.map((s) => Number(s.calc_total_commitment)).filter((n) => Number.isFinite(n) && n > 0);

  function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  const portfolioContext = {
    sample_size: siblings.length,
    monthly_payment: {
      median: median(monthlyValues),
      min: monthlyValues.length ? Math.min(...monthlyValues) : null,
      max: monthlyValues.length ? Math.max(...monthlyValues) : null,
    },
    term_months: {
      median: median(termValues),
      min: termValues.length ? Math.min(...termValues) : null,
      max: termValues.length ? Math.max(...termValues) : null,
    },
    escalation_rate: {
      median: median(escalationValues),
      max: escalationValues.length ? Math.max(...escalationValues) : null,
    },
    total_commitment: {
      median: median(commitmentValues),
      max: commitmentValues.length ? Math.max(...commitmentValues) : null,
    },
    asset_types: Array.from(new Set(siblings.map((s) => s.asset_type).filter(Boolean))),
  };

  // Optional: parent lease summary if this is an amendment
  let parentLeaseContext: any = null;
  if (lease.parent_lease_id) {
    const { data: parent } = await supabaseAdmin
      .from("leases")
      .select("id, request_title, tenant_name, landlord_name, property_address, lease_start, lease_end, term_months, monthly_payment, escalation_rate")
      .eq("id", lease.parent_lease_id)
      .maybeSingle();
    if (parent) parentLeaseContext = parent;
  }

  // Build user prompt — compact, structured
  const ej = (lease.extracted_json ?? {}) as Record<string, unknown>;
  const leaseSummary = {
    id: lease.id,
    asset_type: lease.asset_type,
    lease_type: lease.lease_type,
    title: lease.request_title || lease.filename,
    parties: {
      tenant: extractValue(ej.tenant_name) ?? lease.tenant_name,
      landlord: extractValue(ej.landlord_name) ?? lease.landlord_name,
    },
    property: extractValue(ej.property_address) ?? lease.property_address,
    dates: {
      start: lease.lease_start,
      end: lease.lease_end,
      term_months: lease.term_months,
    },
    economics: {
      monthly_payment: lease.monthly_payment ?? lease.current_monthly_rent,
      escalation_type: lease.escalation_type,
      escalation_rate: lease.escalation_rate,
      total_commitment: lease.calc_total_commitment,
      pv_liability: lease.calc_pv_liability,
      security_deposit: extractValue(ej.security_deposit),
    },
    lifecycle_status: lease.lifecycle_status,
  };

  const userContent = JSON.stringify(
    {
      lease: leaseSummary,
      portfolio_context: portfolioContext,
      parent_lease: parentLeaseContext,
    },
    null,
    2,
  );

  // Call Sonnet
  let raw: string;
  try {
    raw = await callSonnet(SONNET_SYSTEM, userContent);
  } catch (err) {
    console.error("[generate-lease-insights] Sonnet call failed:", err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "AI call failed" },
      502,
      origin,
    );
  }

  let parsed: any;
  try { parsed = safeJsonParse(raw); } catch (err) {
    console.error("[generate-lease-insights] Failed to parse Sonnet output:", err);
    return jsonResponse(
      { ok: false, error: "AI returned invalid JSON", raw: raw.slice(0, 500) },
      502,
      origin,
    );
  }

  const rawInsights = Array.isArray(parsed?.insights) ? parsed.insights : [];

  // Validate + sanitize. Drop anything that doesn't fit the bounded shape.
  const cleanInsights = (rawInsights as any[]).slice(0, MAX_INSIGHTS_PER_CALL).flatMap((ins) => {
    if (!ins || typeof ins !== "object") return [];
    const insight_type = VALID_INSIGHT_TYPES.has(ins.insight_type) ? ins.insight_type : "general_observation";
    const severity = VALID_SEVERITIES.has(ins.severity) ? ins.severity : "info";
    const title = typeof ins.title === "string" ? ins.title.trim().slice(0, 120) : "";
    const bodyText = typeof ins.body === "string" ? ins.body.trim().slice(0, 1000) : "";
    if (!title || !bodyText) return [];
    const source_data = ins.source_data && typeof ins.source_data === "object" ? ins.source_data : {};
    return [{
      workspace_id: workspaceId,
      lease_id: leaseId,
      insight_type,
      severity,
      title,
      body: bodyText,
      source_data,
      triggered_by: triggeredBy,
      generated_model: MODEL,
    }];
  });

  if (cleanInsights.length === 0) {
    // Sonnet found nothing notable — that's a valid signal. Return empty.
    return jsonResponse(
      { ok: true, insights: [], message: "No notable insights identified for this lease in the current portfolio context." },
      200,
      origin,
    );
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("lease_insights")
    .insert(cleanInsights)
    .select("id, insight_type, severity, title, body, source_data, generated_at");

  if (insertError) {
    console.error("[generate-lease-insights] insert failed:", insertError.message);
    return jsonResponse(
      { ok: false, error: `Failed to persist insights: ${insertError.message}` },
      500,
      origin,
    );
  }

  // Best-effort activity log entry — wrapped because the new
  // 'lease_insights_generated' activity_type is added in this same
  // migration; if migration is mid-rollout it may not yet be live.
  try {
    const { error: activityErr } = await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: leaseId,
      user_id: user.id,
      activity_type: "lease_insights_generated",
      details: {
        insight_count: cleanInsights.length,
        triggered_by: triggeredBy,
        model: MODEL,
      },
    });
    if (activityErr) {
      console.warn("[generate-lease-insights] activity log insert failed:", activityErr.message);
    }
  } catch (e) {
    console.warn("[generate-lease-insights] activity log insert threw:", e);
  }

  return jsonResponse({ ok: true, insights: inserted ?? [] }, 200, origin);
});
