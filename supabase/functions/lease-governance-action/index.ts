import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const ALLOWED_ORIGINS = [
  "https://theleaseio.com",
  "https://www.theleaseio.com",
  "https://app.theleaseio.com",
  "https://theleaseio.lovable.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isLovablePreview =
    requestOrigin &&
    (requestOrigin.includes("lovableproject.com") ||
      requestOrigin.includes("lovable.app"));
  const isAllowed =
    (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) ||
    isLovablePreview;
  return {
    "Access-Control-Allow-Origin": isAllowed ? requestOrigin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" },
  });
}

const FIELD_TO_COLUMN: Record<string, string> = {
  tenant_name: "executed_tenant_name",
  landlord_name: "executed_landlord_name",
  commencement_date: "executed_commencement_date",
  expiry_date: "executed_expiry_date",
  monthly_payment: "executed_monthly_payment",
  rent_review_clause: "executed_rent_review_clause",
  break_clause: "executed_break_clause",
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
  }): Promise<string> {
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
    return (data as any).id;
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

      const changeSetId = await createDraftChangeSet({
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
      await insertAudit([
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
        {
          lease_id: (unlockRequest as any).lease_id,
          workspace_id: (unlockRequest as any).workspace_id,
          event_type: "change_set_created",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_unlock_request_id: unlockRequestId,
          related_change_set_id: changeSetId,
        },
      ]);
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
      if (!(await isWorkspaceAdmin((lease as any).workspace_id))) {
        return jsonResponse({ error: "Forbidden" }, 403, origin);
      }
      if (!(lease as any).model_locked || (lease as any).lifecycle_status !== "active") {
        return jsonResponse({ error: "Lease is not locked and active" }, 422, origin);
      }

      const changeSetId = await createDraftChangeSet({
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
      await insertAudit([
        {
          lease_id: leaseId,
          workspace_id: (lease as any).workspace_id,
          event_type: "unlock_approved",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
          change_summary: note,
        },
        {
          lease_id: leaseId,
          workspace_id: (lease as any).workspace_id,
          event_type: "change_set_created",
          actor_user_id: user.id,
          actor_email: actorEmail,
          related_change_set_id: changeSetId,
        },
      ]);
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
      for (const item of (items ?? []) as Array<any>) {
        const column = FIELD_TO_COLUMN[item.field_name];
        if (column) leaseUpdate[column] = item.proposed_value;
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
