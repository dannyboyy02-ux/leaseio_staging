import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HERO_ANNUAL_COST,
  buildHeroSeed,
  matchAssetOption,
  medianValue,
  modalValue,
  roundAnnualCost,
  seedFromLeases,
  seedFromRule,
  shouldReseedFromRule,
  topActiveRule,
  type HeroSeedRule,
} from '@/lib/approvalHeroSeed';
import { buildAssetTypeOptions } from '@/lib/assetTypes';

const OPTIONS = buildAssetTypeOptions();
const DEPTS = ['Warehouse', 'Operations'];

const rule = (over: Partial<HeroSeedRule> = {}): HeroSeedRule => ({
  id: 'r1',
  is_active: true,
  match_asset_types: [],
  match_departments: [],
  match_min_annual_cost: null,
  match_max_annual_cost: null,
  ...over,
});

describe('primitives', () => {
  it('modalValue ignores blanks and prefers the most frequent', () => {
    expect(modalValue(['Warehouse', null, 'Ops', 'Warehouse', '  '])).toBe('Warehouse');
    expect(modalValue([null, ''])).toBeNull();
  });

  it('medianValue skips non-positive and non-finite values', () => {
    expect(medianValue([10, 0, -5, 30, null, NaN])).toBe(20);
    expect(medianValue([])).toBeNull();
  });

  it('roundAnnualCost produces a figure a human would say out loud', () => {
    expect(roundAnnualCost(204_317)).toBe(200_000);
    expect(roundAnnualCost(43_210)).toBe(43_000);
    expect(roundAnnualCost(1_499)).toBe(1_500);
    expect(roundAnnualCost(0)).toBe(0);
  });

  it('matchAssetOption folds canonically so real_estate selects property', () => {
    expect(matchAssetOption('real_estate', OPTIONS)).toBe('property');
    expect(matchAssetOption('Real Estate', OPTIONS)).toBe('property');
    expect(matchAssetOption('', OPTIONS)).toBeNull();
  });
});

describe('seedFromLeases', () => {
  it('takes modal asset type, modal department and the rounded median annual cost', () => {
    const seed = seedFromLeases(
      [
        { asset_type: 'real_estate', requesting_department: 'Warehouse', monthly_payment: 20_000 },
        { asset_type: 'property', requesting_department: 'Warehouse', monthly_payment: 15_000 },
        { asset_type: 'equipment', requesting_department: 'Ops', monthly_payment: 1_000 },
      ],
      OPTIONS,
      DEPTS,
    );
    // 'real_estate' and 'property' are ONE class but distinct raw strings, so
    // the modal raw value wins the tie by recency and still folds to property.
    expect(seed?.assetType).toBe('property');
    expect(seed?.department).toBe('Warehouse');
    // annual: 240k / 180k / 12k → median 180k → rounded to the nearest 10k
    expect(seed?.annualCost).toBe(180_000);
  });

  it('returns null when there is no usable history', () => {
    expect(seedFromLeases([], OPTIONS, DEPTS)).toBeNull();
    expect(
      seedFromLeases(
        [{ asset_type: null, requesting_department: null, monthly_payment: null }],
        OPTIONS,
        DEPTS,
      ),
    ).toBeNull();
  });
});

describe('seedFromRule', () => {
  it('lands on the inclusive lower bound so the seed provably matches', () => {
    const seed = seedFromRule(
      rule({
        match_asset_types: ['equipment'],
        match_departments: ['Operations'],
        match_min_annual_cost: 100_000,
        match_max_annual_cost: 500_000,
      }),
      OPTIONS,
      DEPTS,
    );
    expect(seed).toEqual({
      assetType: 'equipment',
      department: 'Operations',
      annualCost: 100_000,
    });
  });

  it('respects a ceiling-only rule', () => {
    expect(seedFromRule(rule({ match_max_annual_cost: 5_000 }), OPTIONS, DEPTS).annualCost).toBe(
      5_000,
    );
  });
});

describe('buildHeroSeed ladder', () => {
  it('prefers lease history', () => {
    const seed = buildHeroSeed({
      leases: [{ asset_type: 'vehicle', requesting_department: 'Fleet', monthly_payment: 1_000 }],
      rules: [rule()],
      assetTypeOptions: OPTIONS,
      departmentOptions: DEPTS,
    });
    expect(seed.source).toBe('leases');
    expect(seed.inputs.assetType).toBe('vehicle');
  });

  it('falls back to the first rule the engine checks', () => {
    const seed = buildHeroSeed({
      leases: [],
      rules: [rule({ is_active: false, match_asset_types: ['vehicle'] }), rule({ id: 'r2', match_asset_types: ['equipment'] })],
      assetTypeOptions: OPTIONS,
      departmentOptions: DEPTS,
    });
    expect(seed.source).toBe('rule');
    expect(seed.inputs.assetType).toBe('equipment');
  });

  it('falls back to plain defaults with no history and no rules', () => {
    const seed = buildHeroSeed({
      leases: [],
      rules: [],
      assetTypeOptions: OPTIONS,
      departmentOptions: DEPTS,
    });
    expect(seed).toEqual({
      source: 'defaults',
      inputs: {
        assetType: OPTIONS[0].value,
        department: 'Warehouse',
        annualCost: DEFAULT_HERO_ANNUAL_COST,
      },
    });
  });
});

describe('shouldReseedFromRule', () => {
  const base = {
    source: 'leases' as const,
    matched: false,
    untouched: true,
    alreadyReseeded: false,
    rules: [rule()],
  };

  it('re-seeds a lease sample that matched nothing while rules exist', () => {
    expect(shouldReseedFromRule(base)).toBe(true);
  });

  it('never overwrites a request the user has edited', () => {
    expect(shouldReseedFromRule({ ...base, untouched: false })).toBe(false);
  });

  it('only ever fires once', () => {
    expect(shouldReseedFromRule({ ...base, alreadyReseeded: true })).toBe(false);
  });

  it('does nothing when the sample already routes, or when no rule can fire', () => {
    expect(shouldReseedFromRule({ ...base, matched: true })).toBe(false);
    expect(shouldReseedFromRule({ ...base, rules: [rule({ is_active: false })] })).toBe(false);
  });
});

describe('topActiveRule', () => {
  it('takes the first ACTIVE rule in the given (engine) order, never re-sorting', () => {
    const paused = rule({ id: 'a', is_active: false });
    const live = rule({ id: 'b' });
    expect(topActiveRule([paused, live])?.id).toBe('b');
    expect(topActiveRule([])).toBeNull();
  });
});
