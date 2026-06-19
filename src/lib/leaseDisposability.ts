/**
 * #116 — client-side mirror of the `prevent_committed_lease_hard_delete` trigger's
 * disposable allowlist (`supabase/migrations/20260618140000_*`).
 *
 * A lease is "committed" — NOT client-hard-deletable; it must be ARCHIVED
 * (restorable + attributed) — once it is `model_locked` OR has any
 * `lifecycle_status` beyond `'draft'`. The disposable set a client may hard-
 * delete (ImportHistory import-rollback) is the exact inverse: not locked AND
 * (NULL or 'draft') lifecycle — byte-for-byte the SQL allowlist
 * `model_locked IS NOT TRUE AND (lifecycle_status IS NULL OR lifecycle_status = 'draft')`.
 *
 * SYNC CONSTRAINT: this predicate and the SQL trigger must stay in lockstep. The
 * positive-allowlist shape ('draft'/NULL only) is deliberate so that any NEW
 * lifecycle state added to `lifecycleStates.ts` defaults to PROTECTED (fail-safe
 * — preserve the audit trail), never to deletable. `leaseDisposability.test.ts`
 * pins this against `ALL_STATES`.
 */
export interface LeaseDisposabilityInput {
  lifecycle_status: string | null;
  model_locked: boolean | null;
}

/** True when the lease is committed → block hard-delete, steer to Archive. */
export function isCommittedLease(row: LeaseDisposabilityInput): boolean {
  return (
    row.model_locked === true ||
    (row.lifecycle_status != null && row.lifecycle_status !== 'draft')
  );
}

/** True when a client may hard-delete (import rollback) — the inverse. */
export function isDisposableLease(row: LeaseDisposabilityInput): boolean {
  return !isCommittedLease(row);
}
