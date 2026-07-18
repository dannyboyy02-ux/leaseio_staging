import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #172c — Portfolio.tsx mixed two currency conventions: the KPI tiles used the
// canonical locale-aware formatLocalizedCurrency while the Rent Forecast bar
// labels, the Cost-by-Department tooltip/legend, and the Blended Cost tile
// rendered a hand-rolled en-only `$...` string (module-level compactCurrency
// helper + a raw template literal). dateFormatters.ts declares
// formatLocalizedCurrency the single canonical formatter — components must not
// roll their own. These pins keep the page on the canonical formatter.

const src = readFileSync(join(process.cwd(), 'src/pages/app/Portfolio.tsx'), 'utf8');

/** Slice the file between two unique markers (fails loudly if either is missing). */
const window = (start: string, end: string): string => {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  expect(a, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found: ${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('#172c — Portfolio currency renders route through formatLocalizedCurrency', () => {
  it('the hand-rolled compactCurrency helper never returns', () => {
    expect(src).not.toMatch(/compactCurrency/);
  });

  it('no template literal prefixes an interpolation with a hardcoded dollar sign', () => {
    // Built by concatenation so this test file does not contain the banned
    // substring itself. This is the exact shape of both former violations
    // (the compactCurrency body and the Blended Cost tile).
    expect(src).not.toContain('$' + '${');
  });

  it('CommitmentForecast bar labels use the canonical compact formatter', () => {
    const w = window('function CommitmentForecast', 'function CostByDepartment');
    expect(w).toContain('formatLocalizedCurrency(b.contracted, language, { compact: true })');
    // The em-dash placeholder for empty buckets must survive (formatter would render $0).
    expect(w).toContain("b.contracted > 0 ?");
  });

  it('CostByDepartment tooltip + legend use the canonical compact formatter', () => {
    const w = window('function CostByDepartment', 'function CostPerSqft');
    expect(w).toContain('formatLocalizedCurrency(s.annualCost, language, { compact: true })');
  });

  it('Blended Cost KPI tile uses the canonical non-compact cents formatter', () => {
    const w = window("t('portfolio.kpi_blended_cost')", "t('portfolio.kpi_total_footprint')");
    expect(w).toContain('formatLocalizedCurrency(kpis.blendedCostPerSqft, language, { cents: true })');
  });
});
