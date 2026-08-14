import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  requiresSubscriptionToProcess,
  resolveProcessingSubscriptionGate,
  NO_SUBSCRIPTION_REASON,
  FIRM_SUBSCRIPTION_REQUIRED_REASON,
  FIRM_SUBSCRIPTION_REQUIRED_ERROR,
  type MonetizationRow,
} from '../../../supabase/functions/_shared/monetization';

// ============================================================================
// #201 (owner decision 2026-08-14): firm-bound children INHERIT processing
// entitlement from the firm's subscription. The firm "live" signal is
// firms.stripe_subscription_id — the webhook's entitlement gate only writes it
// for active/trialing subs, keeps it through dunning, clears it on deletion.
// monetization.ts is dependency-free (no Deno globals), so the Deno-shared
// gate is behaviorally testable here directly — the same file both paid-AI
// entry points bundle.
// The contract these tests pin:
//   - the workspace-local gate (grandfather, plan exemptions, own past sub)
//     runs FIRST; the firm is consulted only when it would block,
//   - firm sub present  -> unblocked,
//   - firm sub absent   -> blocked with firm_subscription_required (NEVER
//     no_subscription — the trial CTA lies to a firm-managed workspace),
//   - firms lookup error -> fail closed with the firm-flavored reason.
// ============================================================================

// Post-cutoff never-subscribed workspace — the gated baseline.
const GATED_WS: MonetizationRow = {
  plan: 'business',
  subscription_status: null,
  stripe_subscription_id: null,
  created_at: '2026-08-01T00:00:00Z',
};

/** Stub admin whose firms lookup resolves as configured. Also records whether
 *  the lookup ran, so we can pin "the firm is only consulted when needed". */
function stubAdmin(result: { data?: unknown; error?: unknown }) {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      calls.push(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
          }),
        }),
      };
    },
  };
  return { admin, calls };
}

describe('#201 — resolveProcessingSubscriptionGate', () => {
  it('non-firm workspace: blocked with no_subscription (pre-#201 behavior preserved)', async () => {
    const { admin, calls } = stubAdmin({});
    const out = await resolveProcessingSubscriptionGate(admin, { ...GATED_WS, firm_id: null });
    expect(out).toMatchObject({ blocked: true, reason: NO_SUBSCRIPTION_REASON });
    expect(calls).toEqual([]); // no firm lookup for a non-firm workspace
  });

  it('firm-bound + firm has a live subscription: UNBLOCKED (inherits entitlement)', async () => {
    const { admin, calls } = stubAdmin({ data: { stripe_subscription_id: 'sub_live_123' } });
    const out = await resolveProcessingSubscriptionGate(admin, { ...GATED_WS, firm_id: 'firm-1' });
    expect(out).toEqual({ blocked: false });
    expect(calls).toEqual(['firms']);
  });

  it('firm-bound + firm has NO subscription: blocked with firm_subscription_required, never the trial reason', async () => {
    const { admin } = stubAdmin({ data: { stripe_subscription_id: null } });
    const out = await resolveProcessingSubscriptionGate(admin, { ...GATED_WS, firm_id: 'firm-1' });
    expect(out).toMatchObject({
      blocked: true,
      reason: FIRM_SUBSCRIPTION_REQUIRED_REASON,
      error: FIRM_SUBSCRIPTION_REQUIRED_ERROR,
    });
  });

  it('firm-bound + firm row missing: blocked with the firm reason (fail closed)', async () => {
    const { admin } = stubAdmin({ data: null });
    const out = await resolveProcessingSubscriptionGate(admin, { ...GATED_WS, firm_id: 'firm-1' });
    expect(out).toMatchObject({ blocked: true, reason: FIRM_SUBSCRIPTION_REQUIRED_REASON });
  });

  it('firm-bound + firms lookup ERROR: blocked with the firm reason (fail closed, no free processing on a DB hiccup)', async () => {
    const { admin } = stubAdmin({ data: { stripe_subscription_id: 'sub_live_123' }, error: { message: 'boom' } });
    const out = await resolveProcessingSubscriptionGate(admin, { ...GATED_WS, firm_id: 'firm-1' });
    expect(out).toMatchObject({ blocked: true, reason: FIRM_SUBSCRIPTION_REQUIRED_REASON });
  });

  it('the workspace-local gate short-circuits FIRST — no firm lookup when the workspace is already entitled', async () => {
    const { admin, calls } = stubAdmin({});
    for (const ws of [
      { ...GATED_WS, firm_id: 'firm-1', subscription_status: 'active' }, // own live sub
      { ...GATED_WS, firm_id: 'firm-1', stripe_subscription_id: 'sub_own' }, // own sub pointer
      { ...GATED_WS, firm_id: 'firm-1', created_at: '2026-07-01T00:00:00Z' }, // grandfathered
      { ...GATED_WS, firm_id: 'firm-1', plan: 'audit' }, // exempt plan
      { ...GATED_WS, firm_id: 'firm-1', plan: 'vault' }, // exempt plan
      null,
      undefined,
    ]) {
      const out = await resolveProcessingSubscriptionGate(admin, ws as MonetizationRow | null | undefined);
      expect(out).toEqual({ blocked: false });
    }
    expect(calls).toEqual([]); // the firm was never consulted
  });

  it('pure gate untouched: requiresSubscriptionToProcess ignores firm_id entirely', () => {
    expect(requiresSubscriptionToProcess({ ...GATED_WS, firm_id: 'firm-1' })).toBe(true);
    expect(requiresSubscriptionToProcess({ ...GATED_WS, firm_id: null })).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Lockstep wiring — both paid-AI entry points route through the async gate
// (not the bare pure function), select firm_id, and forward the gate's own
// error/reason instead of hardcoding the trial copy.
// ----------------------------------------------------------------------------
describe('#201 — entry-point wiring', () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  for (const entry of [
    'supabase/functions/process_lease/index.ts',
    'supabase/functions/retry_lease/index.ts',
  ]) {
    it(`${entry} awaits the firm-aware gate and forwards its reason`, () => {
      const src = read(entry);
      expect(src).toContain('resolveProcessingSubscriptionGate(supabaseAdmin,');
      expect(src).toMatch(/await resolveProcessingSubscriptionGate/);
      expect(src).toContain('subGate.reason');
      expect(src).toContain('subGate.error');
      // The workspace select feeds firm_id to the gate.
      expect(src).toMatch(/select\('[^']*created_at, firm_id'\)/);
      // The bypassable pure call is gone from the entry point.
      expect(src).not.toMatch(/if \(requiresSubscriptionToProcess\(/);
    });
  }

  it('LeaseUploadModal branches firm_subscription_required away from the trial panel', () => {
    const src = read('src/components/leases/LeaseUploadModal.tsx');
    const branchIdx = src.indexOf("result?.reason === 'firm_subscription_required'");
    expect(branchIdx).toBeGreaterThan(-1);
    const branch = src.slice(branchIdx, branchIdx + 200);
    expect(branch).toContain("setStep('firm_subscription')");
    // The firm panel has no trial CTA.
    const panelIdx = src.indexOf("step === 'firm_subscription' && (");
    expect(panelIdx).toBeGreaterThan(-1);
    const panel = src.slice(panelIdx, src.indexOf('</Dialog>', panelIdx));
    expect(panel).not.toContain('handleStartTrial');
    expect(panel).toContain('firm_subscription_body');
  });
});
