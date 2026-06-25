import { describe, expect, it } from 'vitest';
import { escapeCsvCell, rowsToCsv } from '../csv';

// KNOWN_ISSUES #118 (R1) — CSV formula injection + RFC-4180 quoting.
describe('escapeCsvCell — formula-injection neutralization', () => {
  it('prefixes a single quote on =, +, -, @ leading chars', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(escapeCsvCell('+ping')).toBe("'+ping");
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
  });
  it('neutralizes a realistic HYPERLINK payload (and still quotes it)', () => {
    // leading '=' -> prefix quote; contains '"' -> RFC-4180 quote + doubling
    expect(escapeCsvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
  });
  it('leaves a safe leading char untouched', () => {
    expect(escapeCsvCell('Acme Corp')).toBe('Acme Corp');
    expect(escapeCsvCell('$1,000')).toBe('"$1,000"'); // has comma -> quoted, no formula prefix
  });
});

describe('escapeCsvCell — RFC-4180 quoting', () => {
  it('quotes commas, quotes (doubled), and newlines', () => {
    expect(escapeCsvCell('Acme, Inc')).toBe('"Acme, Inc"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it('handles a formula prefix AND a comma together', () => {
    expect(escapeCsvCell('=a,b')).toBe('"\'=a,b"');
  });
  it('neutralizes a leading tab or carriage return (both are formula vectors)', () => {
    expect(escapeCsvCell('\tTAB')).toBe("'\tTAB");
    expect(escapeCsvCell('\rCR')).toBe("'\rCR");
  });
  it('passes through plain text + numbers; null/undefined -> empty', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('rowsToCsv', () => {
  it('uses the first record\'s keys as the header row, preserving key order', () => {
    const csv = rowsToCsv([{ Property: 'HQ', Rent: 1000 }]);
    expect(csv.split('\n')[0]).toBe('Property,Rent');
  });
  it('emits one line per record, every cell escaped', () => {
    const csv = rowsToCsv([
      { Property: 'Acme, Inc', Type: 'Real Estate' },
      { Property: '=cmd', Type: 'Equipment' },
    ]);
    expect(csv).toBe('Property,Type\n"Acme, Inc",Real Estate\n\'=cmd,Equipment');
  });
  it('renders null/undefined cells as empty', () => {
    expect(rowsToCsv([{ A: null, B: undefined, C: 0 }])).toBe('A,B,C\n,,0');
  });
  it('returns empty string for no records', () => {
    expect(rowsToCsv([])).toBe('');
  });

  // Documented contract: the header is taken from the FIRST record's keys only.
  // Keys that appear only in later records are DROPPED; keys missing from a
  // later record render as empty cells. This is intentional for the Leases
  // export (every row is built with an identical key set) — the test pins it so
  // a future heterogeneous caller can't silently lose columns.
  it('uses only the first record\'s keys: later-only keys are dropped, missing keys are empty', () => {
    expect(rowsToCsv([{ A: 1, B: 2 }, { A: 3, C: 4 }])).toBe('A,B\n1,2\n3,');
  });

  it('escapes the HEADER cells too (formula prefix + comma quoting on a key)', () => {
    // Key '=Rent,USD' → formula prefix then RFC-4180 quoting.
    expect(rowsToCsv([{ '=Rent,USD': 100 }])).toBe('"\'=Rent,USD"\n100');
  });

  it('passes unicode through untouched (no spurious quoting on non-ASCII)', () => {
    expect(rowsToCsv([{ City: 'Zürich', Note: 'café — naïve' }])).toBe(
      'City,Note\nZürich,café — naïve',
    );
  });

  it('renders boolean and zero-number cells (not treated as empty)', () => {
    expect(rowsToCsv([{ A: false, B: 0, C: true }])).toBe('A,B,C\nfalse,0,true');
  });
});
