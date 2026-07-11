import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolvePeriodEndIso,
  resolvePeriodEndSeconds,
} from '../../../supabase/functions/_shared/stripe_subscription';

// Incident 2026-07-11 (second-pass money-path audit): every edge function pins
// Stripe apiVersion "2025-08-27.basil", and Basil REMOVED current_period_end
// from the top-level Subscription (it lives on subscription items now). The
// old `(subscription as any).current_period_end` read returned undefined on
// every webhook event → workspaces.subscription_period_end was NULL for every
// subscription (verified against live staging data), which also left
// vault-renewal-reminder matching zero rows forever. These tests pin the
// items-aware resolver and that every former direct-read site now uses it.
// The helper is pure TS with no Deno imports, so vitest imports it directly
// (same pattern as the payment_method mirror).

const T = 1_790_000_000; // arbitrary unix seconds

describe('resolvePeriodEndSeconds / resolvePeriodEndIso', () => {
  it('reads top-level current_period_end when present (pre-Basil shape)', () => {
    expect(resolvePeriodEndSeconds({ current_period_end: T })).toBe(T);
    expect(resolvePeriodEndIso({ current_period_end: T })).toBe(
      new Date(T * 1000).toISOString(),
    );
  });

  it('falls back to items.data[0].current_period_end (the Basil shape — THE incident case)', () => {
    const basilSub = {
      status: 'trialing',
      items: { data: [{ current_period_end: T }] },
    };
    expect(resolvePeriodEndSeconds(basilSub)).toBe(T);
    expect(resolvePeriodEndIso(basilSub)).toBe(new Date(T * 1000).toISOString());
  });

  it('prefers top-level over items when both exist', () => {
    expect(
      resolvePeriodEndSeconds({
        current_period_end: T,
        items: { data: [{ current_period_end: T + 999 }] },
      }),
    ).toBe(T);
  });

  it('falls back to trial_end as a last resort', () => {
    expect(resolvePeriodEndSeconds({ trial_end: T, items: { data: [{}] } })).toBe(T);
  });

  it('returns null (never NaN/Invalid Date) for missing/malformed shapes', () => {
    expect(resolvePeriodEndSeconds({})).toBeNull();
    expect(resolvePeriodEndSeconds(null)).toBeNull();
    expect(resolvePeriodEndSeconds(undefined)).toBeNull();
    expect(resolvePeriodEndSeconds({ current_period_end: 'soon' })).toBeNull();
    expect(resolvePeriodEndSeconds({ items: { data: [] } })).toBeNull();
    expect(resolvePeriodEndSeconds({ items: { data: [null] } })).toBeNull();
    expect(resolvePeriodEndIso({})).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Every former direct-read site must now import the shared resolver, and no
// edge function may read current_period_end straight off a subscription.
// ─────────────────────────────────────────────────────────────────────────

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FORMER_DIRECT_READ_SITES = [
  'supabase/functions/stripe-webhook/index.ts',
  'supabase/functions/cancel-subscription/index.ts',
  'supabase/functions/get-billing-summary/index.ts',
  'supabase/functions/manage-document-pack/index.ts',
];

describe('period-end reads go through the shared resolver', () => {
  for (const file of FORMER_DIRECT_READ_SITES) {
    it(`${file} imports the items-aware resolver and has no direct top-level read`, () => {
      const src = read(file);
      expect(src).toContain('_shared/stripe_subscription.ts');
      // The dead pattern: casting the sub and reading .current_period_end.
      // (cancel_at_period_end is fine — different field.)
      expect(src).not.toMatch(/\)\s*\.current_period_end/);
      expect(src).not.toMatch(/\bas any\)\.current_period_end/);
    });
  }

  it('the webhook grace anchor uses ended_at with the resolver as fallback', () => {
    const src = read('supabase/functions/stripe-webhook/index.ts');
    const i = src.indexOf('const endedAtSec');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 300);
    expect(block).toContain('ended_at');
    expect(block).toContain('resolvePeriodEndSeconds(subscription)');
  });
});
