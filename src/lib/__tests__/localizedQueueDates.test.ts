import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #172a: every date render in the approval queue + signator review must go
// through formatLocalizedDate (locale-aware, es gets Spanish month names, and
// date-only strings render via parseToLocalDate instead of shifting a day west
// of UTC). This pins the raw date-fns `format(new Date(...), 'MMM d, yyyy')`
// pattern OUT of both files. It deliberately does NOT ban all of date-fns —
// non-rendering utilities (e.g. differenceInDays) stay legal.

const FILES = [
  'src/pages/app/ApprovalQueue.tsx',
  'src/pages/app/SignatorReview.tsx',
];

describe('#172a — approval queue + signator review dates are localized', () => {
  for (const path of FILES) {
    describe(path, () => {
      const src = read(path);

      it("contains no hardcoded-English 'MMM d, yyyy' format token", () => {
        expect(src).not.toMatch(/MMM d, yyyy/);
      });

      it("does not import `format` from date-fns", () => {
        expect(src).not.toMatch(/import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*'date-fns'/);
      });

      it('renders dates through formatLocalizedDate from @/lib/dateFormatters', () => {
        expect(src).toContain('formatLocalizedDate(');
        expect(src).toMatch(
          /import\s*\{[^}]*\bformatLocalizedDate\b[^}]*\}\s*from\s*'@\/lib\/dateFormatters'/,
        );
      });
    });
  }
});
