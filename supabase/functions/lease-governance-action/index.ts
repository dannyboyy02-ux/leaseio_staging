import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  return baseCorsHeaders(requestOrigin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" },
  });
}

// Maps the workbench field id (matches SECTION_CONFIG[*].fields[*].id) to
// the lease column it writes to on apply. CRITICAL: every editable field
// MUST be in this map. Items whose field_name isn't a key are SILENTLY
// SKIPPED on apply — that's the bug class that lost asset_type edits and
// caused the Portfolio to render stale values.
//
// The 'executed_*' entries (tenant_name, landlord_name, commencement_date,
// expiry_date, monthly_payment, rent_review_clause, break_clause) are
// pre-existing variance-tracking columns used when the workbench is in
// "executed terms review" mode; they're not the live lease columns.
// We keep them BUT also add direct-column mappings for the same fields,
// keyed differently. The two paths don't conflict because field_name in
// lease_change_set_items is set by the workbench section card and
// uniquely identifies the source.
const FIELD_TO_COLUMN: Record<string, string> = {
  // --- Pre-existing executed-terms variance columns (kept for back-compat) ---
  commencement_date: "executed_commencement_date",
  expiry_date: "executed_expiry_date",
  monthly_payment: "executed_monthly_payment",
  rent_review_clause: "executed_rent_review_clause",
  break_clause: "executed_break_clause",

  // --- Live lease columns (every workbench-editable scalar field) ---
  // Parties
  tenant_name: "tenant_name",
  landlord_name: "landlord_name",
  vendor_name: "vendor_name",

  // Property / classification
  asset_type: "asset_type",
  property_address: "property_address",
  location: "location",
  building: "building",
  region: "region",
  requesting_department: "requesting_department",
  square_footage: "square_footage",

  // Dates / term
  lease_start: "lease_start",
  lease_end: "lease_end",
  rent_commencement_date: "rent_commencement_date",
  term_months: "term_months",

  // Rent
  base_rent_amount: "base_rent_amount",
  base_rent_frequency: "base_rent_frequency",
  current_monthly_rent: "current_monthly_rent",
  security_deposit: "security_deposit",

  // Clauses (long-form text)
  renewal_options: "renewal_options",
  escalation_clauses: "escalation_clauses",
  termination_clauses: "termination_clauses",
  rent_escalation_type: "rent_escalation_type",
};

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(origin) });
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
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ error: "Invalid authentication" }, 401, origin);
  }

  const user = userData.user;
  const actorEmail = user.email ?? null;

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed). Each action branch
  // calls this exactly once, right after its target row is resolved and
  // validated, before any mutation.
  async function livenessGate(workspaceId: string): Promise<Response | null> {
    const liveness = await checkWorkspaceLive(supabaseAdmin, workspaceId);
    if (!liveness.live) {
      return jsonResponse(
        { ok: false, error: "subscription_inactive", reason: liveness.reason },
        403,
        origin,
      );
    }
    return null;
  }

  async function isWorkspaceAdmin(workspaceId: string): Promise<boolean> {
    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (workspaceError || !workspace) return false;
    if ((workspace as any).owner_id === user.id) return true;

    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    return Boolean(member);
  }

  async function canApproveChangeSet(workspaceId: string): Promise<boolean> {
    if (await isWorkspaceAdmin(workspaceId)) return true;
    const { data: role } = await supabaseAdmin
      .from("workspace_roles")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .in("role", ["financial_approver", "admin"])
      .maybeSingle();
    return Boolean(role);
  }

  async function logActivity(leaseId: string, activityType: string, details: Record<string, unknown>) {
    await supabaseAdmin
      .from("lease_activity_log")
      .insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: activityType,
        details,
      })
      .then(({ error }) => {
        if (error) console.error("[lease-governance-action] activity log error:", error.message);
      });
  }

  async function insertAudit(rows: Array<Record<string, unknown>> | Record<string, unknown>) {
    await supabaseAdmin
      .from("lease_governance_audit")
      .insert(rows as any)
      .then(({ error }) => {
        if (error) console.error("[lease-governance-action] audit log error:", error.message);
      });
  }

  async function createDraftChangeSet({
    leaseId,
    workspaceId,
    unlockRequestId,
    submittedBy,
  }: {
    leaseId: string;
    workspaceId: string;
    unlockRequestId: string | null;
    submittedBy: string;
  }): Promise<{ id: string; created: boolean }> {
    // Reuse the existing open change set (draft or pending_approval) for this
    // lease if one exists. Without this, repeated unlocks would create
    // duplicate drafts — the frontend's maybeSingle() returns null on multiple
    // matches, which silently disables editing for the user.
    //
    // Return shape: { id, created }. `created=false` means we reused an
    // existing draft; callers MUST NOT emit a `change_set_created` audit
    // event in that case (the original create event is already in the log).
    const { data: existing } = await supabaseAdmin
      .from("lease_change_sets")
      .select("id")
      .eq("lease_id", leaseId)
      .in("status", ["draft", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing && (existing as any).id) {
      return { id: (existing as any).id, created: false };
    }

    const { data, error } = await supabaseAdmin
      .from("lease_change_sets")
      .insert({
        lease_id: leaseId,
        workspace_id: workspaceId,
        unlock_request_id: unlockRequestId,
        submitted_by: submittedBy,
        status: "draft",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Failed to create change set");
    return { id: (data as any).id, created: true };
  }

  try {
    const body = await req.json();
    const action = body?.action as string | undefined;
    const note = typeof body?.note === "string" ? body.note.trim() || null : null;

    if (action === "approve_unlock_request" || action === "reject_unlock_request") {
      const unlockRequestId = body?.unlockRequestId as string | undefined;
      if (!unlockRequestId) return jsonResponse({ error: "unlockRequestId is required" }, 400, origin);

      const { data: unlockRequest, error: requestError } = await supabaseAdmin
        .from("lease_unlock_requests")
        .select("id, lease_id, workspace_id, requested_by, status")
        .eq("id", unlockRequestId)
        .maybeSingle();
      if (requestError || !unlockRequest) return jsonResponse({ error: "Unlock request not found" }, 404, origin);
      if ((unlockRequest as any).status !== "pending") {
        return jsonResponse({ error: "Unlock request has already been resolved" }, 409, origin);
      }
      const liveBlock = await livenessGate((unlockRequest as any).workspace_id);
      if (liveBlock) return liveBlock;
      if (!(await isWorkspaceAdmin((unlockRequest as any).workspace_id))) {
        return jsonResponse({ error: "Forbidden" }, 403, origin);
      }

      if (action === "reject_unlock_request") {
        const { error } = await supabaseAdmin
          .from("lease_unlock_requests")
          .update({
            status: "rejected",
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
            review_note: note,
          })
          .eq("id", unlockRequestId);
        if (error) throw error;

        await logActivity((unlockRequest as any).lease_id, "unlock_rejected", {
          unlock_request_id: unlockRequestId,
          note,
        });
        await insertAudit({
          lease_id: (unlockRequest as any).lease_id,
          workspace_id: (unlockRequest as any).workspace_id,
          event_type: "unlock_rejected",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_unlock_request_id: unlockRequestId,
          rejection_reason: note,
        });
        return jsonResponse({ ok: true }, 200, origin);
      }

      const { data: lease, error: leaseError } = await supabaseAdmin
        .from("leases")
        .select("id, workspace_id, lifecycle_status, model_locked")
        .eq("id", (unlockRequest as any).lease_id)
        .maybeSingle();
      if (leaseError || !lease) return jsonResponse({ error: "Lease not found" }, 404, origin);
      if (!(lease as any).model_locked || (lease as any).lifecycle_status !== "active") {
        return jsonResponse({ error: "Lease is not locked and active" }, 422, origin);
      }

      const { id: changeSetId, created: changeSetCreated } = await createDraftChangeSet({
        leaseId: (unlockRequest as any).lease_id,
        workspaceId: (unlockRequest as any).workspace_id,
        unlockRequestId,
        submittedBy: (unlockRequest as any).requested_by,
      });

      const { error: updateError } = await supabaseAdmin
        .from("lease_unlock_requests")
        .update({
          status: "approved",
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_note: note,
        })
        .eq("id", unlockRequestId);
      if (updateError) throw updateError;

      const { error: unlockError } = await supabaseAdmin
        .from("leases")
        .update({ model_locked: false })
        .eq("id", (unlockRequest as any).lease_id);
      if (unlockError) throw unlockError;

      await logActivity((unlockRequest as any).lease_id, "unlock_approved", {
        unlock_request_id: unlockRequestId,
        change_set_id: changeSetId,
        note,
      });
      const auditRows: any[] = [
        {
          lease_id: (unlockRequest as any).lease_id,
          workspace_id: (unlockRequest as any).workspace_id,
          event_type: "unlock_approved",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_unlock_request_id: unlockRequestId,
          related_change_set_id: changeSetId,
          change_summary: note,
        },
      ];
      // Only emit change_set_created if we ACTUALLY created a new draft.
      // Reusing an existing draft would otherwise double-emit (audit posture
      // bug surfaced by the sweep — 9 events for 7 distinct change_sets).
      if (changeSetCreated) {
        auditRows.push({
          lease_id: (unlockRequest as any).lease_id,
          workspace_id: (unlockRequest as any).workspace_id,
          event_type: "change_set_created",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_unlock_request_id: unlockRequestId,
          related_change_set_id: changeSetId,
        });
      }
      await insertAudit(auditRows);
      return jsonResponse({ ok: true, changeSetId }, 200, origin);
    }

    if (action === "direct_unlock") {
      const leaseId = body?.leaseId as string | undefined;
      if (!leaseId) return jsonResponse({ error: "leaseId is required" }, 400, origin);

      const { data: lease, error: leaseError } = await supabaseAdmin
        .from("leases")
        .select("id, workspace_id, lifecycle_status, model_locked")
        .eq("id", leaseId)
        .maybeSingle();
      if (leaseError || !lease) return jsonResponse({ error: "Lease not found" }, 404, origin);
      const liveBlock = await livenessGate((lease as any).workspace_id);
      if (liveBlock) return liveBlock;
      if (!(await isWorkspaceAdmin((lease as any).workspace_id))) {
        return jsonResponse({ error: "Forbidden" }, 403, origin);
      }
      if (!(lease as any).model_locked || (lease as any).lifecycle_status !== "active") {
        return jsonResponse({ error: "Lease is not locked and active" }, 422, origin);
      }

      const { id: changeSetId, created: changeSetCreated } = await createDraftChangeSet({
        leaseId,
        workspaceId: (lease as any).workspace_id,
        unlockRequestId: null,
        submittedBy: user.id,
      });

      const { error: unlockError } = await supabaseAdmin
        .from("leases")
        .update({ model_locked: false })
        .eq("id", leaseId);
      if (unlockError) throw unlockError;

      await logActivity(leaseId, "unlock_approved", {
        change_set_id: changeSetId,
        direct_admin_unlock: true,
        note,
      });
      const auditRows: any[] = [
        {
          lease_id: leaseId,
          workspace_id: (lease as any).workspace_id,
          event_type: "unlock_approved",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          change_summary: note,
        },
      ];
      // Only emit change_set_created on actual create — same double-emit
      // guard as the approve_unlock_request branch.
      if (changeSetCreated) {
        auditRows.push({
          lease_id: leaseId,
          workspace_id: (lease as any).workspace_id,
          event_type: "change_set_created",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
        });
      }
      await insertAudit(auditRows);
      return jsonResponse({ ok: true, changeSetId }, 200, origin);
    }

    if (action === "approve_change_set" || action === "reject_change_set") {
      const changeSetId = body?.changeSetId as string | undefined;
      if (!changeSetId) return jsonResponse({ error: "changeSetId is required" }, 400, origin);

      const { data: changeSet, error: changeSetError } = await supabaseAdmin
        .from("lease_change_sets")
        .select("id, lease_id, workspace_id, status")
        .eq("id", changeSetId)
        .maybeSingle();
      if (changeSetError || !changeSet) return jsonResponse({ error: "Change set not found" }, 404, origin);
      if ((changeSet as any).status !== "pending_approval") {
        return jsonResponse({ error: "Change set is not pending approval" }, 409, origin);
      }
      const liveBlock = await livenessGate((changeSet as any).workspace_id);
      if (liveBlock) return liveBlock;
      if (!(await canApproveChangeSet((changeSet as any).workspace_id))) {
        return jsonResponse({ error: "Forbidden" }, 403, origin);
      }

      if (action === "reject_change_set") {
        const { error } = await supabaseAdmin
          .from("lease_change_sets")
          .update({
            status: "rejected",
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
            review_note: note,
          })
          .eq("id", changeSetId);
        if (error) throw error;

        await logActivity((changeSet as any).lease_id, "change_rejected", {
          change_set_id: changeSetId,
          note,
        });
        await insertAudit({
          lease_id: (changeSet as any).lease_id,
          workspace_id: (changeSet as any).workspace_id,
          event_type: "change_set_rejected",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          rejection_reason: note,
        });
        return jsonResponse({ ok: true }, 200, origin);
      }

      const { data: items, error: itemError } = await supabaseAdmin
        .from("lease_change_set_items")
        .select("field_name, field_label, old_value, proposed_value")
        .eq("change_set_id", changeSetId);
      if (itemError) throw itemError;

      const leaseUpdate: Record<string, unknown> = {};
      const unmappedFields: string[] = [];
      for (const item of (items ?? []) as Array<any>) {
        const column = FIELD_TO_COLUMN[item.field_name];
        if (column) {
          leaseUpdate[column] = item.proposed_value;
        } else {
          unmappedFields.push(item.field_name);
        }
      }
      // If any staged item couldn't be mapped to a column, that's a bug
      // (FIELD_TO_COLUMN is incomplete). Fail loud instead of silently
      // dropping — silent drops were how asset_type edits got lost.
      if (unmappedFields.length > 0) {
        console.error('[lease-governance-action] approve: unmapped fields', unmappedFields);
        return jsonResponse({
          error: `Cannot apply change set — unmapped fields: ${unmappedFields.join(', ')}. Add them to FIELD_TO_COLUMN.`,
        }, 500, origin);
      }
      leaseUpdate.model_locked = true;

      const { error: leaseUpdateError } = await supabaseAdmin
        .from("leases")
        .update(leaseUpdate as any)
        .eq("id", (changeSet as any).lease_id);
      if (leaseUpdateError) throw leaseUpdateError;

      const { error: changeSetUpdateError } = await supabaseAdmin
        .from("lease_change_sets")
        .update({
          status: "approved",
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_note: note,
        })
        .eq("id", changeSetId);
      if (changeSetUpdateError) throw changeSetUpdateError;

      await logActivity((changeSet as any).lease_id, "change_approved", {
        change_set_id: changeSetId,
        note,
      });
      await insertAudit([
        {
          lease_id: (changeSet as any).lease_id,
          workspace_id: (changeSet as any).workspace_id,
          event_type: "change_set_approved",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          change_summary: note,
        },
        ...((items ?? []) as Array<any>).map((item) => ({
          lease_id: (changeSet as any).lease_id,
          workspace_id: (changeSet as any).workspace_id,
          event_type: "field_change_committed",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          field_name: item.field_name,
          field_label: item.field_label,
          old_value: item.old_value,
          proposed_value: item.proposed_value,
          final_value: item.proposed_value,
        })),
        {
          lease_id: (changeSet as any).lease_id,
          workspace_id: (changeSet as any).workspace_id,
          event_type: "lease_relocked",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
        },
      ]);

      return jsonResponse({ ok: true }, 200, origin);
    }

    if (action === "submit_change_set") {
      // Server-side trust boundary for the Lock-with-edits flow. Two modes:
      //   - 'approver'     → standard pending_approval queue (any role).
      //   - 'self_approve' → admin-only soft bypass: changes apply immediately,
      //                       audit trail flags self_approved=true.
      // The frontend chooses the mode based on userRole; we re-validate here.
      const changeSetId = body?.changeSetId as string | undefined;
      const mode = (body?.mode as string | undefined) ?? "approver";
      // Optional in 'approver' mode: the specific user_id the submitter
      // wants to approve. Server validates the target is a workspace admin.
      const requestedApproverId = body?.requestedApproverId as string | undefined;
      if (!changeSetId) return jsonResponse({ error: "changeSetId is required" }, 400, origin);
      if (mode !== "approver" && mode !== "self_approve") {
        return jsonResponse({ error: "Invalid mode (expected 'approver' or 'self_approve')" }, 400, origin);
      }

      const { data: changeSet, error: changeSetError } = await supabaseAdmin
        .from("lease_change_sets")
        .select("id, lease_id, workspace_id, submitted_by, status")
        .eq("id", changeSetId)
        .maybeSingle();
      if (changeSetError || !changeSet) return jsonResponse({ error: "Change set not found" }, 404, origin);
      if ((changeSet as any).status !== "draft") {
        return jsonResponse({ error: "Only draft change sets can be submitted" }, 409, origin);
      }
      const liveBlock = await livenessGate((changeSet as any).workspace_id);
      if (liveBlock) return liveBlock;

      const isSubmitter = (changeSet as any).submitted_by === user.id;
      const isAdminUser = await isWorkspaceAdmin((changeSet as any).workspace_id);
      if (!isSubmitter && !isAdminUser) {
        return jsonResponse({ error: "Forbidden — only the submitter or a workspace admin may submit this change set" }, 403, origin);
      }

      const { data: items, error: itemError } = await supabaseAdmin
        .from("lease_change_set_items")
        .select("field_name, field_label, old_value, proposed_value")
        .eq("change_set_id", changeSetId);
      if (itemError) throw itemError;
      if (!items || items.length === 0) {
        return jsonResponse({ error: "Change set has no items to submit" }, 409, origin);
      }

      const now = new Date().toISOString();
      const leaseId = (changeSet as any).lease_id as string;
      const workspaceId = (changeSet as any).workspace_id as string;

      if (mode === "self_approve") {
        // Trust boundary: must be a workspace admin. Frontend role checks
        // are advisory; this is the authoritative gate.
        if (!isAdminUser) {
          return jsonResponse({ error: "Self-approval requires workspace admin role" }, 403, origin);
        }

        // Apply each staged item to the corresponding lease column.
        const leaseUpdate: Record<string, unknown> = {};
        const unmappedFields: string[] = [];
        for (const item of items as Array<any>) {
          const column = FIELD_TO_COLUMN[item.field_name];
          if (column) {
            leaseUpdate[column] = item.proposed_value;
          } else {
            unmappedFields.push(item.field_name);
          }
        }
        // Self-approve must also fail loud on unmapped fields — same
        // silent-drop bug class as the approver path.
        if (unmappedFields.length > 0) {
          console.error('[lease-governance-action] self_approve: unmapped fields', unmappedFields);
          return jsonResponse({
            error: `Cannot apply change set — unmapped fields: ${unmappedFields.join(', ')}. Add them to FIELD_TO_COLUMN.`,
          }, 500, origin);
        }
        leaseUpdate.model_locked = true;
        leaseUpdate.model_locked_at = now;
        leaseUpdate.model_locked_by = user.id;

        const { error: leaseUpdateError } = await supabaseAdmin
          .from("leases")
          .update(leaseUpdate as any)
          .eq("id", leaseId);
        if (leaseUpdateError) throw leaseUpdateError;

        const { error: csUpdateError } = await supabaseAdmin
          .from("lease_change_sets")
          .update({
            status: "approved",
            self_approved: true,
            // submitted_by intentionally NOT overwritten — preserves the
            // original requester's attribution (set at createDraftChangeSet
            // time). Previously this overwrote to user.id which was the
            // admin self-approving, hiding the original requester from the
            // audit trail and conflicting with the
            // prevent_change_set_field_tampering trigger added in
            // migration 20260517000000. The admin's identity is captured
            // in reviewed_by + self_approved=true + the activity/audit
            // rows below.
            submitted_at: now,
            reviewed_by: user.id,
            reviewed_at: now,
            review_note: "Self-approved by admin role",
          })
          .eq("id", changeSetId);
        if (csUpdateError) throw csUpdateError;

        await logActivity(leaseId, "change_set_self_approved", {
          change_set_id: changeSetId,
          item_count: items.length,
          actor_user_id: user.id,
        });
        await insertAudit([
          {
            lease_id: leaseId,
            workspace_id: workspaceId,
            event_type: "change_set_self_approved",
            actor_user_id: user.id,
            actor_email: actorEmail,
            related_change_set_id: changeSetId,
            change_summary: `${items.length} field(s) self-approved by admin`,
          },
          ...((items ?? []) as Array<any>).map((item) => ({
            lease_id: leaseId,
            workspace_id: workspaceId,
            event_type: "field_change_committed",
            actor_user_id: user.id,
            actor_email: actorEmail,
            related_change_set_id: changeSetId,
            field_name: item.field_name,
            field_label: item.field_label,
            old_value: item.old_value,
            proposed_value: item.proposed_value,
            final_value: item.proposed_value,
          })),
          {
            lease_id: leaseId,
            workspace_id: workspaceId,
            event_type: "lease_relocked",
            actor_user_id: user.id,
            actor_email: actorEmail,
            related_change_set_id: changeSetId,
          },
        ]);

        return jsonResponse({ ok: true, mode: "self_approve", applied: items.length }, 200, origin);
      }

      // mode === 'approver' — standard pending_approval flow. Optional
      // requested_approver_id targets a specific admin reviewer; if
      // provided, server-validates the target is a workspace admin.
      let validatedApproverId: string | null = null;
      if (requestedApproverId) {
        const { data: targetMembership } = await supabaseAdmin
          .from("workspace_members")
          .select("role")
          .eq("workspace_id", workspaceId)
          .eq("user_id", requestedApproverId)
          .maybeSingle();
        const { data: targetOwnedWs } = await supabaseAdmin
          .from("workspaces")
          .select("id")
          .eq("id", workspaceId)
          .eq("owner_id", requestedApproverId)
          .maybeSingle();
        const isAdminOrOwner = (targetMembership && (targetMembership as any).role === 'admin') || !!targetOwnedWs;
        if (!isAdminOrOwner) {
          return jsonResponse({ error: "Requested approver must be a workspace admin or owner" }, 400, origin);
        }
        validatedApproverId = requestedApproverId;
      }

      const { error: csSubmitError } = await supabaseAdmin
        .from("lease_change_sets")
        .update({
          status: "pending_approval",
          self_approved: false,
          // submitted_by intentionally NOT overwritten — preserves the
          // value set at createDraftChangeSet time. In the direct path
          // (submitter creates and submits their own draft) that value
          // is already user.id, so the prior overwrite was a no-op. In
          // the approve_unlock_request path (admin acts on behalf of
          // requester) it preserves the requester's attribution rather
          // than overwriting it with the admin's id. Aligns with the
          // prevent_change_set_field_tampering trigger added in
          // migration 20260517000000.
          submitted_at: now,
          requested_approver_id: validatedApproverId,
        })
        .eq("id", changeSetId);
      if (csSubmitError) throw csSubmitError;

      const { error: relockError } = await supabaseAdmin
        .from("leases")
        .update({
          model_locked: true,
          model_locked_at: now,
          model_locked_by: user.id,
        })
        .eq("id", leaseId);
      if (relockError) throw relockError;

      await logActivity(leaseId, "change_set_submitted", {
        change_set_id: changeSetId,
        item_count: items.length,
        requested_approver_id: validatedApproverId,
      });
      await insertAudit([
        {
          lease_id: leaseId,
          workspace_id: workspaceId,
          event_type: "change_set_submitted",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          change_summary: `${items.length} field(s) submitted for approval`,
        },
        ...((items ?? []) as Array<any>).map((item) => ({
          lease_id: leaseId,
          workspace_id: workspaceId,
          event_type: "field_change_staged",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          field_name: item.field_name,
          field_label: item.field_label,
          old_value: item.old_value,
          proposed_value: item.proposed_value,
        })),
      ]);

      return jsonResponse({ ok: true, mode: "approver", queued: items.length }, 200, origin);
    }

    if (action === "cancel_change_set") {
      const changeSetId = body?.changeSetId as string | undefined;
      if (!changeSetId) return jsonResponse({ error: "changeSetId is required" }, 400, origin);

      const { data: changeSet, error: changeSetError } = await supabaseAdmin
        .from("lease_change_sets")
        .select("id, lease_id, workspace_id, submitted_by, status")
        .eq("id", changeSetId)
        .maybeSingle();
      if (changeSetError || !changeSet) return jsonResponse({ error: "Change set not found" }, 404, origin);
      if ((changeSet as any).status !== "draft") {
        return jsonResponse({ error: "Only draft change sets can be canceled" }, 409, origin);
      }
      const liveBlock = await livenessGate((changeSet as any).workspace_id);
      if (liveBlock) return liveBlock;

      const isSubmitter = (changeSet as any).submitted_by === user.id;
      if (!isSubmitter && !(await isWorkspaceAdmin((changeSet as any).workspace_id))) {
        return jsonResponse({ error: "Forbidden" }, 403, origin);
      }

      const { error: cancelError } = await supabaseAdmin
        .from("lease_change_sets")
        .update({ status: "canceled" })
        .eq("id", changeSetId);
      if (cancelError) throw cancelError;

      const { error: relockError } = await supabaseAdmin
        .from("leases")
        .update({ model_locked: true })
        .eq("id", (changeSet as any).lease_id);
      if (relockError) throw relockError;

      await logActivity((changeSet as any).lease_id, "change_canceled", {
        change_set_id: changeSetId,
      });
      await insertAudit({
        lease_id: (changeSet as any).lease_id,
        workspace_id: (changeSet as any).workspace_id,
        event_type: "change_set_canceled",
        actor_user_id: user.id,
        actor_email: actorEmail,
        related_change_set_id: changeSetId,
      });
      return jsonResponse({ ok: true }, 200, origin);
    }

    return jsonResponse({ error: "Unknown governance action" }, 400, origin);
  } catch (err) {
    console.error("[lease-governance-action] Error:", err instanceof Error ? err.message : err);
    return jsonResponse({ error: "Governance action failed" }, 500, origin);
  }
});
