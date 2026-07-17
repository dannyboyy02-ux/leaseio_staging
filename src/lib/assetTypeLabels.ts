// Localized display wrapper for asset-type options.
//
// assetTypes.ts stays i18n-free (it's in TS/Deno/SQL lockstep with the
// canonical matcher — see docs/CANONICAL_ASSET_TYPE_DEPLOY_2026-07-12.md).
// UI code renders option labels through THIS helper: the four built-in
// classes translate via asset_types.builtin.<value>; workspace-custom
// options (whose value is the custom label itself, never a built-in enum)
// miss the catalog and fall through to their stored label untouched.

import { t } from 'i18next';
import type { AssetTypeOption } from '@/lib/assetTypes';

export function localizedAssetTypeLabel(option: AssetTypeOption): string {
  return t(`asset_types.builtin.${option.value}`, { defaultValue: option.label });
}

// Raw DB token → localized compact display name for meta rows ("Real estate ·
// Operations"). The three writer surfaces disagree on the real-estate token
// ('property' / 'real_estate' / a workspace label) — canonicalAssetType folds
// them; workspace-custom values fall through to Title Case untouched.
import { canonicalAssetType, prettyAssetType } from '@/lib/assetTypes';

const CANONICAL_TO_BUILTIN: Record<string, string> = {
  realestate: 'property',
  property: 'property',
  equipment: 'equipment',
  vehicle: 'vehicle',
  other: 'other',
};

export function localizedAssetTypeName(raw: string | null | undefined): string {
  if (!raw) return '';
  const builtin = CANONICAL_TO_BUILTIN[canonicalAssetType(raw)];
  return builtin
    ? t(`asset_types.compact.${builtin}`, { defaultValue: prettyAssetType(raw) })
    : prettyAssetType(raw);
}
