import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('audit remediation guardrails', () => {
  it('requires a cron secret for scheduled lease notifications', () => {
    const source = readRepoFile('supabase/functions/send-lease-notifications/index.ts');

    expect(source).toContain('LEASE_NOTIFICATIONS_CRON_SECRET');
    expect(source).toContain('x-cron-secret');
    expect(source).toContain('status: 401');
  });

  it('keeps audit uploads authenticated and rate limited', () => {
    const source = readRepoFile('supabase/functions/audit-session/index.ts');

    expect(source).toContain('auth.getUser');
    expect(source).toContain('enforceWorkspaceRateLimit');
    expect(source).not.toContain('auth.admin.createUser');
  });

  it('validates amendment parents inside the resolved workspace before processing', () => {
    const source = readRepoFile('supabase/functions/process_lease/index.ts');

    expect(source).toContain("parentLeaseId is required for amendment uploads");
    expect(source).toContain(".eq('workspace_id', resolvedWorkspaceId)");
    expect(source).toContain("Parent lease must be active");
  });

  it('limits financial summary publishing to admins and approved lifecycle states', () => {
    const source = readRepoFile('supabase/functions/generate-summary-token/index.ts');

    expect(source).toContain("approved");
    expect(source).toContain("executed");
    expect(source).toContain("active");
    expect(source).toContain(".eq('role', 'admin')");
  });

  it('installs the database storage, model-lock, and entitlement guardrails', () => {
    const migration = readRepoFile('supabase/migrations/_archive/20260426000003_audit_remediation.sql');

    expect(migration).toContain('authenticated_read_executed_leases');
    expect(migration).toContain('prevent_locked_lease_edits');
    expect(migration).toContain('prevent_workspace_entitlement_edits');
    expect(migration).toContain('audit_rls_smoke_check');
  });
});
