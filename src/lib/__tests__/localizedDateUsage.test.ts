import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Wave 5 es-rendering pin.
//
// The Wave-4 Spanish sweep found ~20 surfaces rendering raw date-fns
// `format(x, 'MMM d, yyyy')` — English month names mid-Spanish-sentence —
// because nothing stopped a new component from reaching for date-fns instead
// of src/lib/dateFormatters.ts (formatLocalizedDate/DateTime/MonthYear, which
// route through Intl with the active language). This pin fails when a NEW
// month-name format string appears outside the formatter module.
//
// What it catches: any format string containing a month-NAME token (MMM/MMMM)
// in src/ outside dateFormatters.ts — those render localized ONLY via the
// formatter (or an explicit date-fns `locale:` option, which the allowlist
// covers). Numeric-only patterns (yyyy-MM-dd, MM/dd/yyyy — CSV/data files)
// are locale-neutral and deliberately NOT flagged.
const ALLOWLIST: Record<string, string> = {
  'src/components/dashboard/FinancialSummary.tsx':
    'UNMOUNTED dead code (KNOWN_ISSUES #42) — fix or delist when it returns',
};

const repoRoot = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => f.slice(repoRoot.length + 1).replace(/\\/g, '/');

// Detection (review fold): the first cut tried to parse the format() arg list
// with [^)]* — which cannot cross the ')' inside `format(new Date(d), 'MMM…')`,
// the DOMINANT offender shape, making the pin largely vacuous. Instead: flag
// any quoted month-name literal ('MMM'/'MMMM' token) in a file that imports
// date-fns. Numeric-only patterns (yyyy-MM-dd, MM/dd/yyyy) contain no MMM so
// the CSV exemption survives; Intl option objects don't use MMM literals.
const MONTH_LITERAL = /['"][^'"\n]*\bMMM/;
const IMPORTS_DATE_FNS = /from\s+['"]date-fns['"]/;
const RAW_MONTH_FORMAT = (src: string) =>
  IMPORTS_DATE_FNS.test(src) && MONTH_LITERAL.test(src);

describe('localized date usage pin (Wave 5)', () => {
  const files = walk(join(repoRoot, 'src')).filter(
    (f) => !rel(f).endsWith('lib/dateFormatters.ts'),
  );

  it('scans a plausible number of files (guards a broken walk)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no raw month-name date-fns format() outside dateFormatters.ts', () => {
    const offenders = files
      .map(rel)
      .filter((r) => !(r in ALLOWLIST))
      .filter((r) => RAW_MONTH_FORMAT(readFileSync(join(repoRoot, r), 'utf8')));
    expect(
      offenders,
      'These files hard-code English month names. Use formatLocalizedDate/' +
        'DateTime/MonthYear from src/lib/dateFormatters.ts (or pass a date-fns ' +
        'locale and add an ALLOWLIST entry with the reason):\n' +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries are still live', () => {
    const stale = Object.keys(ALLOWLIST).filter((k) => {
      try {
        return !RAW_MONTH_FORMAT(readFileSync(join(repoRoot, k), 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale, 'Stale allowlist entries — remove:\n' + stale.join('\n')).toEqual([]);
  });
});
