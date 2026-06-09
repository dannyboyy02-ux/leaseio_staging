import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS } from '../../config/pricing';

// The Business workspace cap (10) lives in THREE places that must agree, or the
// UI offers creations the DB silently rejects (or vice-versa):
//   1. src/config/pricing.ts            — PLANS.business.maxWorkspaces (client display)
//   2. supabase/functions/_shared/workspace_limits.ts — WORKSPACE_LIMITS.business (edge fn)
//   3. the create_workspace_locked() RPC — v_cap literal (the authoritative gate)
// This static test pins them together so a future cap change can't drift one of
// the three out of sync. The RPC literal is the source of truth.
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('workspace cap is consistent across config, shared limits, and the RPC', () => {
  it('pricing.ts sets the expected per-plan workspace caps', () => {
    expect(PLANS.starter.maxWorkspaces).toBe(1);
    expect(PLANS.business.maxWorkspaces).toBe(10);
  });

  it('the Deno shared mirror agrees with pricing.ts', () => {
    const src = read('supabase/functions/_shared/workspace_limits.ts');
    // Narrow to the WORKSPACE_LIMITS object before asserting (avoid false matches).
    const block = src.slice(src.indexOf('WORKSPACE_LIMITS'), src.indexOf('};', src.indexOf('WORKSPACE_LIMITS')));
    expect(block).toMatch(/starter:\s*1\b/);
    expect(block).toMatch(/business:\s*10\b/);
  });

  it('the create_workspace_locked RPC cap literal matches the Business cap', () => {
    const sql = read('supabase/migrations/20260609120000_workspace_management_phase1.sql');
    // The RPC declares: v_cap int := 10;  (Business cap is the authoritative gate)
    const m = sql.match(/v_cap\s+int\s*:=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(PLANS.business.maxWorkspaces);
  });
});
