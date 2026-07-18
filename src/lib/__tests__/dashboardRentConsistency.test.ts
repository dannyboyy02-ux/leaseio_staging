import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// Fresh-eyes fix: the dashboard money surfaces used to annualize a single raw
// column — `(monthly_payment ?? 0) * 12` — which ignored executed rent, current
// rent, and the rent schedule, so activated/escalated leases showed the wrong
// annual value. They now all route through getMonthlyRent (which prefers
// executed_monthly_payment > current_monthly_rent > rent_schedules >
// monthly_payment) and select the rent_schedules embed. These static pins keep
// every surface on that one helper so a future edit can't silently reintroduce
// the raw annualization.

const IMPORT_RE = /import\s*\{[^}]*\bgetMonthlyRent\b[^}]*\}\s*from\s*'@\/lib\/leaseCalculations'/;
const RAW_ANNUALIZE_RE = /monthly_payment\s*\?\?\s*0\s*\)\s*\*\s*12/;

const CANONICAL = [
  'src/components/dashboard/LeasePipeline.tsx',
  'src/components/dashboard/PipelineByDepartment.tsx',
  'src/components/dashboard/IntakeTrend.tsx',
  'src/hooks/useNeedsAction.ts',
];

describe('dashboard rent consistency — getMonthlyRent + rent_schedules embed', () => {
  for (const path of CANONICAL) {
    describe(path, () => {
      const src = read(path);
      it("imports getMonthlyRent from '@/lib/leaseCalculations'", () => {
        expect(src).toMatch(IMPORT_RE);
      });
      it('selects the rent_schedules(period_start, period_end, monthly_amount) embed', () => {
        expect(src).toContain('rent_schedules(period_start, period_end, monthly_amount)');
      });
      it('no longer annualizes the raw monthly_payment column', () => {
        expect(src).not.toMatch(RAW_ANNUALIZE_RE);
      });
    });
  }
});

describe('other money surfaces also route through getMonthlyRent', () => {
  for (const path of [
    'src/components/dashboard/SummaryStrip.tsx',
    'src/components/dashboard/UpcomingRisks.tsx',
    'src/components/dashboard/UpcomingEvents.tsx',
  ]) {
    it(`${path} imports getMonthlyRent`, () => {
      expect(read(path)).toMatch(IMPORT_RE);
    });
  }
});
