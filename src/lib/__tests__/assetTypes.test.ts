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
});
