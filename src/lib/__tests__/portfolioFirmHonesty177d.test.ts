import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #177d — copy-honesty pins across three surfaces:
//   (1) FirmDashboard must show the BILLED child-workspace count
//       (firms.child_workspaces_used) and the restricted-hidden note —
//       restrict_firm_access children are RLS-hidden from firm staff but still
//       bound and billed, so the visible-only count (and the false "No
//       workspaces yet" empty state) understated what the firm pays for.
//   (2) The Portfolio cost-per-sqft card is per-LEASE (one row per lease keyed
//       by l.id), not per-location; the title must not claim otherwise.
//   (3) Forecast copy drops CRE-analyst jargon ("re-leasing cliff",
//       "uncontracted") for plain language.
//   (4) FirmBilling's invoice-mode copy must not assert per-workspace invoice
//       line-items — that itemization is the deferred #105 follow-on; the
//       toggle only stores a preference today.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const en = JSON.parse(read('src/locales/en/common.json'));
const es = JSON.parse(read('src/locales/es/common.json'));

describe('#177d — FirmDashboard shows the billed child count + hidden-children note', () => {
  const src = read('src/pages/app/firm/FirmDashboard.tsx');
  const marker = 'export default function FirmDashboard';

  it('component body reads firms.child_workspaces_used (billed truth, not visible-only)', () => {
    const start = src.indexOf(marker);
    expect(start, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
    const body = src.slice(start);
    expect(body).toContain('child_workspaces_used');
  });

  it('component body renders the restricted-hidden note', () => {
    const body = src.slice(src.indexOf(marker));
    expect(body).toContain('firm.dashboard.restricted_hidden');
  });

  it('both locale files carry the restricted_hidden plural keys with a count placeholder', () => {
    for (const json of [en, es]) {
      expect(json.firm.dashboard.restricted_hidden_one).toContain('{{count}}');
      expect(json.firm.dashboard.restricted_hidden_other).toContain('{{count}}');
    }
  });
});

describe('#177d — cost-per-sqft card is titled per-lease, not per-location', () => {
  it('en title says lease, not location', () => {
    expect(en.portfolio.cost_per_sqft_title).toMatch(/lease/i);
    expect(en.portfolio.cost_per_sqft_title).not.toMatch(/location/i);
  });

  it('es title says arrendamiento, not ubicación', () => {
    expect(es.portfolio.cost_per_sqft_title).toMatch(/arrendamiento/i);
    expect(es.portfolio.cost_per_sqft_title).not.toMatch(/ubicaci/i);
  });
});

describe('#177d — forecast copy uses plain language, not CRE jargon', () => {
  it('en forecast strings drop "cliff" and "uncontracted"', () => {
    expect(en.portfolio.forecast_sub).not.toMatch(/cliff|uncontracted/i);
    expect(en.portfolio.term_ends_uncontracted).not.toMatch(/cliff|uncontracted/i);
  });

  it('es forecast strings drop the jargon', () => {
    expect(es.portfolio.forecast_sub).not.toMatch(/precipicio/i);
    expect(es.portfolio.term_ends_uncontracted).not.toMatch(/precipicio/i);
  });
});

describe('#177d — FirmBilling invoice-mode copy does not promise unshipped itemization', () => {
  it('en detailed-mode description does not claim per-workspace invoice lines', () => {
    expect(en.firm.billing.mode_detailed_desc).not.toMatch(/invoice shows one line/i);
    expect(en.firm.billing.mode_detailed_desc).toMatch(/combined charge/i);
  });

  it('es detailed-mode description does not claim per-workspace invoice lines', () => {
    expect(es.firm.billing.mode_detailed_desc).not.toMatch(/línea por espacio/i);
    expect(es.firm.billing.mode_detailed_desc).toMatch(/cargo combinado/i);
  });
});
