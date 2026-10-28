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
//   - Routing is NOT frozen for in-flight requests, and never claimed to be.
//     A lease is re-evaluated against the CURRENT rule set whenever its own
//     attributes change materially, so a rule reorder/edit/addition CAN change
//     who approves work already in flight (owner decision D-Q5). The guarantee
//     is DISCLOSURE, not immutability: whenever the WINNING RULE changes, this
//     function writes a `chain_routing_rule_changed` activity row naming the
//     prior rule, the new rule and why, and returns `routingChanged: true` so
//     the UI can say so out loud.
//
// See docs/PHASE_2_BUILD_SPEC.md (initial) and docs/PHASE_6_BUILD_SPEC.md
// (reroute) for the full contract.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import { isFirmStaffOfWorkspace } from "../_shared/role_gate.ts";
import {
  type ChainStepLike,
  checkSeparationOfDuties,
  getEffectiveSeparationOfDuties,
  materializeSignatorInheritance,
  reconcileChainSteps,
  rollbackTargetForNewChain,
} from "../_shared/approval_chain.ts";
import {
  getApprovalRequirements,
  getInitialStatusAfterSubmission,
} from "../_shared/approval_routing.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

// Canonical asset-type token for equality across intake vocabularies. Deno copy
// of TS canonicalAssetType (src/lib/assetTypes.ts) + SQL canonical_asset_type
// (migration 20260712140000) — KEEP IN LOCKSTEP. leases.asset_type is written
// as 'property' (request form), 'real_estate' (AI), or a label ("Real Estate",
// LeaseReview); an exact match let a rule silently miss the other spellings.
function canonicalAssetType(value: string | null | undefined): string {
  const key = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key === "property" ? "realestate" : key;
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
  // C4 (#111) — force concept reactivation. When true, rebuilds the CONCEPT
  // stage from the CURRENT policy (re-match, not a verbatim clone) and returns;
  // does not touch the signator stage or the lifecycle. Used by
  // escalate-to-concept-approver. Short-circuits before reroute/initial modes.
  forceConceptReactivation?: boolean;
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
  // D-Q1 (Phase 0): `is_default_fallback` is deliberately NOT selected or typed
  // here. The column still exists (migration 20260719120100 left it in place so
  // authored data survives) but it is inert — it can no longer route anything.
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

// Move 1 (D1): the `ambiguous` outcome is GONE. Co-matching policies at the same
// top priority are broken deterministically by the matchPolicy() sort
// (priority DESC, created_at ASC, id ASC — a total order); the winner carries
// `tieBrokenWith` so the deterministic pick is audit-attributed instead of 409'd.
//
// D-Q1 (Phase 0): the `usedFallback` field is GONE with the is_default_fallback
// branch. A "matched" outcome now always means a real rule matched, so the flag
// could only ever be false. The `used_default_fallback` key is still emitted in
// the chain_resolved audit payload (as a literal false) so the audit row shape
// is unchanged for existing consumers.
type MatchOutcome =
  | { kind: "no_policies" }
  | { kind: "no_match_no_fallback" }
  | {
    kind: "matched";
    policy: PolicyRow;
    tieBrokenWith?: { id: string; name: string }[];
  };

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
  const forceConceptReactivation = body?.forceConceptReactivation === true;

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
      "id, workspace_id, asset_type, lease_type, requesting_department, region, monthly_payment, lifecycle_status, calc_total_commitment, covenant_flagged",
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
    .select("owner_id, separation_of_duties_default, approval_threshold")
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
  // #197: firm staff of the owning firm count as members of a non-restricted
  // child (is_workspace_member's firm arm). They can create drafts now, so
  // submission must recognize them too — else the request is stuck in draft.
  if (!isMember) {
    isMember = await isFirmStaffOfWorkspace(supabaseAdmin, workspaceId, user.id);
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
        "id, workspace_id, name, priority, match_asset_types, match_departments, match_min_annual_cost, match_max_annual_cost, match_regions, match_lease_types, separation_of_duties_override, version, is_active, created_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("is_active", true);
    if (policiesError) throw new Error(policiesError.message);

    const allPolicies = (policies ?? []) as PolicyRow[];
    if (allPolicies.length === 0) return { kind: "no_policies" };

    const leaseAssetCanon = canonicalAssetType(liveAttrs.asset_type);
    const matched = allPolicies
      .filter((p) => {
        // asset_type via canonical token on both sides (property ≡ real_estate ≡
        // "Real Estate"); must mirror the preview_policy_resolution RPC exactly.
        // A lease with no asset type ('' after canonicalizing) never satisfies a
        // rule that specifies asset types (matches the RPC's `<> ''` guard).
        if (
          p.match_asset_types.length > 0 &&
          (leaseAssetCanon === "" || !p.match_asset_types.map(canonicalAssetType).includes(leaseAssetCanon))
        ) {
          return false;
        }
        if (p.match_departments.length > 0 && !p.match_departments.includes(liveAttrs.requesting_department ?? "")) return false;
        if (p.match_min_annual_cost != null && annualCost < p.match_min_annual_cost) return false;
        if (p.match_max_annual_cost != null && annualCost > p.match_max_annual_cost) return false;
        if (p.match_regions.length > 0 && !p.match_regions.includes(liveAttrs.region ?? "")) return false;
        if (p.match_lease_types.length > 0 && !p.match_lease_types.includes(liveAttrs.lease_type ?? "")) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        // Total-order final key — mirrors the preview RPC's `p.id ASC`. Without
        // it, two policies created in the same transaction (identical created_at)
        // would sort nondeterministically.
        return a.id.localeCompare(b.id);
      });

    // D-Q1 (Phase 0): the `?? allPolicies.find(p => p.is_default_fallback)` rung
    // is RETIRED. It was a second, invisible catch-all — and unlike the filter
    // above it never checked `is_active`, so a rule the admin had switched OFF
    // still caught every unmatched request with nothing on screen saying so.
    // A no-match now falls through to the legacy default approvers (and 409s
    // only when there are none), which is the one catch-all the UI can show.
    // Migration 20260719120100 converted every previously-flagged rule into an
    // ordinary rule pinned last, so their matching behaviour is preserved and
    // visible.
    const chosen = matched[0];
    if (!chosen) return { kind: "no_match_no_fallback" };

    // Move 1 (D1): deterministic tie-break replaces the old ambiguous 409. The
    // sort already ordered co-priority matches by created_at ASC then id ASC, so
    // matched[0] is the unique deterministic winner (the older rule). Record any
    // same-priority peers so the pick is attributed in the chain_resolved audit.
    const tieBrokenWith =
      matched.length >= 2 && matched[0].priority === matched[1].priority
        ? matched
          .filter((p) => p.priority === matched[0].priority && p.id !== matched[0].id)
          .map((p) => ({ id: p.id, name: p.name }))
        : undefined;

    return { kind: "matched", policy: chosen, tieBrokenWith };
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

  // ── D-Q5 routing-change disclosure ───────────────────────────────────
  // An in-flight request CAN change approvers: whenever its own attributes
  // change materially, the chain is re-evaluated against the CURRENT rules, and
  // a reorder/edit/new rule may have made a different rule the winner. That
  // behaviour is deliberate (owner decision D-Q5) and is NOT frozen here. What
  // is fixed is the SILENCE: every winner change now writes an explicit,
  // human-readable activity row naming the prior rule, the new rule, and why —
  // so "why did my approvers change?" is answerable from the activity log
  // without a DB query.
  //
  // The activity_type is added to the lease_activity_log CHECK constraint by
  // migration 20260719122000 (the CHECK governs ALL writers, service_role
  // included); without it the insert 23514-fails and logActivity's best-effort
  // catch swallows the disclosure. Same precedent as 20260718140000.
  //
  // The activity_type is written as a LITERAL at the logActivity call below
  // (not via a const) so the #76 constraint-drift sweep
  // (src/lib/__tests__/activityTypeConstraintSync.test.ts) can see it.
  //
  // The snapshot stores only a policy_id, and "your approvers changed" is not
  // answerable from a uuid. Resolve the prior rule's NAME. Best-effort: a rule
  // deleted since the snapshot resolves to name=null and the audit still
  // carries the id.
  async function loadPolicyIdentity(
    policyId: string | null | undefined,
  ): Promise<{ id: string; name: string | null } | null> {
    if (!policyId) return null;
    const { data, error } = await supabaseAdmin
      .from("approval_policies")
      .select("id, name")
      .eq("id", policyId)
      .maybeSingle();
    if (error) {
      console.error("[resolve-approval-chain] prior policy lookup error:", error.message);
      return { id: policyId, name: null };
    }
    const row = data as { id: string; name: string | null } | null;
    return { id: policyId, name: row?.name ?? null };
  }

  // DB-written audit prose — an English-canonical deliberate i18n remainder
  // (KNOWN_ISSUES #160), like every other lease_activity_log message. The UI
  // renders its own localized notice from the structured fields + the
  // routingChanged flag on the function response.
  async function logRoutingRuleChanged(params: {
    context: "reroute" | "concept_reactivation";
    prior: { id: string; name: string | null } | null;
    priorVersion: number | null;
    next: PolicyRow;
    changedAttributes?: Record<string, { from: unknown; to: unknown }>;
    detectionMode?: string;
  }): Promise<void> {
    const priorLabel = params.prior
      ? (params.prior.name
        ? `the rule "${params.prior.name}"`
        : `a rule that no longer exists (${params.prior.id})`)
      : "the workspace default approvers";
    const changedList = Object.keys(params.changedAttributes ?? {}).join(", ");
    const why = params.context === "reroute"
      ? (changedList
        ? `this request's own details changed (${changedList}), so the approval rules were re-evaluated and a different rule now matches`
        : "this request's own details changed, so the approval rules were re-evaluated and a different rule now matches")
      : "concept review was reopened, so the approval rules were re-evaluated and a different rule now matches";
    await logActivity(leaseId, "chain_routing_rule_changed", {
      context: params.context,
      prior_policy_id: params.prior?.id ?? null,
      prior_policy_name: params.prior?.name ?? null,
      prior_policy_version: params.priorVersion,
      new_policy_id: params.next.id,
      new_policy_name: params.next.name,
      new_policy_version: params.next.version,
      reason: params.context === "reroute"
        ? "lease_attributes_changed"
        : "concept_reactivation",
      ...(params.changedAttributes ? { changed_attributes: params.changedAttributes } : {}),
      ...(params.detectionMode ? { detection_mode: params.detectionMode } : {}),
      message:
        `Approvers changed: this request now routes through the rule "${params.next.name}" ` +
        `instead of ${priorLabel} — ${why}.`,
    });
  }

  // ─── Branch: C4 (#111) force concept reactivation ────────────────────
  // escalate-to-concept-approver calls this to rebuild the CONCEPT stage from
  // the CURRENT policy match (NOT a verbatim clone of the prior rows, which
  // resurrected superseded prior-policy approvers). Concept-only: signator rows
  // are untouched. Does NOT change the lifecycle — the caller flips it to
  // concept_under_review only AFTER this succeeds, so a failed policy match can
  // never strand the lease with no approvers.
  if (forceConceptReactivation) {
    let m: MatchOutcome;
    try {
      m = await matchPolicy();
    } catch (e: any) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "policy_load_failed",
        error: e?.message ?? String(e),
        reactivation: true,
      });
      return jsonResponse(
        { ok: false, error: e?.message ?? "Policy load failed", reason: "invalid_lease" },
        500,
        origin,
      );
    }
    // A chain lease's concept rebuild must NOT fall back to the chainless legacy
    // route (that would strand a lease that already has a chain). Keep the 409.
    if (m.kind === "no_policies" || m.kind === "no_match_no_fallback") {
      await logActivity(leaseId, "chain_resolution_failed", { reason: m.kind, reactivation: true });
      return jsonResponse(
        {
          ok: false,
          error: "No matching policy to reactivate concept review. Ask an admin to add a fallback or matching policy.",
          reason: "no_match_no_fallback",
        },
        409,
        origin,
      );
    }
    // Move 1: the `ambiguous` outcome no longer exists — matchPolicy()
    // deterministically resolves ties, so m is now narrowed to `matched` here.
    const chosen = m.policy;

    // D-Q5 disclosure. This branch deliberately rebuilds the concept stage from
    // the CURRENT match rather than cloning the prior rows (#111 — a verbatim
    // clone resurrected superseded prior-policy approvers). That behaviour STAYS.
    // What was missing is the comparison the reroute branch makes at ~L900:
    // if the rule that wins NOW is not the rule this lease was routed under, the
    // reactivation silently changes who approves. Compare against the same
    // comparator the reroute branch uses (the latest attribute snapshot), with
    // the lease's own concept chain rows as a fallback for leases that predate
    // snapshotting. When neither is known we say so (prior_policy_unknown)
    // rather than inventing a change.
    const { data: reactSnapData } = await supabaseAdmin
      .from("lease_attribute_snapshots")
      .select("id, policy_id, policy_version, asset_type, lease_type, requesting_department, region, monthly_payment")
      .eq("lease_id", leaseId)
      .order("chain_resolution_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const reactSnapshot = reactSnapData as SnapshotRow | null;

    let priorRoutedPolicyId: string | null = reactSnapshot?.policy_id ?? null;
    let priorRoutedPolicyVersion: number | null = reactSnapshot?.policy_version ?? null;
    if (!priorRoutedPolicyId) {
      const { data: priorChainRows } = await supabaseAdmin
        .from("lease_approval_chain")
        .select("policy_id, policy_version")
        .eq("lease_id", leaseId)
        .eq("stage", "concept")
        .not("policy_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const priorRow = ((priorChainRows ?? []) as Array<
        { policy_id: string | null; policy_version: number | null }
      >)[0];
      priorRoutedPolicyId = priorRow?.policy_id ?? null;
      priorRoutedPolicyVersion = priorRow?.policy_version ?? null;
    }
    const reactRoutingChanged = priorRoutedPolicyId !== null && priorRoutedPolicyId !== chosen.id;
    const reactPriorIdentity = reactRoutingChanged
      ? await loadPolicyIdentity(priorRoutedPolicyId)
      : null;

    // Load CONCEPT steps for the current policy only.
    const { data: cStepsData, error: cStepsError } = await supabaseAdmin
      .from("approval_chain_steps")
      .select(
        "stage, step_order, parallel_group, approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required",
      )
      .eq("policy_id", chosen.id)
      .eq("stage", "concept")
      .order("step_order")
      .order("parallel_group");
    if (cStepsError) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "steps_load_failed",
        policy_id: chosen.id,
        error: cStepsError.message,
        reactivation: true,
      });
      return jsonResponse({ ok: false, error: cStepsError.message, reason: "invalid_lease" }, 500, origin);
    }
    const conceptPolicySteps = (cStepsData ?? []) as PolicyStepRow[];
    if (conceptPolicySteps.length === 0) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "policy_has_no_concept_steps",
        policy_id: chosen.id,
        reactivation: true,
      });
      return jsonResponse(
        {
          ok: false,
          error: "Selected policy has no concept steps to reactivate.",
          reason: "no_match_no_fallback",
          details: { policyId: chosen.id, policyName: chosen.name },
        },
        409,
        origin,
      );
    }

    // Separation-of-duties over the concept steps.
    const sodEffective = getEffectiveSeparationOfDuties(wsSod, chosen.separation_of_duties_override);
    const sodViolator = checkSeparationOfDuties(
      conceptPolicySteps.map((s) => ({
        stage: s.stage,
        step_order: s.step_order,
        parallel_group: s.parallel_group,
        approver_user_id: s.approver_user_id,
        approver_role: s.approver_role,
        is_required: s.is_required,
        status: "pending",
      })),
      sodEffective,
    );
    if (sodViolator) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "separation_violation",
        policy_id: chosen.id,
        conflicting_user_id: sodViolator,
        reactivation: true,
      });
      return jsonResponse(
        {
          ok: false,
          error: "Separation of duties violated in the concept stage. Ask an admin to fix the policy.",
          reason: "separation_violation",
          details: { conflictingUserId: sodViolator, policyId: chosen.id },
        },
        409,
        origin,
      );
    }

    // Supersede any LINGERING pending concept rows (defensive — normally the
    // prior concept rows are 'approved' history and stay untouched; this guards
    // against a double-reactivation leaving stale pending rows).
    const { data: lingering } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("id")
      .eq("lease_id", leaseId)
      .eq("stage", "concept")
      .eq("status", "pending");
    const supersededIds = ((lingering ?? []) as Array<{ id: string }>).map((r) => r.id);

    // Build fresh pending concept rows (Phase-7 columns; pending_since on the
    // first-active required step, mirroring creation semantics).
    const firstConceptOrder = (() => {
      const req = conceptPolicySteps.filter((s) => s.is_required);
      return req.length > 0 ? Math.min(...req.map((s) => s.step_order)) : null;
    })();
    const reactivateNowIso = new Date().toISOString();
    const freshRows = conceptPolicySteps.map((s) => ({
      lease_id: leaseId,
      workspace_id: workspaceId,
      policy_id: chosen.id,
      policy_version: chosen.version,
      stage: "concept",
      step_order: s.step_order,
      parallel_group: s.parallel_group,
      approver_user_id: s.approver_user_id,
      approver_role: s.approver_role,
      delegate_user_id: s.delegate_user_id,
      delegate_after_days: s.delegate_after_days,
      is_required: s.is_required,
      status: "pending",
      effective_assignee_user_id: s.approver_user_id,
      assignee_resolution_source: s.approver_user_id ? "policy_user" : "policy_role",
      pending_since:
        s.is_required && firstConceptOrder !== null && s.step_order === firstConceptOrder
          ? reactivateNowIso
          : null,
    }));

    // Atomic supersede + insert (C5 RPC) — never leave the lease mid-rebuild.
    const { error: reconErr } = await supabaseAdmin.rpc("reroute_reconcile_chain_steps", {
      p_superseded_ids: supersededIds,
      p_new_rows: freshRows,
    });
    if (reconErr) {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: "concept_reactivation_failed",
        policy_id: chosen.id,
        error: reconErr.message,
        reactivation: true,
      });
      return jsonResponse(
        { ok: false, error: `Failed to reactivate concept chain: ${reconErr.message}`, reason: "invalid_lease" },
        500,
        origin,
      );
    }

    await logActivity(leaseId, "chain_resolved", {
      policy_id: chosen.id,
      policy_name: chosen.name,
      policy_version: chosen.version,
      steps_created: freshRows.length,
      superseded_pending: supersededIds.length,
      reactivation: true,
      // Audit-shape stability: the key survives the D-Q1 retirement of the
      // is_default_fallback branch, but a "matched" outcome now always means a
      // real rule matched, so it is permanently false.
      used_default_fallback: false,
      // D-Q5: the reactivation rebuilds from the CURRENT winner, so state
      // plainly whether that winner is the rule the lease was routed under.
      routing_rule_changed: reactRoutingChanged,
      prior_policy_id: priorRoutedPolicyId,
      prior_policy_name: reactPriorIdentity?.name ?? null,
      ...(priorRoutedPolicyId === null ? { prior_policy_unknown: true } : {}),
      ...(m.tieBrokenWith
        ? { tie_broken: true, tied_policy_ids: m.tieBrokenWith.map((t) => t.id) }
        : {}),
    });

    // D-Q5: the loud, human-meaningful record. Silent is the bug; changing is
    // not — the rebuild already happened above and is not being reverted.
    if (reactRoutingChanged) {
      await logRoutingRuleChanged({
        context: "concept_reactivation",
        prior: reactPriorIdentity,
        priorVersion: priorRoutedPolicyVersion,
        next: chosen,
      });
    }

    const firstAssignees =
      firstConceptOrder == null
        ? []
        : conceptPolicySteps
            .filter((s) => s.is_required && s.step_order === firstConceptOrder)
            .map((s) => ({ userId: s.approver_user_id, role: s.approver_role }));

    return jsonResponse(
      {
        ok: true,
        reactivated: true,
        policyId: chosen.id,
        policyName: chosen.name,
        stepsCreated: freshRows.length,
        assignees: firstAssignees,
        // D-Q5: lets the caller surface "the approvers for this request changed"
        // instead of quietly swapping them.
        routingChanged: reactRoutingChanged,
        priorPolicyId: priorRoutedPolicyId,
        priorPolicyName: reactPriorIdentity?.name ?? null,
        newPolicyName: chosen.name,
      },
      200,
      origin,
    );
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
        { ok: true, no_reroute_needed: true, reason: "no_attribute_change", routingChanged: false },
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
          routingChanged: false,
        },
        200,
        origin,
      );
    }

    // Move 1: no `ambiguous` outcome anymore — matchPolicy() resolves ties
    // deterministically (older rule wins), consistent with initial resolution
    // and the preview RPC. matchResult is now narrowed to `matched` here.
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
          // Same rule, same version — by definition no routing change.
          routingChanged: false,
        },
        200,
        origin,
      );
    }

    // D-Q5: distinguish "the SAME rule was edited" (version bump) from "a
    // DIFFERENT rule now wins" (the winner changed). Only the latter changes who
    // approves because the rule SET moved underneath an in-flight request, and
    // only the latter gets the explicit disclosure record below. A null prior
    // policy_id means the lease was previously on the legacy default-approver
    // route, which is itself a routing change worth naming.
    const routingRuleChanged = (snapshot?.policy_id ?? null) !== newPolicy.id;
    const priorPolicyIdentity = routingRuleChanged
      ? await loadPolicyIdentity(snapshot?.policy_id ?? null)
      : null;

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

    // Move 2 (D2): expand a one-stage new policy AFTER the authored-steps SoD
    // check (SoD auto-satisfied for the inherited signature stage by design).
    // Reconcile/rollback/insert all operate on the EXPANDED list — otherwise the
    // inherited signator identities in reconciled.added would find no source row
    // and the signature stage would be silently dropped on reroute.
    const { steps: effectiveNewSteps, inheritedSignator } = materializeSignatorInheritance(
      newPolicySteps,
    );
    const effectiveNewAsLike: ChainStepLike[] = effectiveNewSteps.map((s) => ({
      stage: s.stage,
      step_order: s.step_order,
      parallel_group: s.parallel_group,
      approver_user_id: s.approver_user_id,
      approver_role: s.approver_role,
      is_required: s.is_required,
      status: "pending",
    }));

    // Reconcile
    const reconciled = reconcileChainSteps(existingChain, effectiveNewAsLike);
    const target = rollbackTargetForNewChain(effectiveNewAsLike, reconciled);

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
        signator_inherited: inheritedSignator,
        // D-Q5: a dry run must also say whether the WINNING RULE would change,
        // not just that some reroute would happen. No disclosure row is written
        // here — audit mode changes nothing, so there is nothing to disclose.
        would_change_routing_rule: routingRuleChanged,
        prior_policy_name: priorPolicyIdentity?.name ?? null,
        new_policy_name: newPolicy.name,
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
          routingChanged: routingRuleChanged,
          priorPolicyName: priorPolicyIdentity?.name ?? null,
          newPolicyName: newPolicy.name,
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

    // ── Apply reconciliation (C5: atomic supersede + insert) ──────────────
    // Build the superseded IDs + the added rows, then apply BOTH in a single
    // transaction via reroute_reconcile_chain_steps. The previous code issued
    // two separate PostgREST writes that each only console.error- d on failure
    // and continued — so a failed insert after a successful supersede left the
    // lease with zero active approvers while still reporting success (#111 C5).
    const supersededIds = (reconciled.superseded as Array<{ id: string }>).map((s) => s.id);

    // Phase 7: rows added via reroute become immediately pending — the lease
    // lifecycle has rolled back so they're what's blocking. Set pending_since on
    // required ones. Build the full INSERT shape from newPolicySteps, filtered to
    // the added identities.
    const addedIdentities = new Set(
      reconciled.added.map((a) => `${a.stage}::${a.approver_user_id ?? ""}::${a.approver_role ?? ""}`),
    );
    const rerouteNowIso = new Date().toISOString();
    // Move 2: iterate the EXPANDED steps so inherited signator identities in
    // reconciled.added resolve to a source row (else the signature stage drops).
    const rowsToInsert = effectiveNewSteps
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

    if (supersededIds.length > 0 || rowsToInsert.length > 0) {
      const { error: reconcileErr } = await supabaseAdmin.rpc(
        "reroute_reconcile_chain_steps",
        { p_superseded_ids: supersededIds, p_new_rows: rowsToInsert },
      );
      if (reconcileErr) {
        // Atomic: on failure NEITHER write landed, so the lease keeps its prior
        // active approvers. Abort the reroute instead of swallowing the error.
        console.error("[resolve-approval-chain] reconcile error:", reconcileErr.message);
        await logActivity(leaseId, "chain_resolution_failed", {
          reason: "reroute_reconcile_failed",
          error: reconcileErr.message,
          steps_superseded: supersededIds.length,
          steps_added: rowsToInsert.length,
        });
        return jsonResponse({ ok: false, error: "reroute_reconcile_failed" }, 500, origin);
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
      signator_inherited: inheritedSignator,
      // D-Q5: name the rules, not just their uuids, and say whether the WINNER
      // changed (vs the same rule having been edited).
      routing_rule_changed: routingRuleChanged,
      prior_policy_name: priorPolicyIdentity?.name ?? null,
      new_policy_name: newPolicy.name,
      ...(matchResult.tieBrokenWith
        ? { tie_broken: true, tied_policy_ids: matchResult.tieBrokenWith.map((t) => t.id) }
        : {}),
    });
    // D-Q5: the explicit, human-meaningful disclosure. Written only when the
    // WINNING RULE changed — a version bump of the same rule is an edit to that
    // rule, already carried by chain_rerouted's policy_version fields.
    if (routingRuleChanged) {
      await logRoutingRuleChanged({
        context: "reroute",
        prior: priorPolicyIdentity,
        priorVersion: snapshot?.policy_version ?? null,
        next: newPolicy,
        changedAttributes,
        detectionMode,
      });
    }
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
        // D-Q5: lets the caller raise "the approvers for this request changed"
        // in the UI instead of the change being visible only in the audit log.
        routingChanged: routingRuleChanged,
        priorPolicyName: priorPolicyIdentity?.name ?? null,
        newPolicyName: newPolicy.name,
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
    // Chain already exists. If a prior attempt wrote the chain but the lease
    // never left draft (an old browser flip was rejected by the governance
    // trigger or interrupted), complete the draft → concept_submitted flip
    // server-side now so the lease is not stranded. `recovered` tells the
    // caller whether THIS call advanced it (so it only notifies once).
    let finalStatus = currentLifecycle;
    let recovered = false;
    if (currentLifecycle === "draft") {
      const flipped = await updateLifecycle(leaseId, "concept_submitted");
      if (flipped) {
        finalStatus = "concept_submitted";
        recovered = true;
        await logStatusChange(leaseId, "draft", "concept_submitted", {
          triggered_by: "request_submission",
          recovered_existing_chain: true,
        });
      }
    }
    // First-step assignees from the existing chain (concept stage, required,
    // lowest step_order) so the caller can notify on the recovery path.
    const { data: existingChainRows } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("approver_user_id, approver_role, step_order, stage, is_required")
      .eq("lease_id", leaseId);
    const conceptRows = ((existingChainRows ?? []) as Array<any>).filter(
      (s) => s.stage === "concept" && s.is_required,
    );
    const firstOrder = conceptRows.length > 0
      ? Math.min(...conceptRows.map((s) => s.step_order))
      : null;
    const firstStepAssignees = firstOrder == null
      ? []
      : conceptRows
        .filter((s) => s.step_order === firstOrder)
        .map((s) => ({ userId: s.approver_user_id ?? null, role: s.approver_role ?? null }));

    return jsonResponse(
      {
        ok: true,
        alreadyResolved: true,
        recovered,
        finalStatus,
        firstStepAssignees,
        // D-Q5: the flag is TOTAL across every branch so a caller can read it
        // unconditionally. Initial resolution has no prior routing to change.
        routingChanged: false,
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

  // Move 1 (D1): the legacy default-approver route now serves BOTH "no policies
  // configured" AND "policies exist but none matched (and no explicit fallback
  // policy)". A request that matches no rule routes to the workspace default
  // approvers (workspace_roles manager_approver → financial_approver) exactly
  // like the zero-policy world. The 409 survives ONLY for a no-match workspace
  // that ALSO has no default approvers configured — a workspace with rules has
  // expressed gating intent, so silently auto-approving there would be an
  // approval bypass.
  if (
    initialMatch.kind === "no_policies" ||
    initialMatch.kind === "no_match_no_fallback"
  ) {
    // Compute the required approvals SERVER-SIDE — never trust a client-supplied
    // target, or a submitter could pass 'approved' and self-approve — then apply
    // the draft → X flip here so the browser never attempts the trigger-blocked
    // lifecycle write. The caller still sends the approver notifications using
    // the requirements it re-derives (notifications are not a security boundary).
    const [{ data: mgrRoles }, { data: finRoles }] = await Promise.all([
      supabaseAdmin
        .from("workspace_roles")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("role", "manager_approver"),
      supabaseAdmin
        .from("workspace_roles")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("role", "financial_approver"),
    ]);
    const hasManagerApprovers = ((mgrRoles ?? []) as unknown[]).length > 0;
    const hasFinancialApprovers = ((finRoles ?? []) as unknown[]).length > 0;
    const hasDefaultApprovers = hasManagerApprovers || hasFinancialApprovers;
    const isFallbackFromNoMatch = initialMatch.kind === "no_match_no_fallback";

    // Compute the legacy OUTCOME before the guard below — the guard keys on the
    // resulting status, not on whether approvers merely exist. Order matters.
    const requirements = getApprovalRequirements({
      totalCashCommitment: Number((lease as any).calc_total_commitment ?? 0),
      approvalThreshold: (ownership as any)?.approval_threshold ?? null,
      hasManagerApprovers,
      hasFinancialApprovers,
      covenantFlagged: Boolean((lease as any).covenant_flagged),
    });
    const legacyStatus = getInitialStatusAfterSubmission(requirements);

    // #207 (HIGH, approval bypass) — GATE ON THE OUTCOME, NEVER ON PRESENCE.
    //
    // The previous guard was `isFallbackFromNoMatch && !hasDefaultApprovers`,
    // which asked "does this workspace have ANY default approver?" instead of
    // "would this request actually be reviewed by a human?". Those are not the
    // same question. getApprovalRequirements only requires the MANAGER when a
    // manager approver exists, and only requires FINANCIAL review when the
    // commitment clears the threshold (or a covenant is flagged, or no
    // threshold is set). So a workspace with a financial approver, NO manager
    // approver, a $100k threshold and a $72k no-match request produced
    // requiresManager=false + requiresFinancial=false -> 'approved', and the
    // lease auto-approved with ZERO human review — in a workspace that had
    // explicitly configured approval rules. The old guard let it through
    // because an approver existed; it just was not required.
    //
    // Keying on `legacyStatus === "approved"` is strictly safer AND subsumes
    // the old condition: with no approvers at all, requiresManager and
    // requiresFinancial are both false, so legacyStatus is already 'approved'.
    //
    // A TRUE zero-policy workspace is deliberately NOT caught here —
    // `isFallbackFromNoMatch` is only set for `no_match_no_fallback`, so a
    // workspace that never configured any rule keeps its historical
    // auto-approve-when-no-roles behavior via the legacy body below. The line
    // being drawn is intent: configuring rules expresses gating intent.
    //
    // The WIRE reason stays `no_match_no_fallback` — leaseSubmissionDecision.ts
    // maps it to leave_draft and en/es carry its user-facing copy. Only the
    // audit detail distinguishes the two causes.
    if (isFallbackFromNoMatch && legacyStatus === "approved") {
      await logActivity(leaseId, "chain_resolution_failed", {
        reason: hasDefaultApprovers
          ? "no_match_would_auto_approve"
          : "no_match_no_fallback",
        default_approvers_configured: hasDefaultApprovers,
        has_manager_approver: hasManagerApprovers,
        has_financial_approver: hasFinancialApprovers,
        would_have_been: "approved",
      });
      return jsonResponse(
        {
          ok: false,
          reason: "no_match_no_fallback",
          error: hasDefaultApprovers
            ? "This request matches no approval rule, and your default approvers would not be required to review it — so it would be approved with nobody looking at it. Ask an admin to add a matching rule, assign a manager approver, or lower the approval threshold."
            : "No matching approval rule and no default approvers are assigned. Ask an admin to assign default approvers or add a matching rule.",
        },
        409,
        origin,
      );
    }

    // Distinct audit row when we FELL BACK from a no-match (vs. the workspace
    // simply having zero policies). Service-role write — bypasses the
    // 20260717120500 authenticated-writer allowlist RLS. The activity_type is
    // added to the lease_activity_log CHECK constraint by migration
    // 20260718140000 (the CHECK governs all writers, service_role included).
    if (isFallbackFromNoMatch) {
      await logActivity(leaseId, "chain_resolution_fallback_to_default", {
        reason: "no_policy_match",
        legacy_status: legacyStatus,
        has_manager_approver: hasManagerApprovers,
        has_financial_approver: hasFinancialApprovers,
      });
    }

    let finalStatus = currentLifecycle;
    if (currentLifecycle === "draft") {
      const flipped = await updateLifecycle(leaseId, legacyStatus);
      if (!flipped) {
        return jsonResponse(
          { ok: false, error: "Failed to update request status", reason: "flip_failed" },
          500,
          origin,
        );
      }
      finalStatus = legacyStatus;
      await logStatusChange(leaseId, "draft", legacyStatus, {
        triggered_by: "request_submission",
        routing_path: "legacy",
        auto_approved: legacyStatus === "approved",
        ...(isFallbackFromNoMatch ? { fallback_from: "no_policy_match" } : {}),
      });
    }

    return jsonResponse(
      {
        ok: true,
        legacyFallback: true,
        // fallbackReason distinguishes "no policies" from "rules existed but none
        // matched". Additive — decideSubmissionOutcome ignores it.
        ...(isFallbackFromNoMatch ? { fallbackReason: initialMatch.kind } : {}),
        // finalStatus is the server-authoritative destination (the flip +
        // status_change log are owned here). The caller re-derives approval
        // requirements locally only to pick the NOTIFICATION target — not a
        // security/audit boundary — so we don't ship requirement flags it
        // doesn't read.
        finalStatus,
        routingChanged: false,
        message: isFallbackFromNoMatch
          ? "No matching approval rule; routed via workspace default approvers."
          : "No approval policies configured; legacy notification path.",
      },
      200,
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

  // Move 2 (D2): a policy with concept steps but ZERO signator steps inherits
  // its concept steps into the signature stage at CHAIN-CREATION time
  // (materialized, not virtual — the inherited rows sit as real 'pending'
  // signator rows exactly like authored ones, so every downstream consumer,
  // advance-to-final-review / act-on-chain-step / stuck-chain / delegate-timer,
  // works untouched). SoD ran over the AUTHORED policySteps above, so the
  // inherited clone of a concept approver is auto-satisfied by design.
  const { steps: effectiveSteps, inheritedSignator } = materializeSignatorInheritance(policySteps);
  const conceptCount = policySteps.filter((s) => s.stage === "concept").length;

  // Phase 7: precompute the lowest required concept step_order so we
  // can populate pending_since on the first-active row(s). Steps in
  // higher step_orders (or the signator stage) start with pending_since
  // = null and get it set when the prior steps complete. (Concept subset is
  // identical in policySteps and effectiveSteps — inheritance only ADDS signator
  // rows — so this stays on policySteps.)
  const firstConceptOrderForPending = (() => {
    const concept = policySteps.filter((s) => s.stage === "concept" && s.is_required);
    return concept.length > 0 ? Math.min(...concept.map((s) => s.step_order)) : null;
  })();
  const phase7NowIso = new Date().toISOString();

  const rowsToInsert = effectiveSteps.map((s) => ({
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
    // Audit-shape stability: the key survives the D-Q1 retirement of the
    // is_default_fallback branch, but a "matched" outcome now always means a
    // real rule matched, so it is permanently false.
    used_default_fallback: false,
    target_lifecycle_status: "concept_submitted",
    signator_inherited: inheritedSignator,
    signator_steps_inherited: inheritedSignator ? conceptCount : 0,
    ...(initialMatch.tieBrokenWith
      ? { tie_broken: true, tied_policy_ids: initialMatch.tieBrokenWith.map((t) => t.id) }
      : {}),
  });
  await logActivity(leaseId, "concept_stage_entered", {
    policy_id: chosen.id,
    policy_version: chosen.version,
  });

  // Apply the draft → concept_submitted lifecycle flip SERVER-SIDE. The browser
  // cannot do this (prevent_unauthorized_lease_workflow_edits rejects
  // authenticated lifecycle_status writes); the caller used to attempt it and
  // fail silently, stranding the lease in draft with a misleading "submitted"
  // audit row. Guarded on draft so a re-resolution never clobbers an advanced
  // lease.
  let finalStatus = currentLifecycle;
  if (currentLifecycle === "draft") {
    const flipped = await updateLifecycle(leaseId, "concept_submitted");
    if (!flipped) {
      // The chain rows already exist; do NOT fall through and return success
      // with a target the lease never reached — that would re-create the
      // lying-audit / stranded-draft defect this change removes. Surface the
      // failure; the idempotent-recovery branch completes the flip on retry.
      return jsonResponse(
        { ok: false, error: "Failed to update request status", reason: "flip_failed" },
        500,
        origin,
      );
    }
    finalStatus = "concept_submitted";
    await logStatusChange(leaseId, "draft", "concept_submitted", {
      triggered_by: "request_submission",
      policy_id: chosen.id,
      policy_version: chosen.version,
    });
  }

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
      finalStatus,
      routingChanged: false,
    },
    200,
    origin,
  );
});
