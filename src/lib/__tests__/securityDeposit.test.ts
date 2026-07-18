import { describe, expect, it } from 'vitest';
import { parseSingleCurrencyAmount } from '@/lib/securityDeposit';

describe('parseSingleCurrencyAmount', () => {
  it('parses clean single amounts (optional $, commas, decimals)', () => {
    expect(parseSingleCurrencyAmount('5000')).toBe(5000);
    expect(parseSingleCurrencyAmount('$5,000')).toBe(5000);
    expect(parseSingleCurrencyAmount('$5,000.00')).toBe(5000);
    expect(parseSingleCurrencyAmount('  $ 1,234,567.89 ')).toBe(1234567.89);
    expect(parseSingleCurrencyAmount('500.5')).toBe(500.5);
    // A bare large number is still a single number — format it.
    expect(parseSingleCurrencyAmount('50002')).toBe(50002);
  });

  it('returns null for free-text / multi-number deposits (never fabricates)', () => {
    // The regression: this used to render as $50,002.00.
    expect(parseSingleCurrencyAmount('$5,000 (2 months)')).toBeNull();
    expect(parseSingleCurrencyAmount('$5,000.00 plus $500 cleaning')).toBeNull();
    expect(parseSingleCurrencyAmount("two months' rent")).toBeNull();
    expect(parseSingleCurrencyAmount('$5,000/month')).toBeNull();
    expect(parseSingleCurrencyAmount('5,00')).toBeNull(); // malformed grouping
    expect(parseSingleCurrencyAmount('N/A')).toBeNull();
  });

  it('returns null for empty / non-positive values', () => {
    expect(parseSingleCurrencyAmount(null)).toBeNull();
    expect(parseSingleCurrencyAmount(undefined)).toBeNull();
    expect(parseSingleCurrencyAmount('')).toBeNull();
    expect(parseSingleCurrencyAmount('0')).toBeNull();
    expect(parseSingleCurrencyAmount('$0.00')).toBeNull();
  });
});
