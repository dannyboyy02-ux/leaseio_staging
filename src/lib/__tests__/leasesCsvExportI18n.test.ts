import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #172d — the Leases CSV export is a WYSIWYG snapshot of the localized
// table. Headers and display values (type, status, archived) must render
// through i18n, while the machine-parseable fields stay raw: ISO dates and
// raw rent/sqft numbers are locale-independent and Excel-safe in every
// locale. These pins keep the export from regressing to hardcoded English
// headers or locale-formatted (comma-decimal) numbers.

const HEADER_KEYS = [
  'leases.property',
  'leases.type',
  'leases.landlord',
  'leases.monthly_rent',
  'leases.start',
  'leases.end',
  'leases.sqft',
  'leases.status',
  'archive.deleted_badge',
];

describe('Leases.tsx CSV export localization (#172d)', () => {
  const src = read('src/pages/Leases.tsx');
  const start = src.indexOf('const handleExportCsv');
  const block = src.slice(start, src.indexOf('\n  };', start));

  it('narrows to the export handler', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('rowsToCsv');
  });

  it('derives every CSV header from a locale key', () => {
    for (const key of HEADER_KEYS) {
      expect(block).toContain(`[t('${key}')]`);
    }
    // The old hardcoded-English record shape must not creep back.
    expect(block).not.toMatch(/'Monthly Rent'|'Sq Ft'|Property:|Landlord:|Status:|Archived:/);
  });

  it('localizes the display values (type, status, archived)', () => {
    expect(block).toContain('localizedAssetTypeName(');
    expect(block).toContain('localizedStatusLabel(');
    expect(block).toContain("t('common.yes')");
    expect(block).toContain("t('common.no')");
    expect(block).not.toContain('prettyAssetType(');
    expect(block).not.toContain('statusText(');
  });

  it('keeps machine-parseable fields raw (ISO dates, raw numbers)', () => {
    expect(block).toContain("l.lease_start ?? ''");
    expect(block).toContain('getLeaseEnd(l)');
    expect(block).not.toContain('formatDate(');
    expect(block).not.toContain('formatCurrency(');
  });
});

describe('every reused CSV locale key resolves in both locales', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));
  const get = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>(
      (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
      obj,
    );
  const keys = [...HEADER_KEYS, 'common.yes', 'common.no'];

  // A future key rename must fail here rather than silently shipping a CSV
  // whose headers are raw i18n key strings.
  for (const key of keys) {
    it(`${key} is a non-empty string in en and es`, () => {
      for (const locale of [en, es]) {
        const value = get(locale, key);
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    });
  }
});
