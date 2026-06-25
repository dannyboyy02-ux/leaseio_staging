import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 3 lease soft-delete + 14-day retention. These are STATIC guards on the
// security-critical shape of the migration (RLS hiding + service-role guard +
// audit types) so a future refactor can't silently regress the properties the
// security/integrity reviews signed off on. Static tests catch in-repo drift,
// not live-DB drift (the live layer is the smoke-audit / advisor checks).

const repoRoot = join(__dirname, '..', '..', '..');
function readMigration(name: string): string {
  return readFileSync(join(repoRoot, 'supabase', 'migrations', name), 'utf8');
}

// Narrow a source to the body of a named block so a `toContain` can't pass on a
// match from an unrelated part of the file (the documented false-positive trap).
function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

const RETENTION = '20260625130000_lease_retention_lifecycle.sql';
const CRON = '20260625130100_lease_retention_cron.sql';

describe('lease retention migration — hiding RLS', () => {
  const sql = readMigration(RETENTION);

  it('adds a RESTRICTIVE SELECT policy that hides soft-deleted leases from authenticated reads', () => {
    // This single policy is what makes a soft-deleted lease (even one that is
    // also archived) invisible in EVERY authenticated scope — Active, Archived,
    // and All — and on every other surface (Dashboard/Portfolio/Reports/Leo).
    const block = sliceBetween(sql, 'CREATE POLICY leases_hide_soft_deleted', ';');
    expect(block).toContain('AS RESTRICTIVE');
    expect(block).toContain('FOR SELECT');
    expect(block).toContain('TO authenticated');
    expect(block).toContain('USING (deleted_at IS NULL)');
  });

  it('keeps the four retention columns service-role-only via a disjoint guard', () => {
    const fn = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.enforce_lease_retention_columns()',
      '$$;',
    );
    // service_role is the only writer.
    expect(fn).toContain("COALESCE(auth.role(), '') = 'service_role'");
    // Guards exactly the four retention columns on both INSERT and UPDATE.
    for (const col of ['deleted_at', 'purge_after', 'deleted_by', 'deletion_reason']) {
      expect(fn).toContain(col);
    }
    expect(fn).toContain('TG_OP');
    // Wired as a BEFORE INSERT OR UPDATE trigger.
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON public.leases');
  });

  it('registers the soft-delete / restore / purge audit activity types', () => {
    const check = sliceBetween(
      sql,
      'ADD CONSTRAINT lease_activity_log_activity_type_check',
      ']));',
    );
    expect(check).toContain("'lease_soft_deleted'");
    expect(check).toContain("'lease_restored_from_deletion'");
    expect(check).toContain("'lease_purged'");
    // The new types are ADDED, not a replacement — a long-standing value must
    // still be present (guards against an accidental list truncation).
    expect(check).toContain("'lease_archived'");
  });

  it('creates the service-role-only deleted_leases forensic table (UNIQUE original_lease_id)', () => {
    const tbl = sliceBetween(sql, 'CREATE TABLE IF NOT EXISTS public.deleted_leases', ');');
    expect(tbl).toContain('original_lease_id');
    expect(tbl).toContain('UNIQUE (original_lease_id)'); // the cron's resume-on-duplicate key
    expect(sql).toContain('REVOKE ALL ON public.deleted_leases FROM PUBLIC, anon, authenticated');
  });
});

describe('lease retention cron migration', () => {
  it('schedules the daily purge with the fail-closed cron-secret forwarding', () => {
    const sql = readMigration(CRON);
    expect(sql).toContain("'process-lease-retention-daily'");
    expect(sql).toContain('/functions/v1/process-lease-retention');
    expect(sql).toContain("WHERE id = 'lease_retention'"); // private.cron_secrets key
    expect(sql).toContain("'x-cron-secret'");
  });
});
