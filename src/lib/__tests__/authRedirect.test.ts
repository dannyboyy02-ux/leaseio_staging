import { describe, it, expect } from 'vitest';
import { resolvePostLoginRedirect, isSafeInternalPath } from '@/lib/authRedirect';

// Fresh-eyes fix: post-login redirect resolution + open-redirect hardening.
// The deep link a user was bounced off of (a Location object stashed in
// navigate state) beats an explicit ?next param beats the dashboard. Every
// candidate must be a single-leading-slash, same-origin path that is not an
// auth page — otherwise `//evil.com` / `https://evil.com` / `javascript:` would
// be a live open redirect, and `/login` would strand/loop the user.

const DEFAULT = '/app/dashboard';

describe('isSafeInternalPath', () => {
  it('accepts a single-leading-slash same-origin path (with query/hash)', () => {
    expect(isSafeInternalPath('/app/dashboard')).toBe(true);
    expect(isSafeInternalPath('/app/leases?status=active')).toBe(true);
    expect(isSafeInternalPath('/app/leases?status=active#row-3')).toBe(true);
  });

  it('rejects open-redirect vectors', () => {
    expect(isSafeInternalPath('//evil.com')).toBe(false);       // protocol-relative
    expect(isSafeInternalPath('https://evil.com')).toBe(false); // absolute URL
    expect(isSafeInternalPath('/\\evil.com')).toBe(false);      // backslash bypass
    expect(isSafeInternalPath('javascript:alert(1)')).toBe(false);
    expect(isSafeInternalPath('')).toBe(false);
  });

  it('rejects auth pages as targets even with a query/hash suffix', () => {
    expect(isSafeInternalPath('/login')).toBe(false);
    expect(isSafeInternalPath('/signup')).toBe(false);
    expect(isSafeInternalPath('/login?next=/app/x')).toBe(false);
  });
});

describe('resolvePostLoginRedirect', () => {
  it('preserves search + hash from a Location-object state.from', () => {
    expect(
      resolvePostLoginRedirect(
        { pathname: '/app/leases', search: '?status=active', hash: '#row-3' },
        null,
      ),
    ).toBe('/app/leases?status=active#row-3');
    // search-only and hash-only variants
    expect(resolvePostLoginRedirect({ pathname: '/app/x', search: '?a=1' }, null)).toBe('/app/x?a=1');
    expect(resolvePostLoginRedirect({ pathname: '/app/x', hash: '#h' }, null)).toBe('/app/x#h');
  });

  it('passes a raw string state.from straight through', () => {
    expect(resolvePostLoginRedirect('/app/reports', null)).toBe('/app/reports');
  });

  it('falls back to ?next when there is no state.from', () => {
    expect(resolvePostLoginRedirect(null, '/app/settings/account')).toBe('/app/settings/account');
  });

  it('state.from wins over ?next', () => {
    expect(resolvePostLoginRedirect('/app/from', '/app/next')).toBe('/app/from');
  });

  it('returns the dashboard default when both candidates are null/undefined', () => {
    expect(resolvePostLoginRedirect(null, null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect(undefined, undefined)).toBe(DEFAULT);
  });

  it('rejects an unsafe state.from and falls through to the next safe candidate', () => {
    expect(resolvePostLoginRedirect('//evil.com', null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect('https://evil.com', null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect('/\\evil.com', null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect('javascript:alert(1)', null)).toBe(DEFAULT);
    // unsafe state.from, safe ?next → use ?next
    expect(resolvePostLoginRedirect('//evil.com', '/app/safe')).toBe('/app/safe');
  });

  it('never targets an auth page (would loop back to login)', () => {
    expect(resolvePostLoginRedirect('/login', null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect('/signup', null)).toBe(DEFAULT);
    expect(resolvePostLoginRedirect(null, '/login')).toBe(DEFAULT);
  });

  it('ignores a Location object with no usable pathname', () => {
    expect(resolvePostLoginRedirect({ search: '?x=1' }, '/app/next')).toBe('/app/next');
    expect(resolvePostLoginRedirect({ pathname: '' }, null)).toBe(DEFAULT);
  });
});
