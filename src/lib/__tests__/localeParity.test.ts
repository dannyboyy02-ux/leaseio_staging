import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GUARDRAIL (2026-07-12, en/es sweep): every user-facing string ships in BOTH
// locales. This test fails CI the moment a key is added to one locale file and
// not the other, or left empty — the exact drift that produced the
// half-translated Settings surface (Spanish rail wrapping English panels).
//
// If this test fails: add the missing key(s) to the OTHER locale file with a
// real translation (formal-usted Spanish; match the surrounding tone). Do not
// copy the English string into es to silence it — an English value in es is
// still a bug, just a quieter one.

const repoRoot = join(__dirname, '..', '..', '..');
const en = JSON.parse(readFileSync(join(repoRoot, 'src', 'locales', 'en', 'common.json'), 'utf8'));
const es = JSON.parse(readFileSync(join(repoRoot, 'src', 'locales', 'es', 'common.json'), 'utf8'));

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object') {
      Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    } else {
      out[`${prefix}${k}`] = String(v);
    }
  }
  return out;
}

const flatEn = flatten(en);
const flatEs = flatten(es);

describe('locale parity — en/es ship together', () => {
  it('every en key exists in es', () => {
    const missing = Object.keys(flatEn).filter((k) => !(k in flatEs));
    expect(missing, `keys missing from es/common.json:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every es key exists in en', () => {
    const missing = Object.keys(flatEs).filter((k) => !(k in flatEn));
    expect(missing, `keys missing from en/common.json:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no locale value is empty or whitespace', () => {
    const emptyEn = Object.entries(flatEn).filter(([, v]) => v.trim() === '').map(([k]) => k);
    const emptyEs = Object.entries(flatEs).filter(([, v]) => v.trim() === '').map(([k]) => k);
    expect(emptyEn, 'empty values in en').toEqual([]);
    expect(emptyEs, 'empty values in es').toEqual([]);
  });

  it('interpolation placeholders match between locales', () => {
    // A translated string must keep the same {{variables}} or the runtime
    // renders a literal hole (e.g. missing {{count}}).
    const holes = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((m) => m.replace(/\s/g, '')).sort();
    const mismatched = Object.keys(flatEn)
      .filter((k) => k in flatEs)
      .filter((k) => holes(flatEn[k]).join(',') !== holes(flatEs[k]).join(','));
    expect(
      mismatched,
      `placeholder mismatch (en vs es):\n${mismatched.map((k) => `${k}: [${holes(flatEn[k])}] vs [${holes(flatEs[k])}]`).join('\n')}`,
    ).toEqual([]);
  });
});
