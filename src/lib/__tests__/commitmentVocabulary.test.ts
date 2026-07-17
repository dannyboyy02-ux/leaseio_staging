import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Polish walkthrough 2026-07-17 (commit 9bce71a, cluster 4) — vocabulary.
// "Commitment" was used in two unrelated senses: the OBJECT being requested
// ("New Commitment Request" — jargon nobody in an SMB finance team says) and
// the MONEY total ("Total Cash Commitment" — correct finance vocabulary).
// The fix renamed every object-sense use to "lease request" while keeping the
// money sense everywhere. This pins both directions so a future copy pass
// doesn't reintroduce the jargon OR "fix" the legitimate finance terms away.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const en = JSON.parse(read('src/locales/en/common.json'));
const es = JSON.parse(read('src/locales/es/common.json'));
const get = (obj: any, path: string) =>
  path.split('.').reduce((acc, key) => acc?.[key], obj);

describe('cluster 4 — object-sense "commitment" is gone from the locales', () => {
  it('workflow.request.title says lease request, not commitment', () => {
    const enTitle = get(en, 'workflow.request.title');
    const esTitle = get(es, 'workflow.request.title');
    expect(enTitle).toBeTruthy();
    expect(esTitle).toBeTruthy();
    expect(enTitle).not.toMatch(/commitment/i);
    expect(esTitle).not.toMatch(/compromiso/i);
  });

  it('approvals.queue.subtitle says lease requests, not commitments', () => {
    const enSub = get(en, 'approvals.queue.subtitle');
    const esSub = get(es, 'approvals.queue.subtitle');
    expect(enSub).toBeTruthy();
    expect(esSub).toBeTruthy();
    expect(enSub).not.toMatch(/commitment/i);
    expect(esSub).not.toMatch(/compromiso/i);
  });
});

describe('cluster 4 — money-sense commitment vocabulary is KEPT', () => {
  it('workflow.impact.total_cash_commitment still exists in both locales', () => {
    expect(get(en, 'workflow.impact.total_cash_commitment')).toMatch(/commitment/i);
    expect(get(es, 'workflow.impact.total_cash_commitment')).toMatch(/compromiso/i);
  });

  it('portfolio.kpi_remaining_commitment still exists in both locales', () => {
    expect(get(en, 'portfolio.kpi_remaining_commitment')).toMatch(/commitment/i);
    expect(get(es, 'portfolio.kpi_remaining_commitment')).toMatch(/compromiso/i);
  });
});

describe('cluster 4 — DB-written notification literals say "lease request"', () => {
  // These literals are written INTO notification rows (DB-written strings are
  // the documented i18n remainder — KNOWN_ISSUES #160), so the locale sweep
  // does not cover them. Pin them at the source.
  for (const p of [
    'src/components/workflow/LeaseRequestForm.tsx',
    'src/lib/retryRequestRouting.ts',
  ]) {
    it(`${p} notifies about a "lease request", never a "commitment"`, () => {
      const src = read(p);
      expect(src).toContain('New lease request requires your approval:');
      expect(src).toContain('New lease request awaiting your review:');
      expect(src).toContain('New lease request awaiting financial review:');
      expect(src).toMatch(/New lease request: \$\{/);
      // Object-sense phrasing must not creep back into any literal.
      expect(src).not.toMatch(/commitment request/i);
      expect(src).not.toMatch(/New commitment/i);
    });
  }
});

describe('cluster 4/6 — new locale keys land in en (parity test carries es)', () => {
  // localeParity.test.ts already fails on en↔es structural drift, so pinning
  // en existence is sufficient to guarantee both.
  const NEW_KEYS = [
    'leases.asc842.sections_captured',
    'workflow.request.discard_title',
    'reports.no_reports_empty',
    'lease_review.tabs.mark_reviewed',
    'common.open',
    'common.retry',
  ];
  for (const key of NEW_KEYS) {
    it(`en defines ${key}`, () => {
      const value = get(en, key);
      expect(typeof value, `${key} should be a non-empty string`).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    });
  }
});
