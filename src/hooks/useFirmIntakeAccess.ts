import { useApp } from '@/contexts/AppContext';
import { useFirm } from '@/contexts/FirmContext';

/**
 * #197 (owner decision 2026-08-14): firm staff can create leases in child
 * workspaces. This hook is the CLIENT third of the three lockstep gates —
 * the leases INSERT policy (20260814190000) and
 * supabase/functions/_shared/role_gate.ts are the other two.
 *
 * Answers: "is this session intake-capable HERE purely via firm membership?"
 * True only when the user has NO direct workspace_members row (`!userRole`)
 * AND the current workspace is bound to a firm the user belongs to. Direct
 * roles keep their existing arms at the call sites (admin/editor allowed,
 * viewer read-only — a direct viewer row out-ranks the firm allowance, same
 * as the server gates). `restrict_firm_access` needs no client check: a
 * restricted child is invisible to a purely firm-derived session
 * (is_workspace_member excludes it), so it can never be the active workspace.
 */
export function useFirmIntakeAccess(): boolean {
  const { workspace, userRole } = useApp();
  const { firmMemberships } = useFirm();
  if (userRole) return false;
  if (!workspace?.firmId) return false;
  return firmMemberships.some((m) => m.firm_id === workspace.firmId);
}
