import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Profile name sync (found in the 2026-08-14 firm walkthrough): Signup.tsx
// passes { first_name, last_name, company_name } into supabase.auth.signUp's
// options.data, landing them in auth.users.raw_user_meta_data — but the
// handle_new_user trigger inserted only (id, email), dropping the names.
// Result: every named signup had its name in auth metadata yet NULL in
// public.profiles, so every surface that reads names from profiles (FirmMembers,
// workspace member lists, audit actor names — anything showing a user OTHER than
// the viewer, who can't read others' auth metadata) fell back to the raw email.
//
// The fix lives entirely in the DB (migration 20260814230000): the trigger now
// copies the names, and a fill-only backfill repairs existing rows. These static
// pins keep the trigger contract from silently regressing (the auth trigger is
// not covered by the runtime suite) and lock the metadata key names to the
// exact keys Signup.tsx writes.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('profile name sync — handle_new_user trigger (migration 20260814230000)', () => {
  const migration = read('supabase/migrations/20260814230000_profile_name_sync.sql');
  const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_user');
  const fnEnd = migration.indexOf('-- 2. Backfill');
  const fn = migration.slice(fnStart, fnEnd);

  it('copies timezone from metadata, defaulting to America/New_York when absent', () => {
    expect(fn).toMatch(/coalesce\(nullif\(new\.raw_user_meta_data->>'timezone', ''\), 'America\/New_York'\)/);
    // On-conflict timezone fills only the bare default (never clobbers a choice).
    expect(fn).toMatch(/timezone\s*=\s*case\s*\n?\s*when public\.profiles\.timezone = 'America\/New_York' then excluded\.timezone/);
  });

  it('the trigger function block was located', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  it('preserves SECURITY DEFINER + pinned search_path from the baseline', () => {
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toMatch(/SET search_path TO 'public'/);
  });

  it('copies first_name / last_name / company_name from raw_user_meta_data', () => {
    expect(fn).toContain('insert into public.profiles (id, email, first_name, last_name, company_name, timezone)');
    for (const key of ['first_name', 'last_name', 'company_name']) {
      // Each name column is sourced from the matching metadata key, empty->null.
      expect(fn).toMatch(new RegExp(`nullif\\(new\\.raw_user_meta_data->>'${key}', ''\\)`));
    }
  });

  it('the metadata keys match exactly what Signup.tsx writes into signUp options.data', () => {
    const signup = read('src/pages/Signup.tsx');
    // Signup sets first_name/last_name in the signUp metadata object.
    expect(signup).toMatch(/first_name:\s*formData\.firstName/);
    expect(signup).toMatch(/last_name:\s*formData\.lastName/);
  });

  it('ON CONFLICT is fill-only via COALESCE (never clobbers an existing/edited value)', () => {
    expect(fn).toMatch(/on conflict \(id\) do update set/i);
    for (const col of ['first_name', 'last_name', 'company_name']) {
      expect(fn).toMatch(new RegExp(`${col}\\s*=\\s*coalesce\\(public\\.profiles\\.${col},\\s*excluded\\.${col}\\)`));
    }
  });
});

describe('profile name sync — names/company backfill (2b)', () => {
  const migration = read('supabase/migrations/20260814230000_profile_name_sync.sql');
  const backfill = migration.slice(migration.indexOf('-- 2b. Backfill names'));

  it('is fill-only (COALESCE keeps a set value, only writes into NULLs)', () => {
    expect(backfill).toContain('UPDATE public.profiles p');
    for (const col of ['first_name', 'last_name', 'company_name']) {
      expect(backfill).toMatch(new RegExp(`${col}\\s*=\\s*coalesce\\(p\\.${col},`));
    }
  });

  it('joins on the same user (u.id = p.id) and guards to genuinely-missing rows with non-empty metadata', () => {
    expect(backfill).toMatch(/FROM auth\.users u/);
    expect(backfill).toMatch(/WHERE u\.id = p\.id/);
    // At least one arm of the guard requires a NULL column AND a non-empty source.
    expect(backfill).toMatch(/p\.first_name\s+IS NULL AND nullif\(u\.raw_user_meta_data->>'first_name', ''\)\s+IS NOT NULL/);
  });

  it('never writes empty strings (nullif "" guards every source read)', () => {
    // No unguarded ->>'...' read of a name key outside a nullif(...) wrapper.
    const rawReads = backfill.match(/raw_user_meta_data->>'(first_name|last_name|company_name)'/g) ?? [];
    const guardedReads = backfill.match(/nullif\(u\.raw_user_meta_data->>'(first_name|last_name|company_name)', ''\)/g) ?? [];
    expect(rawReads.length).toBeGreaterThan(0);
    expect(guardedReads.length).toBe(rawReads.length);
  });
});

describe('profile name sync — timezone backfill (2a, provably-safe scope)', () => {
  const migration = read('supabase/migrations/20260814230000_profile_name_sync.sql');
  const tzStart = migration.indexOf('-- 2a. Backfill timezone');
  const tzEnd = migration.indexOf('-- 2b. Backfill names');
  const tz = migration.slice(tzStart, tzEnd);

  it('runs BEFORE the name backfill (its never-edited proxy depends on first_name still being NULL)', () => {
    expect(tzStart).toBeGreaterThan(-1);
    expect(tzEnd).toBeGreaterThan(tzStart);
    // 2a precedes 2b in file order.
    expect(migration.indexOf('-- 2a.')).toBeLessThan(migration.indexOf('-- 2b.'));
  });

  it('only touches rows that were never edited via Settings (both names NULL) and still hold the bare default', () => {
    expect(tz).toMatch(/p\.first_name\s+IS NULL/);
    expect(tz).toMatch(/p\.last_name\s+IS NULL/);
    expect(tz).toMatch(/p\.timezone = 'America\/New_York'/);
  });

  it('only writes a real, different, non-empty metadata timezone (no default->default churn, no revert)', () => {
    expect(tz).toMatch(/nullif\(u\.raw_user_meta_data->>'timezone', ''\)\s+IS NOT NULL/);
    expect(tz).toMatch(/u\.raw_user_meta_data->>'timezone' <> 'America\/New_York'/);
  });
});
