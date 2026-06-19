import { describe, expect, it } from 'vitest';
import { isCommittedLease, isDisposableLease } from '@/lib/leaseDisposability';
import { ALL_STATES } from '@/lib/lifecycleStates';

// #116 — behavioral coverage of the client-side disposable gate, asserting it
// stays in lockstep with the prevent_committed_lease_hard_delete SQL allowlist.
// This catches logic drift the static toContain tests cannot (a refactor that
// flipped an operator but kept the substrings).

// Reference predicate = the SQL trigger's disposable test, transcribed:
//   model_locked IS NOT TRUE AND (lifecycle_status IS NULL OR = 'draft')
const sqlDisposable = (lifecycle_status: string | null, model_locked: boolean | null) =>
  model_locked !== true && (lifecycle_status === null || lifecycle_status === 'draft');

const lockedVariants: (boolean | null)[] = [true, false, null];
const lifecycleVariants: (string | null)[] = [null, ...ALL_STATES];

describe('isCommittedLease — parity with the SQL disposable allowlist', () => {
  it('agrees with the SQL allowlist for every (lifecycle × model_locked) combination', () => {
    for (const lifecycle_status of lifecycleVariants) {
      for (const model_locked of lockedVariants) {
        const row = { lifecycle_status, model_locked };
        expect(isCommittedLease(row)).toBe(!sqlDisposable(lifecycle_status, model_locked));
        expect(isDisposableLease(row)).toBe(sqlDisposable(lifecycle_status, model_locked));
      }
    }
  });

  it('treats only unlocked NULL/draft as disposable (the import-rollback set)', () => {
    expect(isCommittedLease({ lifecycle_status: null, model_locked: false })).toBe(false);
    expect(isCommittedLease({ lifecycle_status: null, model_locked: null })).toBe(false);
    expect(isCommittedLease({ lifecycle_status: 'draft', model_locked: false })).toBe(false);
    expect(isCommittedLease({ lifecycle_status: 'draft', model_locked: null })).toBe(false);
  });

  it('fail-safe sync constraint: EVERY non-draft lifecycle state is committed (iterates lifecycleStates.ALL_STATES, so a newly-added state cannot silently become deletable)', () => {
    for (const state of ALL_STATES) {
      if (state === 'draft') continue;
      expect(isCommittedLease({ lifecycle_status: state, model_locked: false })).toBe(true);
    }
  });

  it('model_locked dominates — a locked lease is committed regardless of lifecycle', () => {
    expect(isCommittedLease({ lifecycle_status: 'draft', model_locked: true })).toBe(true);
    expect(isCommittedLease({ lifecycle_status: null, model_locked: true })).toBe(true);
    for (const state of ALL_STATES) {
      expect(isCommittedLease({ lifecycle_status: state, model_locked: true })).toBe(true);
    }
  });
});
