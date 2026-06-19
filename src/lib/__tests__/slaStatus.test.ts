import { describe, expect, it } from 'vitest';
import { pendingSlaStatus, effectiveSlaDays, DEFAULT_SLA_DAYS } from '../slaStatus';

// KNOWN_ISSUES #111 C6 — behavioral coverage of the per-policy SLA aging helper.

const NOW = new Date('2026-06-18T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('effectiveSlaDays', () => {
  it('uses the policy value when positive', () => {
    expect(effectiveSlaDays(3)).toBe(3);
    expect(effectiveSlaDays(14)).toBe(14);
  });
  it('falls back to the default (7) when null/undefined/non-positive', () => {
    expect(effectiveSlaDays(null)).toBe(DEFAULT_SLA_DAYS);
    expect(effectiveSlaDays(undefined)).toBe(DEFAULT_SLA_DAYS);
    expect(effectiveSlaDays(0)).toBe(DEFAULT_SLA_DAYS);
    expect(effectiveSlaDays(-5)).toBe(DEFAULT_SLA_DAYS);
    expect(DEFAULT_SLA_DAYS).toBe(7);
  });
});

describe('pendingSlaStatus', () => {
  it('returns null daysPending (not over SLA) when not pending', () => {
    expect(pendingSlaStatus(null, 7, NOW)).toEqual({ daysPending: null, overSla: false, slaDays: 7 });
    expect(pendingSlaStatus('not-a-date', 7, NOW)).toEqual({ daysPending: null, overSla: false, slaDays: 7 });
  });

  it('computes whole days pending', () => {
    expect(pendingSlaStatus(daysAgo(0), 7, NOW).daysPending).toBe(0);
    expect(pendingSlaStatus(daysAgo(5), 7, NOW).daysPending).toBe(5);
  });

  it('is over SLA only at/after the effective SLA boundary (default 7)', () => {
    expect(pendingSlaStatus(daysAgo(6), null, NOW).overSla).toBe(false);
    expect(pendingSlaStatus(daysAgo(7), null, NOW).overSla).toBe(true);
    expect(pendingSlaStatus(daysAgo(20), null, NOW).overSla).toBe(true);
  });

  it('respects a custom per-policy SLA (shorter)', () => {
    const r = pendingSlaStatus(daysAgo(3), 2, NOW);
    expect(r).toEqual({ daysPending: 3, overSla: true, slaDays: 2 });
    expect(pendingSlaStatus(daysAgo(1), 2, NOW).overSla).toBe(false);
  });

  it('respects a custom per-policy SLA (longer)', () => {
    expect(pendingSlaStatus(daysAgo(10), 14, NOW).overSla).toBe(false);
    expect(pendingSlaStatus(daysAgo(14), 14, NOW).overSla).toBe(true);
  });
});
