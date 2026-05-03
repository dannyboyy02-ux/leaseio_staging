// resolve-approval-chain — Phase 2
//
// Called by LeaseRequestForm submission (and by Phase 6 rerouting later).
// Loads policy attributes from the lease, finds the matching approval
// policy, snapshots it into lease_approval_chain, and returns the first
// stage's assignees so the caller can notify them.
//
// Critical guarantees:
//   - The chain INSERT is atomic. If anything fails before or during the
//     insert (separation violation, ambiguous match, DB error, anything)
//     no chain rows land. The lease state is the caller's concern; this
//     function only reports the failure (with chain_resolution_failed).
//   - Idempotent on initialResolution=true: if the lease already has any
//     chain rows, return success without inserting (handles flaky-network
//     retries from the form).
//
// See docs/PHASE_2_BUILD_SPEC.md for the full contract.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  type ChainStepLike,
  checkSeparationOfDuties,
  getEffectiveSeparationOfDuties,
} from "../_shared/approval_chain.ts";

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
  leaseId: string;
  initialResolution: boolean;
}

interface PolicyRow {
  id: string;
  workspace_id: string;
  name: string;
  priority: number;
  match_asset_types: string[];
  match_departments: string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
  match_regions: string[];
  match_lease_types: string[];
  separation_of_duties_override: boolean | null;
  is_default_fallback: boolean;
  version: number;
  is_active: boolean;
  created_at: string;
}

interface PolicyStepRow {
  stage: "concept" | "signator";
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days: number | null;
  is_required: boolean;
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
      { ok: false, error: "Unauthorized", reason: "forbidden" },
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
      { ok: false, error: "Invalid authentication", reason: "forbidden" },
      401,
      origin,
    );
  }

  const user = userData.user;

  // Best-effort logger that won't throw on bad activity_type.
  async function logActivity(
    leaseId: string,
    activityType: string,
    details: Record<string, unknown>,
  ) {
    const { error } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: activityType,
        details,
      });
    if (error) {
      console.error("[resolve-approval-chain] activity log error:", error.message);
    }
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body", reason: "invalid_lease" },
      400,
      origin,
    );
  }

  const leaseId = body?.leaseId;
  const initialResolution = body?.initialResolution ?? true;
  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse(
      { ok: false, error: "leaseId is required", reason: "invalid_lease" },
      400,
      origin,
    );
  }

  // Load lease + verify workspace membership.
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select(
      "id, workspace_id, asset_type, lease_type, requesting_department, region, monthly_payment",
    )
    .eq("id", leaseId)
    .maybeSingle();
  if (leaseError || !lease) {
    return jsonResponse(
      { ok: false, error: "Lease not found", reason: "invalid_lease" },
      404,
      origin,
    );
  }

  const workspaceId = (lease as any).workspace_id as string;

  const { data: ownership } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const isOwner = (ownership as any)?.owner_id === user.id;
  let isMember = isOwner;
  if (!isMember) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    isMember = Boolean(member);
  }
  if (!isMember) {
    return jsonResponse(
      { ok: false, error: "Forbidden", reason: "forbidden" },
      403,
      origin,
    );
  }

  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "resolve-approval-chain",
    origin,
    60,
  );
  if (rateLimitResponse) return rateLimitResponse;

  // Idempotency: initial resolution + chain already exists → return ok.
  if (initialResolution) {
    const { count: existingCount } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("id", { count: "exact", head: true })
      .eq("lease_id", leaseId);
    if ((existingCount ?? 0) > 0) {
      return jsonResponse(
        {
          ok: true,
          alreadyResolved: true,
          message: "Chain already exists for this lease",
        },
        200,
        origin,
      );
    }
  }

  // Extract policy-triggering attributes.
  const assetType = (lease as any).asset_type ?? "";
  const department = (lease as any).requesting_department ?? "";
  const region = (lease as any).region ?? "";
  const leaseType = (lease as any).lease_type ?? "";
  const monthly = (lease as any).monthly_payment;
  const annualCost = typeof monthly === "number" && monthly > 0 ? monthly * 12 : 0;

  // Load all active policies for the workspace; do matching in TS so we
  // can detect ambiguity and decide between fallback / no_match / legacy
  // in a single pass.
  const { data: policies, error: policiesError } = await supabaseAdmin
    .from("approval_policies")
    .select(
      "id, workspace_id, name, priority, match_asset_types, match_departments, match_min_annual_cost, match_max_annual_cost, match_regions, match_lease_types, separation_of_duties_override, is_default_fallback, version, is_active, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (policiesError) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "policy_load_failed",
      error: policiesError.message,
    });
    return jsonResponse(
      { ok: false, error: policiesError.message, reason: "invalid_lease" },
      500,
      origin,
    );
  }

  const allPolicies = (policies ?? []) as PolicyRow[];

  // Workspace has no policies at all → caller falls back to legacy flow.
  if (allPolicies.length === 0) {
    return jsonResponse(
      {
        ok: true,
        legacyFallback: true,
        message:
          "No approval policies configured; caller should use legacy notification path.",
      },
      200,
      origin,
    );
  }

  function policyMatches(p: PolicyRow): boolean {
    if (p.match_asset_types.length > 0 && !p.match_asset_types.includes(assetType)) {
      return false;
    }
    if (
      p.match_departments.length > 0 &&
      !p.match_departments.includes(department)
    ) {
      return false;
    }
    if (p.match_min_annual_cost != null && annualCost < p.match_min_annual_cost) {
      return false;
    }
    if (p.match_max_annual_cost != null && annualCost > p.match_max_annual_cost) {
      return false;
    }
    if (p.match_regions.length > 0 && !p.match_regions.includes(region)) {
      return false;
    }
    if (
      p.match_lease_types.length > 0 &&
      !p.match_lease_types.includes(leaseType)
    ) {
      return false;
    }
    return true;
  }

  // Sort matched policies by priority desc, created_at asc.
  const matched = allPolicies
    .filter(policyMatches)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at.localeCompare(b.created_at);
    });

  // Detect tie at top priority.
  if (matched.length >= 2 && matched[0].priority === matched[1].priority) {
    const tied = matched
      .filter((p) => p.priority === matched[0].priority)
      .map((p) => ({ id: p.id, name: p.name }));
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "ambiguous_match",
      tied_policy_ids: tied.map((t) => t.id),
    });
    return jsonResponse(
      {
        ok: false,
        error: "Multiple policies tied at top priority. Ask an admin to disambiguate.",
        reason: "ambiguous_match",
        details: { tiedPolicies: tied },
      },
      409,
      origin,
    );
  }

  // Pick winner; if no specific match, look for default fallback.
  let chosen: PolicyRow | undefined = matched[0];
  if (!chosen) {
    chosen = allPolicies.find((p) => p.is_default_fallback === true);
    if (!chosen) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "no_match_no_fallback",
      });
      return jsonResponse(
        {
          ok: false,
          error:
            "No matching policy and no default fallback configured. Ask an admin to add a fallback or a matching policy.",
          reason: "no_match_no_fallback",
        },
        409,
        origin,
      );
    }
  }

  // Load chosen policy's chain steps.
  const { data: stepsData, error: stepsError } = await supabaseAdmin
    .from("approval_chain_steps")
    .select(
      "stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required",
    )
    .eq("policy_id", chosen.id)
    .order("stage")
    .order("step_order")
    .order("parallel_group");
  if (stepsError) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "steps_load_failed",
      policy_id: chosen.id,
      error: stepsError.message,
    });
    return jsonResponse(
      { ok: false, error: stepsError.message, reason: "invalid_lease" },
      500,
      origin,
    );
  }

  const policySteps = (stepsData ?? []) as PolicyStepRow[];
  if (policySteps.length === 0) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "policy_has_no_steps",
      policy_id: chosen.id,
    });
    return jsonResponse(
      {
        ok: false,
        error: "Selected policy has no chain steps configured.",
        reason: "no_match_no_fallback",
        details: { policyId: chosen.id, policyName: chosen.name },
      },
      409,
      origin,
    );
  }

  // Separation-of-duties enforcement (workspace default + policy override).
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("separation_of_duties_default")
    .eq("id", workspaceId)
    .maybeSingle();
  const wsSod = Boolean(
    (ws as any)?.separation_of_duties_default ?? true,
  );
  const sodEffective = getEffectiveSeparationOfDuties(
    wsSod,
    chosen.separation_of_duties_override,
  );
  // Build lightweight ChainStepLike rows for the SoD check.
  const sodCheckSteps: ChainStepLike[] = policySteps.map((s) => ({
    stage: s.stage,
    step_order: s.step_order,
    parallel_group: s.parallel_group,
    approver_user_id: s.approver_user_id,
    approver_role: s.approver_role,
    is_required: s.is_required,
    status: "pending",
  }));
  const violator = checkSeparationOfDuties(sodCheckSteps, sodEffective);
  if (violator) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "separation_violation",
      policy_id: chosen.id,
      conflicting_user_id: violator,
    });
    return jsonResponse(
      {
        ok: false,
        error:
          "Separation of duties violated: the same user appears in multiple steps. Ask an admin to fix the policy.",
        reason: "separation_violation",
        details: { conflictingUserId: violator, policyId: chosen.id },
      },
      409,
      origin,
    );
  }

  // Build the rows to insert. Single multi-row insert via PostgREST is
  // a single transaction — atomic per spec.
  const rowsToInsert = policySteps.map((s) => ({
    lease_id: leaseId,
    workspace_id: workspaceId,
    policy_id: chosen!.id,
    policy_version: chosen!.version,
    stage: s.stage,
    step_order: s.step_order,
    parallel_group: s.parallel_group,
    approver_user_id: s.approver_user_id,
    approver_role: s.approver_role,
    delegate_user_id: s.delegate_user_id,
    delegate_after_days: s.delegate_after_days,
    is_required: s.is_required,
    status: "pending",
  }));

  const { error: insertError } = await supabaseAdmin
    .from("lease_approval_chain")
    .insert(rowsToInsert);
  if (insertError) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "chain_insert_failed",
      policy_id: chosen.id,
      error: insertError.message,
    });
    return jsonResponse(
      {
        ok: false,
        error: `Failed to write chain: ${insertError.message}`,
        reason: "invalid_lease",
      },
      500,
      origin,
    );
  }

  // Activity log: chain_resolved (best-effort; the chain is the truth).
  // Also emit Phase 3 concept_stage_entered — this is the moment the
  // chain lease enters the concept stage. Both are best-effort, written
  // in sequence; failures of one do not block the other.
  await logActivity(leaseId, "chain_resolved", {
    policy_id: chosen.id,
    policy_name: chosen.name,
    policy_version: chosen.version,
    steps_created: rowsToInsert.length,
    used_default_fallback: matched.length === 0,
    target_lifecycle_status: "concept_submitted",
  });
  await logActivity(leaseId, "concept_stage_entered", {
    policy_id: chosen.id,
    policy_version: chosen.version,
  });

  // Compute the first-stage first-step assignees for the caller's
  // notification step. "First active level" = lowest step_order in
  // 'concept' that has any pending required step.
  const conceptSteps = policySteps.filter(
    (s) => s.stage === "concept" && s.is_required,
  );
  const firstOrder = conceptSteps.length > 0
    ? Math.min(...conceptSteps.map((s) => s.step_order))
    : null;
  const firstStepAssignees = firstOrder == null
    ? []
    : conceptSteps
      .filter((s) => s.step_order === firstOrder)
      .map((s) => ({
        userId: s.approver_user_id,
        role: s.approver_role,
      }));

  return jsonResponse(
    {
      ok: true,
      legacyFallback: false,
      policyId: chosen.id,
      policyVersion: chosen.version,
      policyName: chosen.name,
      stepsCreated: rowsToInsert.length,
      firstStepAssignees,
      // Phase 3: forward-compat hint for the caller. LeaseRequestForm in
      // Checkpoint 4 will read this and flip the lease to
      // 'concept_submitted' (chain vocabulary). Until then this field
      // is ignored.
      targetLifecycleStatus: "concept_submitted",
    },
    200,
    origin,
  );
});
