/**
 * Approval-rule ORDER — the client-side mirror of
 * `public.set_approval_policy_order()` (migration 20260719121000).
 *
 * The Approval Rules redesign removes the "priority" integer from the product.
 * Admins express order as intent (move up / move down / check this first) and
 * the client sends the FULL intended order as an id array; the RPC turns that
 * into the `priority` integers the engine reads. Everything in this module is
 * pure and must stay behaviourally identical to the SQL:
 *
 *   read order  : priority DESC, created_at ASC, id ASC
 *                 (byte-identical to resolve-approval-chain's matchPolicy()
 *                  comparator and to preview_policy_resolution's ORDER BY)
 *   assignment  : priority(i) = (N - i) * 100, 0-based from the top
 *   write guard : only rows whose priority actually changes are written
 *   concurrency : the submitted array must be exactly the current id set
 *
 * NOTHING here writes. The RPC is the only write path; these helpers exist so
 * the list renders in the engine's true order, so a move can be previewed
 * optimistically, and so the payload is validated before it hits the network.
 */

/** Gap between adjacent rules. Sparse by design: an API-authored row can land
 *  between two rules without forcing a renumber. */
export const ORDER_STEP = 100;

export interface OrderablePolicy {
  id: string;
  priority: number;
  created_at: string;
}

/**
 * The engine's total order, as a comparator: priority DESC, created_at ASC,
 * id ASC. The id key is not cosmetic — without it, two rules created in the
 * same transaction (identical created_at) sort nondeterministically and the
 * screen can show an order the engine will not honour.
 */
export function compareByEngineOrder(a: OrderablePolicy, b: OrderablePolicy): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
  return a.id.localeCompare(b.id);
}

/** Non-mutating sort into the engine's evaluation order. */
export function engineOrder<T extends OrderablePolicy>(policies: readonly T[]): T[] {
  return [...policies].sort(compareByEngineOrder);
}

export interface AssignedOrder {
  id: string;
  priority: number;
}

/**
 * priority(i) = (N - i) * 100 for a 0-based index i. Four rules → 400/300/
 * 200/100. Strictly descending, so re-sorting the result with
 * `compareByEngineOrder` reproduces the submitted sequence exactly — which is
 * what makes the first save from the legacy all-100 state a pure
 * renormalization that cannot change which rule wins for any request.
 */
export function assignOrderPriorities(orderedIds: readonly string[]): AssignedOrder[] {
  const n = orderedIds.length;
  return orderedIds.map((id, i) => ({ id, priority: (n - i) * ORDER_STEP }));
}

/**
 * The `priority IS DISTINCT FROM` write guard, mirrored: given the current
 * rows and the intended order, return only the rows the RPC will actually
 * write. A single swap yields exactly two entries, not N.
 */
export function policiesNeedingOrderWrite(
  current: readonly Pick<OrderablePolicy, 'id' | 'priority'>[],
  orderedIds: readonly string[],
): AssignedOrder[] {
  const currentPriority = new Map(current.map((p) => [p.id, p.priority]));
  return assignOrderPriorities(orderedIds).filter(
    (row) => currentPriority.get(row.id) !== row.priority,
  );
}

export type OrderSetProblem = 'duplicate' | 'count_mismatch' | 'unknown_id';

export type OrderSetValidation =
  | { ok: true }
  | { ok: false; reason: 'stale_policy_order'; problem: OrderSetProblem };

/**
 * The set-equality assertion, mirrored client-side so an obviously stale
 * payload never leaves the browser. The RPC re-checks it inside the
 * transaction — this is a fast path, never the guarantee.
 */
export function validateOrderSet(
  currentIds: readonly string[],
  orderedIds: readonly string[],
): OrderSetValidation {
  const seen = new Set(orderedIds);
  if (seen.size !== orderedIds.length) {
    return { ok: false, reason: 'stale_policy_order', problem: 'duplicate' };
  }
  if (orderedIds.length !== currentIds.length) {
    return { ok: false, reason: 'stale_policy_order', problem: 'count_mismatch' };
  }
  const known = new Set(currentIds);
  for (const id of orderedIds) {
    if (!known.has(id)) {
      return { ok: false, reason: 'stale_policy_order', problem: 'unknown_id' };
    }
  }
  return { ok: true };
}

/** Move one rule one slot up (toward "checked first"). Returns a new array;
 *  a no-op at the boundary returns an equal-order copy. */
export function moveUp(orderedIds: readonly string[], id: string): string[] {
  const next = [...orderedIds];
  const i = next.indexOf(id);
  if (i <= 0) return next;
  [next[i - 1], next[i]] = [next[i], next[i - 1]];
  return next;
}

/** Move one rule one slot down (toward "checked last"). */
export function moveDown(orderedIds: readonly string[], id: string): string[] {
  const next = [...orderedIds];
  const i = next.indexOf(id);
  if (i < 0 || i === next.length - 1) return next;
  [next[i], next[i + 1]] = [next[i + 1], next[i]];
  return next;
}

/** Move one rule to the top ("check this first"). */
export function moveToTop(orderedIds: readonly string[], id: string): string[] {
  const rest = orderedIds.filter((x) => x !== id);
  return rest.length === orderedIds.length ? [...orderedIds] : [id, ...rest];
}

/** Move one rule to the bottom ("check this last"). */
export function moveToBottom(orderedIds: readonly string[], id: string): string[] {
  const rest = orderedIds.filter((x) => x !== id);
  return rest.length === orderedIds.length ? [...orderedIds] : [...rest, id];
}
