import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCUMENT_PACKS,
  packPerLeasePrice,
  PLANS,
  type DocumentPackConfig,
} from '../../config/pricing';

// ============================================================================
// Document capacity packs (Workstream B, ratified 2026-06-11)
//
// Two layers of coverage:
//   1. Pricing invariants — pure-logic tests of the exported DOCUMENT_PACKS
//      catalog + packPerLeasePrice(). These pin the *business rules* the pricing
//      was designed around (a pack always beats overage; per-lease price falls
//      with size; every pack clears the margin floor), so a future price/size
//      edit that breaks the model fails here, not in production billing.
//   2. Catalog parity + edge-function/migration behavior — static-source
//      readFileSync assertions (narrowed windows, per CLAUDE.md), because the
//      Deno edge functions can't be imported into vitest.
//
// The addon_document_capacity *entitlement guard* migration is covered in
// workspaceEntitlementGuard.test.ts — not duplicated here.
// ============================================================================

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// Both overage rates the packs must beat (cheaper relief valve than overage).
const STARTER_OVERAGE = PLANS.starter.overagePerDoc; // $12
const BUSINESS_OVERAGE = PLANS.business.overagePerDoc; // $10

// ---------------------------------------------------------------------------
// 1. Pricing invariants (pure, durable)
// ---------------------------------------------------------------------------

describe('document pack pricing invariants', () => {
  it('overage anchor rates are the documented $12 / $10', () => {
    // The pack invariants below are relative to these — pin them so a tier
    // overage edit re-derives the comparison rather than silently passing.
    expect(STARTER_OVERAGE).toBe(12);
    expect(BUSINESS_OVERAGE).toBe(10);
  });

  it('catalog is exactly the three ratified packs: 10/$90, 20/$160, 50/$350', () => {
    expect(DOCUMENT_PACKS.map((p) => [p.id, p.size, p.priceMonthly])).toEqual([
      ['pack_10', 10, 90],
      ['pack_20', 20, 160],
      ['pack_50', 50, 350],
    ]);
  });

  it('every pack per-lease price strictly beats BOTH overage rates', () => {
    for (const pack of DOCUMENT_PACKS) {
      const perLease = packPerLeasePrice(pack);
      expect(
        perLease,
        `${pack.id} ($${perLease}/lease) must beat starter overage $${STARTER_OVERAGE}`,
      ).toBeLessThan(STARTER_OVERAGE);
      expect(
        perLease,
        `${pack.id} ($${perLease}/lease) must beat business overage $${BUSINESS_OVERAGE}`,
      ).toBeLessThan(BUSINESS_OVERAGE);
    }
  });

  it('per-lease price is monotonically non-increasing with pack size (9 -> 8 -> 7)', () => {
    const bySize = [...DOCUMENT_PACKS].sort((a, b) => a.size - b.size);
    const perLease = bySize.map(packPerLeasePrice);
    // The documented curve.
    expect(perLease).toEqual([9, 8, 7]);
    // And the structural invariant the curve must satisfy: never goes up as the
    // pack grows, so a larger commitment is never penalised per-lease.
    for (let i = 1; i < perLease.length; i++) {
      expect(perLease[i]).toBeLessThanOrEqual(perLease[i - 1]);
    }
  });

  it('every pack clears the ~$4.80/lease margin floor (75% margin at 2x AI cost)', () => {
    const MARGIN_FLOOR = 4.8;
    for (const pack of DOCUMENT_PACKS) {
      expect(
        packPerLeasePrice(pack),
        `${pack.id} must clear the margin floor`,
      ).toBeGreaterThan(MARGIN_FLOOR);
    }
  });

  it('packPerLeasePrice rounds to the nearest cent', () => {
    // Contract pin: a hypothetical pack that does not divide evenly is rounded,
    // not truncated/left as a float artifact.
    const odd: DocumentPackConfig = {
      id: 'pack_10',
      size: 3,
      priceMonthly: 10,
      nameKey: 'x',
      stripePriceEnvVar: 'X',
    };
    expect(packPerLeasePrice(odd)).toBe(3.33);
  });
});

// ---------------------------------------------------------------------------
// 2. Catalog parity — pricing.ts <-> Deno mirror document_packs.ts
// ---------------------------------------------------------------------------

describe('document pack catalog parity (config <-> Deno mirror)', () => {
  const MIRROR = 'supabase/functions/_shared/document_packs.ts';

  // Parse the mirror's size/price for each pack id from the DOCUMENT_PACKS
  // object literal, so divergence between the UI catalog and the server catalog
  // (the exact failure the mirror comment warns about) fails this test.
  function parseMirror(): Record<string, { size: number; price: number }> {
    const src = read(MIRROR);
    const block = src.slice(
      src.indexOf('export const DOCUMENT_PACKS'),
      src.indexOf('};', src.indexOf('export const DOCUMENT_PACKS')),
    );
    expect(block.length).toBeGreaterThan(0);
    const out: Record<string, { size: number; price: number }> = {};
    const re =
      /(pack_\d+):\s*\{[^}]*size:\s*(\d+)[^}]*priceMonthlyUsd:\s*(\d+)/g;
    for (const m of block.matchAll(re)) {
      out[m[1]] = { size: Number(m[2]), price: Number(m[3]) };
    }
    return out;
  }

  it('the Deno mirror lists exactly the same pack ids', () => {
    const mirror = parseMirror();
    expect(Object.keys(mirror).sort()).toEqual(
      DOCUMENT_PACKS.map((p) => p.id).sort(),
    );
  });

  it('each pack size and price matches between config and mirror', () => {
    const mirror = parseMirror();
    for (const pack of DOCUMENT_PACKS) {
      expect(mirror[pack.id], `mirror has ${pack.id}`).toBeDefined();
      expect(mirror[pack.id].size, `${pack.id} size`).toBe(pack.size);
      expect(mirror[pack.id].price, `${pack.id} price`).toBe(pack.priceMonthly);
    }
  });

  it('both catalogs use the same Stripe price env var per pack', () => {
    const src = read(MIRROR);
    const block = src.slice(
      src.indexOf('export const DOCUMENT_PACKS'),
      src.indexOf('};', src.indexOf('export const DOCUMENT_PACKS')),
    );
    for (const pack of DOCUMENT_PACKS) {
      // pricing.ts uses stripePriceEnvVar, the mirror uses priceEnvVar — same value.
      expect(block).toContain(`"${pack.stripePriceEnvVar}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Webhook classification (static-source) — packs never take the plan path
// ---------------------------------------------------------------------------

describe('stripe-webhook document-pack classification', () => {
  const WEBHOOK = 'supabase/functions/stripe-webhook/index.ts';

  it('classifies via the shared ADDON_TYPE_DOCUMENT_PACK metadata tag', () => {
    const src = read(WEBHOOK);
    // The import also carries ADDON_TYPE_SINGLE_LEASE since Workstream C —
    // match on members, not the exact line.
    expect(src).toMatch(
      /import \{[^}]*ADDON_TYPE_DOCUMENT_PACK[^}]*\} from "\.\.\/_shared\/document_packs\.ts"/,
    );
    const fn = src.slice(
      src.indexOf('function isDocumentPack'),
      src.indexOf('const DOCUMENT_LIMITS'),
    );
    expect(fn).toContain('subscription.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK');
  });

  it('checkout.session.completed routes packs to applyDocumentPack and non-packs to applySubscription', () => {
    const src = read(WEBHOOK);
    const block = src.slice(
      src.indexOf('case "checkout.session.completed"'),
      src.indexOf('case "customer.subscription.created"'),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('if (isDocumentPack(subscription)) {');
    expect(block).toContain('await applyDocumentPack(subscription);');
    expect(block).toContain('await applySubscription(subscription, workspaceId);');
  });

  it('customer.subscription.* routes packs to applyDocumentPack and non-packs to applySubscription', () => {
    const src = read(WEBHOOK);
    const block = src.slice(
      src.indexOf('case "customer.subscription.created"'),
      src.indexOf('default:'),
    );
    expect(block.length).toBeGreaterThan(0);
    // All three sub events share the one handler block.
    expect(block).toContain('case "customer.subscription.updated"');
    expect(block).toContain('case "customer.subscription.deleted"');
    expect(block).toContain('if (isDocumentPack(subscription)) {');
    expect(block).toContain('await applyDocumentPack(subscription);');
    expect(block).toContain('await applySubscription(subscription);');
  });

  it('applyDocumentPack uses subscriptions.list (strongly consistent), never subscriptions.search', () => {
    const src = read(WEBHOOK);
    const fn = src.slice(
      src.indexOf('async function applyDocumentPack'),
      src.indexOf('try {', src.indexOf('async function applyDocumentPack')),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain('await stripe.subscriptions.list({');
    expect(fn).not.toContain('subscriptions.search');
  });

  it('applyDocumentPack filters on active/trialing status AND workspace_id, and sums pack_size', () => {
    const src = read(WEBHOOK);
    const fn = src.slice(
      src.indexOf('async function applyDocumentPack'),
      src.indexOf('try {', src.indexOf('async function applyDocumentPack')),
    );
    expect(fn).toContain('s.metadata?.addon_type === ADDON_TYPE_DOCUMENT_PACK');
    expect(fn).toContain('s.metadata?.workspace_id === workspaceId');
    expect(fn).toContain('s.status === "active" || s.status === "trialing"');
    expect(fn).toContain('Number.parseInt(s.metadata?.pack_size ?? "0", 10)');
  });

  it('applyDocumentPack only ever writes addon_document_capacity — never plan/document_limit/subscription columns', () => {
    const src = read(WEBHOOK);
    const fn = src.slice(
      src.indexOf('async function applyDocumentPack'),
      src.indexOf('try {', src.indexOf('async function applyDocumentPack')),
    );
    // The single update writes only the capacity column.
    expect(fn).toContain('.update({ addon_document_capacity: total })');
    // Hard negative: the plan-path entitlement columns must never appear in the
    // pack handler, or a pack could clobber the real subscription.
    expect(fn).not.toContain('plan:');
    expect(fn).not.toContain('document_limit:');
    expect(fn).not.toContain('stripe_subscription_id:');
    expect(fn).not.toContain('subscription_status:');
  });

  it('only applySubscription writes plan/document_limit (the plan path)', () => {
    const src = read(WEBHOOK);
    const fn = src.slice(
      src.indexOf('async function applySubscription'),
      // Stop before applyDocumentPack's comment preamble (which mentions the
      // capacity column) so the negative assertion below is scoped to the body.
      src.indexOf("// Recompute a workspace's total document-pack capacity"),
    );
    expect(fn).toContain('plan: effectivePlan');
    expect(fn).toContain('document_limit: DOCUMENT_LIMITS[effectivePlan]');
    // ...and the plan path never touches the pack capacity column.
    expect(fn).not.toContain('addon_document_capacity');
  });
});

// ---------------------------------------------------------------------------
// 4. Quota math (static-source) — process_lease adds pack capacity to both caps
// ---------------------------------------------------------------------------

describe('process_lease pack-aware quota math', () => {
  const FN = 'supabase/functions/process_lease/index.ts';

  it('reads addon_document_capacity alongside plan when computing quota', () => {
    const src = read(FN);
    const fn = src.slice(
      src.indexOf('async function assertProcessingQuota'),
      src.indexOf('// Monthly extractions'),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain(".select('plan, addon_document_capacity')");
  });

  it('clamps the addon to >= 0 so a bad value can never shrink the base cap', () => {
    const src = read(FN);
    const fn = src.slice(
      src.indexOf('async function assertProcessingQuota'),
      src.indexOf('// Monthly extractions'),
    );
    expect(fn).toContain('const addon = Math.max(0, Number(');
    expect(fn).toContain('?.addon_document_capacity ?? 0');
  });

  it('adds the addon to BOTH active_leases and monthly_extractions limits', () => {
    const src = read(FN);
    const fn = src.slice(
      src.indexOf('async function assertProcessingQuota'),
      src.indexOf('// Monthly extractions'),
    );
    const limits = fn.slice(fn.indexOf('const limits = {'), fn.indexOf('};', fn.indexOf('const limits = {')));
    expect(limits).toContain('active_leases: base.active_leases + addon');
    expect(limits).toContain('monthly_extractions: base.monthly_extractions + addon');
  });
});
