import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P0-d (2026-07-16): delete-account had two catastrophic bugs.
//   (1) It deleted leases by `user_id = me` AND the leases.user_id -> profiles FK
//       was ON DELETE CASCADE, so deleting the profile erased every lease the
//       user had uploaded into OTHER tenants' (employers') workspaces.
//   (2) It canceled ZERO Stripe subscriptions — a departed customer billed
//       forever.
// The rebuild purges ONLY owned workspaces (by workspace_id) via the shared
// helpers and the FK is SET NULL. These static pins prevent regression.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fn = read('supabase/functions/delete-account/index.ts');

describe('#P0-d — delete-account no longer destroys cross-tenant data', () => {
  it('NEVER deletes leases by user_id (the cross-tenant destruction vector)', () => {
    // Any leases.delete() must be keyed on workspace_id (owned workspaces only),
    // never on user_id.
    expect(fn).not.toMatch(/from\(["']leases["']\)[\s\S]{0,80}\.delete\(\)[\s\S]{0,80}\.eq\(["']user_id["']/);
    // Positive: the owned-workspace lease delete is by workspace_id.
    expect(fn).toMatch(/from\(["']leases["']\)[\s\S]{0,80}\.delete\(\)[\s\S]{0,80}\.eq\(["']workspace_id["']/);
  });

  it('only ever loads/purges workspaces the caller OWNS', () => {
    expect(fn).toMatch(/from\(["']workspaces["']\)[\s\S]{0,120}\.eq\(["']owner_id["'],\s*user\.id\)/);
  });

  it('cancels Stripe subscriptions on the owned workspaces', () => {
    expect(fn).toContain('cancelWorkspaceSubscriptions');
    expect(fn).toContain('from "../_shared/workspace_purge.ts"');
  });

  it('writes a forensic deleted_workspaces record before destroying', () => {
    expect(fn).toContain('deleted_workspaces');
    expect(fn).toContain('account_deletion');
  });

  it('writes deleted_by null (would otherwise FK-block the terminal auth delete)', () => {
    expect(fn).toMatch(/deleted_by:\s*null/);
    expect(fn).not.toMatch(/deleted_by:\s*user\.id/);
  });

  it('reassigns the departing user\'s pending chain steps before the FK nulls them', () => {
    expect(fn).toContain('reassign_departing_user_chain_steps');
  });

  it('does not delete the profile explicitly (relies on auth-user CASCADE — zombie-proof)', () => {
    expect(fn).not.toMatch(/from\(["']profiles["']\)[\s\S]{0,40}\.delete\(\)/);
  });
});

describe('#P0-d — the leases.user_id FK is SET NULL, not CASCADE', () => {
  const mig = read('supabase/migrations/20260716140000_leases_user_id_set_null_on_profile_delete.sql');
  it('drops NOT NULL and rebuilds the FK as ON DELETE SET NULL', () => {
    expect(mig).toContain('ALTER COLUMN user_id DROP NOT NULL');
    expect(mig).toMatch(/leases_user_id_fkey[\s\S]{0,120}ON DELETE SET NULL/);
    expect(mig).not.toMatch(/leases_user_id_fkey[\s\S]{0,120}ON DELETE CASCADE/);
  });
});
