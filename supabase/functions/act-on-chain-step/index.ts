// act-on-chain-step — Phase 2
//
// Called when an approver clicks Approve / Reject / Send Back on their
// assigned chain step. Updates the step row, runs stage-completion
// logic, and advances the lease lifecycle accordingly.
//
// Phase 2 only consumes the 'concept' stage's chain rows. 'signator'
// rows may exist (the resolver inserts them) but stage-advancement for
// signator is a no-op until Phase 5 owns it; the lease still flows
// through legacy execution post-`approved`.
//
// See docs/PHASE_2_BUILD_SPEC.md for the full contract.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  type ChainStepLike,
  advancedPastStepOrder,
  findFirstPendingAssignees,
  isStageComplete,
} from "../_shared/approval_chain.ts";
import { getLifecycleMode, type LifecycleMode } from "../_shared/lifecycle_mode.ts";
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

interface RequestBody {
  chainStepId: string;
  action: "approve" | "reject" | "send_back";
  // For concept-stage actions, this is the reviewer's note. For
  // signator approve, this is the intent-to-bind attestation captured
  // from the signator review page (≥30 chars enforced UI-side; server
  // enforces non-empty as defense-in-depth). Same field for both —
  // the UI populates it appropriately for the stage.
  comment?: string;
}

interface ChainStepRow {
  id: string;
  lease_id: string;
  workspace_id: string;
  stage: "concept" | "signator";
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  is_required: boolean;
  status: string;
  // Phase 7
  effective_assignee_user_id: string | null;
  assignee_resolution_source: string | null;
}

const ACTION_TO_STATUS: Record<string, "approved" | "rejected" | "sent_back"> = {
  approve: "approved",
  reject: "rejected",
  send_back: "sent_back",
};

const ACTION_TO_ACTIVITY: Record<string, string> = {
  approve: "chain_step_approved",
  reject: "chain_step_rejected",
  send_back: "chain_step_sent_back",
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
      console.error("[act-on-chain-step] activity log error:", error.message);
    }
  }

  // ── Lifecycle Transition Convention (CLAUDE.md) ─────────────────────────
  // Every leases.lifecycle_status update MUST also bump status_changed_at
  // in the SAME UPDATE statement. Every status_change activity log row
  // MUST populate from_status + to_status as top-level columns AND keep
  // the equivalent fields inside details for backward compatibility,
  // and include a routing_path value so downstream consumers can
  // distinguish how the transition was produced.
  async function updateLifecycle(
    leaseId: string,
    newStatus: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabaseAdmin
      .from("leases")
      .update({
        lifecycle_status: newStatus,
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", leaseId);
    if (error) {
      console.error("[act-on-chain-step] lease lifecycle update error:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async function logStatusChange(
    leaseId: string,
    fromStatus: string,
    toStatus: string,
    extra: Record<string, unknown>,
  ) {
    const details = {
      // Keep the legacy nested shape so any consumer reading details.from /
      // details.to keeps working while we migrate to columns.
      from: fromStatus,
      to: toStatus,
      // Convention: every chain-driven transition is tagged 'chain'.
      routing_path: "chain",
      ...extra,
    };
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
      console.error("[act-on-chain-step] status_change log error:", error.message);
    }
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, origin);
  }

  const chainStepId = body?.chainStepId;
  const action = body?.action;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";

  if (!chainStepId || typeof chainStepId !== "string") {
    return jsonResponse({ ok: false, error: "chainStepId is required" }, 400, origin);
  }
  if (!action || !["approve", "reject", "send_back"].includes(action)) {
    return jsonResponse(
      { ok: false, error: "action must be approve | reject | send_back" },
      400,
      origin,
    );
  }
  // Comment required for reject and send_back, matches existing UX.
  if ((action === "reject" || action === "send_back") && !comment) {
    return jsonResponse(
      { ok: false, error: `${action} requires a comment.` },
      400,
      origin,
    );
  }

  // Load the chain step. Phase 7 adds effective_assignee_user_id and
  // assignee_resolution_source to the SELECT so we can recognize
  // delegate authority and tag activity log entries with the source.
  const { data: stepData, error: stepError } = await supabaseAdmin
    .from("lease_approval_chain")
    .select(
      "id, lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status, effective_assignee_user_id, assignee_resolution_source",
    )
    .eq("id", chainStepId)
    .maybeSingle();
  if (stepError || !stepData) {
    return jsonResponse(
      { ok: false, error: "Chain step not found" },
      404,
      origin,
    );
  }
  const step = stepData as ChainStepRow;
  if (step.status !== "pending") {
    return jsonResponse(
      { ok: false, error: `Step is not pending (current status: ${step.status})` },
      409,
      origin,
    );
  }

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed).
  const liveness = await checkWorkspaceLive(supabaseAdmin, step.workspace_id);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // Phase 5: signator approve requires a non-empty attestation.
  // Defense-in-depth alongside the row-level CHECK on
  // leases.signator_attestation_required (which rejects the lease
  // UPDATE) and the UI's ≥30-char gate.
  if (step.stage === "signator" && action === "approve" && !comment) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Signator approval requires a non-empty attestation. Type your intent-to-bind statement before approving.",
      },
      400,
      origin,
    );
  }

  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    step.workspace_id,
    "act-on-chain-step",
    origin,
    30,
  );
  if (rateLimitResponse) return rateLimitResponse;

  // Authorization: original assignee user OR effective assignee
  // (Phase 7 — covers admin reassign / voluntary delegation / OOO
  // routing / activated policy delegate) OR active voluntary delegation
  // for this step OR has the step's role OR workspace owner/admin
  // (override path). The first hit short-circuits.
  let authorized = false;
  let actedAsDelegate = false;
  let delegateResolution: string | null = null;

  // C3 (#111): effective_assignee_user_id is the precedence-resolved actor
  // (voluntary > OOO > policy delegate > original). Delegation is EXCLUSIVE —
  // when it is set, ONLY that user is assignee-authorized; the original approver
  // can no longer act on a step they handed off (they retain only the owner/admin
  // override paths below). Fall back to approver_user_id solely when there is no
  // resolved effective assignee: role-based rows (no user), or a pre-Phase-7
  // chain not yet backfilled by migration 20260618150000.
  if (step.effective_assignee_user_id) {
    if (step.effective_assignee_user_id === user.id) {
      authorized = true;
      if (step.approver_user_id !== user.id) {
        actedAsDelegate = true;
        delegateResolution = step.assignee_resolution_source ?? "unknown";
      }
    }
  } else if (step.approver_user_id && step.approver_user_id === user.id) {
    authorized = true;
  }

  // Phase 7: also accept active (un-revoked) voluntary delegations as
  // a defensive secondary path. Normally effective_assignee_user_id
  // already reflects the voluntary delegate, but if the denormalized
  // column is somehow stale this catches the canonical row.
  if (!authorized) {
    const { data: vd } = await supabaseAdmin
      .from("chain_step_voluntary_delegations")
      .select("id, delegated_by")
      .eq("chain_step_id", step.id)
      .eq("delegated_to", user.id)
      .is("revoked_at", null)
      .order("delegated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vd) {
      authorized = true;
      actedAsDelegate = true;
      delegateResolution = "voluntary_delegate";
    }
  }

  if (!authorized && step.approver_role) {
    const { data: roleRow } = await supabaseAdmin
      .from("workspace_roles")
      .select("id")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", user.id)
      .eq("role", step.approver_role)
      .maybeSingle();
    if (roleRow) authorized = true;
  }

  if (!authorized) {
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", step.workspace_id)
      .maybeSingle();
    if ((ws as any)?.owner_id === user.id) authorized = true;
  }

  if (!authorized) {
    const { data: adminMember } = await supabaseAdmin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", step.workspace_id)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (adminMember) authorized = true;
  }

  if (!authorized) {
    return jsonResponse(
      { ok: false, error: "Forbidden: you are not authorized to act on this step." },
      403,
      origin,
    );
  }

  // P1-2 lifecycle gate (placed AFTER authz so it never discloses lease state to
  // an unauthorized caller — P1-2 review, security). The step being 'pending' is
  // not enough: a signator row is inserted 'pending' at initial submission, so a
  // signator could otherwise reject/send-back a lease that hasn't even been
  // concept-approved. Gate:
  //   (a) no action of any kind on a terminal lease;
  //   (b) signator-stage actions require the lease to have reached the signature
  //       phase — before that (concept review / negotiation) the signator stage
  //       has not begun. Retroactive states (chain_violation and the executed
  //       states) are intentionally NOT blocked here — that reroute path is
  //       governed separately.
  const { data: lifecycleRow } = await supabaseAdmin
    .from("leases")
    .select("lifecycle_status")
    .eq("id", step.lease_id)
    .maybeSingle();
  const leaseLifecycle =
    (lifecycleRow as { lifecycle_status?: string | null } | null)?.lifecycle_status ?? null;
  if (leaseLifecycle && ["rejected", "cancelled", "expired"].includes(leaseLifecycle)) {
    return jsonResponse(
      {
        ok: false,
        error: `This lease is ${leaseLifecycle} — no further approval actions can be taken.`,
      },
      409,
      origin,
    );
  }
  const CONCEPT_PHASE_LIFECYCLES = [
    "draft",
    "submitted",
    "under_review",
    "concept_submitted",
    "concept_under_review",
    "in_negotiation",
  ];
  if (
    step.stage === "signator" &&
    leaseLifecycle &&
    CONCEPT_PHASE_LIFECYCLES.includes(leaseLifecycle)
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "This lease hasn't reached signature review yet. The signature step becomes available once the lease is advanced to Final Review.",
      },
      409,
      origin,
    );
  }

  const newStatus = ACTION_TO_STATUS[action];

  // Update the step row using the admin client. This bypasses the
  // assignee RLS policy's WITH CHECK (which requires action_by=auth.uid()
  // — auth.uid() is null in service-role context). We set action_by
  // explicitly to the acting user, preserving the audit trail.
  const { error: updateError } = await supabaseAdmin
    .from("lease_approval_chain")
    .update({
      status: newStatus,
      action_at: new Date().toISOString(),
      action_by: user.id,
      comment: comment || null,
    })
    .eq("id", step.id);
  if (updateError) {
    return jsonResponse(
      { ok: false, error: `Failed to update step: ${updateError.message}` },
      500,
      origin,
    );
  }

  await logActivity(step.lease_id, ACTION_TO_ACTIVITY[action], {
    chain_step_id: step.id,
    stage: step.stage,
    step_order: step.step_order,
    parallel_group: step.parallel_group,
    comment: comment || null,
    // Phase 7: when the actor is acting via delegation rather than
    // as the original assignee, tag the audit row so reviewers can
    // distinguish original vs delegated actions.
    acted_as_delegate: actedAsDelegate,
    delegate_resolution: actedAsDelegate ? delegateResolution : null,
    original_approver_user_id: actedAsDelegate ? step.approver_user_id : null,
  });

  // ── Phase 3: determine lifecycle mode ONCE, before any transition ─────
  // Per CLAUDE.md and the Phase 3 spec, mode is determined once at the
  // top of the request to avoid races where chain rows get inserted or
  // removed mid-handler. In practice act-on-chain-step always operates
  // on a chain step, so mode is virtually always 'chain' — but the
  // branching is implemented defensively to keep all transition sites
  // mode-aware.
  const mode: LifecycleMode = await getLifecycleMode(step.lease_id, supabaseAdmin);

  // Capture lease's current lifecycle for accurate from_status in chain
  // mode. Legacy mode keeps Phase 2's literal from_status values
  // verbatim to honor the byte-identical-observable-behavior contract.
  //
  // Phase 5: also capture requestor_id / user_id for the execution-owner
  // default when signator approve transitions the lease to
  // pending_counter_signature. Cheap (same row, more columns).
  let currentLifecycle: string | null = null;
  let leaseRequestorId: string | null = null;
  let leaseUserId: string | null = null;
  if (mode === "chain") {
    const { data: leaseRow } = await supabaseAdmin
      .from("leases")
      .select("lifecycle_status, requestor_id, user_id")
      .eq("id", step.lease_id)
      .maybeSingle();
    currentLifecycle = (leaseRow as any)?.lifecycle_status ?? null;
    leaseRequestorId = (leaseRow as any)?.requestor_id ?? null;
    leaseUserId = (leaseRow as any)?.user_id ?? null;
  }

  // Stage advancement / lifecycle transitions.
  let lifecycleChange: string | null = null;
  let nextAssignees: { userId: string | null; role: string | null }[] = [];
  let stageCompleted: boolean = false;

  if (action === "reject") {
    // Lease → rejected (terminal — same in both vocabularies). Mark all
    // remaining pending steps in the chain as superseded.
    const result = await updateLifecycle(step.lease_id, "rejected");
    if (result.ok) {
      lifecycleChange = "rejected";
      if (mode === "chain") {
        await logStatusChange(
          step.lease_id,
          currentLifecycle ?? "pending",
          "rejected",
          {
            triggered_by: "chain_step_rejected",
            chain_step_id: step.id,
          },
        );
      } else {
        // Legacy — byte-identical to Phase 2.
        await logStatusChange(step.lease_id, "pending", "rejected", {
          triggered_by: "chain_step_rejected",
          chain_step_id: step.id,
        });
      }
    }
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({ status: "superseded" })
      .eq("lease_id", step.lease_id)
      .eq("status", "pending");
  } else if (action === "send_back") {
    // Phase 5: send_back semantics differ by stage in chain mode.
    //   - concept stage send_back  → concept_submitted (Phase 2/3 behavior)
    //   - signator stage send_back → in_negotiation (Phase 5)
    // The signator's send-back loops the lease back to negotiation,
    // not back to the concept stage — concept approvers already
    // signed off; what changed is in the negotiated terms.
    //
    // Legacy mode keeps the Phase 2 byte-identical behavior
    // (always → 'submitted').
    let targetLifecycle: string;
    let activityType: string;
    if (mode === "chain" && step.stage === "signator") {
      targetLifecycle = "in_negotiation";
      activityType = "final_review_returned_to_negotiation";
    } else if (mode === "chain") {
      targetLifecycle = "concept_submitted";
      activityType = "chain_step_sent_back";
    } else {
      targetLifecycle = "submitted";
      activityType = "chain_step_sent_back";
    }

    const result = await updateLifecycle(step.lease_id, targetLifecycle);
    if (result.ok) {
      lifecycleChange = targetLifecycle;
      if (mode === "chain" && step.stage === "signator") {
        await logStatusChange(
          step.lease_id,
          currentLifecycle ?? "final_review",
          "in_negotiation",
          {
            triggered_by: "chain_step_sent_back",
            chain_step_id: step.id,
            stage: "signator",
            reason: comment,
          },
        );
        // Phase 5 audit row capturing the signator-specific transition
        // semantics. Distinct from chain_step_sent_back so downstream
        // dashboards can differentiate concept-vs-signator returns.
        await logActivity(step.lease_id, "final_review_returned_to_negotiation", {
          chain_step_id: step.id,
          reason: comment,
        });
      } else if (mode === "chain") {
        await logStatusChange(
          step.lease_id,
          currentLifecycle ?? "concept_under_review",
          "concept_submitted",
          {
            triggered_by: "chain_step_sent_back",
            chain_step_id: step.id,
          },
        );
      } else {
        // Legacy — byte-identical to Phase 2.
        await logStatusChange(step.lease_id, "under_review", "submitted", {
          triggered_by: "chain_step_sent_back",
          chain_step_id: step.id,
        });
      }
    }
    // For BOTH stages: mark only the current stage's pending rows as
    // superseded. Concept rows from a prior stage stay 'approved'
    // (preserving the audit trail); the spec's intent for signator
    // send-back is that the signator step row goes to 'sent_back'
    // (already done by the global UPDATE earlier in this handler) and
    // the lease is re-advanced via Phase 4's advance-to-final-review
    // when ready, which will insert a fresh pending signator row.
    await supabaseAdmin
      .from("lease_approval_chain")
      .update({ status: "superseded" })
      .eq("lease_id", step.lease_id)
      .eq("stage", step.stage)
      .eq("status", "pending");
  } else {
    // approve: load full chain to evaluate stage advancement.
    const { data: chainRows } = await supabaseAdmin
      .from("lease_approval_chain")
      .select("stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status")
      .eq("lease_id", step.lease_id);
    const allRows = (chainRows ?? []) as ChainStepLike[];

    if (step.stage === "concept" && isStageComplete(allRows, "concept")) {
      // Stage just completed. Chain mode → in_negotiation; legacy mode
      // → under_review (Phase 2 verbatim).
      const targetLifecycle = mode === "chain" ? "in_negotiation" : "under_review";
      const result = await updateLifecycle(step.lease_id, targetLifecycle);
      if (result.ok) {
        lifecycleChange = targetLifecycle;
        stageCompleted = true;
        // Phase 2's chain_stage_completed entry retained in BOTH modes
        // for backward compatibility with downstream activity-log
        // consumers that filter on it.
        await logActivity(step.lease_id, "chain_stage_completed", {
          stage: "concept",
          chain_step_id: step.id,
        });
        if (mode === "chain") {
          // Phase 3: more specific transition activity types.
          await logActivity(step.lease_id, "concept_stage_completed", {
            chain_step_id: step.id,
          });
          await logActivity(step.lease_id, "negotiation_stage_entered", {
            chain_step_id: step.id,
          });
          await logStatusChange(
            step.lease_id,
            currentLifecycle ?? "concept_submitted",
            "in_negotiation",
            {
              triggered_by: "chain_stage_completed",
              stage: "concept",
            },
          );
        } else {
          // Legacy — byte-identical to Phase 2.
          await logStatusChange(step.lease_id, "submitted", "under_review", {
            triggered_by: "chain_stage_completed",
            stage: "concept",
          });
        }
      }
      // Next assignees would be from the signator stage. Phase 2/3 does
      // not notify signator yet, but compute and return them so the
      // caller has the data if it wants to surface it.
      nextAssignees = findFirstPendingAssignees(allRows, "signator");
    } else if (step.stage === "concept") {
      // Approve in concept stage that did NOT complete the stage.
      // Chain-mode addition (Phase 3): if currently in 'concept_submitted',
      // bump to 'concept_under_review' on the FIRST concept-stage approval
      // (regardless of whether we crossed a sequential parallel-group level).
      // This is a new transition that did not exist in Phase 2; legacy
      // mode skips this branch and behaves identically to Phase 2.
      if (mode === "chain" && currentLifecycle === "concept_submitted") {
        const result = await updateLifecycle(
          step.lease_id,
          "concept_under_review",
        );
        if (result.ok) {
          lifecycleChange = "concept_under_review";
          await logStatusChange(
            step.lease_id,
            "concept_submitted",
            "concept_under_review",
            {
              triggered_by: "chain_step_approved",
              chain_step_id: step.id,
            },
          );
        }
      }
      if (advancedPastStepOrder(allRows, "concept", step.step_order)) {
        // Crossed a sequential level — compute who's now active.
        nextAssignees = findFirstPendingAssignees(allRows, "concept");

        // Phase 7: set pending_since on the new active concept rows
        // (the lowest step_order among required pending rows that
        // don't yet have pending_since populated). The cron functions
        // use pending_since to compute delegate-timer + stuck-chain
        // thresholds, so accuracy here matters.
        const { data: nextRows } = await supabaseAdmin
          .from("lease_approval_chain")
          .select("id, step_order")
          .eq("lease_id", step.lease_id)
          .eq("stage", "concept")
          .eq("status", "pending")
          .eq("is_required", true)
          .is("pending_since", null);
        const rows = (nextRows ?? []) as Array<{ id: string; step_order: number }>;
        if (rows.length > 0) {
          const minOrder = Math.min(...rows.map((r) => r.step_order));
          const ids = rows.filter((r) => r.step_order === minOrder).map((r) => r.id);
          if (ids.length > 0) {
            await supabaseAdmin
              .from("lease_approval_chain")
              .update({ pending_since: new Date().toISOString() })
              .in("id", ids);
          }
        }
      }
    } else if (step.stage === "signator") {
      // Phase 5: signator approve transitions the lease to
      // pending_counter_signature. The lease moves out of approval
      // workflow and into counter-signature chase mode.
      //
      // Required preconditions (already validated upstream):
      //   - mode === 'chain' (signator chain rows only exist in chain)
      //   - comment (= attestation) is non-empty (validated at body
      //     parsing time alongside reject/send_back validation)
      //   - The chain step has been authorized + UPDATED to status=approved
      //     by the standard handler block above; this block does the
      //     post-approve lease state transition.
      //
      // Note: Phase 5 spec assumes a single required signator step
      // resolves the stage on first approve. Multi-signator concurrence
      // is out of scope (chain rows can be added but only one is
      // consumed; if isStageComplete returns false, the lease stays in
      // final_review and the additional signator rows wait their turn).
      // We don't gate on isStageComplete here — even if there are more
      // signator rows, this single approve is the policy moment that
      // commits the company. This matches the spec's "Approve" branch.

      // Look up the workspace's counter-signature window
      const { data: wsRow } = await supabaseAdmin
        .from("workspaces")
        .select("counter_signature_default_due_days")
        .eq("id", step.workspace_id)
        .maybeSingle();
      const dueDays = (wsRow as any)?.counter_signature_default_due_days ?? 21;

      // Compute due date (UTC midnight today + dueDays). YYYY-MM-DD
      // string is what the date column expects.
      const today = new Date();
      const dueDate = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + dueDays,
      ));
      const dueDateStr = dueDate.toISOString().slice(0, 10);

      // Default execution owner: the lease submitter. Falls back to
      // user_id (the legacy uploader column) if requestor_id is null.
      const executionOwnerId = leaseRequestorId ?? leaseUserId;

      // Lease UPDATE: lifecycle + signator approval + counter-signature
      // setup + execution-owner assignment all in one statement so the
      // attestation CHECK constraint sees a consistent row.
      const nowIso = new Date().toISOString();
      const { error: leaseUpdateError } = await supabaseAdmin
        .from("leases")
        .update({
          lifecycle_status: "pending_counter_signature",
          signator_approved_at: nowIso,
          signator_attestation: comment,
          counter_signature_due_date: dueDateStr,
          execution_owner_id: executionOwnerId,
          status_changed_at: nowIso,
        })
        .eq("id", step.lease_id);
      if (leaseUpdateError) {
        console.error(
          "[act-on-chain-step] signator lease update error:",
          leaseUpdateError.message,
        );
        // The chain step has already been marked approved by the
        // earlier UPDATE. We can't easily roll that back; log and
        // surface the error so the signator UI can retry the lease
        // update path (which is idempotent given the chain step is
        // already approved).
        return jsonResponse(
          {
            ok: false,
            error: `Signator approve recorded on chain step but lease update failed: ${leaseUpdateError.message}`,
            reason: "lease_update_failed",
          },
          500,
          origin,
        );
      }

      lifecycleChange = "pending_counter_signature";
      stageCompleted = isStageComplete(allRows, "signator");

      // Phase 5 activity log entries:
      //   - signator_attestation_recorded — captures the attestation
      //     text for forensic audit (separate from chain_step_approved
      //     so consumers can filter on attestation events specifically)
      //   - chain_stage_completed — Phase 2 contract; retained
      //   - pending_counter_signature_started — Phase 3 contract;
      //     captures the new lifecycle state's entry
      //   - execution_owner_assigned — captures the auto-assignment
      //   - status_change — Lifecycle Transition Convention
      await logActivity(step.lease_id, "signator_attestation_recorded", {
        chain_step_id: step.id,
        attestation: comment,
        attestation_length: comment.length,
      });
      await logActivity(step.lease_id, "chain_stage_completed", {
        stage: "signator",
        chain_step_id: step.id,
      });
      await logActivity(step.lease_id, "pending_counter_signature_started", {
        chain_step_id: step.id,
        counter_signature_due_date: dueDateStr,
      });
      if (executionOwnerId) {
        await logActivity(step.lease_id, "execution_owner_assigned", {
          execution_owner_id: executionOwnerId,
          assigned_by: "system",
          reason: "default_at_signator_approval",
        });
      }
      await logStatusChange(
        step.lease_id,
        currentLifecycle ?? "final_review",
        "pending_counter_signature",
        {
          triggered_by: "signator_approved",
          chain_step_id: step.id,
          counter_signature_due_date: dueDateStr,
          execution_owner_id: executionOwnerId,
        },
      );

      // Notify the execution owner that they're now responsible for
      // chasing the counter-signature.
      if (executionOwnerId) {
        const { error: auditErr } = await supabaseAdmin.from("lease_activity_log").insert({
          lease_id: step.lease_id,
          user_id: null,
          activity_type: "comment",
          details: {
            notification_type: "execution_owner_assigned",
            recipient_ids: [executionOwnerId],
            message:
              `You are responsible for chasing the counter-signed document. Due ${dueDateStr}.`,
          },
        });
        if (auditErr) console.error("lease_activity_log insert failed (comment/execution_owner_assigned notification):", auditErr.message);
      }

      // No nextAssignees for Phase 5 — counter-signature is not a
      // chain step, it's a manual upload + record-counter-signature
      // edge function call.
    }
  }

  return jsonResponse(
    {
      ok: true,
      stepStatus: newStatus,
      stageCompleted,
      lifecycleChange,
      nextAssignees,
    },
    200,
    origin,
  );
});
