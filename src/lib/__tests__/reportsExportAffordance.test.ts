import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// Fresh-eyes fix: Reports.tsx carried a redundant "export all / Download"
// affordance that competed with the real per-report exports. It was removed —
// the export surface is now solely <RentRollExport /> plus the per-report
// "View report" cards. These pins keep the dead affordance from creeping back
// (both in the JSX and as a dangling locale key).

describe('Reports.tsx export affordance', () => {
  const src = read('src/pages/Reports.tsx');

  it('drops the removed export-all affordance', () => {
    expect(src).not.toContain('reports.export_all');
    expect(src).not.toContain('Download');
    expect(src).not.toContain('canExport');
  });

  it('keeps the real export surfaces', () => {
    expect(src).toContain('<RentRollExport');
    expect(src).toContain("t('reports.view_report')");
  });
});

describe('reports.export_all is gone from both locales', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));

  it('en has no reports.export_all key', () => {
    expect(en.reports?.export_all).toBeUndefined();
  });

  it('es has no reports.export_all key', () => {
    expect(es.reports?.export_all).toBeUndefined();
  });
});
