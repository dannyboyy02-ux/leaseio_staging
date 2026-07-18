import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Deferred fix #177c — expired/used recovery links must land on a recovery
// path, not a dead-end form. GoTrue redirects an expired link back to
// /reset-password with error params in the hash (auth-js swallows the error
// internally but leaves the hash intact), and before this fix the page had a
// no-op `if (!session) {}` effect, always rendered the form, and never
// referenced /forgot-password — the user typed a new password twice into a
// form that could not succeed.
//
// Static-source idiom (see documentLifecyclePolish.test.ts): narrow the search
// window to the relevant block before asserting, so a match elsewhere in the
// file can't produce a false positive.

const root = process.cwd();
const source = readFileSync(join(root, 'src/pages/ResetPassword.tsx'), 'utf8');

/** Slice `source` from the first occurrence of `start` to the next occurrence of `end`. */
const window = (src: string, start: string, end: string): string => {
  const startIdx = src.indexOf(start);
  expect(startIdx, `window start marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  const endIdx = src.indexOf(end, startIdx + start.length);
  expect(endIdx, `window end marker not found after start: ${end}`).toBeGreaterThan(startIdx);
  return src.slice(startIdx, endIdx + end.length);
};

describe('ResetPassword expired-link handling (#177c)', () => {
  it('detects GoTrue error params in the URL (hash and query)', () => {
    expect(source).toContain('hasRecoveryErrorInUrl');
    // '\n}' at column 0 only matches the function's own closing brace (inner
    // closers are indented), so this window spans the whole declaration block.
    const fn = window(source, 'function hasRecoveryErrorInUrl', '\n}');
    expect(fn).toContain('error_code');
    expect(fn).toContain('error_description');
    expect(fn).toContain('location.hash');
  });

  it('runs the three-state link machine', () => {
    expect(source).toContain("'checking' | 'ready' | 'expired'");
    // The fallback waits for AuthContext's isLoading to settle before
    // classifying a missing session as an expired link (race-free: getSession
    // awaits supabase-js's initializePromise).
    expect(source).toContain('isAuthLoading');
  });

  it('offers the recovery path from the expired state', () => {
    const expiredBranch = window(source, "linkState === 'expired'", "linkState === 'checking'");
    expect(expiredBranch).toContain('to="/forgot-password"');
    expect(expiredBranch).toContain('auth.reset.request_new_link');
    // Reuses the existing forgot-password key rather than duplicating it.
    expect(expiredBranch).toContain('auth.forgot.back_to_signin');
  });

  it('renders a verifying state while the session check settles', () => {
    const checkingBranch = window(source, "linkState === 'checking' ? (", '</CardContent>');
    expect(checkingBranch).toContain('auth.reset.verifying_link');
  });

  it('maps submit-time session loss to the expired state, not a dead-end toast', () => {
    expect(source).toContain('AuthSessionMissingError');
    expect(source).toContain("code === 'session_expired'");
    expect(source).toContain("code === 'session_not_found'");
    expect(source).toContain("setLinkState('expired')");
  });

  it('gives same_password its own accurate copy instead of the misleading generic error', () => {
    expect(source).toContain("code === 'same_password'");
    expect(source).toContain('auth.reset.same_password_title');
    expect(source).toContain('auth.reset.same_password_desc');
  });

  it('removed the old no-op session check', () => {
    expect(source).not.toContain('let them try anyway');
    expect(source).not.toMatch(/if\s*\(\s*!session\s*\)/);
  });
});
