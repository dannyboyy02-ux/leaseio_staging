// ─────────────────────────────────────────────────────────────────────────
// Lifecycle mode determination — Deno-only.
//
// Why this file exists separately from _shared/approval_chain.ts:
//   The pure-helpers module (_shared/approval_chain.ts ↔ src/lib/
//   approvalChainLogic.ts) has a SYNC CONSTRAINT that forbids Supabase
//   or Deno-specific imports — both files must be byte-equivalent in
//   behavior. getLifecycleMode requires the supabase-js client and does
//   IO, so it can't live in the pure module without violating that
//   constraint.
//
//   This file is Deno-runtime-only. There is no Node mirror because the
//   frontend never needs to compute the lifecycle mode (the chain rows
//   themselves are visible to the UI). If a use case ever arises to
//   reuse this from Node, lift the SQL pattern into a hook with the
//   project's typed supabase client; do not import this file from
//   src/.
//
// LIFECYCLE TRANSITION CONVENTION (CLAUDE.md)
//   getLifecycleMode is the chain-vs-legacy gate that act-on-chain-step
//   and (in the future) other transition triggers consult ONCE per
//   request. Per the convention, every transition site must determine
//   the mode at the top of the handler, not per-transition, to avoid
//   races where chain rows are inserted or removed mid-handler and the
//   mode flips inconsistently across activity-log entries.
// ─────────────────────────────────────────────────────────────────────────

// We type the supabase client loosely because the edge functions import
// the @supabase/supabase-js client via esm.sh and the strict types are
// not always tractable across Deno minor versions. The single .from()
// call below doesn't depend on full typing.
type AnySupabaseClient = {
  from: (table: string) => any;
};

export type LifecycleMode = "legacy" | "chain";

/**
 * Returns 'chain' when the lease has at least one row in
 * lease_approval_chain, else 'legacy'. Determined ONCE per request at
 * the top of the edge function handler — do not call repeatedly within
 * the same handler. The mode dictates which lifecycle vocabulary every
 * transition site in this request should write.
 *
 * Single SELECT count(head=true) — cheap. Pass the admin client; RLS
 * doesn't apply, so we see chain rows even for service-role-only
 * inserts from resolve-approval-chain.
 */
export async function getLifecycleMode(
  leaseId: string,
  supabaseAdmin: AnySupabaseClient,
): Promise<LifecycleMode> {
  const { count } = await supabaseAdmin
    .from("lease_approval_chain")
    .select("id", { count: "exact", head: true })
    .eq("lease_id", leaseId);
  return (count ?? 0) > 0 ? "chain" : "legacy";
}
