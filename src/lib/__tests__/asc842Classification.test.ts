import { describe, it, expect } from 'vitest';
import { deriveClassification, classificationMismatches } from '@/lib/asc842Classification';

// Fresh-eyes fix: derive an ASC 842-10-25-2 classification cross-check from the
// five lease-classification tests, and flag when the concrete derivation
// disagrees with the value the disclosure report prints. This is a factual
// cross-check surface (NOT an accounting engine — Hard Rule #1): finance if ANY
// of the five tests is affirmed; operating once all five are assessed and none
// affirmed; partial while any test is still unassessed. A 'partial' derivation
// never mismatches (nothing concrete to contradict).

describe('deriveClassification', () => {
  it('finance when ANY test is affirmed', () => {
    expect(deriveClassification([true, false, false, false, false])).toBe('finance');
    expect(deriveClassification([false, false, false, false, true])).toBe('finance');
    expect(deriveClassification([true, true, true, true, true])).toBe('finance');
  });

  it('finance even when other tests are still unassessed — an affirmed test wins', () => {
    expect(deriveClassification([true, null, null, null, null])).toBe('finance');
  });

  it('operating only when all five are assessed and none affirmed', () => {
    expect(deriveClassification([false, false, false, false, false])).toBe('operating');
  });

  it('partial while any test is still unassessed (and none affirmed)', () => {
    expect(deriveClassification([false, false, null, false, false])).toBe('partial');
    expect(deriveClassification([null, null, null, null, null])).toBe('partial');
    // a single unassessed test among negatives is enough to stay partial
    expect(deriveClassification([false, null])).toBe('partial');
  });
});

describe('classificationMismatches', () => {
  it('flags a concrete derivation that differs from the recorded value', () => {
    expect(classificationMismatches('finance', 'operating')).toBe(true);
    expect(classificationMismatches('finance', 'pending')).toBe(true);
    expect(classificationMismatches('operating', 'finance')).toBe(true);
    expect(classificationMismatches('operating', 'pending')).toBe(true);
  });

  it('treats null/undefined recorded as "pending" (the leases.lease_classification default)', () => {
    expect(classificationMismatches('finance', null)).toBe(true);
    expect(classificationMismatches('finance', undefined)).toBe(true);
    expect(classificationMismatches('operating', null)).toBe(true);
  });

  it('no mismatch when the derivation equals the recorded value', () => {
    expect(classificationMismatches('finance', 'finance')).toBe(false);
    expect(classificationMismatches('operating', 'operating')).toBe(false);
  });

  it('partial NEVER mismatches — the badge already reads "not fully assessed"', () => {
    expect(classificationMismatches('partial', 'pending')).toBe(false);
    expect(classificationMismatches('partial', 'finance')).toBe(false);
    expect(classificationMismatches('partial', 'operating')).toBe(false);
    expect(classificationMismatches('partial', null)).toBe(false);
    expect(classificationMismatches('partial', undefined)).toBe(false);
  });
});
