import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 / #107 — firm billing reconciliation (hard rule #9).

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('firm_billing.ts — self-auditing sync + offboarding-cancel', () => {
  const src = fn('supabase/functions/_shared/firm_billing.ts');
  it('audits a quantity change (old → new) to firm_activity_log', () => {
    expect(src).toContain('"firm_billing_quantity_changed"');
    expect(src).toContain('old_quantity: oldQty, new_quantity: qty');
  });
  it('records a sync FAILURE so it is queryable (no silent vendor failure)', () => {
    expect(src).toContain('sync_failed: true');
    expect(src).toContain('catch (e)');
  });
  it('cancels the sub at period end when the firm has 0 children (never sends quantity 0)', () => {
    expect(src).toContain('if (qty < 1)');
    expect(src).toContain('cancel_at_period_end: true');
    expect(src).toContain('"firm_billing_subscription_canceled"');
  });
  it('updates quantity with proration', () => {
    expect(src).toContain('proration_behavior: "create_prorations"');
  });
  it('un-cancels a cancelling sub when a child is re-bound (no silent free Business)', () => {
    expect(src).toContain('const needsUncancel = sub.cancel_at_period_end === true');
    expect(src).toContain('needsUncancel ? { cancel_at_period_end: false } : {}');
    // The in_sync early-return must NOT fire when an un-cancel is needed.
    expect(src).toContain('if (oldQty === qty && !needsUncancel) return');
  });
});

describe('firm-billing-reconcile cron', () => {
  const src = fn('supabase/functions/firm-billing-reconcile/index.ts');
  it('is x-cron-secret gated', () => {
    expect(src).toContain('FIRM_BILLING_CRON_SECRET');
    expect(src).toContain('x-cron-secret');
    expect(src).toContain('status: 401');
  });
  it('sweeps only firms with a live subscription and runs the self-healing sync', () => {
    expect(src).toContain('.not("stripe_subscription_id", "is", null)');
    expect(src).toContain('syncFirmSubscriptionQuantity');
    expect(src).toContain('corrected');
  });
});

describe('#107 migration adds firm_billing_quantity_changed', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir).filter((f) => f.includes('firm_billing_quantity_audit')).sort().pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');
  it('appends the value to the firm_activity_log CHECK', () => {
    expect(sql).toContain('firm_billing_quantity_changed');
    expect(sql).toContain('ADD CONSTRAINT firm_activity_log_activity_type_check');
  });
});

describe('#102 cleanup + create-firm cap', () => {
  it('bind/release no longer echo raw DB error messages', () => {
    const bind = fn('supabase/functions/bind-workspace-to-firm/index.ts');
    const release = fn('supabase/functions/release-workspace-from-firm/index.ts');
    expect(bind).not.toContain('error: updErr.message');
    expect(bind).not.toMatch(/return json\(\{ error: msg \}/);
    expect(release).not.toContain('error: updErr.message');
    expect(release).not.toMatch(/return json\(\{ error: msg \}/);
  });
  it('create-firm caps self-serve firms per owner', () => {
    const src = fn('supabase/functions/create-firm/index.ts');
    expect(src).toContain('firm_cap_reached');
    expect(src).toContain('if (!isOps)');
  });
});
