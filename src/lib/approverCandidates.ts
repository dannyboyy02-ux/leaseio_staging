// Pure approver-candidate composition. Extracted from LeaseReview's
// "Request Approval" flow (P2-04 monolith decomposition).
//
// Inputs come from three workspace tables — workspaces.owner_id,
// workspace_members where role='admin', and workspace_approvers — plus
// a profiles lookup. The page component owns those queries; this
// module owns the deterministic merge, self-exclusion, label
// composition, and sort order so the contract is unit-testable.

export interface ApproverCandidate {
  id: string;
  /** Display label: "First Last (email@x.com)" if name present, else email. */
  label: string;
  isOwner: boolean;
}

export interface ApproverProfile {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface BuildApproverCandidatesInput {
  /** workspace.owner_id, may be null. */
  ownerId: string | null;
  /** user_id values from workspace_members where role='admin'. */
  memberAdminIds: string[];
  /** user_id values from workspace_approvers (explicit allowlist). */
  explicitApproverIds: string[];
  /** Calling user; excluded from the candidate list — you can't request
   *  approval from yourself. */
  selfId: string | null;
  /** Profile rows for any of the resolved candidate ids. Lookup is
   *  case-sensitive on id. Missing profile rows are skipped (the
   *  caller should fetch profiles for every id this module returns
   *  via mergeCandidateIds). */
  profilesById: Map<string, ApproverProfile>;
}

/**
 * Merge + dedup the three input id sources and exclude self.
 * Pulled out so the caller can drive its profiles SELECT off this list.
 */
export function mergeCandidateIds(input: {
  ownerId: string | null;
  memberAdminIds: string[];
  explicitApproverIds: string[];
  selfId: string | null;
}): string[] {
  const ids = new Set<string>();
  if (input.ownerId) ids.add(input.ownerId);
  for (const id of input.memberAdminIds) ids.add(id);
  for (const id of input.explicitApproverIds) ids.add(id);
  if (input.selfId) ids.delete(input.selfId);
  return Array.from(ids);
}

/**
 * Format a profile row's display label. Empty/whitespace name falls
 * back to the bare email; if email is also missing, the id is used so
 * the option doesn't render blank.
 */
export function formatApproverLabel(p: ApproverProfile): string {
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (name && p.email) return `${name} (${p.email})`;
  return p.email ?? p.id;
}

/**
 * Compose the final candidate list with the self-exclusion + fallback
 * rule and the owner-first-then-alphabetical sort.
 *
 * Fallback: if there are no other admins (typical for solo-operator
 * workspaces), return the calling user as the sole candidate so the
 * approval flow isn't blocked. The UI usually steers the user toward
 * "Apply" in this case, but the dropdown still needs an option.
 */
export function buildApproverCandidates(input: BuildApproverCandidatesInput): ApproverCandidate[] {
  let ids = mergeCandidateIds({
    ownerId: input.ownerId,
    memberAdminIds: input.memberAdminIds,
    explicitApproverIds: input.explicitApproverIds,
    selfId: input.selfId,
  });

  // Fallback: solo-operator workspace. Surface self so the flow isn't blocked.
  if (ids.length === 0 && input.selfId) {
    ids = [input.selfId];
  }

  const candidates: ApproverCandidate[] = [];
  for (const id of ids) {
    const profile = input.profilesById.get(id);
    if (!profile) continue;
    candidates.push({
      id,
      label: formatApproverLabel(profile),
      isOwner: id === input.ownerId,
    });
  }

  // Owner first, then alphabetical by label.
  candidates.sort((a, b) => {
    if (a.isOwner && !b.isOwner) return -1;
    if (!a.isOwner && b.isOwner) return 1;
    return a.label.localeCompare(b.label);
  });

  return candidates;
}
