import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from '../csv';

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
  it('passes through plain text + numbers; null/undefined -> empty', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});
