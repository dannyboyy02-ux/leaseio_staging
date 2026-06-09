// Client-side "+ New workspace" affordance gate. Authoritative gate is the
// server-side create-workspace RPC under an advisory lock — this helper only
// determines what entries the UI surfaces. Per spec §P2.11 (HIGH-polish) the
// eligibility is "user owns any active Business workspace AND ownedCount <
// Business cap", NOT the active workspace's plan — so a Business owner viewing
// a Starter workspace still sees the CTA.
//
// Inputs are deliberately the subset of WorkspaceBasic that this function reads,
// so it can be unit-tested without standing up the App/Auth contexts.

import { PLANS } from "@/config/pricing";

export interface WorkspaceLike {
  role: string;
  plan: string;
  subscription_status: string | null;
}

export interface EligibilityResult {
  ownedCount: number;
  hasActiveBusiness: boolean;
  /** A "+ New workspace" entry should be shown. */
  canCreate: boolean;
  /** A "Manage workspaces (at limit)" entry should be shown. */
  atCap: boolean;
}

export function computeWorkspaceCreateEligibility(
  workspaces: ReadonlyArray<WorkspaceLike>,
  businessCap: number = PLANS.business.maxWorkspaces,
): EligibilityResult {
  let ownedCount = 0;
  let hasActiveBusiness = false;
  for (const w of workspaces) {
    if (w.role === "owner") {
      ownedCount++;
      if (
        w.plan === "business" &&
        w.subscription_status !== null &&
        (w.subscription_status === "active" || w.subscription_status === "trialing")
      ) {
        hasActiveBusiness = true;
      }
    }
  }
  const canCreate = hasActiveBusiness && ownedCount < businessCap;
  const atCap = hasActiveBusiness && ownedCount >= businessCap;
  return { ownedCount, hasActiveBusiness, canCreate, atCap };
}
