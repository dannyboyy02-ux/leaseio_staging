import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

// ============================================================================
// Workspace entitlement guard — KNOWN_ISSUES #29 (billing-bypass P0)
//
// Background: public.workspaces had no WITH CHECK on its UPDATE policy and the
// enforce_workspace_entitlement_guard trigger never reached prod, so any
// authenticated owner could PATCH plan/document_limit/subscription_* to grant
// themselves Business-tier features and unbounded extraction spend. The
// restoration migration below re-derives the guard fresh (the archived
// definition was committed-but-never-applied; replaying it is forbidden by the
// Schema Change Rule). These static assertions catch in-repo drift — a future
// migration weakening the guard, or someone editing the file. The live-DB
// counterpart is audit_rls_smoke_check()'s 'workspace_entitlement_guard' key
// via scripts/smoke-audit-hardening.mjs (npm run smoke:security).
//
// Assertions are NARROWED to the relevant declaration block before toContain,
// per the CLAUDE.md rule against full-file toContain false positives.
// ============================================================================
describe('workspace entitlement guard — KNOWN_ISSUES #29', () => {
  const MIGRATION =
    'supabase/migrations/20260522000000_restore_workspace_entitlement_guard.sql';

  // The 9 billing/entitlement columns that must be guarded on INSERT and UPDATE.
  // max_archived_leases is a tier-derived entitlement (read DB-first in
  // AppContext) added per security review M1.
  const GUARDED_COLUMNS = [
    'plan',
    'document_limit',
    'documents_used',
    'billing_interval',
    'stripe_customer_id',
    'stripe_subscription_id',
    'subscription_status',
    'subscription_period_end',
    'max_archived_leases',
  ];

  function functionBlock(migration: string): string {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.prevent_workspace_entitlement_edits'
    );
    const end = migration.indexOf(
      'ALTER FUNCTION public.prevent_workspace_entitlement_edits'
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
  }

  it('guards only via the service_role carve-out and is not SECURITY DEFINER', () => {
    const fn = functionBlock(readRepoFile(MIGRATION));

    // Service role is the sole bypass; everything else (authenticated, anon,
    // direct DB) is enforced.
    expect(fn).toContain("COALESCE(auth.role(), '') = 'service_role'");
    // No SECURITY DEFINER — the guard must run with the caller's auth context
    // so auth.role() reflects the JWT, matching prevent_change_set_field_tampering.
    expect(fn).not.toContain('SECURITY DEFINER');
    // Violations raise check_violation, not a bare exception.
    expect(fn).toContain("ERRCODE = 'check_violation'");
  });

  it('rejects divergent INSERTs from the Starter baseline for every guarded column', () => {
    const fn = functionBlock(readRepoFile(MIGRATION));
    const insertBranch = fn.slice(
      fn.indexOf("IF TG_OP = 'INSERT' THEN"),
      fn.indexOf("-- TG_OP = 'UPDATE'")
    );
    expect(insertBranch.length).toBeGreaterThan(0);

    // Starter baseline pins.
    expect(insertBranch).toContain("NEW.plan IS DISTINCT FROM 'starter'");
    expect(insertBranch).toContain('NEW.document_limit IS DISTINCT FROM 15');
    expect(insertBranch).toContain('NEW.documents_used IS DISTINCT FROM 0');
    expect(insertBranch).toContain("NEW.billing_interval IS DISTINCT FROM 'monthly'");
    // Stripe/subscription columns + max_archived_leases may not be set at creation.
    for (const col of [
      'stripe_customer_id',
      'stripe_subscription_id',
      'subscription_status',
      'subscription_period_end',
      'max_archived_leases',
    ]) {
      expect(insertBranch).toContain(`NEW.${col} IS NOT NULL`);
    }
  });

  it('rejects any UPDATE that changes a guarded column', () => {
    const fn = functionBlock(readRepoFile(MIGRATION));
    const updateBranch = fn.slice(fn.indexOf("-- TG_OP = 'UPDATE'"));
    expect(updateBranch.length).toBeGreaterThan(0);

    for (const col of GUARDED_COLUMNS) {
      expect(updateBranch).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
  });

  it('does NOT guard intended_plan (Onboarding writes it; abandoned-checkout recovery)', () => {
    const fn = functionBlock(readRepoFile(MIGRATION));
    expect(fn).not.toContain('intended_plan');
  });

  it('installs the trigger BEFORE INSERT OR UPDATE on workspaces', () => {
    const migration = readRepoFile(MIGRATION);
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS enforce_workspace_entitlement_guard ON public.workspaces'
    );
    const trigStart = migration.indexOf(
      'CREATE TRIGGER enforce_workspace_entitlement_guard'
    );
    expect(trigStart).toBeGreaterThan(-1);
    const trigBlock = migration.slice(trigStart, trigStart + 220);
    expect(trigBlock).toContain('BEFORE INSERT OR UPDATE ON public.workspaces');
    expect(trigBlock).toContain(
      'EXECUTE FUNCTION public.prevent_workspace_entitlement_edits()'
    );
  });

  it('closes the UPDATE policy gap with a WITH CHECK on owner_id', () => {
    const migration = readRepoFile(MIGRATION);
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Owners can update their workspaces" ON public.workspaces'
    );
    const polStart = migration.indexOf(
      'CREATE POLICY "Owners can update their workspaces"'
    );
    expect(polStart).toBeGreaterThan(-1);
    const polBlock = migration.slice(polStart, polStart + 240);
    expect(polBlock).toContain('FOR UPDATE');
    expect(polBlock).toContain('USING (owner_id = auth.uid())');
    expect(polBlock).toContain('WITH CHECK (owner_id = auth.uid())');
  });

  it('aligns the column defaults to the Starter baseline (so onboarding INSERTs pass the guard)', () => {
    const migration = readRepoFile(MIGRATION);
    const alterStart = migration.indexOf('ALTER TABLE public.workspaces');
    expect(alterStart).toBeGreaterThan(-1);
    const alterBlock = migration.slice(alterStart, alterStart + 200);
    expect(alterBlock).toContain("ALTER COLUMN plan SET DEFAULT 'starter'");
    expect(alterBlock).toContain('ALTER COLUMN document_limit SET DEFAULT 15');
  });

  // Immutability guard: the fix must be a NEW migration, not an edit of the
  // archived file. The archived guard used the weaker `<> 'authenticated'`
  // carve-out; if that string changed in the archive, the archive was edited.
  it('does not modify the archived migration (restoration is a fresh re-derivation)', () => {
    const archived = readRepoFile(
      'supabase/migrations/_archive/20260426000003_audit_remediation.sql'
    );
    expect(archived).toContain("COALESCE(auth.role(), '') <> 'authenticated'");
  });
});
