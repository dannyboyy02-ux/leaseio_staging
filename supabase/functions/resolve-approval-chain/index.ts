// resolve-approval-chain — Phase 2 (initial resolution) + Phase 6 (reroute)
//
// Two modes selected by request body:
//   initialResolution: true  → matches policy, inserts chain rows, writes
//                              the first lease_attribute_snapshots row.
//                              Idempotent: existing chain → success no-op.
//   initialResolution: false → reroute mode. Loads the most recent snapshot,
//                              diffs against current lease attributes, and
//                              if a different policy now matches, reconciles
//                              the existing chain (preserve / supersede /
//                              add), rolls lifecycle back to the earliest
//                              unsatisfied stage (or `chain_violation` if
//                              the lease has executed), writes a fresh
//                              snapshot + reroute_event row, and clears
//                              `reroute_evaluation_pending`.
//   auditMode (Phase 6)      → reroute-mode dry-run. Detects a would-be
//                              reroute, writes a single `reroute_audit_run`
//                              activity row, and returns the diff. Does NOT
//                              modify chain rows, lifecycle, snapshots, or
//                              the flag. Used by reroute-audit-sweep.
//
// Critical guarantees:
//   - The initial chain INSERT is atomic. If anything fails before or
//     during it, no chain rows land.
//   - Idempotent on initialResolution=true: existing chain → return ok.
//   - Reroute reconciliation issues UPDATE (supersede) + INSERT (add)
//     separately. Each is atomic individually but the pair is not.
//     Failure modes are recovered by the trigger flag staying set so a
//     subsequent cron run retries.
//
// See docs/PHASE_2_BUILD_SPEC.md (initial) and docs/PHASE_6_BUILD_SPEC.md
// (reroute) for the full contract.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  type ChainStepLike,
  checkSeparationOfDuties,
  getEffectiveSeparationOfDuties,
  reconcileChainSteps,
  rollbackTargetForNewChain,
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
  // Phase 6 — reroute-only fields. Ignored on initialResolution=true.
  auditMode?: boolean;
  detectionMode?: "auto" | "manual_admin" | "manual_audit";
  triggerReason?: string;
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

interface LeaseAttrs {
  asset_type: string | null;
  lease_type: string | null;
  requesting_department: string | null;
  region: string | null;
  monthly_payment: number | null;
}

interface SnapshotRow {
  id: string;
  policy_id: string | null;
  policy_version: number | null;
  asset_type: string | null;
  lease_type: string | null;
  requesting_department: string | null;
  region: string | null;
  monthly_payment: number | null;
}

type MatchOutcome =
  | { kind: "no_policies" }
  | { kind: "ambiguous"; tied: { id: string; name: string }[] }
  | { kind: "no_match_no_fallback" }
  | { kind: "matched"; policy: PolicyRow; usedFallback: boolean };

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

  // Lifecycle Transition Convention helpers — used on every chain-driven
  // lifecycle update introduced by reroute mode.
  async function updateLifecycle(leaseId: string, newStatus: string) {
    const { error } = await supabaseAdmin
      .from("leases")
      .update({
        lifecycle_status: newStatus,
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", leaseId);
    if (error) {
      console.error("[resolve-approval-chain] lifecycle update error:", error.message);
    }
    return !error;
  }

  async function logStatusChange(
    leaseId: string,
    fromStatus: string,
    toStatus: string,
    extra: Record<string, unknown>,
  ) {
    const details = { from: fromStatus, to: toStatus, routing_path: "chain", ...extra };
    const { error } = await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: "status_change",
        from_status: fromStatus,
        to_status: toStatus,
        details,
      });
    if (error) {
      console.error("[resolve-approval-chain] status_change log error:", error.message);
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
  const auditMode = body?.auditMode === true;
  const detectionMode = body?.detectionMode ?? "auto";
  const triggerReason = body?.triggerReason ?? "attribute_change_detected";

  if (!leaseId || typeof leaseId !== "string") {
    return jsonResponse(
      { ok: false, error: "leaseId is required", reason: "invalid_lease" },
      400,
      origin,
    );
  }
  if (!["auto", "manual_admin", "manual_audit"].includes(detectionMode)) {
    return jsonResponse(
      { ok: false, error: "Invalid detectionMode", reason: "invalid_lease" },
      400,
      origin,
    );
  }

  // Load lease + verify workspace membership.
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select(
      "id, workspace_id, asset_type, lease_type, requesting_department, region, monthly_payment, lifecycle_status",
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
  const currentLifecycle = (lease as any).lifecycle_status as string;

  const { data: ownership } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id, separation_of_duties_default")
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

  const wsSod = Boolean((ownership as any)?.separation_of_duties_default ?? true);

  // Extract policy-triggering attributes from the live lease row.
  const liveAttrs: LeaseAttrs = {
    asset_type: (lease as any).asset_type ?? null,
    lease_type: (lease as any).lease_type ?? null,
    requesting_department: (lease as any).requesting_department ?? null,
    region: (lease as any).region ?? null,
    monthly_payment: (lease as any).monthly_payment ?? null,
  };
  const annualCost = typeof liveAttrs.monthly_payment === "number" && liveAttrs.monthly_payment > 0
    ? liveAttrs.monthly_payment * 12
    : 0;

  // ── Shared policy-matching helper ────────────────────────────────────
  async function matchPolicy(): Promise<MatchOutcome> {
    const { data: policies, error: policiesError } = await supabaseAdmin
      .from("approval_policies")
      .select(
        "id, workspace_id, name, priority, match_asset_types, match_departments, match_min_annual_cost, match_max_annual_cost, match_regions, match_lease_types, separation_of_duties_override, is_default_fallback, version, is_active, created_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("is_active", true);
    if (policiesError) throw new Error(policiesError.message);

    const allPolicies = (policies ?? []) as PolicyRow[];
    if (allPolicies.length === 0) return { kind: "no_policies" };

    const matched = allPolicies
      .filter((p) => {
        if (p.match_asset_types.length > 0 && !p.match_asset_types.includes(liveAttrs.asset_type ?? "")) return false;
        if (p.match_departments.length > 0 && !p.match_departments.includes(liveAttrs.requesting_department ?? "")) return false;
        if (p.match_min_annual_cost != null && annualCost < p.match_min_annual_cost) return false;
        if (p.match_max_annual_cost != null && annualCost > p.match_max_annual_cost) return false;
        if (p.match_regions.length > 0 && !p.match_regions.includes(liveAttrs.region ?? "")) return false;
        if (p.match_lease_types.length > 0 && !p.match_lease_types.includes(liveAttrs.lease_type ?? "")) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.created_at.localeCompare(b.created_at);
      });

    if (matched.length >= 2 && matched[0].priority === matched[1].priority) {
      const tied = matched
        .filter((p) => p.priority === matched[0].priority)
        .map((p) => ({ id: p.id, name: p.name }));
      return { kind: "ambiguous", tied };
    }

    const chosen = matched[0] ?? allPolicies.find((p) => p.is_default_fallback === true);
    if (!chosen) return { kind: "no_match_no_fallback" };
    return { kind: "matched", policy: chosen, usedFallback: matched.length === 0 };
  }

  // ── Snapshot writer (used by both initial and reroute success paths) ─
  async function writeSnapshot(policy: PolicyRow | null): Promise<void> {
    const { error } = await supabaseAdmin
      .from("lease_attribute_snapshots")
      .insert({
        lease_id: leaseId,
        workspace_id: workspaceId,
        policy_id: policy?.id ?? null,
        policy_version: policy?.version ?? null,
        asset_type: liveAttrs.asset_type,
        lease_type: liveAttrs.lease_type,
        requesting_department: liveAttrs.requesting_department,
        region: liveAttrs.region,
        monthly_payment: liveAttrs.monthly_payment,
        annual_cost_at_snapshot: annualCost,
        raw_attributes: {
          asset_type: liveAttrs.asset_type,
          lease_type: liveAttrs.lease_type,
          requesting_department: liveAttrs.requesting_department,
          region: liveAttrs.region,
          monthly_payment: liveAttrs.monthly_payment,
          annual_cost: annualCost,
        },
      });
    if (error) {
      console.error("[resolve-approval-chain] snapshot write error:", error.message);
    }
  }

  // ─── Branch: Phase 6 reroute mode ────────────────────────────────────
  if (!initialResolution) {
    // Load most recent snapshot
    const { data: snapData } = await supabaseAdmin
      .from("lease_attribute_snapshots")
      .select("id, policy_id, policy_version, asset_type, lease_type, requesting_department, region, monthly_payment")
      .eq("lease_id", leaseId)
      .order("chain_resolution_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const snapshot = snapData as SnapshotRow | null;

    // Diff attributes
    const changedAttributes: Record<string, { from: unknown; to: unknown }> = {};
    if (snapshot) {
      const fields: (keyof LeaseAttrs)[] = [
        "asset_type",
        "lease_type",
        "requesting_department",
        "region",
        "monthly_payment",
      ];
      for (const f of fields) {
        if (snapshot[f] !== liveAttrs[f]) {
          changedAttributes[f] = { from: snapshot[f], to: liveAttrs[f] };
        }
      }
    }

    if (Object.keys(changedAttributes).length === 0) {
      // No attribute change since last snapshot → nothing to do.
      // Clear the flag in case the trigger set it on a non-policy
      // attribute change (defensive; the trigger only fires on
      // policy-triggering attributes today, but the column might
      // get other writers later).
      if (!auditMode) {
        await supabaseAdmin
          .from("leases")
          .update({ reroute_evaluation_pending: false })
          .eq("id", leaseId);
      }
      return jsonResponse(
        { ok: true, no_reroute_needed: true, reason: "no_attribute_change" },
        200,
        origin,
      );
    }

    // Match new policy
    let matchResult: MatchOutcome;
    try {
      matchResult = await matchPolicy();
    } catch (e: any) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "policy_load_failed",
        error: e?.message ?? String(e),
        reroute_path: true,
      });
      return jsonResponse(
        { ok: false, error: e?.message ?? "Policy load failed", reason: "invalid_lease" },
        500,
        origin,
      );
    }

    if (matchResult.kind === "no_policies" || matchResult.kind === "no_match_no_fallback") {
      // Workspace lost its matching policy. Cannot reroute. Leave the
      // chain alone but clear the flag so we don't loop forever.
      if (!auditMode) {
        await supabaseAdmin
          .from("leases")
          .update({ reroute_evaluation_pending: false })
          .eq("id", leaseId);
      }
      await logActivity(leaseId, "chain_reroute_skipped_no_match", {
        reason: matchResult.kind,
        changed_attributes: changedAttributes,
        audit_mode: auditMode,
      });
      return jsonResponse(
        {
          ok: true,
          no_reroute_needed: true,
          reason: matchResult.kind,
          changed_attributes: changedAttributes,
        },
        200,
        origin,
      );
    }

    if (matchResult.kind === "ambiguous") {
      // Don't reroute — surface the same error initial resolution would.
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "ambiguous_match",
        tied_policy_ids: matchResult.tied.map((t) => t.id),
        reroute_path: true,
      });
      return jsonResponse(
        {
          ok: false,
          error: "Multiple policies tied at top priority during reroute. Ask an admin to disambiguate.",
          reason: "ambiguous_match",
          details: { tiedPolicies: matchResult.tied },
        },
        409,
        origin,
      );
    }

    const newPolicy = matchResult.policy;

    // If same policy + version as snapshot, the change was immaterial.
    if (
      snapshot &&
      snapshot.policy_id === newPolicy.id &&
      snapshot.policy_version === newPolicy.version
    ) {
      if (!auditMode) {
        await supabaseAdmin
          .from("leases")
          .update({ reroute_evaluation_pending: false })
          .eq("id", leaseId);
        // Refresh the snapshot so the next evaluation diffs from current.
        await writeSnapshot(newPolicy);
      }
      await logActivity(leaseId, "chain_reroute_skipped_no_match", {
        reason: "attribute_change_immaterial",
        changed_attributes: changedAttributes,
        policy_id: newPolicy.id,
        policy_version: newPolicy.version,
        audit_mode: auditMode,
      });
      return jsonResponse(
        {
          ok: true,
          no_reroute_needed: true,
          attribute_change_immaterial: true,
          changed_attributes: changedAttributes,
        },
        200,
        origin,
      );
    }

    // Load existing chain and the new policy's steps
    const { data: existingRows } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("id, stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status, policy_id, policy_version")
      .eq("lease_id", leaseId);
    const existingChain = (existingRows ?? []) as Array<
      ChainStepLike & { id: string; policy_id: string | null; policy_version: number | null }
    >;

    const { data: stepsData, error: stepsError } = await supabaseAdmin
      .from("approval_chain_steps")
      .select("stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required")
      .eq("policy_id", newPolicy.id)
      .order("stage")
      .order("step_order")
      .order("parallel_group");
    if (stepsError) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "steps_load_failed",
        policy_id: newPolicy.id,
        error: stepsError.message,
        reroute_path: true,
      });
      return jsonResponse(
        { ok: false, error: stepsError.message, reason: "invalid_lease" },
        500,
        origin,
      );
    }
    const newPolicySteps = (stepsData ?? []) as PolicyStepRow[];

    // SoD enforcement on the new chain
    const sodEffective = getEffectiveSeparationOfDuties(
      wsSod,
      newPolicy.separation_of_duties_override,
    );
    const newAsLike: ChainStepLike[] = newPolicySteps.map((s) => ({
      stage: s.stage,
      step_order: s.step_order,
      parallel_group: s.parallel_group,
      approver_user_id: s.approver_user_id,
      approver_role: s.approver_role,
      is_required: s.is_required,
      status: "pending",
    }));
    const sodViolator = checkSeparationOfDuties(newAsLike, sodEffective);
    if (sodViolator) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "separation_violation",
        policy_id: newPolicy.id,
        conflicting_user_id: sodViolator,
        reroute_path: true,
      });
      return jsonResponse(
        {
          ok: false,
          error: "Separation of duties violated by the new chain. Reroute aborted.",
          reason: "separation_violation",
          details: { conflictingUserId: sodViolator, policyId: newPolicy.id },
        },
        409,
        origin,
      );
    }

    // Reconcile
    const reconciled = reconcileChainSteps(existingChain, newAsLike);
    const target = rollbackTargetForNewChain(newAsLike, reconciled);

    // Determine new lifecycle
    let newLifecycle = currentLifecycle;
    let resultedInChainViolation = false;
    if (target !== "no_rollback_needed") {
      if (currentLifecycle === "fully_executed" || currentLifecycle === "active") {
        newLifecycle = "chain_violation";
        resultedInChainViolation = true;
      } else if (target === "concept_under_review" && currentLifecycle === "concept_submitted") {
        // Already earlier than the target; keep as-is
        newLifecycle = currentLifecycle;
      } else {
        newLifecycle = target;
      }
    }

    // ── Audit mode short-circuit ──────────────────────────────────────
    if (auditMode) {
      await logActivity(leaseId, "reroute_audit_run", {
        would_reroute: true,
        prior_policy_id: snapshot?.policy_id ?? null,
        new_policy_id: newPolicy.id,
        prior_policy_version: snapshot?.policy_version ?? null,
        new_policy_version: newPolicy.version,
        changed_attributes: changedAttributes,
        steps_added_count: reconciled.added.length,
        steps_superseded_count: reconciled.superseded.length,
        steps_preserved_count: reconciled.preserved.length,
        prior_lifecycle_status: currentLifecycle,
        proposed_lifecycle_status: newLifecycle,
        proposed_chain_violation: resultedInChainViolation,
      });
      return jsonResponse(
        {
          ok: true,
          rerouted: false,
          audit_mode: true,
          would_reroute: true,
          prior_policy_id: snapshot?.policy_id ?? null,
          new_policy_id: newPolicy.id,
          changed_attributes: changedAttributes,
          steps_added: reconciled.added.length,
          steps_superseded: reconciled.superseded.length,
          steps_preserved: reconciled.preserved.length,
          prior_lifecycle_status: currentLifecycle,
          proposed_lifecycle_status: newLifecycle,
          would_chain_violation: resultedInChainViolation,
        },
        200,
        origin,
      );
    }

    // ── Apply reconciliation ──────────────────────────────────────────
    // 1. Mark superseded rows
    if (reconciled.superseded.length > 0) {
      const supersededIds = (reconciled.superseded as Array<{ id: string }>).map((s) => s.id);
      const { error: supErr } = await supabaseAdmin
        .from("lease_approval_chain")
        .update({ status: "superseded" })
        .in("id", supersededIds);
      if (supErr) {
        console.error("[resolve-approval-chain] supersede error:", supErr.message);
      }
    }

    // 2. Insert added rows
    if (reconciled.added.length > 0) {
      // Build full INSERT shape from newPolicySteps, filtered to added identities
      const addedIdentities = new Set(
        reconciled.added.map((a) => `${a.stage}::${a.approver_user_id ?? ""}::${a.approver_role ?? ""}`),
      );
      // Phase 7: rows added via reroute become immediately pending —
      // the lease lifecycle has rolled back so they're what's blocking.
      // Set pending_since on required ones.
      const rerouteNowIso = new Date().toISOString();
      const rowsToInsert = newPolicySteps
        .filter((s) =>
          addedIdentities.has(`${s.stage}::${s.approver_user_id ?? ""}::${s.approver_role ?? ""}`),
        )
        .map((s) => ({
          lease_id: leaseId,
          workspace_id: workspaceId,
          policy_id: newPolicy.id,
          policy_version: newPolicy.version,
          stage: s.stage,
          step_order: s.step_order,
          parallel_group: s.parallel_group,
          approver_user_id: s.approver_user_id,
          approver_role: s.approver_role,
          delegate_user_id: s.delegate_user_id,
          delegate_after_days: s.delegate_after_days,
          is_required: s.is_required,
          status: "pending",
          // Phase 7 columns
          effective_assignee_user_id: s.approver_user_id,
          assignee_resolution_source: s.approver_user_id ? "policy_user" : "policy_role",
          pending_since: s.is_required ? rerouteNowIso : null,
        }));
      if (rowsToInsert.length > 0) {
        const { error: insErr } = await supabaseAdmin
          .from("lease_approval_chain")
          .insert(rowsToInsert);
        if (insErr) {
          console.error("[resolve-approval-chain] add error:", insErr.message);
        }
      }
    }

    // 3. Update lifecycle if it changed (Lifecycle Transition Convention)
    if (newLifecycle !== currentLifecycle) {
      await updateLifecycle(leaseId, newLifecycle);
      await logStatusChange(leaseId, currentLifecycle, newLifecycle, {
        triggered_by: "chain_rerouted",
        reroute_detection_mode: detectionMode,
        prior_policy_id: snapshot?.policy_id ?? null,
        new_policy_id: newPolicy.id,
      });
    }

    // 4. Insert reroute event
    const { data: rerouteEvent } = await supabaseAdmin
      .from("lease_reroute_events")
      .insert({
        lease_id: leaseId,
        workspace_id: workspaceId,
        triggered_by: user.id,
        trigger_reason: triggerReason,
        prior_policy_id: snapshot?.policy_id ?? null,
        prior_policy_version: snapshot?.policy_version ?? null,
        new_policy_id: newPolicy.id,
        new_policy_version: newPolicy.version,
        changed_attributes: changedAttributes,
        prior_lifecycle_status: currentLifecycle,
        new_lifecycle_status: newLifecycle,
        steps_added_count: reconciled.added.length,
        steps_superseded_count: reconciled.superseded.length,
        steps_preserved_count: reconciled.preserved.length,
        detection_mode: detectionMode,
        resulted_in_chain_violation: resultedInChainViolation,
      })
      .select("id")
      .single();
    const rerouteEventId = (rerouteEvent as any)?.id ?? null;

    // 5. Insert fresh snapshot
    await writeSnapshot(newPolicy);

    // 6. Activity log
    await logActivity(leaseId, "chain_rerouted", {
      reroute_event_id: rerouteEventId,
      prior_policy_id: snapshot?.policy_id ?? null,
      new_policy_id: newPolicy.id,
      prior_policy_version: snapshot?.policy_version ?? null,
      new_policy_version: newPolicy.version,
      changed_attributes: changedAttributes,
      steps_added: reconciled.added.length,
      steps_superseded: reconciled.superseded.length,
      steps_preserved: reconciled.preserved.length,
      prior_lifecycle_status: currentLifecycle,
      new_lifecycle_status: newLifecycle,
      detection_mode: detectionMode,
      resulted_in_chain_violation: resultedInChainViolation,
    });
    if (resultedInChainViolation) {
      await logActivity(leaseId, "chain_violation_entered", {
        reroute_event_id: rerouteEventId,
        prior_lifecycle_status: currentLifecycle,
      });
    }

    // 7. Clear the trigger flag (the cron poller and this real-time
    //    path both arrive here; whichever wins, the flag ends up false)
    await supabaseAdmin
      .from("leases")
      .update({ reroute_evaluation_pending: false })
      .eq("id", leaseId);

    return jsonResponse(
      {
        ok: true,
        rerouted: true,
        reroute_event_id: rerouteEventId,
        prior_policy_id: snapshot?.policy_id ?? null,
        new_policy_id: newPolicy.id,
        changed_attributes: changedAttributes,
        steps_added: reconciled.added.length,
        steps_superseded: reconciled.superseded.length,
        steps_preserved: reconciled.preserved.length,
        prior_lifecycle_status: currentLifecycle,
        new_lifecycle_status: newLifecycle,
        resulted_in_chain_violation: resultedInChainViolation,
      },
      200,
      origin,
    );
  }

  // ─── Branch: initial resolution (Phase 2 path) ───────────────────────

  // Idempotency: initial resolution + chain already exists → return ok.
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

  let initialMatch: MatchOutcome;
  try {
    initialMatch = await matchPolicy();
  } catch (e: any) {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "policy_load_failed",
      error: e?.message ?? String(e),
    });
    return jsonResponse(
      { ok: false, error: e?.message ?? "Policy load failed", reason: "invalid_lease" },
      500,
      origin,
    );
  }

  if (initialMatch.kind === "no_policies") {
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
  if (initialMatch.kind === "ambiguous") {
    await logActivity(leaseId, "chain_resolution_failed", {
      reason: "ambiguous_match",
      tied_policy_ids: initialMatch.tied.map((t) => t.id),
    });
    return jsonResponse(
      {
        ok: false,
        error: "Multiple policies tied at top priority. Ask an admin to disambiguate.",
        reason: "ambiguous_match",
        details: { tiedPolicies: initialMatch.tied },
      },
      409,
      origin,
    );
  }
  if (initialMatch.kind === "no_match_no_fallback") {
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

  const chosen = initialMatch.policy;

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

  const sodEffective = getEffectiveSeparationOfDuties(
    wsSod,
    chosen.separation_of_duties_override,
  );
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

  // Phase 7: precompute the lowest required concept step_order so we
  // can populate pending_since on the first-active row(s). Steps in
  // higher step_orders (or the signator stage) start with pending_since
  // = null and get it set when the prior steps complete.
  const firstConceptOrderForPending = (() => {
    const concept = policySteps.filter((s) => s.stage === "concept" && s.is_required);
    return concept.length > 0 ? Math.min(...concept.map((s) => s.step_order)) : null;
  })();
  const phase7NowIso = new Date().toISOString();

  const rowsToInsert = policySteps.map((s) => ({
    lease_id: leaseId,
    workspace_id: workspaceId,
    policy_id: chosen.id,
    policy_version: chosen.version,
    stage: s.stage,
    step_order: s.step_order,
    parallel_group: s.parallel_group,
    approver_user_id: s.approver_user_id,
    approver_role: s.approver_role,
    delegate_user_id: s.delegate_user_id,
    delegate_after_days: s.delegate_after_days,
    is_required: s.is_required,
    status: "pending",
    // Phase 7 columns:
    // effective_assignee_user_id mirrors approver_user_id at insert
    // (null for role-based rows). assignee_resolution_source documents
    // how it was determined.
    effective_assignee_user_id: s.approver_user_id,
    assignee_resolution_source: s.approver_user_id ? "policy_user" : "policy_role",
    // pending_since set only on the first-active concept row(s).
    pending_since: s.stage === "concept" &&
        s.is_required &&
        firstConceptOrderForPending !== null &&
        s.step_order === firstConceptOrderForPending
      ? phase7NowIso
      : null,
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

  // Phase 6: write the first attribute snapshot. Best-effort (the chain
  // is the truth; a missing snapshot only affects future reroute diffs,
  // and the next re-resolution would establish one).
  await writeSnapshot(chosen);

  await logActivity(leaseId, "chain_resolved", {
    policy_id: chosen.id,
    policy_name: chosen.name,
    policy_version: chosen.version,
    steps_created: rowsToInsert.length,
    used_default_fallback: initialMatch.usedFallback,
    target_lifecycle_status: "concept_submitted",
  });
  await logActivity(leaseId, "concept_stage_entered", {
    policy_id: chosen.id,
    policy_version: chosen.version,
  });

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
      targetLifecycleStatus: "concept_submitted",
    },
    200,
    origin,
  );
});
