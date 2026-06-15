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
    // Bound the window at applySingleLeaseCredit's own end — the next helper
    // declaration OR the main handler try, whichever comes first. The firm
    // branch added applyFirmSubscription (which DOES write the workspaces row to
    // propagate plan='business' to children); it sits between this function and
    // the main try, so anchoring solely on `try {` would bleed its write into
    // this window and falsely fail the "never writes workspaces" assertion.
    const nextFn = src.indexOf('async function ', start + 1);
    const nextTry = src.indexOf('try {', start);
    const end = Math.min(...[nextFn, nextTry].filter((i) => i > start));
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
    // The grant column is never touched here — only the ledger row is written;
    // the AFTER INSERT trigger increments purchased_lease_credits.
    expect(fn).not.toContain('purchased_lease_credits');
    // Workstream C added a validation SELECT on workspaces (plan + customer, to
    // validate the charge against billing state), so the function now reads the
    // table. The intent that survives: it must never WRITE the workspaces row —
    // no .update/.upsert on workspaces, and the only .from("workspaces") use is
    // the read-only validation .select(...).
    expect(fn).toContain('.from("workspaces")\n      .select(');
    const wsWrites = fn.match(/\.from\("workspaces"\)\s*\.\s*(update|upsert|insert|delete)/g);
    expect(wsWrites, 'applySingleLeaseCredit must never write the workspaces row').toBeNull();
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
  // The over-cap credit flow was split during the Workstream C review-fix pass:
  //   * checkProcessingQuota(...) is a side-effect-free DECISION returning
  //     { kind: 'ok' | 'needs_credit' | 'block' } — it no longer touches the RPC.
  //   * consumeCreditOrBlock(...) does the atomic claim and returns a block
  //     Response (fail-closed) or null (allow). It is invoked from the NEW-lease
  //     call site AFTER Tier 2 confirms the document is a lease, so a rejected
  //     non-lease never burns a paid credit.
  function consumeFn(): string {
    const src = read(PROCESS);
    const start = src.indexOf('async function consumeCreditOrBlock');
    const end = src.indexOf('async function extractLeaseDataWithClaude');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('claims a credit via the consume_lease_credit RPC (2-arg) inside consumeCreditOrBlock only', () => {
    const src = read(PROCESS);
    const fn = consumeFn();
    expect(fn).toContain("supabaseAdmin.rpc('consume_lease_credit'");
    // New two-arg shape: workspace + lease (the debit row attributes the spend).
    expect(fn).toContain('p_workspace_id: workspaceId');
    expect(fn).toContain('p_lease_id: leaseId');
    // Exactly one RPC call site (the quoted RPC name; prose comments are
    // unquoted), and it lives inside consumeCreditOrBlock — the side-effect-free
    // checkProcessingQuota decision must never spend a credit.
    const CALL = "rpc('consume_lease_credit'";
    expect(src.indexOf(CALL)).toBe(src.lastIndexOf(CALL));
    const consumeStart = src.indexOf('async function consumeCreditOrBlock');
    const consumeEnd = src.indexOf('async function extractLeaseDataWithClaude');
    expect(src.indexOf(CALL)).toBeGreaterThan(consumeStart);
    expect(src.indexOf(CALL)).toBeLessThan(consumeEnd);
  });

  it('the claim is gated behind the needsCreditClaim guard, which sits AFTER the tier2-passed log', () => {
    const src = read(PROCESS);
    // The new-lease call site reserves the credit at the decision step...
    const reserve = src.indexOf("const needsCreditClaim = quotaDecision.kind === 'needs_credit'");
    expect(reserve).toBeGreaterThan(-1);
    // ...the tier2-passed activity log runs next...
    const tier2Passed = src.indexOf("activity_type: 'tier2_classification_passed'", reserve);
    expect(tier2Passed).toBeGreaterThan(reserve);
    // ...and the actual spend (consumeCreditOrBlock under the needsCreditClaim
    // guard) happens AFTER that log, so a Tier-2-rejected non-lease never burns
    // a paid credit.
    const guard = src.indexOf('if (needsCreditClaim && resolvedWorkspaceId)', tier2Passed);
    expect(guard).toBeGreaterThan(tier2Passed);
    const call = src.indexOf('await consumeCreditOrBlock(', guard);
    expect(call).toBeGreaterThan(guard);
  });

  it('returns null (allows the upload) when the claim returns exactly true', () => {
    const fn = consumeFn();
    // Allow only on a clean claim: no error AND claimed strictly true.
    expect(fn).toContain('if (!claimErr && claimed === true)');
    const allow = fn.indexOf('if (!claimErr && claimed === true)');
    // Window ends where the fall-through block response begins.
    const branch = fn.slice(allow, fn.indexOf('return quotaBlockResponse'));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('return null;');
  });

  it('fails CLOSED on a claim error / no credit — returns the block response, never allows', () => {
    const fn = consumeFn();
    // A transient RPC failure is logged but must NOT grant a free over-cap
    // extraction; the only non-allow exit is the block response.
    expect(fn).toContain('if (claimErr) console.error');
    // The single early allow is the clean-claim path above; everything else
    // falls through to the block response.
    const allowReturns = fn.match(/return null;/g) ?? [];
    expect(allowReturns.length).toBe(1);
    // The fall-through (error OR no-credit) returns the structured wall.
    expect(fn).toContain('return quotaBlockResponse(');
  });

  it('blocks with the structured quota_exceeded body when no credit is claimed', () => {
    const src = read(PROCESS);
    // quotaBlockResponse carries reason + metric so the limit wall can render,
    // and consumeCreditOrBlock emits one when the claim fails.
    const helper = src.slice(
      src.indexOf('function quotaBlockResponse'),
      src.indexOf('async function checkProcessingQuota'),
    );
    expect(helper).toContain("reason: 'quota_exceeded'");
    expect(helper).toContain('metric,');
    // 200 + structured body (functions.invoke swallows non-2xx bodies).
    const resp = helper.indexOf('return new Response(');
    expect(resp).toBeGreaterThan(-1);
    expect(helper).toContain('status: 200');
    // The block decision also surfaces both metric variants from the check.
    const check = src.slice(
      src.indexOf('async function checkProcessingQuota'),
      src.indexOf('async function consumeCreditOrBlock'),
    );
    expect(check).toContain("'monthly_extractions'");
    expect(check).toContain("'active_leases'");
  });

  it('re-extraction (isNewLease:false) never claims a credit — it only blocks', () => {
    const src = read(PROCESS);
    // The executed/re-extraction call site passes isNewLease:false and acts only
    // on a 'block' decision; there is no needsCreditClaim / consumeCreditOrBlock
    // wired to that path (credits sell "add a lease", not re-runs).
    const execStart = src.indexOf('const execQuota = await checkProcessingQuota(');
    expect(execStart).toBeGreaterThan(-1);
    const execBlock = src.slice(execStart, execStart + 400);
    expect(execBlock).toContain('isNewLease: false');
    expect(execBlock).toContain('if (execQuota.kind === \'block\') return execQuota.response;');
    expect(execBlock).not.toContain('consumeCreditOrBlock');
    expect(execBlock).not.toContain('needsCreditClaim');
  });
});
