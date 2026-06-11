import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS } from '../../config/pricing';

// ============================================================================
// Single-lease credits (Workstream C — limit wall, 2026-06-11)
//
// A workspace at its cap buys ONE extra lease at the plan's overage rate.
// Money flow: manage-document-pack `buy_single` creates a one-time
// PaymentIntent tagged addon_type='single_lease' → stripe-webhook's
// payment_intent.succeeded handler upserts the idempotent ledger row (the DB
// trigger grants the credit) → process_lease consumes a credit atomically via
// the consume_lease_credit RPC when over-cap.
//
// Coverage layers:
//   1. Price parity — SINGLE_LEASE_PRICE_CENTS (Deno mirror) must equal
//      pricing.ts overagePerDoc × 100 per plan, or the UI advertises a price
//      the server doesn't charge.
//   2. Static-source assertions (narrowed windows, per CLAUDE.md) on the three
//      edge functions, since Deno code can't be imported into vitest.
//
// The migration (guard re-derivation, ledger, RPC grants) is covered in
// workspaceEntitlementGuard.test.ts; the client limit-wall logic in
// src/hooks/__tests__/useWorkspaceQuota.test.ts. Not duplicated here.
// ============================================================================

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const MIRROR = 'supabase/functions/_shared/document_packs.ts';
const WEBHOOK = 'supabase/functions/stripe-webhook/index.ts';
const MANAGE = 'supabase/functions/manage-document-pack/index.ts';
const PROCESS = 'supabase/functions/process_lease/index.ts';

// ---------------------------------------------------------------------------
// 1. Price parity — Deno mirror <-> pricing.ts overage rates
// ---------------------------------------------------------------------------

describe('single-lease price parity (Deno mirror <-> pricing.ts overage)', () => {
  function parseMirrorPrices(): { starter: number; business: number } {
    const src = read(MIRROR);
    const start = src.indexOf('export const SINGLE_LEASE_PRICE_CENTS');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('};', start));
    const starter = /starter:\s*(\d+)/.exec(block);
    const business = /business:\s*(\d+)/.exec(block);
    expect(starter, 'mirror has a starter price').not.toBeNull();
    expect(business, 'mirror has a business price').not.toBeNull();
    return { starter: Number(starter![1]), business: Number(business![1]) };
  }

  it('mirror charges exactly the documented overage rates: 1200¢/$12 and 1000¢/$10', () => {
    const prices = parseMirrorPrices();
    expect(prices.starter).toBe(1200);
    expect(prices.business).toBe(1000);
  });

  it('mirror cents equal pricing.ts overagePerDoc × 100 for each plan', () => {
    const prices = parseMirrorPrices();
    expect(prices.starter).toBe(PLANS.starter.overagePerDoc * 100);
    expect(prices.business).toBe(PLANS.business.overagePerDoc * 100);
  });

  it('the single-lease metadata tag is the stable string "single_lease"', () => {
    // Stripe metadata on already-created PaymentIntents is frozen; renaming the
    // constant's VALUE would orphan in-flight purchases at the webhook.
    expect(read(MIRROR)).toContain(
      'export const ADDON_TYPE_SINGLE_LEASE = "single_lease"',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. manage-document-pack buy_single — charges, tags, never writes entitlements
// ---------------------------------------------------------------------------

describe('manage-document-pack buy_single (static-source)', () => {
  function buySingleBlock(): string {
    const src = read(MANAGE);
    const start = src.indexOf('if (mode === "buy_single")');
    const end = src.indexOf('if (mode === "cancel")');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('charges the plan-derived single-lease price as a one-time PaymentIntent', () => {
    const src = read(MANAGE);
    // The price is resolved from the shared catalog by plan...
    expect(src).toContain('const singleLeasePriceCents = SINGLE_LEASE_PRICE_CENTS[plan]');
    // ...and is the PaymentIntent amount.
    const block = buySingleBlock();
    expect(block).toContain('stripe.paymentIntents.create(');
    expect(block).toContain('amount: singleLeasePriceCents');
  });

  it('stamps the metadata the webhook classifies on: addon_type, workspace_id, quantity, purchased_by', () => {
    const block = buySingleBlock();
    expect(block).toContain('addon_type: ADDON_TYPE_SINGLE_LEASE');
    expect(block).toContain('workspace_id: workspaceId');
    expect(block).toContain('quantity: "1"');
    expect(block).toContain('purchased_by: user.id');
  });

  it('requires a client idempotencyKey and passes a workspace-scoped Stripe idempotency key', () => {
    const block = buySingleBlock();
    expect(block).toContain('if (!idempotencyKey || typeof idempotencyKey !== "string"');
    expect(block).toContain('idempotencyKey: `single_${workspaceId}_${idempotencyKey}`');
  });

  it('never writes entitlements itself — the webhook + ledger trigger are the only grant path', () => {
    const block = buySingleBlock();
    // No direct ledger insert and no workspace update from the purchase path;
    // otherwise a failed/duplicate webhook could double-grant or desync.
    expect(block).not.toContain('lease_credit_purchases');
    expect(block).not.toContain('purchased_lease_credits');
    expect(block).not.toContain('.update(');
  });

  it('returns the 3DS client_secret only when the PI requires action', () => {
    const block = buySingleBlock();
    expect(block).toContain(
      'clientSecret: pi.status === "requires_action" ? pi.client_secret : null',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. stripe-webhook — payment_intent.succeeded routing + idempotent grant
// ---------------------------------------------------------------------------

describe('stripe-webhook single-lease credit grant (static-source)', () => {
  it('payment_intent.succeeded routes ONLY single_lease-tagged PIs to applySingleLeaseCredit', () => {
    const src = read(WEBHOOK);
    const start = src.indexOf('case "payment_intent.succeeded"');
    const end = src.indexOf('case "checkout.session.completed"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    // Gate on the shared metadata tag — an untagged PI (e.g. a future one-time
    // charge of another kind) must not mint a lease credit.
    expect(block).toContain(
      'if (pi.metadata?.addon_type === ADDON_TYPE_SINGLE_LEASE)',
    );
    expect(block).toContain('await applySingleLeaseCredit(pi);');
  });

  function applyFnBlock(): string {
    const src = read(WEBHOOK);
    const start = src.indexOf('async function applySingleLeaseCredit');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('try {', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('grants via an idempotent ledger upsert keyed on payment_intent_id with ignoreDuplicates', () => {
    const fn = applyFnBlock();
    expect(fn).toContain('.from("lease_credit_purchases")');
    expect(fn).toContain('.upsert(');
    expect(fn).toContain('onConflict: "payment_intent_id"');
    expect(fn).toContain('ignoreDuplicates: true');
    expect(fn).toContain('payment_intent_id: pi.id');
  });

  it('never increments purchased_lease_credits directly — the DB trigger is the single writer', () => {
    const fn = applyFnBlock();
    expect(fn).not.toContain('purchased_lease_credits');
    expect(fn).not.toContain('.from("workspaces")');
  });

  it('skips (does not throw) when the PI is missing workspace_id metadata', () => {
    const fn = applyFnBlock();
    const guard = fn.indexOf('if (!workspaceId)');
    expect(guard).toBeGreaterThan(-1);
    // The guard returns before the upsert.
    expect(guard).toBeLessThan(fn.indexOf('.upsert('));
    expect(fn.slice(guard, fn.indexOf('}', guard))).toContain('return;');
  });

  it('imports ADDON_TYPE_SINGLE_LEASE from the shared Deno mirror (no string drift)', () => {
    const src = read(WEBHOOK);
    expect(src).toMatch(
      /import \{[^}]*ADDON_TYPE_SINGLE_LEASE[^}]*\} from "\.\.\/_shared\/document_packs\.ts"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. process_lease — credit consumption on the over-cap path
// ---------------------------------------------------------------------------

describe('process_lease single-lease credit consumption (static-source)', () => {
  function overCapBlock(): { src: string; block: string; blockStart: number } {
    const src = read(PROCESS);
    const blockStart = src.indexOf('if (overMonthly || overActive)');
    const end = src.indexOf('async function extractLeaseDataWithClaude');
    expect(blockStart).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(blockStart);
    return { src, block: src.slice(blockStart, end), blockStart };
  }

  it('claims a credit via the consume_lease_credit RPC only AFTER a cap has tripped', () => {
    const { src, block, blockStart } = overCapBlock();
    expect(block).toContain("'consume_lease_credit'");
    expect(block).toContain('{ p_workspace_id: workspaceId }');
    // Exactly one call site (the quoted RPC name; prose comments are unquoted),
    // and it lives inside the over-cap branch — an under-cap upload must never
    // spend a paid credit.
    const CALL = "'consume_lease_credit'";
    expect(src.indexOf(CALL)).toBe(src.lastIndexOf(CALL));
    expect(src.indexOf(CALL)).toBeGreaterThan(blockStart);
  });

  it('returns null (allows the upload) when the claim returns exactly true', () => {
    const { block } = overCapBlock();
    const claimed = block.indexOf('else if (claimed === true)');
    expect(claimed).toBeGreaterThan(-1);
    // Window ends where the block-response construction begins (slicing to the
    // next '}' would stop inside the log line's `${workspaceId}` literal).
    const branch = block.slice(claimed, block.indexOf('const body = overMonthly'));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('return null;');
  });

  it('fails CLOSED on a claim error — falls through to the block response, never extracts', () => {
    const { block } = overCapBlock();
    const errStart = block.indexOf('if (claimErr)');
    expect(errStart).toBeGreaterThan(-1);
    const errBranch = block.slice(
      errStart,
      block.indexOf('else if (claimed === true)'),
    );
    expect(errBranch.length).toBeGreaterThan(0);
    // Logged, but no early allow: a transient RPC failure must not grant a
    // free over-cap extraction (contrast with the fail-open count errors).
    expect(errBranch).toContain('console.error');
    expect(errBranch).not.toContain('return null');
    expect(errBranch).not.toContain('return new Response');
  });

  it('blocks with the structured quota_exceeded body when no credit is claimed', () => {
    const { block } = overCapBlock();
    // Both cap variants carry reason + metric so the limit wall can render.
    expect(block).toContain("reason: 'quota_exceeded'");
    expect(block).toContain("metric: 'monthly_extractions'");
    expect(block).toContain("metric: 'active_leases'");
    // 200 + structured body (functions.invoke swallows non-2xx bodies).
    const resp = block.indexOf('return new Response(JSON.stringify(body)');
    expect(resp).toBeGreaterThan(-1);
    expect(block.slice(resp, resp + 200)).toContain('status: 200');
  });
});
