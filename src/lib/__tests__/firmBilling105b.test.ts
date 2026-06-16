import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 / #105-B — firm-bound child workspace creation.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('create_firm_workspace_locked migration', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir).filter((f) => f.includes('create_firm_workspace_rpc')).sort().pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');

  it('inserts the workspace WITH firm_id (triggers set plan/counter/firm_joined_at)', () => {
    expect(sql).toContain('INSERT INTO public.workspaces (name, owner_id, firm_id)');
  });
  it('is advisory-locked per firm + idempotent on idempotency_key', () => {
    expect(sql).toContain('pg_advisory_xact_lock(hashtext(p_firm_id::text))');
    expect(sql).toContain("WHERE idempotency_key = p_idempotency_key");
    expect(sql).toContain("status', 'duplicate'");
  });
  it('creates the owner admin membership', () => {
    expect(sql).toContain("INSERT INTO public.workspace_members");
    expect(sql).toContain("'admin'");
  });
  it('is service-role-only (execute revoked from anon/authenticated)', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.create_firm_workspace_locked');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.create_firm_workspace_locked(uuid, uuid, text, text) TO service_role');
  });
});

describe('create-firm-workspace edge fn', () => {
  const src = fn('supabase/functions/create-firm-workspace/index.ts');
  it('is firm admin/owner gated', () => {
    expect(src).toContain('firm as { owner_id: string }).owner_id === user.id');
    expect(src).toContain('role", "firm_admin"');
    expect(src).toContain('reason: "not_authorized"');
  });
  it('calls the RPC and surfaces the child-limit quota as 409', () => {
    expect(src).toContain("rpc(\"create_firm_workspace_locked\"");
    expect(src).toContain('child workspace limit');
    expect(src).toContain('"quota_exceeded"');
  });
  it('syncs the firm subscription quantity after creating (best-effort)', () => {
    expect(src).toContain('syncFirmSubscriptionQuantity');
  });
  it('never leaks raw DB errors', () => {
    expect(src).not.toMatch(/message:\s*\w*[Ee]rr(or)?\.message/);
    expect(src).toContain('reason: "server_error"');
  });
});
