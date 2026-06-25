import { describe, it, expect } from 'vitest';
import { normalizeAssetKey, prettyAssetType, assetAbbreviation } from '@/lib/assetTypes';

describe('normalizeAssetKey', () => {
  it('collapses snake_case, spaces, and case to one key', () => {
    expect(normalizeAssetKey('real_estate')).toBe('realestate');
    expect(normalizeAssetKey('Real Estate')).toBe('realestate');
    expect(normalizeAssetKey('REAL-ESTATE')).toBe('realestate');
    expect(normalizeAssetKey(null)).toBe('');
  });
});

describe('prettyAssetType', () => {
  it('snake_case → Title Case', () => {
    expect(prettyAssetType('real_estate')).toBe('Real Estate');
    expect(prettyAssetType('equipment')).toBe('Equipment');
    expect(prettyAssetType(null)).toBe('');
  });
});

describe('assetAbbreviation', () => {
  it('uses built-in defaults for the common types (snake_case input)', () => {
    expect(assetAbbreviation('real_estate')).toBe('RE');
    expect(assetAbbreviation('equipment')).toBe('EQP');
    expect(assetAbbreviation('vehicle')).toBe('VEH');
    expect(assetAbbreviation('other')).toBe('OTH');
  });
  it('matches a label-keyed override against a snake_case lease value', () => {
    expect(assetAbbreviation('real_estate', { 'Real Estate': 'REL' })).toBe('REL');
    expect(assetAbbreviation('Customer', { Customer: 'CX' })).toBe('CX');
  });
  it('override beats the built-in default', () => {
    expect(assetAbbreviation('vehicle', { Vehicle: 'AUTO' })).toBe('AUTO');
  });
  it('ignores empty overrides and falls through to the default', () => {
    expect(assetAbbreviation('vehicle', { Vehicle: '' })).toBe('VEH');
  });
  it('derives an abbreviation for an unknown type (initials / first-3)', () => {
    expect(assetAbbreviation('Show Room Lease')).toBe('SRL'); // multi-word initials
    expect(assetAbbreviation('warehouse')).toBe('WAR');        // single word → first 3
  });
  it('returns empty for a missing asset type', () => {
    expect(assetAbbreviation(null)).toBe('');
    expect(assetAbbreviation('')).toBe('');
  });

  // --- Override-precedence + normalizeAssetKey matching edge cases ---

  it('matches an override key with punctuation/spaces against a snake_case lease value', () => {
    // "Real-Estate!" and 'real_estate' both normalize to 'realestate'.
    expect(assetAbbreviation('real_estate', { 'Real-Estate!': 'RE' })).toBe('RE');
    // A snake_case-keyed override also matches a snake_case value.
    expect(assetAbbreviation('real_estate', { real_estate: 'RX' })).toBe('RX');
  });

  it('lets an override beat a built-in default even for a default-covered key (customer)', () => {
    expect(assetAbbreviation('customer', { Customer: 'CU' })).toBe('CU');
  });

  it('falls through to the default when an override is present but its key does not match', () => {
    expect(assetAbbreviation('vehicle', { Boat: 'BT' })).toBe('VEH');
  });

  it('returns the FIRST matching override when two labels normalize to the same key', () => {
    // Object.entries order = insertion order; 'realestate' is inserted first.
    expect(assetAbbreviation('real_estate', { realestate: 'A', 'Real Estate': 'B' })).toBe('A');
  });

  // Pins a known quirk: the truthiness guard `if (abbr && ...)` treats a
  // whitespace-only abbreviation as PRESENT (unlike ''), so it is returned
  // verbatim rather than falling through to the default. If the SUT ever trims
  // overrides this test must change deliberately. (See findings: LOW.)
  it('returns a whitespace-only override verbatim (does NOT fall through like an empty one)', () => {
    expect(assetAbbreviation('vehicle', { Vehicle: '   ' })).toBe('   ');
  });

  it("normalizes 'Other'/'other' to the OTH default in both casings", () => {
    expect(assetAbbreviation('Other')).toBe('OTH');
    expect(assetAbbreviation('other')).toBe('OTH');
  });

  it('derives a custom multi-word type with no default to initials, capped at 4 letters', () => {
    expect(assetAbbreviation('Net Net Net Lease')).toBe('NNNL'); // 4 words → 4 initials
    expect(assetAbbreviation('A B C D E Lease')).toBe('ABCD');    // 6 words → first 4 initials
  });

  // Pins a quirk: a whitespace-only assetType is truthy (so not short-circuited
  // by `if (!assetType)`), normalizes to '', has no default, and derives to its
  // own slice — returning whitespace rather than ''. (See findings: LOW.)
  it('returns whitespace for a whitespace-only asset type (not empty)', () => {
    expect(assetAbbreviation('   ')).toBe('   ');
  });
});
