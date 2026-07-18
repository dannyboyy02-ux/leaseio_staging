import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #172b — LeaseReportDetail leaked raw DB tokens (status badge,
// discount-method snapshot) and browser-locale dates (toLocaleString /
// toLocaleDateString ignore the app language). These pins hold the page to
// the same localized patterns its sibling DisclosureReportLibrary uses.

describe('LeaseReportDetail.tsx localization (#172b)', () => {
  const src = read('src/pages/app/LeaseReportDetail.tsx');

  it('renders the status badge through reports.status.* with raw-token fall-through', () => {
    const start = src.indexOf('statusBadgeVariant(report.status)');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 300);
    expect(block).toContain(
      't(`reports.status.${report.status}`, { defaultValue: report.status })',
    );
    // The raw token must never render bare inside the badge again.
    expect(src).not.toMatch(/>\{report\.status\}</);
  });

  it('renders both dates through formatLocalizedDate with the app language', () => {
    expect(src).not.toContain('toLocaleString(');
    expect(src).not.toContain('toLocaleDateString(');
    // Consolidated onto the canonical datetime helper (polish fold 2026-07-18).
    expect(src).toContain('formatLocalizedDateTime(report.generated_at, language');
    expect(src).toContain('formatLocalizedDate(report.expires_at, language');
  });

  it('recomputes generatedAtDisplay when the language changes', () => {
    expect(src).toContain('[report, language]');
  });

  it('maps all four discount-method tokens to workspace.report_settings keys', () => {
    const start = src.indexOf('const DISCOUNT_METHOD_LABEL_KEYS');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('};', start) + 2);
    expect(block).toContain(
      "workspace_default: 'workspace.report_settings.method_workspace_default'",
    );
    expect(block).toContain("risk_free_rate: 'workspace.report_settings.method_risk_free'");
    expect(block).toContain(
      "incremental_borrowing_rate: 'workspace.report_settings.method_ibr'",
    );
    expect(block).toContain("custom: 'workspace.report_settings.method_custom'");
    // The raw snake_case render is gone; the localized lookup is what ships.
    expect(src).not.toContain("{report.discount_rate_method_at_gen ?? 'workspace_default'}");
    expect(src).toContain('{discountMethodLabel}');
  });
});

describe('locale keys backing the localized renders exist in both files', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));
  const get = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>(
      (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
      obj,
    );

  const keys = [
    // pending is a legal lease_reports status per the DB CHECK constraint
    // (baseline migration) even though no writer sets it yet.
    'reports.status.pending',
    'workspace.report_settings.method_workspace_default',
    'workspace.report_settings.method_risk_free',
    'workspace.report_settings.method_ibr',
    'workspace.report_settings.method_custom',
  ];

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
