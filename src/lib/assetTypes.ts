/**
 * Asset-type presentation helpers.
 *
 * Two vocabularies exist in the app and must be reconciled here:
 *  - `leases.asset_type` is canonical snake_case from the AI classifier:
 *    'real_estate' | 'equipment' | 'vehicle' | 'other' (process_lease).
 *  - `workspaces.asset_type_config` is a free-text Title-Case label list the
 *    workspace configures (default ["Real Estate","Equipment","Vehicle","Other"]).
 *
 * `normalizeAssetKey` collapses both forms to a comparable key so an
 * abbreviation configured against a label ("Real Estate") still matches a
 * lease stored as 'real_estate'.
 */

/** Lowercase, strip every non-alphanumeric → a stable comparison key. */
export function normalizeAssetKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** snake_case / free-text → "Title Case" (matches ApprovalQueue / LeaseAudit). */
export function prettyAssetType(value: string | null | undefined): string {
  return value ? value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

/**
 * Built-in shorthands for the common types, keyed by {@link normalizeAssetKey}.
 * Workspace-configured abbreviations (Phase 2b) override these; if neither
 * exists, {@link assetAbbreviation} derives one from the label.
 */
export const DEFAULT_ASSET_ABBR: Record<string, string> = {
  realestate: 'RE',
  equipment: 'EQP',
  vehicle: 'VEH',
  customer: 'CX',
  other: 'OTH',
};

/**
 * Resolve a tight display abbreviation for a lease's asset type.
 * Precedence: workspace override → built-in default → derived from the label.
 *
 * @param assetType  the lease's stored asset_type (snake_case or a label)
 * @param overrides  workspace map keyed by the configured label, e.g.
 *                   { "Real Estate": "RE", "Customer": "CX" } (label-keyed;
 *                   matched by normalized key so snake_case leases still hit)
 */
export function assetAbbreviation(
  assetType: string | null | undefined,
  overrides: Record<string, string> = {},
): string {
  if (!assetType) return '';
  const key = normalizeAssetKey(assetType);

  for (const [label, abbr] of Object.entries(overrides)) {
    if (abbr && normalizeAssetKey(label) === key) return abbr;
  }
  if (DEFAULT_ASSET_ABBR[key]) return DEFAULT_ASSET_ABBR[key];

  // Derive: multi-word → initials; single word → first 3 letters.
  const label = prettyAssetType(assetType);
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  return label.slice(0, 3).toUpperCase();
}
