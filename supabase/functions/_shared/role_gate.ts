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
// Semantics (kept in lockstep with the leases INSERT policy
// leases_insert_own_editor_plus — see 20260814190000):
//   - workspace OWNER                       -> allowed
//   - member role admin/editor              -> allowed
//   - member role viewer                    -> blocked
//   - FIRM staff of the owning firm (#197,  -> allowed
//     owner decision 2026-08-14) unless the
//     child set restrict_firm_access — both
//     firm roles map to editor-or-better
//   - no membership / any error             -> blocked (fail closed)

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
    .select('owner_id, firm_id, restrict_firm_access')
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
  if (role === 'admin' || role === 'editor') return true;
  // A direct VIEWER row is a deliberate read-only assignment — it wins over
  // any firm-derived allowance (a firm shouldn't out-rank an explicit "this
  // person is read-only here").
  if (role === 'viewer') return false;

  // #197 (owner decision 2026-08-14): firm staff of the owning firm are
  // intake-capable in child workspaces unless the child opted out — mirrors
  // the INSERT policy's firm arm (and is_workspace_member's Phase-9 shape).
  if (ws?.firm_id && ws?.restrict_firm_access === false) {
    const { data: fmRows, error: fmErr } = await admin
      .from('firm_members')
      .select('id')
      .eq('firm_id', ws.firm_id)
      .eq('user_id', userId)
      .limit(1);
    if (fmErr) return false;
    return (fmRows?.length ?? 0) > 0;
  }

  return false;
}

/** Canonical user-facing copy + machine reason, mirroring the monetization gate.
 *  Worded around ACCESS, not "your role is view-only" — the gate also blocks
 *  firm-derived staff (no direct membership row), for whom a view-only claim
 *  would be false (Wave 5b polish review). */
export const READ_ONLY_ROLE_ERROR =
  "Your access to this workspace doesn't include adding or processing leases. Ask a workspace admin if you need edit access.";
export const READ_ONLY_ROLE_REASON = 'read_only_role';
