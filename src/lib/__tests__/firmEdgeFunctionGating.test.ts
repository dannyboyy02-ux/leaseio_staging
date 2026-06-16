import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 9 firm edge functions are service-role (they write past the DB guards),
// so each function's own caller-authorization is the security boundary. These
// static-source assertions pin those contracts so they can't silently regress.
// (Edge functions run on Deno with no unit harness in this repo; the established
// idiom is source-level assertions — see billingSummaryGating.test.ts.)

const root = process.cwd();
const fn = (name: string) => readFileSync(join(root, `supabase/functions/${name}/index.ts`), 'utf8');

function section(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

describe('all firm edge functions — common auth gate', () => {
  for (const name of ['create-firm', 'add-firm-member', 'bind-workspace-to-firm', 'release-workspace-from-firm']) {
    it(`${name} requires a bearer token and validates the user`, () => {
      const src = fn(name);
      expect(src).toContain('getCorsHeaders');
      expect(src).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(src).toContain('const authHeader = req.headers.get("Authorization")');
      expect(src).toContain('reason: "no_auth"');
      expect(src).toContain('supabaseAdmin.auth.getUser(token)');
      expect(src).toContain('reason: "invalid_auth"');
    });
  }
});

describe('create-firm — self-serve provisioning (#105-C)', () => {
  const src = fn('create-firm');
  it('is self-serve: a non-ops caller owns the firm they create (owner forced to user.id)', () => {
    // ops_admins is still consulted, but only to ALLOW a foreign owner — not to gate.
    expect(src).toContain('.from("ops_admins")');
    expect(src).toContain('const isOps = Boolean(opsRow)');
    expect(src).toContain('isOps && requestedOwnerId && typeof requestedOwnerId === "string" ? requestedOwnerId : user.id');
    // No standalone ops-only 403 gate anymore.
    expect(src).not.toContain('if (!opsRow)');
  });
  it('validates name/firmType/billingEmail and writes firm_created audit', () => {
    expect(src).toContain('firmType must be cpa_firm | parent_company | other');
    expect(src).toContain('name must be at least 2 characters');
    expect(src).toContain('billingEmail is required');
    const audit = section(src, 'firm_activity_log', '});');
    expect(audit).toContain('"firm_created"');
  });
});

describe('add-firm-member — owner-only mints admins', () => {
  const src = fn('add-firm-member');
  it('only the firm OWNER can grant firm_admin; firm_admin can add firm_member', () => {
    expect(src).toContain("if (role === \"firm_admin\" && !isOwner)");
    expect(src).toContain('Only the firm owner can grant the firm_admin role');
    expect(src).toContain("if (role === \"firm_member\" && !isAdmin)");
  });
  it('is idempotent on an existing membership and writes firm_member_added audit', () => {
    expect(src).toContain('idempotent: true');
    expect(src).toContain('"firm_member_added"');
  });
});

describe('bind-workspace-to-firm — caller must own both firm and workspace', () => {
  const src = fn('bind-workspace-to-firm');
  it('verifies firm ownership AND workspace ownership', () => {
    expect(src).toContain('You must own the firm to bind a workspace to it');
    expect(src).toContain('You must own the workspace to bind it');
  });
  it('rejects an already-bound workspace and maps the quota trigger to 409', () => {
    expect(src).toContain('reason: "already_bound"');
    expect(src).toContain('child workspace limit');
    expect(src).toContain('quota_exceeded');
    expect(src).toContain('"workspace_joined_firm"');
  });
});

describe('release-workspace-from-firm — firm owner OR workspace owner', () => {
  const src = fn('release-workspace-from-firm');
  it('allows release by either owner and only when actually bound to this firm', () => {
    expect(src).toContain('reason: "not_bound"');
    expect(src).toContain('isWorkspaceOwner');
    expect(src).toContain('isFirmOwner');
    expect(src).toContain('Only the firm owner or workspace owner can release this workspace');
  });
  it('clears firm_id (plan retained) and writes workspace_left_firm audit', () => {
    expect(src).toContain('.update({ firm_id: null })');
    expect(src).toContain('"workspace_left_firm"');
  });
});
