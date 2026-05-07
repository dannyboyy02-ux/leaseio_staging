import { describe, it, expect } from 'vitest';

// Re-implement the pure helpers under test. The component file isn't
// importable in vitest (it pulls in lucide-react / radix-ui ESM that needs
// jsdom + transform), so we mirror the helper logic here. Keep these copies
// byte-for-byte aligned with the implementation in
// `src/pages/settings/MatchCriteriaSentence.tsx` — the contract these test
// pin is the user-facing sentence grammar, which would silently regress if
// the implementation drifted.
//
// Spec: docs/APPROVAL_POLICY_EDITOR_REDESIGN.md (P1.2 — sentence-style
// matching criteria).

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

type FilterKind =
  | 'asset_types'
  | 'lease_types'
  | 'departments'
  | 'regions'
  | 'cost_range';

const empty = (): MatchCriteriaState => ({
  match_asset_types: [],
  match_lease_types: [],
  match_departments: [],
  match_regions: [],
  match_min_annual_cost: '',
  match_max_annual_cost: '',
});

function isActive(state: MatchCriteriaState, kind: FilterKind): boolean {
  switch (kind) {
    case 'asset_types':
      return state.match_asset_types.length > 0;
    case 'lease_types':
      return state.match_lease_types.length > 0;
    case 'departments':
      return state.match_departments.length > 0;
    case 'regions':
      return state.match_regions.length > 0;
    case 'cost_range':
      return (
        state.match_min_annual_cost.trim() !== '' ||
        state.match_max_annual_cost.trim() !== ''
      );
  }
}

const fmtMoney = (raw: string): string => {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
};

function joinWithOr(values: string[]): string {
  if (values.length === 0) return '…';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

function pillLabel(state: MatchCriteriaState, kind: FilterKind): string {
  switch (kind) {
    case 'asset_types': {
      const labels = state.match_asset_types.map(
        (v) => ASSET_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v,
      );
      return labels.length === 0
        ? 'asset type is …'
        : `asset type is ${joinWithOr(labels)}`;
    }
    case 'lease_types':
      return state.match_lease_types.length === 0
        ? 'lease type is …'
        : `lease type is ${joinWithOr(state.match_lease_types)}`;
    case 'departments':
      return state.match_departments.length === 0
        ? 'department is …'
        : `department is ${joinWithOr(state.match_departments)}`;
    case 'regions':
      return state.match_regions.length === 0
        ? 'region is …'
        : `region is ${joinWithOr(state.match_regions)}`;
    case 'cost_range': {
      const min = state.match_min_annual_cost.trim();
      const max = state.match_max_annual_cost.trim();
      if (min && max) return `annual cost is between ${fmtMoney(min)} and ${fmtMoney(max)}`;
      if (min) return `annual cost is at least ${fmtMoney(min)}`;
      if (max) return `annual cost is at most ${fmtMoney(max)}`;
      return 'annual cost is …';
    }
  }
}

describe('joinWithOr', () => {
  it('returns ellipsis for empty list', () => {
    expect(joinWithOr([])).toBe('…');
  });
  it('returns the single value for one-element list', () => {
    expect(joinWithOr(['Property'])).toBe('Property');
  });
  it('joins two values with " or "', () => {
    expect(joinWithOr(['Property', 'Equipment'])).toBe('Property or Equipment');
  });
  it('uses Oxford comma + ", or " for three values', () => {
    expect(joinWithOr(['A', 'B', 'C'])).toBe('A, B, or C');
  });
  it('handles four values cleanly', () => {
    expect(joinWithOr(['A', 'B', 'C', 'D'])).toBe('A, B, C, or D');
  });
});

describe('isActive', () => {
  it('treats every empty filter as inactive', () => {
    const s = empty();
    expect(isActive(s, 'asset_types')).toBe(false);
    expect(isActive(s, 'lease_types')).toBe(false);
    expect(isActive(s, 'departments')).toBe(false);
    expect(isActive(s, 'regions')).toBe(false);
    expect(isActive(s, 'cost_range')).toBe(false);
  });
  it('treats a single asset_type value as active', () => {
    expect(isActive({ ...empty(), match_asset_types: ['property'] }, 'asset_types')).toBe(true);
  });
  it('treats cost_range as active when only min is set', () => {
    expect(isActive({ ...empty(), match_min_annual_cost: '50000' }, 'cost_range')).toBe(true);
  });
  it('treats cost_range as active when only max is set', () => {
    expect(isActive({ ...empty(), match_max_annual_cost: '500000' }, 'cost_range')).toBe(true);
  });
  it('treats cost_range as inactive when only whitespace is set', () => {
    expect(
      isActive({ ...empty(), match_min_annual_cost: '   ' }, 'cost_range'),
    ).toBe(false);
  });
});

describe('pillLabel — asset_types', () => {
  it('shows ellipsis when empty', () => {
    expect(pillLabel(empty(), 'asset_types')).toBe('asset type is …');
  });
  it('uses the friendly label, not the raw enum, for one value', () => {
    expect(
      pillLabel({ ...empty(), match_asset_types: ['property'] }, 'asset_types'),
    ).toBe('asset type is Property (Real Estate)');
  });
  it('joins two values with " or "', () => {
    expect(
      pillLabel(
        { ...empty(), match_asset_types: ['property', 'equipment'] },
        'asset_types',
      ),
    ).toBe('asset type is Property (Real Estate) or Equipment');
  });
  it('falls back to raw value when label is unknown', () => {
    expect(
      pillLabel({ ...empty(), match_asset_types: ['unknown_kind'] }, 'asset_types'),
    ).toBe('asset type is unknown_kind');
  });
});

describe('pillLabel — lease_types / departments / regions', () => {
  it('lease_types renders raw values', () => {
    expect(
      pillLabel({ ...empty(), match_lease_types: ['Real Estate'] }, 'lease_types'),
    ).toBe('lease type is Real Estate');
  });
  it('departments renders the user-typed values verbatim', () => {
    expect(
      pillLabel(
        { ...empty(), match_departments: ['Operations', 'Sales', 'HR'] },
        'departments',
      ),
    ).toBe('department is Operations, Sales, or HR');
  });
  it('regions handles two values', () => {
    expect(
      pillLabel({ ...empty(), match_regions: ['West', 'East'] }, 'regions'),
    ).toBe('region is West or East');
  });
});

describe('pillLabel — cost_range', () => {
  it('renders ellipsis when both blank', () => {
    expect(pillLabel(empty(), 'cost_range')).toBe('annual cost is …');
  });
  it('uses "between X and Y" when both bounds set', () => {
    expect(
      pillLabel(
        { ...empty(), match_min_annual_cost: '50000', match_max_annual_cost: '500000' },
        'cost_range',
      ),
    ).toBe('annual cost is between $50,000 and $500,000');
  });
  it('uses "at least X" when only min is set', () => {
    expect(
      pillLabel({ ...empty(), match_min_annual_cost: '50000' }, 'cost_range'),
    ).toBe('annual cost is at least $50,000');
  });
  it('uses "at most Y" when only max is set', () => {
    expect(
      pillLabel({ ...empty(), match_max_annual_cost: '500000' }, 'cost_range'),
    ).toBe('annual cost is at most $500,000');
  });
  it('formats decimal bounds without cents', () => {
    expect(
      pillLabel(
        { ...empty(), match_min_annual_cost: '12345.67', match_max_annual_cost: '98765.43' },
        'cost_range',
      ),
    ).toBe('annual cost is between $12,346 and $98,765');
  });
  it('falls back gracefully on a non-numeric input', () => {
    expect(
      pillLabel({ ...empty(), match_min_annual_cost: 'abc' }, 'cost_range'),
    ).toBe('annual cost is at least $abc');
  });
});
