import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #164 + #165 (full-product assessment, 2026-07-16): the lease-removal path had
// two data-safety holes.
//   #164 — delete-lease / restore-lease skipped the checkWorkspaceLive gate every
//          other user-invokable mutator enforces, so a Vault (read-only retention)
//          or canceled/soft-deleted-workspace admin could POST directly and
//          permanently destroy leases the Vault tier promises to preserve. The
//          retention cron also purged Vault leases (violating preservation).
//   #165 — delete-lease never revoked summary_share_token, so a "permanently
//          deleted" lease kept serving its public no-login financial summary for
//          14 days; and get-summary-by-token + the three report generators (all
//          service_role, bypassing leases_hide_soft_deleted) had no deleted_at
//          filter, leaking soft-deleted leases into public links and CPA PDFs.
// These static pins keep the fixes from silently regressing (edge functions
// aren't covered by the runtime suite).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#164 — lease-removal liveness gates', () => {
  for (const fn of ['delete-lease', 'restore-lease']) {
    it(`${fn} imports and calls checkWorkspaceLive`, () => {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src).toContain('from "../_shared/workspace_live.ts"');
      expect(src).toContain('checkWorkspaceLive(');
      expect(src).toContain('subscription_inactive');
    });
  }

  it('process-lease-retention preserves Vault-workspace leases (never hard-purges the retention tier)', () => {
    const src = read('supabase/functions/process-lease-retention/index.ts');
    expect(src).toContain('=== "vault"');
  });
});

describe('#165 — deleted leases stop leaking to public links + reports', () => {
  it('delete-lease revokes the public summary token', () => {
    const src = read('supabase/functions/delete-lease/index.ts');
    // Nulling the token is the established revocation pattern.
    expect(src).toMatch(/summary_share_token:\s*null/);
    expect(src).toMatch(/summary_share_token_expires_at:\s*null/);
  });

  const READERS = [
    'supabase/functions/get-summary-by-token/index.ts',
    'supabase/functions/generate-lease-report/index.ts',
    'supabase/functions/generate-portfolio-report/index.ts',
    'supabase/functions/generate-workspace-asc842-report/index.ts',
  ];
  for (const p of READERS) {
    it(`${p.split('/').slice(-2)[0]} filters soft-deleted leases`, () => {
      const src = read(p);
      expect(src).toMatch(/\.is\((['"])deleted_at\1,\s*null\)/);
    });
  }

  it('generate-summary-token (MINT path) refuses to re-arm a link on a soft-deleted lease', () => {
    const src = read('supabase/functions/generate-summary-token/index.ts');
    // Loads deleted_at and rejects mint on a soft-deleted lease (revoke allowed).
    expect(src).toContain('deleted_at');
    expect(src).toMatch(/deleted_at.*action !== ['"]revoke['"]/s);
  });
});
