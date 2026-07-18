export type DerivedClassification = 'finance' | 'operating' | 'partial';

/**
 * finance if ANY 842-10-25-2 test is affirmed; operating once all five are
 * assessed and none affirmed; partial while any test is still unassessed.
 */
export function deriveClassification(tests: Array<boolean | null>): DerivedClassification {
  const met = tests.filter((v) => v === true).length;
  const assessed = tests.filter((v) => v !== null).length;
  if (met > 0) return 'finance';
  if (assessed === tests.length) return 'operating';
  return 'partial';
}

/**
 * True when the derived cross-check is CONCRETE (finance/operating) and differs
 * from the recorded classification the disclosure report prints. A 'partial'
 * derivation never mismatches (the badge already reads "not fully assessed" —
 * no confident claim to contradict). null/undefined recorded => 'pending' (the
 * leases.lease_classification default the report reads).
 */
export function classificationMismatches(
  derived: DerivedClassification,
  recorded: string | null | undefined,
): boolean {
  if (derived !== 'finance' && derived !== 'operating') return false;
  return (recorded ?? 'pending') !== derived;
}
