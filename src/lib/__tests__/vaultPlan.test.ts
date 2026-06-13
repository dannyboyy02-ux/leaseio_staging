import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANS,
  PLAN_ORDER,
  getPlanIndex,
  isUpgrade,
  normalizePlanId,
} from '../../config/pricing';

// ============================================================================
// Vault retention tier — V2 plan plumbing (VAULT_TIER_SPEC.md;
// PRODUCT_STRATEGY.md Decision 5; commits 59481c6 + 56db50f).
//
// Vault is the $249/yr owner-only read-only offramp. Its plan-config entry is
// load-bearing in three ways this file pins:
//   1. Invariants — zero AI spend, zero intake, never on a pricing surface.
//      A future PLANS edit that gives Vault an abstraction allowance or adds
//      it to PLAN_ORDER would silently re-open paid surfaces for a $249/yr
//      retention plan.
//   2. Webhook recognition — stripe-webhook must classify Vault subs (via
//      metadata plan_id OR STRIPE_PRICE_VAULT_ANNUAL) and must NOT clobber
//      document_limit when entitling Vault (DOCUMENT_LIMITS has no vault key;
//      writing DOCUMENT_LIMITS['vault'] would null the column and destroy the
//      workspace's shape for reactivation).
//   3. Mirror parity — WORKSPACE_LIMITS (Deno) and the duplicate
//      SubscriptionPlan union in src/types/index.ts must agree with
//      pricing.ts (commit 56db50f exists because the duplicate union drifted
//      once already).
//
// Static-source assertions use narrowed windows per the CLAUDE.md rule.
// ============================================================================

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Slice src from `start` up to (not including) `end`; asserts both anchors exist. */
function window(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from);
  expect(to, `end anchor not found after start: ${end}`).toBeGreaterThan(from);
  return src.slice(from, to);
}

// ---------------------------------------------------------------------------
// 1. normalizePlanId — 'vault' is canonical; legacy ids still coerce to starter
// ---------------------------------------------------------------------------

describe('normalizePlanId recognizes vault without disturbing legacy coercion', () => {
  it("'vault' -> 'vault'", () => {
    expect(normalizePlanId('vault')).toBe('vault');
  });

  it("'business' -> 'business'", () => {
    expect(normalizePlanId('business')).toBe('business');
  });

  it("legacy 'free'/'pro', null, undefined, and unknown all -> 'starter'", () => {
    expect(normalizePlanId('free')).toBe('starter');
    expect(normalizePlanId('pro')).toBe('starter');
    expect(normalizePlanId(null)).toBe('starter');
    expect(normalizePlanId(undefined)).toBe('starter');
    expect(normalizePlanId('enterprise')).toBe('starter');
    expect(normalizePlanId('')).toBe('starter');
    // Case-sensitive contract: the DB stores lowercase; anything else is unknown.
    expect(normalizePlanId('Vault')).toBe('starter');
  });
});

// ---------------------------------------------------------------------------
// 2. PLANS.vault invariants (VAULT_TIER_SPEC.md)
// ---------------------------------------------------------------------------

describe('PLANS.vault invariants', () => {
  const vault = PLANS.vault;

  it('is the $249/year plan with no monthly price (yearlyOnly)', () => {
    expect(vault.price.annual).toBe(249);
    // yearlyOnly contract: monthly is 0 and must never be rendered.
    expect(vault.price.monthly).toBe(0);
    expect(vault.yearlyOnly).toBe(true);
  });

  it('is owner-only and read-only', () => {
    expect(vault.ownerOnly).toBe(true);
    expect(vault.readOnly).toBe(true);
    expect(vault.maxUsers).toBe(1);
    expect(vault.hasTeamAccess).toBe(false);
  });

  it('zero-AI-spend invariant: no assistant, no abstractions, no overage', () => {
    expect(vault.hasAiAssistant).toBe(false);
    expect(vault.abstractionsIncluded).toBe(0);
    expect(vault.overagePerDoc).toBe(0);
  });

  it('zero-intake / zero-growth invariant: no active leases, no new workspaces', () => {
    expect(vault.maxActiveLeases).toBe(0);
    expect(vault.maxArchivedLeases).toBe(0);
    expect(vault.maxWorkspaces).toBe(0);
    expect(vault.hasBulkUpload).toBe(false);
  });

  it('id is self-consistent and the plan is never marked popular', () => {
    expect(vault.id).toBe('vault');
    expect(vault.popular).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. PLAN_ORDER exclusion — Vault never appears on pricing/upgrade surfaces
// ---------------------------------------------------------------------------

describe('Vault is excluded from pricing surfaces (PLAN_ORDER)', () => {
  it('PLAN_ORDER does not contain vault', () => {
    expect(PLAN_ORDER).not.toContain('vault');
    // And pins the full surface order so an accidental append fails loudly.
    expect(PLAN_ORDER).toEqual(['starter', 'business']);
  });

  it('getPlanIndex(vault) is -1, so every real plan is an "upgrade" from Vault', () => {
    expect(getPlanIndex('vault')).toBe(-1);
    // Offramp semantics: moving from Vault back to any paid plan is an upgrade
    // (reactivation), and nothing is ever an upgrade TO vault.
    expect(isUpgrade('vault', 'starter')).toBe(true);
    expect(isUpgrade('vault', 'business')).toBe(true);
    expect(isUpgrade('starter', 'vault')).toBe(false);
    expect(isUpgrade('business', 'vault')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. stripe-webhook static-source — Vault recognition + document_limit carve-out
// ---------------------------------------------------------------------------

describe('stripe-webhook Vault plumbing (static source)', () => {
  const WEBHOOK = 'supabase/functions/stripe-webhook/index.ts';
  const src = read(WEBHOOK);

  it('validPlan accepts vault alongside starter/business', () => {
    const fn = window(src, 'function validPlan', 'const VAULT_PRICE_ID');
    expect(fn).toContain('plan === "starter"');
    expect(fn).toContain('plan === "business"');
    expect(fn).toContain('plan === "vault"');
  });

  it('VAULT_PRICE_ID is read from STRIPE_PRICE_VAULT_ANNUAL (env, not hardcoded)', () => {
    const decl = window(src, 'const VAULT_PRICE_ID', 'function resolvePlan');
    expect(decl).toContain('Deno.env.get("STRIPE_PRICE_VAULT_ANNUAL")');
  });

  it('resolvePlan detects Vault by price id, guarded so an unset env can never match', () => {
    const fn = window(src, 'function resolvePlan', 'function resolveInterval');
    // The metadata path (plan_id='vault') flows through validPlan above; the
    // price-id path must be guarded on VAULT_PRICE_ID being set, or
    // `undefined === undefined` style bugs could classify arbitrary subs.
    expect(fn).toContain('if (validPlan(metadataPlan)) return metadataPlan;');
    expect(fn).toContain('if (VAULT_PRICE_ID && priceId === VAULT_PRICE_ID) return "vault";');
  });

  it('DOCUMENT_LIMITS deliberately has NO vault key', () => {
    const block = window(src, 'const DOCUMENT_LIMITS', '};');
    expect(block).toContain('starter:');
    expect(block).toContain('business:');
    // If someone "helpfully" adds vault here, the carve-out below stops making
    // sense and a later refactor could write that value into document_limit.
    expect(block).not.toMatch(/vault/i);
  });

  it('applySubscription omits document_limit for vault but writes it for real plans', () => {
    // Same window end-anchor as documentPacks.test.ts: stop before the
    // applyDocumentPack preamble so we only see the plan path's update.
    const fn = window(
      src,
      'async function applySubscription',
      "// Recompute a workspace's total document-pack capacity",
    );
    expect(fn).toContain('plan: effectivePlan');
    // Undefined-guarded write: vault (no DOCUMENT_LIMITS entry) contributes
    // {}; every plan WITH an entry writes it. Guarding on undefined rather
    // than the 'vault' literal keeps a future keyless plan from nulling the
    // column (security review 2026-06-13).
    expect(fn).toContain('const newDocumentLimit = DOCUMENT_LIMITS[effectivePlan];');
    expect(fn).toContain('...(newDocumentLimit !== undefined');
    expect(fn).toContain('? { document_limit: newDocumentLimit }');
  });
});

// ---------------------------------------------------------------------------
// 5. Mirror / duplicate-declaration parity
// ---------------------------------------------------------------------------

describe('Vault parity across mirrors', () => {
  it('WORKSPACE_LIMITS.vault (Deno mirror) is 0 and matches PLANS.vault.maxWorkspaces', () => {
    const mirror = read('supabase/functions/_shared/workspace_limits.ts');
    const block = window(mirror, 'WORKSPACE_LIMITS', '};');
    const m = block.match(/vault:\s*(\d+)\b/);
    expect(m, 'WORKSPACE_LIMITS must declare a vault entry').not.toBeNull();
    expect(Number(m![1])).toBe(0);
    expect(Number(m![1])).toBe(PLANS.vault.maxWorkspaces);
  });

  it('src/types/index.ts re-exports SubscriptionPlan from pricing (no duplicate union — regression: 56db50f)', () => {
    const types = read('src/types/index.ts');
    // The literal-union duplicate drifted and broke the build once; the fix
    // is a single source of truth re-exported. Pin the re-export AND the
    // absence of a redeclared literal union.
    expect(types).toContain("import type { SubscriptionPlan } from '@/config/pricing';");
    expect(types).toContain('export type { SubscriptionPlan };');
    expect(types).not.toMatch(/export type SubscriptionPlan =/);
  });

  it('vault nameKey/descriptionKey/featureKeys resolve in BOTH locales', () => {
    type LocaleTree = { [k: string]: string | LocaleTree };
    const en = JSON.parse(read('src/locales/en/common.json')) as LocaleTree;
    const es = JSON.parse(read('src/locales/es/common.json')) as LocaleTree;
    const lookup = (tree: LocaleTree, key: string): unknown =>
      key.split('.').reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as LocaleTree)[part] : undefined,
        tree,
      );
    const keys = [
      PLANS.vault.nameKey,
      PLANS.vault.descriptionKey,
      ...PLANS.vault.featureKeys,
    ];
    for (const key of keys) {
      expect(typeof lookup(en, key), `en missing ${key}`).toBe('string');
      expect(typeof lookup(es, key), `es missing ${key}`).toBe('string');
    }
  });
});
