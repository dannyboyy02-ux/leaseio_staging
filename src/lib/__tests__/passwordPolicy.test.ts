import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASSWORD_REQUIREMENTS, isPasswordValid } from '@/lib/passwordPolicy';

// Deferred fix #175 — one canonical password policy for every password-setting
// surface. Before this, Signup and ResetPassword gated only on length >= 8
// while AcceptInvite (and its server-side mirror, accept-invite's
// isStrongPassword) enforced length + uppercase + lowercase + number — so the
// self-serve signup path and the reset path (which let any existing user
// downgrade to a weak password) were weaker than the invited-user path.
//
// Static-source idiom (see documentLifecyclePolish.test.ts): narrow the search
// window to the relevant block before asserting, so a match elsewhere in the
// file can't produce a false positive.

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8');

/** Slice `source` from the first occurrence of `start` to the next occurrence of `end`. */
const window = (source: string, start: string, end: string): string => {
  const startIdx = source.indexOf(start);
  expect(startIdx, `window start marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  const endIdx = source.indexOf(end, startIdx + start.length);
  expect(endIdx, `window end marker not found after start: ${end}`).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx + end.length);
};

describe('passwordPolicy — canonical rules', () => {
  it('declares exactly the four canonical requirements', () => {
    expect(PASSWORD_REQUIREMENTS.map((r) => r.id)).toEqual([
      'min_length',
      'uppercase',
      'lowercase',
      'number',
    ]);
  });

  it('accepts a password meeting all four rules', () => {
    expect(isPasswordValid('Abcdefg1')).toBe(true);
  });

  it('rejects each single-rule failure', () => {
    expect(isPasswordValid('abcdefg1')).toBe(false); // no uppercase
    expect(isPasswordValid('ABCDEFG1')).toBe(false); // no lowercase
    expect(isPasswordValid('Abcdefgh')).toBe(false); // no number
    expect(isPasswordValid('Abc1')).toBe(false); // too short
  });

  it('rejects the empty string', () => {
    expect(isPasswordValid('')).toBe(false);
  });
});

describe('passwordPolicy — static wiring pins', () => {
  it('Signup and ResetPassword use the shared validator, not the old length-only gate', () => {
    for (const path of ['src/pages/Signup.tsx', 'src/pages/ResetPassword.tsx']) {
      const source = readRepoFile(path);
      expect(source, `${path} must call isPasswordValid`).toContain('isPasswordValid(');
      expect(source, `${path} must not reinstate the weak length-only gate`).not.toMatch(
        /password\.length\s*<\s*8/
      );
    }
  });

  it('AcceptInvite imports the shared module and does not re-inline rule lambdas', () => {
    const source = readRepoFile('src/pages/AcceptInvite.tsx');
    expect(source).toContain("from '@/lib/passwordPolicy'");
    expect(source).not.toContain('met: (pw)');
  });

  it('server mirror: accept-invite isStrongPassword enforces the same four checks', () => {
    // The client policy in src/lib/passwordPolicy.ts and the server gate must
    // not silently diverge — any change to one must be mirrored in the other.
    const source = readRepoFile('supabase/functions/accept-invite/index.ts');
    const fn = window(source, 'function isStrongPassword', '}');
    expect(fn).toContain('length >= 8');
    expect(fn).toContain('[A-Z]');
    expect(fn).toContain('[a-z]');
    expect(fn).toContain('[0-9]');
  });

  it('both locale files retain the four shared checklist label keys', () => {
    for (const path of ['src/locales/en/common.json', 'src/locales/es/common.json']) {
      const locale = JSON.parse(readRepoFile(path)) as {
        accept_invite?: { password_req?: Record<string, string> };
      };
      const reqKeys = locale.accept_invite?.password_req ?? {};
      for (const key of ['min_length', 'uppercase', 'lowercase', 'number']) {
        expect(reqKeys[key], `${path} accept_invite.password_req.${key}`).toBeTruthy();
      }
    }
  });
});
