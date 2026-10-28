// ─────────────────────────────────────────────────────────────────────────
// approvalHeroSeed — how the "answer strip" decides what request to answer
// BEFORE the user has typed anything.
//
// WHY THIS IS A SEPARATE PURE MODULE
// The hero's whole promise is "it answers before you touch it". That promise
// is only as good as the sample request it opens on, and picking that sample
// is real logic with a documented fallback ladder (listScreenSpec §2). Keeping
// it out of the component makes the ladder unit-testable and keeps the
// component under its size budget.
//
// PURITY CONTRACT: no React, no Supabase, no i18next, no Date.now(). The only
// import is the canonical asset-type matcher, so the seed folds asset types
// exactly the way the engine and preview_policy_resolution do.
// ─────────────────────────────────────────────────────────────────────────

import { canonicalAssetType, type AssetTypeOption } from '@/lib/assetTypes';

/** One historical lease, reduced to the three dimensions intake collects. */
export interface HeroLeaseSample {
  asset_type: string | null;
  requesting_department: string | null;
  /** leases.monthly_payment — annualized as ×12, exactly like the engine. */
  monthly_payment: number | null;
}

/** The match box of one rule. Only the dimensions intake can produce; region
 *  and lease_type are RETIRED (D-Q2) and deliberately absent — seeding from
 *  them would open the hero on a what-if a real request can never be. */
export interface HeroSeedRule {
  id: string;
  is_active: boolean;
  match_asset_types: readonly string[];
  match_departments: readonly string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
}

/** Exactly the three inputs the strip sends to preview_policy_resolution. */
export interface HeroInputs {
  assetType: string;
  department: string;
  annualCost: number;
}

export type HeroSeedSource = 'leases' | 'rule' | 'defaults';

export interface HeroSeed {
  inputs: HeroInputs;
  /** Which rung of the ladder produced it — the caption tells the user. */
  source: HeroSeedSource;
}

/** Fallback amount when there is neither lease history nor a costed rule. */
export const DEFAULT_HERO_ANNUAL_COST = 100_000;

// ── primitives ───────────────────────────────────────────────────────────

/** Most frequent non-blank value; ties break toward the earliest seen (the
 *  caller passes leases newest-first, so the most recent of a tie wins). */
export function modalValue(values: readonly (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  values.forEach((raw, index) => {
    const v = (raw ?? '').trim();
    if (!v) return;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (!firstSeen.has(v)) firstSeen.set(v, index);
  });
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    } else if (count === bestCount && best !== null) {
      if ((firstSeen.get(value) ?? 0) < (firstSeen.get(best) ?? 0)) best = value;
    }
  }
  return best;
}

/** Median of the finite positive values, or null when there are none. */
export function medianValue(values: readonly (number | null | undefined)[]): number | null {
  const nums = values
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Round an annual figure to something a human would say out loud. The hero is
 * a what-if, not a report: "$204,317" reads like a real lease's number and
 * invites the user to trust it as one.
 */
export function roundAnnualCost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step = value >= 100_000 ? 10_000 : value >= 10_000 ? 1_000 : value >= 1_000 ? 100 : 50;
  return Math.max(step, Math.round(value / step) * step);
}

/** Map a stored asset value onto one of the workspace's option values, folding
 *  canonically so a rule authored as 'real_estate' selects the 'property'
 *  option instead of falling through to a blank select. */
export function matchAssetOption(
  value: string | null | undefined,
  options: readonly AssetTypeOption[],
): string | null {
  const key = canonicalAssetType(value ?? '');
  if (!key) return null;
  const hit = options.find((o) => canonicalAssetType(o.value) === key);
  return hit ? hit.value : null;
}

// ── the ladder ───────────────────────────────────────────────────────────

/** Rung 1 — the workspace's own recent leases. Returns null when the history
 *  yields nothing usable on any axis. */
export function seedFromLeases(
  leases: readonly HeroLeaseSample[],
  options: readonly AssetTypeOption[],
  departmentOptions: readonly string[],
): HeroInputs | null {
  if (leases.length === 0) return null;
  const assetType = matchAssetOption(modalValue(leases.map((l) => l.asset_type)), options);
  const department = modalValue(leases.map((l) => l.requesting_department));
  const median = medianValue(
    leases.map((l) => (typeof l.monthly_payment === 'number' ? l.monthly_payment * 12 : null)),
  );
  if (!assetType && !department && median == null) return null;
  return {
    assetType: assetType ?? options[0]?.value ?? '',
    department: department ?? departmentOptions[0] ?? '',
    annualCost: median != null ? roundAnnualCost(median) : DEFAULT_HERO_ANNUAL_COST,
  };
}

/** Rung 2 — the first rule the engine would check, described as a request it
 *  would actually match. Cost lands on the inclusive lower bound (or the upper
 *  bound when only a ceiling is set), so the seed provably matches the rule. */
export function seedFromRule(
  rule: HeroSeedRule,
  options: readonly AssetTypeOption[],
  departmentOptions: readonly string[],
): HeroInputs {
  const assetType =
    matchAssetOption(rule.match_asset_types[0], options) ?? options[0]?.value ?? '';
  const department = rule.match_departments[0] ?? departmentOptions[0] ?? '';
  const min = rule.match_min_annual_cost;
  const max = rule.match_max_annual_cost;
  let annualCost: number;
  if (min != null) annualCost = min;
  else if (max != null) annualCost = Math.min(DEFAULT_HERO_ANNUAL_COST, max);
  else annualCost = DEFAULT_HERO_ANNUAL_COST;
  return { assetType, department, annualCost };
}

/** The first rule the engine checks. `rules` MUST already be in engine order
 *  (priority DESC, created_at ASC, id ASC) — this does not re-sort, because a
 *  second source of evaluation order is exactly the bug the redesign removes. */
export function topActiveRule(rules: readonly HeroSeedRule[]): HeroSeedRule | null {
  return rules.find((r) => r.is_active) ?? null;
}

/**
 * Build the opening sample request.
 *
 * Ladder (listScreenSpec §2): recent leases → top active rule's own criteria →
 * first asset option / first department / $100,000. Rung (i) of the spec — a
 * lease-derived seed that resolves to NO match while rules exist — cannot be
 * decided here (it needs the resolver's answer); see {@link shouldReseedFromRule},
 * which the component calls once the first resolution lands.
 */
export function buildHeroSeed(input: {
  leases: readonly HeroLeaseSample[];
  rules: readonly HeroSeedRule[];
  assetTypeOptions: readonly AssetTypeOption[];
  departmentOptions: readonly string[];
}): HeroSeed {
  const fromLeases = seedFromLeases(input.leases, input.assetTypeOptions, input.departmentOptions);
  if (fromLeases) return { inputs: fromLeases, source: 'leases' };

  const top = topActiveRule(input.rules);
  if (top) {
    return {
      inputs: seedFromRule(top, input.assetTypeOptions, input.departmentOptions),
      source: 'rule',
    };
  }

  return {
    inputs: {
      assetType: input.assetTypeOptions[0]?.value ?? '',
      department: input.departmentOptions[0] ?? '',
      annualCost: DEFAULT_HERO_ANNUAL_COST,
    },
    source: 'defaults',
  };
}

/**
 * Rung (i): the lease-derived seed matched nothing while active rules exist.
 * Opening on that reads as breakage ("none of my rules work") when the truth is
 * only "this particular sample isn't covered". Re-seed ONCE, from the top rule,
 * so the first thing the admin sees is a working route.
 *
 * Guarded on `untouched` — once the user edits an input, their request is the
 * subject and we never overwrite it.
 */
export function shouldReseedFromRule(state: {
  source: HeroSeedSource;
  matched: boolean;
  untouched: boolean;
  alreadyReseeded: boolean;
  rules: readonly HeroSeedRule[];
}): boolean {
  if (state.alreadyReseeded || !state.untouched) return false;
  if (state.source !== 'leases' || state.matched) return false;
  return topActiveRule(state.rules) !== null;
}
