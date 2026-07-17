import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P0-c + P0-f (2026-07-16): two RLS migrations captured/added.
//   P0-c — the workspaces INSERT policy was wide open (any user could
//          client-INSERT unlimited free Starter workspaces, each resetting the
//          AI quota, bypassing the $499 paid path). Now first-workspace-only.
//   P0-f — the lease-reports storage policies were captured from live (they had
//          been fixed out-of-band from the broken foldername(w.name) form; the
//          repo migration still had the broken version → repo drift).
// Static pins so the fixes can't silently regress.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P0-c — client workspace INSERT is fully closed; first workspace via advisory-locked RPC', () => {
  const mig = read('supabase/migrations/20260716130000_workspaces_first_workspace_only_insert.sql');

  it('sets the client INSERT policy to WITH CHECK (false) — no direct client insert', () => {
    // A per-row RLS count was bulk-insert-bypassable (security review). The only
    // safe form is to close the client INSERT entirely and route creation via RPCs.
    expect(mig).toContain('DROP POLICY IF EXISTS "Users can create workspaces"');
    expect(mig).toMatch(/FOR INSERT[\s\S]{0,120}WITH CHECK \(false\)/);
  });

  it('the first-workspace RPC is advisory-locked, count-checked, and derives owner_id from auth.uid()', () => {
    expect(mig).toContain('create_first_workspace');
    expect(mig).toContain('SECURITY DEFINER');
    expect(mig).toContain('SET search_path = public');
    expect(mig).toContain('pg_advisory_xact_lock');            // serializes concurrent calls
    expect(mig).toMatch(/count\(\*\)\s*FROM public\.workspaces WHERE owner_id = v_uid\)\s*>\s*0/);
    expect(mig).toContain('v_uid uuid := auth.uid()');          // not client-supplied
    expect(mig).toContain('REVOKE ALL ON FUNCTION public.create_first_workspace(text, text) FROM anon');
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.create_first_workspace(text, text) TO authenticated');
  });

  it('onboarding calls the RPC, not a direct workspaces insert', () => {
    const onb = read('src/pages/app/Onboarding.tsx');
    expect(onb).toContain("'create_first_workspace'");
    expect(onb).toMatch(/supabase\.rpc[\s\S]{0,40}create_first_workspace/);
    expect(onb).not.toMatch(/from\(['"]workspaces['"]\)\s*\n?\s*\.insert/);
  });
});

describe('P0-f — lease-reports storage RLS parses the object PATH, not the workspace name', () => {
  const mig = read('supabase/migrations/20260716120000_fix_lease_reports_storage_rls.sql');

  it('binds foldername to the OBJECT path (objects.name), never the workspace name', () => {
    // Ignore `-- ...` comment lines (the migration's explanatory text
    // legitimately names the old broken form); assert only on executable SQL.
    const sql = mig.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    // MUST be qualified as objects.name: the INSERT/UPDATE subqueries JOIN
    // `workspaces w` (which HAS a `name` column), so an UNQUALIFIED `name` would
    // silently bind to w.name and re-introduce #18 (security review found this).
    expect(sql).toContain('storage.foldername(objects.name)');
    expect(sql).not.toMatch(/foldername\(w\.name\)/);
    expect(sql).not.toMatch(/foldername\(workspaces\.name\)/);
    expect(sql).not.toMatch(/foldername\(name\)/); // unqualified is the trap
  });

  it('recreates all three lease-reports policies (INSERT / UPDATE / SELECT)', () => {
    expect(mig).toContain('"report owners insert lease-reports"');
    expect(mig).toContain('"report owners update lease-reports"');
    expect(mig).toContain('"workspace members read lease-reports"');
  });
});
