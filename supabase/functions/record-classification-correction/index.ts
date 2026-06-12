// record-classification-correction — Tier 2 Phase 4
//
// Captures workspace-member corrections to the AI classifier's output
// for the in-context-learning loop. Each correction is appended to
// classification_corrections (workspace-scoped, append-only). The
// classifier's next call for this workspace will fetch the most
// recent corrections and inject them as few-shot examples in the
// Haiku system prompt — the same in-context augmentation pattern
// already shipped for risk_templates.
//
// AUTH: verify_jwt = true (default). Caller must be a workspace
// member. The edge function uses service-role internally to bypass
// RLS for the insert, but checks membership explicitly first.
//
// REQUEST BODY (POST JSON):
//   {
//     workspaceId: string,
//     leaseId?: string,            // optional, ON DELETE SET NULL on the FK
//     originalClassification: object,
//     correctedClassification: object,
//     correctionType: 'is_lease_override' | 'asset_type_changed' |
//                     'lease_type_changed' | 'parent_lease_changed' |
//                     'general_correction',
//     userNote?: string,           // human-readable reasoning
//     documentSummary?: string,    // filename + brief field summary
//   }
//
// RESPONSE:
//   { ok: true, correctionId: string } | { ok: false, error: string }

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const VALID_CORRECTION_TYPES = new Set([
  "is_lease_override",
  "asset_type_changed",
  "lease_type_changed",
  "parent_lease_changed",
  "general_correction",
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 1000;
const MAX_SUMMARY_LENGTH = 500;

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication" }, 401, origin);
  }
  const user = userData.user;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, origin);
  }

  const {
    workspaceId,
    leaseId,
    originalClassification,
    correctedClassification,
    correctionType,
    userNote,
    documentSummary,
  } = body ?? {};

  // Validate inputs
  if (!workspaceId || typeof workspaceId !== "string" || !UUID_REGEX.test(workspaceId)) {
    return jsonResponse({ ok: false, error: "workspaceId is required and must be a UUID" }, 400, origin);
  }
  if (leaseId !== undefined && leaseId !== null && (typeof leaseId !== "string" || !UUID_REGEX.test(leaseId))) {
    return jsonResponse({ ok: false, error: "leaseId, when provided, must be a UUID" }, 400, origin);
  }
  if (!correctionType || !VALID_CORRECTION_TYPES.has(correctionType)) {
    return jsonResponse({
      ok: false,
      error: `correctionType must be one of: ${Array.from(VALID_CORRECTION_TYPES).join(", ")}`,
    }, 400, origin);
  }
  if (!originalClassification || typeof originalClassification !== "object") {
    return jsonResponse({ ok: false, error: "originalClassification must be an object" }, 400, origin);
  }
  if (!correctedClassification || typeof correctedClassification !== "object") {
    return jsonResponse({ ok: false, error: "correctedClassification must be an object" }, 400, origin);
  }
  if (userNote !== undefined && userNote !== null && (typeof userNote !== "string" || userNote.length > MAX_NOTE_LENGTH)) {
    return jsonResponse({ ok: false, error: `userNote must be a string ≤ ${MAX_NOTE_LENGTH} chars` }, 400, origin);
  }
  if (documentSummary !== undefined && documentSummary !== null && (typeof documentSummary !== "string" || documentSummary.length > MAX_SUMMARY_LENGTH)) {
    return jsonResponse({ ok: false, error: `documentSummary must be a string ≤ ${MAX_SUMMARY_LENGTH} chars` }, 400, origin);
  }

  // Authorize — caller must be a workspace member or owner
  const { data: workspace, error: workspaceError } = await supabaseAdmin
    .from("workspaces")
    .select("id, owner_id")
    .eq("id", workspaceId)
    .maybeSingle();

  if (workspaceError || !workspace) {
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

  // Vault V1: corrections are workspace data writes — a non-live workspace
  // (canceled / soft-deleted / vault) is read-only.
  const liveness = await checkWorkspaceLive(supabaseAdmin, workspaceId);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // If leaseId provided, verify it belongs to the same workspace
  // (defense-in-depth; the FK is ON DELETE SET NULL not RESTRICT).
  if (leaseId) {
    const { data: lease } = await supabaseAdmin
      .from("leases")
      .select("workspace_id")
      .eq("id", leaseId)
      .maybeSingle();
    if (!lease || lease.workspace_id !== workspaceId) {
      return jsonResponse(
        { ok: false, error: "leaseId does not belong to the specified workspace" },
        400,
        origin,
      );
    }
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("classification_corrections")
    .insert({
      workspace_id: workspaceId,
      lease_id: leaseId ?? null,
      original_classification: originalClassification,
      corrected_classification: correctedClassification,
      correction_type: correctionType,
      user_note: userNote ?? null,
      document_summary: documentSummary ?? null,
      corrected_by: user.id,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("[record-classification-correction] insert failed:", insertError?.message);
    return jsonResponse(
      { ok: false, error: insertError?.message ?? "Failed to record correction" },
      500,
      origin,
    );
  }

  // Best-effort activity log entry (CHECK migration may not be live;
  // see migration 20260507240000 which adds tier2_correction_recorded).
  if (leaseId) {
    try {
      const { error: activityErr } = await supabaseAdmin.from("lease_activity_log").insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: "tier2_correction_recorded",
        details: {
          correction_id: inserted.id,
          correction_type: correctionType,
          original: originalClassification,
          corrected: correctedClassification,
          user_note: userNote ?? null,
        },
      });
      if (activityErr) {
        console.warn(
          "[record-classification-correction] activity log insert failed:",
          activityErr.message,
        );
      }
    } catch (e) {
      console.warn("[record-classification-correction] activity log insert threw:", e);
    }
  }

  return jsonResponse({ ok: true, correctionId: inserted.id }, 200, origin);
});
