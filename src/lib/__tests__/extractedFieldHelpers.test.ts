import { describe, it, expect } from 'vitest';
import { getFieldConfidence } from '../extractedFieldHelpers';

// Regression coverage for the B1 fix: getFieldConfidence is the single source
// of truth for per-field extraction confidence — the field badges, the
// LeaseReview review-gate, and the NeedsReviewBanner all read it. It lives in
// a pure module (no supabase import) so presentational components can use it.
//
// Contract pinned here:
//   - numeric confidence passes through unchanged (0–1 scale).
//   - string confidences map: high -> 0.95, medium -> 0.80, low -> 0.60.
//   - null whenever there is no per-field confidence to report: missing field,
//     non-object (old string-format) field, null map, or an object without a
//     recognizable `confidence`.

describe('getFieldConfidence — numeric passthrough', () => {
  it('returns a numeric confidence unchanged', () => {
    const json = { landlord_name: { value: 'Acme LLC', confidence: 0.55 } };
    expect(getFieldConfidence(json, 'landlord_name')).toBe(0.55);
  });

  it('passes boundary numeric values through unchanged (0, 1)', () => {
    expect(getFieldConfidence({ f: { value: 'x', confidence: 0 } }, 'f')).toBe(0);
    expect(getFieldConfidence({ f: { value: 'x', confidence: 1 } }, 'f')).toBe(1);
  });
});

describe('getFieldConfidence — string confidence mappings', () => {
  it("maps 'high' -> 0.95", () => {
    expect(getFieldConfidence({ f: { value: 'x', confidence: 'high' } }, 'f')).toBe(0.95);
  });

  it("maps 'medium' -> 0.80", () => {
    expect(getFieldConfidence({ f: { value: 'x', confidence: 'medium' } }, 'f')).toBe(0.80);
  });

  it("maps 'low' -> 0.60", () => {
    expect(getFieldConfidence({ f: { value: 'x', confidence: 'low' } }, 'f')).toBe(0.60);
  });

  it('returns null for an unrecognized string confidence', () => {
    expect(getFieldConfidence({ f: { value: 'x', confidence: 'maybe' } }, 'f')).toBeNull();
  });
});

describe('getFieldConfidence — null cases', () => {
  it('returns null when the field is missing from the map', () => {
    expect(getFieldConfidence({ tenant_name: { value: 'X', confidence: 0.9 } }, 'landlord_name')).toBeNull();
  });

  it('returns null for an old-format string-valued field (no confidence object)', () => {
    // Old extracted_json format stores a bare string, not { value, confidence }.
    expect(getFieldConfidence({ landlord_name: '123 Main St' }, 'landlord_name')).toBeNull();
  });

  it('returns null when extractedJson is null', () => {
    expect(getFieldConfidence(null, 'landlord_name')).toBeNull();
  });

  it('returns null for an object field that carries no confidence', () => {
    expect(getFieldConfidence({ f: { value: 'x' } }, 'f')).toBeNull();
  });

  it('returns null when the field value is null/undefined', () => {
    expect(getFieldConfidence({ f: null }, 'f')).toBeNull();
    expect(getFieldConfidence({ f: undefined }, 'f')).toBeNull();
  });
});
