// The `preview_policy_resolution` result, mirrored in TypeScript, plus the
// directory the answer surfaces need to turn ids and role tokens into people.
//
// Kept in its own module so the answer panel and the default-route renderer can
// both import it without a cycle. The shape tracks the RPC's migrations:
//   20260718130000 — signator inheritance (`signator_inherited` + the cloned
//                    signature stage inside `chain`)
//   20260718150000 — `tie`, `empty_chain`, `fallback` + `legacy`
//   20260719120100 — `is_default_fallback` retired from the precedence ladder,
//                    so the ladder is: matching rule > legacy default approvers
//                    > blocked. There is no third "fallback policy" branch.

import type { MemberLike, RoleHolderMap } from '@/lib/approvalDescribe';

export interface PreviewChainStep {
  stage: 'concept' | 'signator';
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days?: number | null;
  is_required: boolean;
  inherited?: boolean;
}

export interface MatchedResolution {
  matched: true;
  policy_id: string;
  policy_name: string;
  chain: PreviewChainStep[];
  /** Server truth — MUST be passed to describeChain, or an engine-cloned
   *  signature stage gets described as one the admin chose. */
  signator_inherited?: boolean;
  empty_chain?: boolean;
  tie?: { tied_policies: Array<{ id: string; name: string }>; winner_reason?: string };
  warnings?: string[];
}

export interface UnmatchedResolution {
  matched: false;
  fallback?: 'legacy_default' | 'none';
  legacy?: { has_manager_approver: boolean; has_financial_approver: boolean };
  error?: string;
}

export type PreviewResolution = MatchedResolution | UnmatchedResolution;

/** Explicit guard rather than a bare `result.matched` check: the render
 *  branches capture `result` in JSX callbacks, and a guard keeps the narrowing
 *  definite on both sides of the fork. */
export function isMatched(r: PreviewResolution): r is MatchedResolution {
  return r.matched;
}

/** Everything an answer surface needs to name a human. */
export interface ApprovalDirectory {
  members: MemberLike[];
  roleHolders: RoleHolderMap;
}
