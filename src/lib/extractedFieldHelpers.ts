/**
 * Helper functions for safely extracting values from lease extracted_json fields.
 * 
 * The extracted_json can contain fields in two formats:
 * 1. Old format: direct string values (e.g., property_address: "123 Main St")
 * 2. New format: object with value property (e.g., property_address: { value: "123 Main St", confidence: 0.95, page: 1, source_text: "..." })
 */

export interface ExtractedFieldObject {
  value: string | number | null;
  confidence?: number | string;
  page?: number;
  source_text?: string;
  span_index?: number;
  bounding_box?: unknown;
}

/**
 * Safely extracts a string value from an extracted field.
 * Handles both old string format and new object format.
 */
export function getExtractedFieldValue(field: unknown): string | null {
  try {
    if (field === null || field === undefined) return null;

    // If it's a string, return directly
    if (typeof field === 'string') {
      return field;
    }

    // If it's a number, convert to string
    if (typeof field === 'number') {
      return String(field);
    }

    // If it's an object with a value property
    if (typeof field === 'object' && 'value' in field) {
      const obj = field as ExtractedFieldObject;
      if (obj.value === null || obj.value === undefined) return null;
      return String(obj.value);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a field's extraction confidence on a 0–1 scale, or null when the
 * field is absent or carries no confidence. String confidences
 * ('low' | 'medium' | 'high') map to representative numeric values.
 *
 * This is the single source of truth for per-field confidence — the field
 * badges, the LeaseReview review-gate, and the NeedsReviewBanner all read
 * it. (Lives here, in a pure module, so presentational components can use it
 * without pulling a component-level supabase import.)
 */
export function getFieldConfidence(
  // Permissive to accept both the typed ExtractedJson and loose maps that
  // call sites pass; matches the helper's prior signature.
  extractedJson: Record<string, any> | null,
  fieldId: string,
): number | null {
  if (!extractedJson) return null;
  const field = extractedJson[fieldId];
  if (!field || typeof field !== 'object') return null;
  const confidence = (field as ExtractedFieldObject).confidence;
  if (typeof confidence === 'number') return confidence;
  if (confidence === 'high') return 0.95;
  if (confidence === 'medium') return 0.80;
  if (confidence === 'low') return 0.60;
  return null;
}

/**
 * Bands a 0–1 confidence into the shared tiers used by BOTH the per-field
 * ConfidenceBadge and the NeedsReviewBanner, so their visual severity can't
 * drift apart. Thresholds: high ≥ 0.90, medium ≥ 0.70, else low.
 */
export function confidenceTier(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.90) return 'high';
  if (confidence >= 0.70) return 'medium';
  return 'low';
}

/**
 * Safely extracts the property_address from lease extracted_json.
 */
export function getPropertyAddress(extractedJson: Record<string, unknown> | null): string | null {
  if (!extractedJson) return null;
  return getExtractedFieldValue(extractedJson.property_address);
}

/**
 * Gets a display value for a property, falling back to filename if address not available.
 */
export function getPropertyDisplayName(
  extractedJson: Record<string, unknown> | null, 
  filename: string | null,
  fallback: string = 'Unknown Property'
): string {
  const address = getPropertyAddress(extractedJson);
  return address || filename || fallback;
}
