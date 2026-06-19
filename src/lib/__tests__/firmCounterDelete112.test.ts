import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #112 (audit W1 + B2) — the firm child-counter must decrement on
// a firm-bound workspace DELETE, and delete-workspace must resync firm billing.
// Edge fns / migrations aren't vitest-runnable, so these are static guards.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#112 migration — counter DELETE branch + reconcile', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir).filter((f) => f.includes('firm_counter_delete_decrement')).sort().pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');

  it('decrements the firm counter on a firm-bound workspace DELETE', () => {
    expect(sql).toContain("TG_OP = 'DELETE' AND OLD.firm_id IS NOT NULL");
    expect(sql).toContain('child_workspaces_used = GREATEST(0, child_workspaces_used - 1)');
  });
  it('fires the trigger on DELETE and returns OLD (BEFORE DELETE requirement)', () => {
    expect(sql).toContain('BEFORE INSERT OR DELETE OR UPDATE OF firm_id');
    expect(sql).toContain('RETURN OLD');
  });
  it('one-time reconciles any counter that already drifted (idempotent)', () => {
    expect(sql).toContain('UPDATE public.firms f');
    expect(sql).toContain('child_workspaces_used <> sub.cnt');
  });
  it('brackets the reconcile with disable/re-enable of the entitlement guard', () => {
    // The migration runs as table owner (not service_role), so the guard would
    // RAISE on the system-managed column write without this bracket.
    expect(sql).toContain('ALTER TABLE public.firms DISABLE TRIGGER enforce_firm_entitlement_guard');
    expect(sql).toContain('ALTER TABLE public.firms ENABLE TRIGGER enforce_firm_entitlement_guard');
  });
});

describe('#112 delete-workspace — immediate firm billing resync', () => {
  const src = fn('supabase/functions/delete-workspace/index.ts');
  it('loads firm_id and resyncs the firm Stripe quantity after the delete', () => {
    expect(src).toContain('stripe_customer_id, firm_id');
    expect(src).toContain('syncFirmSubscriptionQuantity');
    expect(src).toContain('if (ws.firm_id && stripe)');
  });
});
