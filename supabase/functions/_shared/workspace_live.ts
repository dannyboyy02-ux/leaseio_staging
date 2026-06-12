// Workspace liveness gate for mutating edge functions (Vault V1 companion
// to migration 20260613000000 — service_role bypasses the RESTRICTIVE RLS
// layer, so every user-invokable mutator must check this explicitly).
//
// A workspace is NOT live when:
//   - canceled_at is set        (cancellation grace window — read+export only)
//   - soft_deleted_at is set    (access revoked, pre-purge)
//   - plan = 'vault'            (retention tier — read+export only; V2 value)
//
// Mirror of public.is_workspace_live() in the same migration. If the SQL
// helper's semantics change, change this too — drift between the two layers
// is its own bug.
//
// Usage (fail closed):
//   const liveness = await checkWorkspaceLive(supabaseAdmin, workspaceId);
//   if (!liveness.live) {
//     return jsonResponse(
//       { ok: false, error: "subscription_inactive", reason: liveness.reason },
//       403, origin,
//     );
//   }

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface WorkspaceLiveness {
  live: boolean;
  /** 'canceled' | 'soft_deleted' | 'vault' | 'not_found' | 'lookup_failed' */
  reason?: string;
}

export async function checkWorkspaceLive(
  supabaseAdmin: AdminClient,
  workspaceId: string | null | undefined,
): Promise<WorkspaceLiveness> {
  if (!workspaceId) return { live: false, reason: "not_found" };

  const { data, error } = await supabaseAdmin
    .from("workspaces")
    .select("canceled_at, soft_deleted_at, plan")
    .eq("id", workspaceId)
    .maybeSingle();

  // Fail CLOSED: if we can't establish liveness, we don't mutate.
  if (error) {
    console.error("workspace liveness lookup failed:", error.message);
    return { live: false, reason: "lookup_failed" };
  }
  if (!data) return { live: false, reason: "not_found" };

  if (data.soft_deleted_at) return { live: false, reason: "soft_deleted" };
  if (data.canceled_at) return { live: false, reason: "canceled" };
  if (data.plan === "vault") return { live: false, reason: "vault" };
  return { live: true };
}

/** Liveness resolved through a lease id (mirror of public.is_lease_live). */
export async function checkLeaseWorkspaceLive(
  supabaseAdmin: AdminClient,
  leaseId: string | null | undefined,
): Promise<WorkspaceLiveness> {
  if (!leaseId) return { live: false, reason: "not_found" };

  const { data, error } = await supabaseAdmin
    .from("leases")
    .select("workspace_id")
    .eq("id", leaseId)
    .maybeSingle();

  if (error) {
    console.error("lease liveness lookup failed:", error.message);
    return { live: false, reason: "lookup_failed" };
  }
  if (!data?.workspace_id) return { live: false, reason: "not_found" };

  return checkWorkspaceLive(supabaseAdmin, data.workspace_id);
}
