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

// A format call whose pattern literal contains a month-name token. Matches
// format(x, 'MMM d'), format(x, "MMMM yyyy"), etc. — not identifiers that
// merely contain "format".
const RAW_MONTH_FORMAT = /\bformat(?:Distance\w*)?\s*\([^)]*['"][^'"]*MMM/;

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
      .filter((r) => RAW_MONTH_FORMAT.test(readFileSync(join(repoRoot, r), 'utf8')));
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
        return !RAW_MONTH_FORMAT.test(readFileSync(join(repoRoot, k), 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale, 'Stale allowlist entries — remove:\n' + stale.join('\n')).toEqual([]);
  });
});
