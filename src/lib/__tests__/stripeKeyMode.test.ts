import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedKeyPrefix } from '@/lib/stripe';

// The payment-routing guard's truth table (2026-07-18 incident: the production
// domain runs test-mode Stripe pre-launch, but the old build-mode inference
// made a production build refuse pk_test_ unconditionally — in-app purchases
// were structurally impossible on theleaseio.com and failed with "Payment
// configuration is missing"). An explicit VITE_STRIPE_KEY_MODE declaration
// wins; without one the fail-closed default is unchanged.

describe('expectedKeyPrefix — explicit declaration wins', () => {
  it("'test' forces pk_test_ regardless of build mode (the pre-launch prod-domain case)", () => {
    expect(expectedKeyPrefix('test', 'production')).toBe('pk_test_');
    expect(expectedKeyPrefix('test', 'development')).toBe('pk_test_');
  });

  it("'live' forces pk_live_ regardless of build mode", () => {
    expect(expectedKeyPrefix('live', 'production')).toBe('pk_live_');
    expect(expectedKeyPrefix('live', 'development')).toBe('pk_live_');
  });
});

describe('expectedKeyPrefix — fail-closed default without a declaration', () => {
  it('production build requires pk_live_', () => {
    expect(expectedKeyPrefix(undefined, 'production')).toBe('pk_live_');
  });

  it('non-production builds require pk_test_', () => {
    expect(expectedKeyPrefix(undefined, 'development')).toBe('pk_test_');
    expect(expectedKeyPrefix(undefined, 'test')).toBe('pk_test_');
  });

  it('an unrecognized declaration falls back to the build-mode default (never widens)', () => {
    expect(expectedKeyPrefix('yes', 'production')).toBe('pk_live_');
    expect(expectedKeyPrefix('', 'production')).toBe('pk_live_');
  });
});

describe('getStripe wiring', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/stripe.ts'), 'utf8');

  it('resolves the prefix through expectedKeyPrefix with the declared mode', () => {
    expect(src).toContain('expectedKeyPrefix(');
    expect(src).toContain('VITE_STRIPE_KEY_MODE');
  });

  it('still fails closed (returns null) on a prefix mismatch and never logs the key', () => {
    const guard = src.slice(src.indexOf('if (!key.startsWith(expectedPrefix))'));
    expect(guard).toContain('return null');
    // The console message must not interpolate the key value.
    const msg = guard.slice(0, guard.indexOf('return null'));
    expect(msg).not.toContain('${key}');
  });
});
