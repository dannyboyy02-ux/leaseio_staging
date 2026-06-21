import { describe, it, expect } from 'vitest';
import {
  parseToLocalDate,
  formatLocalizedDate,
  formatLocalizedCurrency,
  formatLocalizedNumber,
  formatLocalizedPercent,
} from '../dateFormatters';

// dateFormatters.ts is the single canonical money/date/number formatter for the
// app (the formatting-consistency sweep migrates every local Intl copy onto it).
// These tests pin the load-bearing contracts: the date-only off-by-one fix, the
// whole-dollars-default + opt-in-cents currency policy, locale awareness, and
// the null sentinels. Assertions match patterns rather than exact ICU output so
// they stay stable across Node ICU builds.

describe('parseToLocalDate', () => {
  it('parses a YYYY-MM-DD date-only string in LOCAL time (no UTC off-by-one)', () => {
    const d = parseToLocalDate('2026-03-15');
    // The whole point: the literal Y-M-D the DB stored must survive, never
    // shifting to the 14th in a timezone west of UTC.
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March, 0-indexed
    expect(d.getDate()).toBe(15);
  });

  it('passes a full datetime string through new Date()', () => {
    const iso = '2026-03-15T12:30:00Z';
    expect(parseToLocalDate(iso).getTime()).toBe(new Date(iso).getTime());
  });

  it('returns a Date input unchanged', () => {
    const date = new Date(2026, 5, 1);
    expect(parseToLocalDate(date)).toBe(date);
  });
});

describe('formatLocalizedCurrency', () => {
  it('returns the em-dash sentinel for null/undefined', () => {
    expect(formatLocalizedCurrency(null, 'en')).toBe('—');
    expect(formatLocalizedCurrency(undefined, 'en')).toBe('—');
  });

  it('defaults to whole dollars (no cents) and rounds', () => {
    const out = formatLocalizedCurrency(1234.56, 'en');
    expect(out).toContain('$');
    expect(out).toContain('1,235'); // rounded to whole dollars
    expect(out).not.toContain('.'); // no fractional part
  });

  it('shows two decimal places when { cents: true }', () => {
    const out = formatLocalizedCurrency(1234.5, 'en', { cents: true });
    expect(out).toContain('1,234.50');
  });

  it('abbreviates with { compact: true } for chart axes', () => {
    expect(formatLocalizedCurrency(1234, 'en', { compact: true })).toBe('$1.2K');
    expect(formatLocalizedCurrency(3400000, 'en', { compact: true })).toBe('$3.4M');
  });

  it('honors a { currency } override (defaults to USD)', () => {
    const eur = formatLocalizedCurrency(1234, 'en', { currency: 'EUR' });
    expect(eur).toContain('€');
    expect(eur).not.toContain('$');
  });

  it('passes the locale through and keeps the digits intact in both locales', () => {
    // The helper must localize (pass the locale to Intl) — the bug this sweep
    // fixes was components hardcoding en-US. For USD specifically, es-419 groups
    // with commas like en-US, and narrowSymbol normalizes the symbol to "$", so
    // the two happen to render identically here — that's expected, not a bug.
    // (The visible locale difference lives in dates; see formatLocalizedDate.)
    const en = formatLocalizedCurrency(1234567, 'en');
    const es = formatLocalizedCurrency(1234567, 'es');
    expect(en).toContain('$1,234,567');
    expect(es).toContain('$');
    expect(es.replace(/[^0-9]/g, '')).toBe('1234567');
  });

  it('renders USD with the $ symbol for es users (narrowSymbol), not "USD"', () => {
    // Product decision (2026-06-21): USD-only product, so es should show "$"
    // (locale-aware grouping) rather than the verbose "USD 5,000" code form.
    const es = formatLocalizedCurrency(5000, 'es');
    expect(es).toContain('$');
    expect(es).not.toContain('USD');
    expect(formatLocalizedCurrency(1200000, 'es', { compact: true })).toContain('$');
  });
});

describe('formatLocalizedNumber', () => {
  it('returns the sentinel for null/undefined', () => {
    expect(formatLocalizedNumber(null, 'en')).toBe('—');
    expect(formatLocalizedNumber(undefined, 'en')).toBe('—');
  });

  it('groups thousands', () => {
    expect(formatLocalizedNumber(1234567, 'en')).toBe('1,234,567');
  });
});

describe('formatLocalizedPercent', () => {
  it('returns the sentinel for null/undefined', () => {
    expect(formatLocalizedPercent(null, 'en')).toBe('—');
    expect(formatLocalizedPercent(undefined, 'en')).toBe('—');
  });

  it('treats the value as a 0–100 percent and appends %', () => {
    expect(formatLocalizedPercent(5.5, 'en')).toBe('5.5%');
    // No forced trailing zeros (min 0 fraction digits).
    expect(formatLocalizedPercent(5, 'en')).toBe('5%');
  });

  it('respects the decimals cap', () => {
    expect(formatLocalizedPercent(5.456, 'en', 2)).toBe('5.46%');
  });
});

describe('formatLocalizedDate', () => {
  it('returns the sentinel for null/undefined', () => {
    expect(formatLocalizedDate(null, 'en')).toBe('—');
    expect(formatLocalizedDate(undefined, 'en')).toBe('—');
  });

  it('formats a date-only string without shifting the day', () => {
    const out = formatLocalizedDate('2026-03-15', 'en');
    expect(out).toContain('2026');
    expect(out).toContain('15'); // not 14
    expect(out).toContain('Mar');
  });
});
