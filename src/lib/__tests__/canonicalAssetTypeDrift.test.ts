import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalAssetType } from '@/lib/assetTypes';

// The load-bearing invariant of the canonical-asset-type change (2026-07-12):
// the approval-rule matcher exists in THREE copies that must fold asset types
// identically, or a lease previewed as matching in the "Try it on a sample
// request" tester won't actually route (or vice versa):
//   1. TS   — src/lib/assetTypes.ts::canonicalAssetType (unit-tested directly)
//   2. Deno — resolve-approval-chain/index.ts::canonicalAssetType (edge matcher)
//   3. SQL  — public.canonical_asset_type (preview_policy_resolution RPC)
// Only (1) had behavioral tests. These STATIC guards assert (2) and (3) still
// implement the same rule — lowercase + strip non-alphanumerics, then fold the
// single synonym 'property' → 'realestate' — so drift fails CI instead of
// silently misrouting. (Static tests catch in-repo drift, not live-DB drift.)

const repoRoot = join(__dirname, '..', '..', '..');

// Narrow to a named block so a `toContain` can't pass on an unrelated match.
function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('canonical asset-type — TS behavior (source of truth for the fold)', () => {
  it('folds only the real-estate synonyms and preserves every other key', () => {
    expect(canonicalAssetType('property')).toBe('realestate');
    expect(canonicalAssetType('real_estate')).toBe('realestate');
    expect(canonicalAssetType('Real Estate')).toBe('realestate');
    expect(canonicalAssetType('equipment')).toBe('equipment');
    expect(canonicalAssetType('properties')).toBe('properties'); // NOT folded
    expect(canonicalAssetType(null)).toBe('');
  });
});

describe('Deno matcher copy stays in lockstep (resolve-approval-chain)', () => {
  const src = readFileSync(
    join(repoRoot, 'supabase', 'functions', 'resolve-approval-chain', 'index.ts'),
    'utf8',
  );
  const fn = sliceBetween(src, 'function canonicalAssetType', '\n}');

  it('strips non-alphanumerics and lowercases', () => {
    expect(fn).toContain('.toLowerCase().replace(/[^a-z0-9]+/g, "")');
  });
  it('folds property → realestate (the only synonym)', () => {
    expect(fn).toContain('=== "property" ? "realestate"');
  });

  it('the edge matcher empty-guards a lease with no asset type', () => {
    // A lease whose asset_type canonicalizes to '' must never satisfy a rule
    // that specifies asset types (mirrors the RPC `<> ''` guard).
    const matcher = sliceBetween(src, 'const leaseAssetCanon', 'match_departments');
    expect(matcher).toContain('leaseAssetCanon === ""');
    expect(matcher).toContain('.map(canonicalAssetType).includes(leaseAssetCanon)');
  });
});

describe('SQL matcher copy stays in lockstep (canonical_asset_type migration)', () => {
  const sql = readFileSync(
    join(repoRoot, 'supabase', 'migrations', '20260712140000_canonical_asset_type_matching.sql'),
    'utf8',
  );

  it('canonical_asset_type strips non-alphanumerics, lowercases, and folds property', () => {
    const fn = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.canonical_asset_type',
      '$function$;',
    );
    expect(fn).toContain("regexp_replace(lower(coalesce(p_value, '')), '[^a-z0-9]+', '', 'g')");
    expect(fn).toContain("= 'property'");
    expect(fn).toContain("THEN 'realestate'");
  });

  it('preview_policy_resolution matches asset_type through the canonical token on BOTH sides', () => {
    const rpc = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.preview_policy_resolution',
      '$function$;',
    );
    expect(rpc).toContain('public.canonical_asset_type(p_asset_type)');
    expect(rpc).toContain('SELECT public.canonical_asset_type(x) FROM unnest(p.match_asset_types)');
    // Empty-guard: a null/blank lease asset never matches an asset-restricted rule.
    expect(rpc).toContain("public.canonical_asset_type(p_asset_type) <> ''");
  });

  it('leaves the other match dimensions on exact/range semantics (only asset_type folds)', () => {
    const rpc = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.preview_policy_resolution',
      '$function$;',
    );
    expect(rpc).toContain('p_department = ANY(p.match_departments)');
    expect(rpc).toContain('p_region = ANY(p.match_regions)');
    expect(rpc).toContain('p_lease_type = ANY(p.match_lease_types)');
  });
});
