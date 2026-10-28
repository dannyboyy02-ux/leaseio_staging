// ─────────────────────────────────────────────────────────────────────────
// The rule row's match sentence — the editor's exact grammar, minus the
// "When someone requests" stem, so the hero, the list and the editor speak
// ONE vocabulary and cannot drift.
//
// Region and lease type are NOT in this sentence. They are retired (D-Q2):
// intake never collects them, so a sentence that stated them would describe a
// filter no real lease request can satisfy. Authored values are preserved and
// reported separately as DEAD criteria, read-only (#209 removed the one-click
// removal — clearing a filter WIDENS what a rule routes, so it is a deliberate
// edit made in the rule editor, behind Save).
//
// Renders through the i18next singleton at call time — any memoized caller
// must include the active language in its cache key.
// ─────────────────────────────────────────────────────────────────────────

import { t } from 'i18next';
import type { AssetTypeOption } from '@/lib/assetTypes';
import type { SupportedLocale } from '@/lib/dateFormatters';
import {
  costLabel,
  departmentLabel,
  leaseTypeLabel,
  type MatchCriteriaState,
} from '@/pages/settings/MatchCriteriaSentence';

/** The live (non-retired) match dimensions a rule row states. */
export interface MatchSentenceInput {
  match_asset_types: string[];
  match_departments: string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
}

/** True when the rule filters on nothing that intake actually sends. */
export function hasLiveMatchCriteria(rule: MatchSentenceInput): boolean {
  return (
    rule.match_asset_types.length > 0 ||
    rule.match_departments.length > 0 ||
    rule.match_min_annual_cost != null ||
    rule.match_max_annual_cost != null
  );
}

/**
 * "Property in Warehouse or Operations for at least $100,000."
 * A rule with no live filters reads as the shipped "Matches all requests".
 */
export function buildMatchSentence(
  rule: MatchSentenceInput,
  language: SupportedLocale,
  assetTypeOptions?: AssetTypeOption[],
): string {
  if (!hasLiveMatchCriteria(rule)) return t('policy_editor.list.matches_all');

  const state: MatchCriteriaState = {
    match_asset_types: rule.match_asset_types,
    match_lease_types: [],
    match_departments: rule.match_departments,
    match_regions: [],
    match_min_annual_cost:
      rule.match_min_annual_cost == null ? '' : String(rule.match_min_annual_cost),
    match_max_annual_cost:
      rule.match_max_annual_cost == null ? '' : String(rule.match_max_annual_cost),
  };

  return [
    leaseTypeLabel(state, assetTypeOptions),
    t('policy_editor.sentence.in_department'),
    departmentLabel(state),
    t('policy_editor.sentence.for_cost'),
    costLabel(state, language),
  ].join(' ');
}
