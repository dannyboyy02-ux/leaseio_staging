// useWorkspaceQuota — single client-side source of truth for "is this
// workspace at its lease limit?" (Workstream C limit wall).
//
// Derived entirely from the workspace object AppContext already maintains:
//   monthly  = documentsUsed (live trailing-30d extraction count) vs
//              documentLimit + addonDocumentCapacity
//   active   = activeLeasesUsed vs maxActiveLeases + addonDocumentCapacity
//   credits  = purchasedLeaseCredits (one credit lets one upload through)
//
// `blocked` mirrors the server gate in process_lease's assertProcessingQuota:
// over either cap AND no spendable credit. This is advisory UI gating only —
// the server remains the authority (it re-checks and consumes credits
// atomically), so a stale client can never bypass the real limit.

import { useApp } from '@/contexts/AppContext';

export interface WorkspaceQuota {
  monthlyUsed: number;
  monthlyLimit: number;
  activeUsed: number;
  activeLimit: number;
  credits: number;
  atMonthlyLimit: boolean;
  atActiveLimit: boolean;
  /** Over a cap with no credits — show the limit wall instead of intake UI. */
  blocked: boolean;
  /** Which cap tripped first (monthly wins ties — it always applies). */
  blockedMetric: 'monthly_extractions' | 'active_leases' | null;
}

export function useWorkspaceQuota(): WorkspaceQuota {
  const { workspace } = useApp();

  const addon = workspace?.addonDocumentCapacity ?? 0;
  const monthlyUsed = workspace?.documentsUsed ?? 0;
  const monthlyLimit = (workspace?.documentLimit ?? 0) + addon;
  const activeUsed = workspace?.activeLeasesUsed ?? 0;
  const activeLimit = (workspace?.maxActiveLeases ?? 0) + addon;
  const credits = workspace?.purchasedLeaseCredits ?? 0;

  // No workspace yet (loading) → never block; the server backstop catches
  // anything a stale/missing client state lets through.
  const loaded = Boolean(workspace) && monthlyLimit > 0;
  const atMonthlyLimit = loaded && monthlyUsed >= monthlyLimit;
  const atActiveLimit = loaded && activeLimit > 0 && activeUsed >= activeLimit;
  const over = atMonthlyLimit || atActiveLimit;

  return {
    monthlyUsed,
    monthlyLimit,
    activeUsed,
    activeLimit,
    credits,
    atMonthlyLimit,
    atActiveLimit,
    blocked: over && credits <= 0,
    blockedMetric: atMonthlyLimit ? 'monthly_extractions' : atActiveLimit ? 'active_leases' : null,
  };
}
