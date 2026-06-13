import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANS,
  PLAN_ORDER,
  getPlanIndex,
  isReadOnlyRetention,
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
// 1b. isReadOnlyRetention — the single predicate gating read-only behaviour
//     (Vault V3). It is plan-driven via PLANS[plan].readOnly, so it stays in
//     lockstep with the PLANS.vault.readOnly invariant above and never needs a
//     hardcoded 'vault' literal at call sites.
// ---------------------------------------------------------------------------

describe('isReadOnlyRetention', () => {
  it("returns true for 'vault'", () => {
    expect(isReadOnlyRetention('vault')).toBe(true);
  });

  it("returns false for the paid plans 'starter' and 'business'", () => {
    expect(isReadOnlyRetention('starter')).toBe(false);
    expect(isReadOnlyRetention('business')).toBe(false);
  });

  it('returns false for null and undefined (no plan = not read-only)', () => {
    expect(isReadOnlyRetention(null)).toBe(false);
    expect(isReadOnlyRetention(undefined)).toBe(false);
  });

  it('is derived from PLANS[plan].readOnly, not a hardcoded literal', () => {
    // Pins the data path: the predicate is true exactly for plans whose config
    // marks them readOnly. A future read-only plan would be covered for free;
    // dropping readOnly from vault would (correctly) flip this to false.
    expect(isReadOnlyRetention('vault')).toBe(PLANS.vault.readOnly === true);
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

// ===========================================================================
// Vault V3 — conversion flows (commits 5d5c345 + c050052).
// Static-source assertions on the checkout edge function, the webhook
// pack-retirement block, the new read-only config-guard migration, and the
// new locale keys. Same narrowed-window discipline as above.
// ===========================================================================

// ---------------------------------------------------------------------------
// 6. create-checkout static-source — Vault price wiring + owner-only gate
// ---------------------------------------------------------------------------

describe('create-checkout Vault wiring (static source)', () => {
  const CHECKOUT = 'supabase/functions/create-checkout/index.ts';
  const src = read(CHECKOUT);

  it("PRICE_IDS.vault has no monthly and sources annual from STRIPE_PRICE_VAULT_ANNUAL", () => {
    const block = window(src, 'const PRICE_IDS', 'type PlanId');
    // Scope to the vault entry specifically (the file also reads STARTER/BUSINESS
    // annual env vars — match the vault block, not the file).
    const vault = window(block, 'vault: {', '},');
    expect(vault).toContain('monthly: null');
    expect(vault).toContain('Deno.env.get("STRIPE_PRICE_VAULT_ANNUAL")');
  });

  it('forces billingInterval to annual when the plan is vault (yearly-only)', () => {
    const block = window(src, 'const isVault = planId === "vault"', 'const priceId');
    // Vault must ignore any requested interval and bill annually.
    expect(block).toContain('isVault\n      ? "annual"');
  });

  it("missing vault price fails closed with 503 vault_not_configured", () => {
    const block = window(src, 'if (!priceId) {', 'const authHeader');
    expect(block).toContain('reason: isVault ? "vault_not_configured" : "annual_not_configured"');
    expect(block).toContain('status: 503');
  });

  it('owner-only gate: non-owner vault conversion returns 403 vault_owner_only', () => {
    // The block runs AFTER the admin-can-manage-billing check, so an admin who
    // could otherwise manage billing is still blocked from converting to Vault.
    const block = window(
      src,
      'if (isVault && workspace.owner_id !== user.id) {',
      'const stripe = new Stripe',
    );
    expect(block).toContain('reason: "vault_owner_only"');
    expect(block).toContain('status: 403');
  });

  it('no trial on the vault branch — trial_period_days only on the non-vault path', () => {
    const block = window(src, 'subscription_data: {', 'metadata: {');
    // The spread is empty for vault, trial only for real plans.
    expect(block).toContain('...(isVault ? {} : { trial_period_days: TRIAL_PERIOD_DAYS })');
  });
});

// ---------------------------------------------------------------------------
// 7. stripe-webhook static-source — Vault pack-retirement block
// ---------------------------------------------------------------------------

describe('stripe-webhook Vault pack-retirement (static source)', () => {
  const WEBHOOK = 'supabase/functions/stripe-webhook/index.ts';
  const src = read(WEBHOOK);

  // The retirement block runs from the entitled+vault guard up to the next
  // function declaration after it.
  function retirementBlock(): string {
    return window(
      src,
      'if (entitled && effectivePlan === "vault") {',
      'async function applyDocumentPack',
    );
  }

  it('only fires when the workspace is entitled AND on the vault plan', () => {
    expect(retirementBlock()).toContain('if (entitled && effectivePlan === "vault") {');
  });

  it('targets only active/trialing document packs for THIS workspace not already flagged', () => {
    const block = retirementBlock();
    expect(block).toContain('s.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK');
    expect(block).toContain('s.metadata?.workspace_id === workspaceId');
    expect(block).toContain('s.status === "active" || s.status === "trialing"');
    // Idempotency guard: skip packs already flagged so a redelivered event is a no-op.
    expect(block).toContain('!s.cancel_at_period_end');
  });

  it('retires matched packs via cancel_at_period_end (period-close, not immediate)', () => {
    const block = retirementBlock();
    expect(block).toContain('await stripe.subscriptions.update(s.id, { cancel_at_period_end: true })');
  });

  it('is best-effort: a Stripe error is caught, not allowed to 500 the webhook', () => {
    const block = retirementBlock();
    expect(block).toContain('} catch (packErr) {');
    expect(block).not.toContain('throw');
  });
});

// ---------------------------------------------------------------------------
// 8. read-only config-guard migration (static source)
// ---------------------------------------------------------------------------

describe('read-only workspace config-guard migration (static source)', () => {
  const MIGRATION =
    'supabase/migrations/20260613010000_readonly_workspace_config_guard.sql';
  const src = read(MIGRATION);

  // Narrow to the function body (CREATE FUNCTION ... up to the COMMENT) so the
  // header prose / COMMENT inventory can't satisfy assertions about behaviour.
  const fn = window(
    src,
    'CREATE OR REPLACE FUNCTION public.prevent_readonly_workspace_config_edits()',
    'COMMENT ON FUNCTION',
  );

  it('bypasses wholesale for service_role (the legitimate conversion writer)', () => {
    expect(fn).toContain("IF COALESCE(auth.role(), '') = 'service_role' THEN");
    expect(fn).toContain('RETURN NEW;');
  });

  it('returns early (no guard) when the workspace is LIVE', () => {
    // Live = not canceled, not soft-deleted, not vault — read from the OLD row.
    expect(fn).toContain('IF OLD.canceled_at IS NULL');
    expect(fn).toContain('AND OLD.soft_deleted_at IS NULL');
    expect(fn).toContain("AND COALESCE(OLD.plan, '') <> 'vault' THEN");
  });

  it('guards both a report config column and a financial config column (spot-check)', () => {
    // Spot-check two representatives of the frozen config set; the full
    // inventory lives in the migration COMMENT (deliberately not re-asserted
    // here, since it would be self-referential against the same source).
    expect(fn).toContain('NEW.discount_rate                    IS DISTINCT FROM OLD.discount_rate');
    expect(fn).toContain('NEW.report_organization_name         IS DISTINCT FROM OLD.report_organization_name');
  });

  it('raises check_violation on a disallowed change', () => {
    expect(fn).toContain("USING ERRCODE = 'check_violation'");
  });

  it('installs a BEFORE UPDATE row trigger on public.workspaces', () => {
    // The trigger declaration lives after the function body (and its closing
    // $$), so slice from the CREATE TRIGGER to the end of the file.
    const idx = src.indexOf('CREATE TRIGGER enforce_workspace_readonly_config_guard');
    expect(idx, 'CREATE TRIGGER not found').toBeGreaterThanOrEqual(0);
    const decl = src.slice(idx);
    expect(decl).toContain('BEFORE UPDATE ON public.workspaces');
    expect(decl).toContain('FOR EACH ROW EXECUTE FUNCTION public.prevent_readonly_workspace_config_edits()');
  });
});

// ---------------------------------------------------------------------------
// 9. Locale parity — Vault V3 cancellation/account keys resolve in both locales
// ---------------------------------------------------------------------------

describe('Vault V3 conversion-flow locale keys', () => {
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
    'cancellation.vault_cta',
    'cancellation.vault_redirecting',
    'cancellation.vault_unavailable',
    'cancellation.wall_vault_note',
    'account.cancel_vault_note',
  ];

  it('every new key resolves to a string in BOTH en and es', () => {
    for (const key of keys) {
      expect(typeof lookup(en, key), `en missing ${key}`).toBe('string');
      expect(typeof lookup(es, key), `es missing ${key}`).toBe('string');
    }
  });

  it('the price-bearing keys carry the {{price}} interpolation token in both locales', () => {
    // vault_cta and cancel_vault_note render "$249/yr" via interpolation —
    // a hardcoded number in either locale would silently drift from pricing.ts.
    for (const key of ['cancellation.vault_cta', 'account.cancel_vault_note']) {
      expect(lookup(en, key) as string, `en ${key} {{price}}`).toContain('{{price}}');
      expect(lookup(es, key) as string, `es ${key} {{price}}`).toContain('{{price}}');
    }
  });
});
