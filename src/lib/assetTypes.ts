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
 * Canonical asset-type token for EQUALITY across intake paths.
 *
 * `leases.asset_type` is written by three surfaces that disagree on the
 * real-estate value: the Path-1 request form writes 'property', the AI
 * classifier writes 'real_estate', and the LeaseReview dropdown writes the
 * configured label ("Real Estate"). They are one asset class. Approval rules
 * store one of these forms in `match_asset_types` and the matcher compared it
 * to the lease's value with an EXACT string match — so a rule built as
 * 'property' silently failed to route an AI-classified 'real_estate' lease.
 *
 * Canonicalize both sides before comparing. `normalizeAssetKey` already folds
 * 'real_estate'/'Real Estate' → 'realestate'; the only remaining synonym is
 * 'property', mapped here. Every other type (equipment/vehicle/other and any
 * workspace-custom label) canonicalizes to its own normalized key, so exact
 * per-workspace matching is preserved.
 *
 * MUST stay in lockstep with the SQL `public.canonical_asset_type(text)`
 * (migration 20260712140000) and the Deno copy in resolve-approval-chain.
 */
export function canonicalAssetType(value: string | null | undefined): string {
  const key = normalizeAssetKey(value);
  return key === 'property' ? 'realestate' : key;
}

export interface AssetTypeOption {
  /** Stored in approval_policies.match_asset_types / a sample-request asset_type. */
  value: string;
  /** Human label for the checkbox / select. */
  label: string;
}

/** The standard asset classes every workspace has (values match what the
 *  Path-1 request form + AI classifier store, via {@link canonicalAssetType}). */
const BUILTIN_ASSET_OPTIONS: AssetTypeOption[] = [
  { value: 'property', label: 'Property (Real Estate)' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'other', label: 'Other' },
];

/**
 * Asset-type options for the approval-rule builder + sample-request tester.
 * Built-ins first, then any workspace-configured Asset Type
 * (`workspaces.asset_type_config`) whose canonical key isn't already a built-in
 * — so a custom class (e.g. "Warehouse") becomes selectable while "Real Estate"
 * doesn't duplicate the built-in Property. Single source for the (previously
 * four) drifting hardcoded lists. The matcher canonicalizes both sides, so a
 * custom label stored verbatim by LeaseReview still routes.
 */
export function buildAssetTypeOptions(
  configuredLabels?: readonly string[] | null,
): AssetTypeOption[] {
  const opts: AssetTypeOption[] = [...BUILTIN_ASSET_OPTIONS];
  const seen = new Set(opts.map((o) => canonicalAssetType(o.value)));
  for (const label of configuredLabels ?? []) {
    const key = canonicalAssetType(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    opts.push({ value: label, label: prettyAssetType(label) });
  }
  return opts;
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
