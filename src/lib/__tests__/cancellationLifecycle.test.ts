import { describe, expect, it } from 'vitest';
import {
  GRACE_DAYS,
  NOTICE_SCHEDULE,
  PURGE_BUFFER_DAYS,
  daysSinceCanceled,
  deriveLifecycleState,
  dueNotices,
  graceDaysRemaining,
} from '../cancellationLifecycle';

const T0 = new Date('2026-06-01T00:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const iso = (n: number) => days(n).toISOString();

describe('cancellationLifecycle policy constants', () => {
  it('encodes the ratified 30-day grace + ~10-day purge buffer', () => {
    expect(GRACE_DAYS).toBe(30);
    expect(PURGE_BUFFER_DAYS).toBe(10);
  });

  it('schedules day 0/7/14/21/27 reminders and arms the final notice on day 29 (one cron cycle before soft-delete)', () => {
    expect(NOTICE_SCHEDULE.map((n) => [n.type, n.atDay])).toEqual([
      ['day0', 0],
      ['day7', 7],
      ['day14', 14],
      ['day21', 21],
      ['day27', 27],
      ['day30_final', 29],
    ]);
    // The final notice must arm strictly BEFORE grace expiry so it lands
    // on the last day of access, not after access is gone.
    expect(NOTICE_SCHEDULE.at(-1)!.atDay).toBeLessThan(GRACE_DAYS);
  });
});

describe('deriveLifecycleState', () => {
  const base = { canceledAt: null, graceExpiresAt: null, softDeletedAt: null, purgeAfter: null };

  it('all-null is active; dunning never starts the clock (no canceledAt = active)', () => {
    expect(deriveLifecycleState(base, T0)).toBe('active');
  });

  it('canceledAt set = grace', () => {
    expect(
      deriveLifecycleState({ ...base, canceledAt: iso(0), graceExpiresAt: iso(30) }, days(5)),
    ).toBe('grace');
  });

  it('softDeletedAt set = soft_deleted until purgeAfter, then purge_due', () => {
    const f = { ...base, canceledAt: iso(0), graceExpiresAt: iso(30), softDeletedAt: iso(30), purgeAfter: iso(40) };
    expect(deriveLifecycleState(f, days(35))).toBe('soft_deleted');
    expect(deriveLifecycleState(f, days(40))).toBe('purge_due');
    expect(deriveLifecycleState(f, days(45))).toBe('purge_due');
  });
});

describe('dueNotices', () => {
  it('sends day0 immediately and nothing else', () => {
    expect(dueNotices(iso(0), new Set(), days(0))).toEqual(['day0']);
  });

  it('is idempotent against the sent ledger', () => {
    expect(dueNotices(iso(0), new Set(['day0']), days(1))).toEqual([]);
  });

  it('catches up after cron downtime without double-sending', () => {
    // Cron down for the first 15 days: day0/7/14 all become due at once.
    expect(dueNotices(iso(0), new Set(), days(15))).toEqual(['day0', 'day7', 'day14']);
    expect(dueNotices(iso(0), new Set(['day0', 'day7', 'day14']), days(15))).toEqual([]);
  });

  it('arms the final notice on day 29 and the full set by day 30', () => {
    expect(dueNotices(iso(0), new Set(['day0', 'day7', 'day14', 'day21', 'day27']), days(29))).toEqual([
      'day30_final',
    ]);
  });
});

describe('date math', () => {
  it('daysSinceCanceled floors to whole days', () => {
    expect(daysSinceCanceled(iso(0), days(7))).toBe(7);
    expect(daysSinceCanceled(iso(0), new Date(days(7).getTime() + 3600_000))).toBe(7);
  });

  it('graceDaysRemaining ceils and clamps at zero', () => {
    expect(graceDaysRemaining(iso(30), days(0))).toBe(30);
    expect(graceDaysRemaining(iso(30), days(29))).toBe(1);
    expect(graceDaysRemaining(iso(30), days(31))).toBe(0);
  });
});

describe('Deno mirror sync', () => {
  it('the _shared mirror carries identical policy logic', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/lib/cancellationLifecycle.ts', 'utf8');
    const mirror = readFileSync('supabase/functions/_shared/cancellation_lifecycle.ts', 'utf8');
    // Everything after the header comment block must be byte-identical.
    const body = (s: string) => s.slice(s.indexOf('export const GRACE_DAYS'));
    expect(body(mirror)).toBe(body(main));
  });
});
