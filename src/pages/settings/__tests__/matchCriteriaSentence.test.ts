import { describe, it, expect } from 'vitest';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { prettyAssetType, canonicalAssetType } from '@/lib/assetTypes';

// Mirror of pure helpers from `src/pages/settings/MatchCriteriaSentence.tsx`.
// The component imports radix UI / lucide-react, so we keep the test
// JSX-runtime-free by re-implementing the data transforms here.
//
// Spec: docs/APPROVAL_POLICY_EDITOR_REDESIGN.md +
//       docs/APPROVAL_POLICY_EDITOR_VISUAL_CONTRACT.md (§3 — sentence pills).
//
// IF YOU CHANGE A HELPER IN MatchCriteriaSentence.tsx, MIRROR IT HERE.

const ASSET_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'property', label: 'Property (Real Estate)' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'other', label: 'Other' },
];

interface MatchCriteriaState {
  match_asset_types: string[];
  match_lease_types: string[];
  match_departments: string[];
  match_regions: string[];
  match_min_annual_cost: string;
  match_max_annual_cost: string;
}

const empty = (): MatchCriteriaState => ({
  match_asset_types: [],
  match_lease_types: [],
  match_departments: [],
  match_regions: [],
  match_min_annual_cost: '',
  match_max_annual_cost: '',
});

// ────── helpers under test (mirrors of MatchCriteriaSentence.tsx) ──────

// Mirrors the migrated component helper, which now delegates to the canonical
// formatLocalizedCurrency (locale 'en' here — the test pins the en-US output).
const fmtMoney = (raw: string): string => {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  return formatLocalizedCurrency(n, 'en');
};

function joinWithOr(values: string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

// Mirror of the component helper. It resolves + dedupes asset values by
// CANONICAL key against the resolved options list (built-ins + workspace Asset
// Types); values outside the list fall back to prettyAssetType, NOT raw.
function leaseTypeLabel(
  state: MatchCriteriaState,
  options: Array<{ value: string; label: string }> = ASSET_TYPE_OPTIONS,
): string {
  const seen = new Set<string>();
  const assetLabels: string[] = [];
  for (const v of state.match_asset_types) {
    const key = canonicalAssetType(v);
    if (seen.has(key)) continue;
    seen.add(key);
    assetLabels.push(
      options.find((o) => canonicalAssetType(o.value) === key)?.label ?? prettyAssetType(v),
    );
  }
  const all = [...assetLabels, ...state.match_lease_types];
  if (all.length === 0) return 'any lease type';
  return joinWithOr(all);
}

function departmentLabel(state: MatchCriteriaState): string {
  if (state.match_departments.length === 0) return 'any department';
  return joinWithOr(state.match_departments);
}

function regionLabel(state: MatchCriteriaState): string {
  if (state.match_regions.length === 0) return 'any region';
  return joinWithOr(state.match_regions);
}

function costLabel(state: MatchCriteriaState): string {
  const min = state.match_min_annual_cost.trim();
  const max = state.match_max_annual_cost.trim();
  if (!min && !max) return 'any annual cost';
  if (min && max) return `${fmtMoney(min)} – ${fmtMoney(max)}`;
  if (min) return `at least ${fmtMoney(min)}`;
  return `at most ${fmtMoney(max)}`;
}

function isLeaseTypeActive(state: MatchCriteriaState): boolean {
  return state.match_asset_types.length > 0 || state.match_lease_types.length > 0;
}
function isDepartmentActive(state: MatchCriteriaState): boolean {
  return state.match_departments.length > 0;
}
function isRegionActive(state: MatchCriteriaState): boolean {
  return state.match_regions.length > 0;
}
function isCostActive(state: MatchCriteriaState): boolean {
  return (
    state.match_min_annual_cost.trim() !== '' ||
    state.match_max_annual_cost.trim() !== ''
  );
}

// ─────────────────────────── tests ───────────────────────────

describe('joinWithOr', () => {
  it('returns empty string for empty list', () => {
    expect(joinWithOr([])).toBe('');
  });
  it('returns single value alone', () => {
    expect(joinWithOr(['Property'])).toBe('Property');
  });
  it('joins two with " or "', () => {
    expect(joinWithOr(['A', 'B'])).toBe('A or B');
  });
  it('uses Oxford ", or " for three', () => {
    expect(joinWithOr(['A', 'B', 'C'])).toBe('A, B, or C');
  });
});

describe('leaseTypeLabel — combined asset+lease pill', () => {
  it('returns "any lease type" when both arrays empty', () => {
    expect(leaseTypeLabel(empty())).toBe('any lease type');
  });
  it('uses friendly asset label, not raw enum, when only asset_type set', () => {
    expect(
      leaseTypeLabel({ ...empty(), match_asset_types: ['property'] }),
    ).toBe('Property (Real Estate)');
  });
  it('returns lease_type verbatim when only that is set', () => {
    expect(
      leaseTypeLabel({ ...empty(), match_lease_types: ['Real Estate'] }),
    ).toBe('Real Estate');
  });
  it('combines asset + lease into one phrase when both set', () => {
    expect(
      leaseTypeLabel({
        ...empty(),
        match_asset_types: ['property'],
        match_lease_types: ['Real Estate'],
      }),
    ).toBe('Property (Real Estate) or Real Estate');
  });
  it('humanizes an unknown asset_type via prettyAssetType (not raw)', () => {
    expect(
      leaseTypeLabel({ ...empty(), match_asset_types: ['unknown'] }),
    ).toBe('Unknown');
  });
  it('resolves a legacy value canonically to the built-in label (not raw Title Case)', () => {
    // 'real_estate' canonicalizes to the built-in 'property' → its label, so
    // the pill matches the checkbox + list chip (vocabulary coherence).
    expect(
      leaseTypeLabel({ ...empty(), match_asset_types: ['real_estate'] }),
    ).toBe('Property (Real Estate)');
  });
  it('dedupes two synonyms of one class to a single label', () => {
    // A malformed legacy rule holding BOTH spellings collapses to one label.
    expect(
      leaseTypeLabel({ ...empty(), match_asset_types: ['real_estate', 'property'] }),
    ).toBe('Property (Real Estate)');
  });
});

describe('departmentLabel / regionLabel', () => {
  it('returns "any department" when empty', () => {
    expect(departmentLabel(empty())).toBe('any department');
  });
  it('uses Oxford comma for 3+ departments', () => {
    expect(
      departmentLabel({
        ...empty(),
        match_departments: ['Ops', 'Sales', 'HR'],
      }),
    ).toBe('Ops, Sales, or HR');
  });
  it('returns "any region" when empty', () => {
    expect(regionLabel(empty())).toBe('any region');
  });
  it('joins two regions with " or "', () => {
    expect(
      regionLabel({ ...empty(), match_regions: ['West', 'East'] }),
    ).toBe('West or East');
  });
});

describe('costLabel', () => {
  it('returns "any annual cost" when both bounds blank', () => {
    expect(costLabel(empty())).toBe('any annual cost');
  });
  it('uses "X – Y" en-dash when both set', () => {
    expect(
      costLabel({
        ...empty(),
        match_min_annual_cost: '50000',
        match_max_annual_cost: '500000',
      }),
    ).toBe('$50,000 – $500,000');
  });
  it('uses "at least X" when only min set', () => {
    expect(
      costLabel({ ...empty(), match_min_annual_cost: '50000' }),
    ).toBe('at least $50,000');
  });
  it('uses "at most Y" when only max set', () => {
    expect(
      costLabel({ ...empty(), match_max_annual_cost: '500000' }),
    ).toBe('at most $500,000');
  });
  it('rounds decimals away from cents', () => {
    expect(
      costLabel({
        ...empty(),
        match_min_annual_cost: '12345.67',
        match_max_annual_cost: '98765.43',
      }),
    ).toBe('$12,346 – $98,765');
  });
  it('falls back gracefully on a non-numeric input', () => {
    expect(
      costLabel({ ...empty(), match_min_annual_cost: 'abc' }),
    ).toBe('at least $abc');
  });
});

describe('isXActive predicates', () => {
  it('lease type active iff either array has items', () => {
    expect(isLeaseTypeActive(empty())).toBe(false);
    expect(
      isLeaseTypeActive({ ...empty(), match_asset_types: ['property'] }),
    ).toBe(true);
    expect(
      isLeaseTypeActive({ ...empty(), match_lease_types: ['Real Estate'] }),
    ).toBe(true);
  });
  it('cost active iff either bound is non-blank', () => {
    expect(isCostActive(empty())).toBe(false);
    expect(
      isCostActive({ ...empty(), match_min_annual_cost: '100' }),
    ).toBe(true);
    expect(
      isCostActive({ ...empty(), match_max_annual_cost: '100' }),
    ).toBe(true);
  });
  it('cost treats whitespace-only as blank', () => {
    expect(
      isCostActive({ ...empty(), match_min_annual_cost: '   ' }),
    ).toBe(false);
  });
  it('department / region predicates flip on non-empty arrays', () => {
    expect(isDepartmentActive(empty())).toBe(false);
    expect(
      isDepartmentActive({ ...empty(), match_departments: ['Ops'] }),
    ).toBe(true);
    expect(isRegionActive(empty())).toBe(false);
    expect(
      isRegionActive({ ...empty(), match_regions: ['West'] }),
    ).toBe(true);
  });
});
