// Shared viewer read-only gate (Wave 5 "honest walls", Decision 2026-08-14).
//
// The Viewer role is sold as "read-only access to view leases and reports"
// (InviteMemberDialog), but until this gate the two paid-AI entry points
// accepted any workspace member: a viewer could create leases and burn paid
// Opus abstractions against the workspace quota (Wave-4 persona sweep, HIGH).
// Enforced on BOTH entry points — process_lease (first pass) and retry_lease
// (a retry burns Opus exactly like a first pass) — in lockstep with the RLS
// INSERT policy (leases_insert_own_editor_plus), mirroring how
// _shared/monetization.ts keeps the subscription gate paired.
//
// Semantics (deliberately identical to public.has_workspace_permission(...,
// 'editor'), the gate the leases UPDATE policy already uses):
//   - workspace OWNER            -> allowed
//   - member role admin/editor   -> allowed
//   - member role viewer         -> blocked
//   - no membership / any error  -> blocked (fail closed; legitimate callers
//     are always owners or members — RLS would zero their writes anyway)
// Firm-derived access (firm staff with no direct workspace_members row) is
// NOT granted here — the same stance has_workspace_permission takes for the
// UPDATE policy, so server and RLS agree. If firm staff ever need intake,
// both gates move together.

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export async function callerCanProcessLeases(
  admin: AdminClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  if (!workspaceId || !userId) return false;

  const { data: ws, error: wsErr } = await admin
    .from('workspaces')
    .select('owner_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (wsErr) return false; // fail closed on lookup errors
  if (ws?.owner_id === userId) return true;

  const { data: rows, error: mErr } = await admin
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .limit(1);
  if (mErr) return false;
  const role = rows?.[0]?.role;
  return role === 'admin' || role === 'editor';
}

/** Canonical user-facing copy + machine reason, mirroring the monetization gate. */
export const READ_ONLY_ROLE_ERROR =
  "Your role in this workspace is view-only, so it can't add or process leases. Ask a workspace admin if you need edit access.";
export const READ_ONLY_ROLE_REASON = 'read_only_role';
