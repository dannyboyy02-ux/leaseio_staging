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
