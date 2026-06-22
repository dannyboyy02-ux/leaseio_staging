import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #65 — every Stripe paid event the webhook can't honor must land a durable,
// attributable dead-letter row instead of a vanished console.warn. Edge
// functions / migrations have no unit harness here, so these are static-source
// assertions (the established idiom — see firmEdgeFunctionGating.test.ts) that
// pin the wiring + the security-load-bearing properties so they can't silently
// regress.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const WEBHOOK = 'supabase/functions/stripe-webhook/index.ts';
const TABLE_MIG = 'supabase/migrations/20260622000000_billing_dead_letters.sql';
const RPC_MIG = 'supabase/migrations/20260622010000_record_billing_dead_letter_rpc.sql';

describe('#65 stripe-webhook dead-letter wiring', () => {
  const src = read(WEBHOOK);

  it('records dropped grants through the service-role RPC (not a direct table write)', () => {
    expect(src).toContain('supabaseAdmin.rpc("record_billing_dead_letter"');
    // The client never writes the forensic table directly — it goes through the
    // RPC so the frozen-first-capture + attempt_count upsert is honored.
    expect(src).not.toContain('.from("billing_dead_letters")');
  });

  it('is best-effort: the dead-letter helper logs but never throws', () => {
    const start = src.indexOf('async function recordBillingDeadLetter');
    const end = src.indexOf('async function applyDocumentPack');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const helper = src.slice(start, end);
    expect(helper).toContain('console.error');
    // Must NOT throw — an un-honorable, un-recordable event must not loop the
    // webhook (it already acks 200 on these branches).
    expect(helper).not.toContain('throw');
  });

  it('emits only CHECK-valid (source, reason) pairs for every drop branch', () => {
    // document_pack: attribution-only. single_lease_credit: + charge rejections.
    const docPackReasons = ['missing_workspace_id', 'missing_customer'];
    const singleReasons = ['missing_workspace_id', 'unknown_workspace', 'underpaid', 'customer_mismatch'];

    // Each reason literal appears wired to a recordBillingDeadLetter call.
    for (const r of new Set([...docPackReasons, ...singleReasons])) {
      expect(src, `reason ${r} should be emitted`).toContain(`reason: "${r}"`);
    }
    // Both sources are emitted.
    expect(src).toContain('source: "document_pack"');
    expect(src).toContain('source: "single_lease_credit"');
    // The single-lease charge-rejection reasons must NEVER be tagged document_pack
    // (the migration's composite CHECK would reject such a row at runtime).
    expect(src).not.toMatch(/source: "document_pack"[\s\S]{0,200}reason: "underpaid"/);
    expect(src).not.toMatch(/source: "document_pack"[\s\S]{0,200}reason: "customer_mismatch"/);
  });

  it('threads the Stripe event id into both grant functions', () => {
    expect(src).toContain('applyDocumentPack(subscription, event.id)');
    expect(src).toContain('applySingleLeaseCredit(pi, event.id)');
  });
});

describe('#65 billing_dead_letters table migration', () => {
  const mig = read(TABLE_MIG);

  it('is append-only/immutable from clients: RLS enabled + FORCE + only a SELECT policy', () => {
    expect(mig).toContain('ENABLE ROW LEVEL SECURITY');
    expect(mig).toContain('FORCE ROW LEVEL SECURITY');
    expect(mig).toContain('FOR SELECT');
    expect(mig).toContain('public.is_ops_admin(auth.uid())');
    // No client write policy may exist (service-role writes via bypass).
    expect(mig).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE)/);
  });

  it('dedupes on (source, stripe_object_id, reason) and self-polices source<->reason', () => {
    expect(mig).toContain('(source, stripe_object_id, reason)');
    expect(mig).toContain('billing_dead_letters_source_reason_valid');
  });
});

describe('#65 record_billing_dead_letter RPC migration', () => {
  const mig = read(RPC_MIG);

  it('is SECURITY INVOKER with a pinned search_path', () => {
    expect(mig).toContain('SECURITY INVOKER');
    expect(mig).toContain('SET search_path = public');
    expect(mig).not.toContain('SECURITY DEFINER');
  });

  it('grants EXECUTE only to service_role (revoked from PUBLIC/anon/authenticated)', () => {
    expect(mig).toContain('REVOKE ALL ON FUNCTION public.record_billing_dead_letter');
    expect(mig).toMatch(/FROM PUBLIC;/);
    expect(mig).toMatch(/FROM anon;/);
    expect(mig).toMatch(/FROM authenticated;/);
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.record_billing_dead_letter');
    expect(mig).toMatch(/TO service_role;/);
  });

  it('upserts with the recurrence bump (first capture stays frozen)', () => {
    expect(mig).toContain('ON CONFLICT (source, stripe_object_id, reason) DO UPDATE');
    expect(mig).toContain('attempt_count = public.billing_dead_letters.attempt_count + 1');
    expect(mig).toContain('last_seen_at  = now()');
  });
});
