import { describe, it, expect } from 'vitest';
import { getFieldConfidence, confidenceTier } from '../extractedFieldHelpers';
import { LOW_CONFIDENCE_THRESHOLD } from '@/types/workflow';

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

// confidenceTier is the single banding used by the ConfidenceBadge, the field
// BORDER (getFieldBorderClass derives from it), and the NeedsReviewBanner, so
// their visual severity (red/amber/green) can't drift. #177a aligned the low
// boundary with the review-flag cutoff (LOW_CONFIDENCE_THRESHOLD = 80).
describe('confidenceTier — shared severity bands', () => {
  it('bands high (>= 0.90)', () => {
    expect(confidenceTier(0.90)).toBe('high');
    expect(confidenceTier(0.95)).toBe('high');
    expect(confidenceTier(1)).toBe('high');
  });

  it('bands medium (0.80 <= x < 0.90)', () => {
    expect(confidenceTier(0.80)).toBe('medium');
    expect(confidenceTier(0.85)).toBe('medium');
    expect(confidenceTier(0.899)).toBe('medium');
  });

  it('bands low (< 0.80)', () => {
    expect(confidenceTier(0.79)).toBe('low');
    expect(confidenceTier(0.70)).toBe('low');
    expect(confidenceTier(0.699)).toBe('low');
    expect(confidenceTier(0.55)).toBe('low');
    expect(confidenceTier(0)).toBe('low');
  });

  it('tier-low boundary equals the review-flag cutoff (red = flagged, exactly)', () => {
    // LeaseReview flags fields with conf < LOW_CONFIDENCE_THRESHOLD / 100.
    // The tier bands must agree: at the cutoff → medium (not flagged),
    // just below → low (flagged). Pinned here instead of importing the
    // constant into extractedFieldHelpers (kept self-contained).
    expect(confidenceTier(LOW_CONFIDENCE_THRESHOLD / 100)).toBe('medium');
    expect(confidenceTier(LOW_CONFIDENCE_THRESHOLD / 100 - 0.001)).toBe('low');
  });
});
