import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapSupabaseError } from '@/lib/userFacingError';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #173 — raw Postgrest/trigger/driver text must never reach the UI. The
// mapper turns the three recognizable classes (lock trigger, RLS/permission,
// network) into localized copy, falls back to the caller's surface-specific
// key otherwise, and ALWAYS preserves the raw error in the console.

const t = (k: string) => k;

describe('mapSupabaseError (#173)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('maps RLS-violation text to errors.no_permission', () => {
    expect(
      mapSupabaseError(
        new Error('new row violates row-level security policy for table "leases"'),
        t,
        'fallback.key',
      ),
    ).toBe('errors.no_permission');
  });

  it('maps a 42501-coded PostgrestError to errors.no_permission', () => {
    expect(
      mapSupabaseError(
        { code: '42501', message: 'permission denied for table leases' },
        t,
        'fallback.key',
      ),
    ).toBe('errors.no_permission');
  });

  it('maps the lease-lock trigger message to errors.lease_locked', () => {
    expect(
      mapSupabaseError(
        new Error('Cannot modify a locked lease except through the governance workflow'),
        t,
        'fallback.key',
      ),
    ).toBe('errors.lease_locked');
  });

  it('maps fetch failures to errors.network', () => {
    expect(mapSupabaseError(new Error('Failed to fetch'), t, 'fallback.key')).toBe(
      'errors.network',
    );
  });

  it('does NOT treat a bare constraint "violates" as a permission error', () => {
    expect(
      mapSupabaseError(
        new Error('duplicate key value violates unique constraint "x"'),
        t,
        'fallback.key',
      ),
    ).toBe('fallback.key');
  });

  it('falls back for undefined errors without throwing', () => {
    expect(mapSupabaseError(undefined, t, 'fallback.key')).toBe('fallback.key');
  });

  it('always logs the raw error to the console with the given context', () => {
    const err = new Error('Failed to fetch');
    mapSupabaseError(err, t, 'fallback.key', '[test-context]');
    expect(errorSpy).toHaveBeenCalledWith('[test-context]', err);
  });
});

// Static routing pins: every #173 surface goes through the mapper and no
// raw `.message` reaches toast/setLoadError anymore. (LockedLeaseDetail's
// `error?.message || data?.error` inside a thrown Error is fine — that
// throw is consumed by a catch that routes through the mapper.)

describe('surfaces route errors through mapSupabaseError (static pins)', () => {
  const vendorCard = read('src/components/leases/locked/VendorCard.tsx');
  const lockedDetail = read('src/components/leases/locked/LockedLeaseDetail.tsx');
  const library = read('src/pages/app/DisclosureReportLibrary.tsx');
  const detail = read('src/pages/app/LeaseReportDetail.tsx');

  it('all four surfaces import the helper', () => {
    for (const src of [vendorCard, lockedDetail, library, detail]) {
      expect(src).toContain("from '@/lib/userFacingError'");
    }
  });

  it('no surface falls back to a raw error message', () => {
    for (const src of [vendorCard, lockedDetail, library, detail]) {
      expect(src).not.toContain('?.message ??');
      expect(src).not.toContain('setLoadError(error.message)');
      expect(src).not.toContain('toast.error(error.message)');
    }
  });

  it('VendorCard maps the save failure', () => {
    expect(vendorCard).toContain(
      "mapSupabaseError(err, t, 'locked_lease.vendor.save_failed'",
    );
  });

  it('LockedLeaseDetail maps all four governance catches', () => {
    for (const key of [
      'locked_lease.risks.dismiss_failed',
      'locked_lease.toast.unlock_request_failed',
      'locked_lease.toast.unlock_failed',
      'locked_lease.toast.unlock_deny_failed',
    ]) {
      expect(lockedDetail).toContain(`mapSupabaseError(err, t, '${key}'`);
    }
    // The {{message}} interpolation and its deleted unknown_error key are gone.
    expect(lockedDetail).not.toContain("t('locked_lease.risks.dismiss_failed', {");
    expect(lockedDetail).not.toContain('locked_lease.risks.unknown_error');
  });

  it('DisclosureReportLibrary maps generate + both load branches', () => {
    expect(library).toContain("mapSupabaseError(e, t, 'reports.consolidated_failed'");
    expect(library).toContain(
      "mapSupabaseError(error, t, 'reports.load_failed', '[DisclosureReportLibrary] load error'",
    );
    expect(library).toContain(
      "mapSupabaseError(e, t, 'reports.load_failed', '[DisclosureReportLibrary] load threw'",
    );
    // loadError is localized product copy now, not raw driver output.
    expect(library).not.toContain('text-red-700 font-mono');
  });

  it('LeaseReportDetail maps both load branches + regenerate', () => {
    expect(detail).toContain(
      "mapSupabaseError(error, t, 'reports.load_failed', '[LeaseReportDetail] load error'",
    );
    expect(detail).toContain(
      "mapSupabaseError(e, t, 'reports.load_failed', '[LeaseReportDetail] load threw'",
    );
    expect(detail).toContain("mapSupabaseError(e, t, 'reports.regeneration_failed'");
    expect(detail).not.toContain('text-red-700 font-mono');
    // The DB-stored generation error render is out of #173 scope — untouched.
    expect(detail).toContain('{report.error_message}');
  });

  it('the four mapping locale keys exist in both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    const get = (obj: unknown, path: string): unknown =>
      path.split('.').reduce<unknown>(
        (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
        obj,
      );
    for (const key of [
      'errors.lease_locked',
      'errors.no_permission',
      'errors.network',
      'reports.load_failed',
    ]) {
      for (const locale of [en, es]) {
        const value = get(locale, key);
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });
});
