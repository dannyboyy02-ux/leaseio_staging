import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #116 (audit DF1) — a committed/finalized lease's row (and its
// ON DELETE CASCADE audit trail) is not client-hard-deletable. Static guards
// over the BEFORE DELETE trigger migration + the ImportHistory UI steer.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#116 migration — prevent_committed_lease_hard_delete trigger', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir)
    .filter((f) => f.includes('prevent_committed_lease_hard_delete'))
    .sort()
    .pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');

  it('defines the guard function and wires it as a BEFORE DELETE row trigger on leases', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.prevent_committed_lease_hard_delete()');
    expect(sql).toContain('BEFORE DELETE ON public.leases');
    expect(sql).toContain('FOR EACH ROW');
    expect(sql).toContain('EXECUTE FUNCTION public.prevent_committed_lease_hard_delete()');
    // Idempotent drop-before-create so a re-run cannot duplicate the trigger.
    expect(sql).toContain('DROP TRIGGER IF EXISTS prevent_committed_lease_hard_delete ON public.leases');
  });

  it('bypasses the trusted server paths (service_role) — delete-workspace/-account + FK CASCADE', () => {
    expect(sql).toMatch(/COALESCE\(auth\.role\(\),\s*''\)\s*=\s*'service_role'/);
    // Scope the assertion to the service_role branch (RETURN OLD appears twice —
    // also in the disposable bypass — so a full-file toContain would false-pass).
    expect(sql).toMatch(/service_role'\s+THEN\s+RETURN OLD;/);
  });

  it('allows only disposable imports: not model_locked AND (NULL or draft) lifecycle', () => {
    expect(sql).toContain('OLD.model_locked IS NOT TRUE');
    expect(sql).toMatch(/OLD\.lifecycle_status IS NULL OR OLD\.lifecycle_status = 'draft'/);
  });

  it('RAISEs an actionable error (steering to archive) for everything else', () => {
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toMatch(/Cannot hard-delete a committed lease/);
    expect(sql).toMatch(/Archive it instead/);
    expect(sql).toContain("ERRCODE = 'check_violation'");
  });

  it('pins search_path and owner like the sibling leases guards', () => {
    expect(sql).toContain("SET search_path TO 'public', 'pg_catalog'");
    expect(sql).toContain('ALTER FUNCTION public.prevent_committed_lease_hard_delete() OWNER TO postgres');
  });
});

describe('#116 disposability gate — shared lib in lockstep with the SQL allowlist', () => {
  const lib = fn('src/lib/leaseDisposability.ts');

  it('encodes the same predicate as the SQL trigger', () => {
    expect(lib).toContain('export function isCommittedLease');
    expect(lib).toContain('row.model_locked === true');
    expect(lib).toContain("row.lifecycle_status !== 'draft'");
  });
});

describe('#116 ImportHistory UI — steer committed leases to Archive', () => {
  const src = fn('src/pages/app/ImportHistory.tsx');

  it('fetches the columns the gate needs', () => {
    expect(src).toContain('lifecycle_status, model_locked');
    expect(src).toMatch(/lifecycle_status:\s*string \| null/);
    expect(src).toMatch(/model_locked:\s*boolean \| null/);
  });

  it('uses the shared isCommittedLease gate (not a local copy)', () => {
    expect(src).toContain("from '@/lib/leaseDisposability'");
    expect(src).toContain('isCommittedLease(imp)');
    // No drift-prone local re-definition.
    expect(src).not.toContain('function isCommittedLease');
  });

  it('renders an Archive steer (not a hard-delete) for committed leases, deep-linked to the archive action', () => {
    expect(src).toContain('<Archive className="h-4 w-4" />');
    expect(src).toContain("t('import.archive_committed')");
    expect(src).toContain('?action=archive');
    // The destructive Trash2 path remains for disposable imports.
    expect(src).toContain('handleDeleteClick(imp)');
  });

  it('surfaces the trigger error message verbatim on a blocked delete (no false success)', () => {
    expect(src).toContain('error instanceof Error && error.message');
  });
});

describe('#116 Archive deep-link — both destination paths honor ?action=archive', () => {
  it('LeaseReview workbench opens the archive dialog for an admin/owner', () => {
    const src = fn('src/pages/app/LeaseReview.tsx');
    expect(src).toContain('useSearchParams');
    expect(src).toMatch(/searchParams\.get\('action'\)\s*!==?\s*'archive'/);
    expect(src).toContain('setShowArchiveDialog(true)');
    // Gated to admin/owner; locked-active is delegated to LockedHeader.
    expect(src).toContain('isAdminUser');
  });

  it('LockedHeader (locked-active path) opens its archive dialog for an admin', () => {
    const src = fn('src/components/leases/locked/LockedHeader.tsx');
    expect(src).toContain('useSearchParams');
    expect(src).toMatch(/searchParams\.get\('action'\)\s*!==?\s*'archive'/);
    expect(src).toContain('setArchiveDialogOpen(true)');
  });
});

describe('#116 locale parity (en/es lockstep)', () => {
  it('both locales carry import.archive_committed', () => {
    const en = JSON.parse(fn('src/locales/en/common.json'));
    const es = JSON.parse(fn('src/locales/es/common.json'));
    expect(typeof en.import.archive_committed).toBe('string');
    expect(typeof es.import.archive_committed).toBe('string');
    expect(en.import.archive_committed.length).toBeGreaterThan(0);
    expect(es.import.archive_committed.length).toBeGreaterThan(0);
  });
});
