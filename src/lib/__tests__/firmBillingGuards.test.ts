import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 CP3b — KNOWN_ISSUES #103 server-side fix. A firm-bound workspace's
// billing is governed by the firm-level subscription, so the three
// workspace-scoped billing entry points must reject a firm-bound child
// fail-closed (else create-checkout mints a duplicate sub the webhook clobbers
// onto the child, and manage-document-pack sells a workspace-scoped pack under
// firm billing). Static-source guards (Deno, no unit harness).

const root = process.cwd();
const fn = (name: string) => readFileSync(join(root, `supabase/functions/${name}/index.ts`), 'utf8');

describe('#103 — firm-bound workspaces are rejected from workspace-scoped billing', () => {
  it('create-checkout selects firm_id and rejects firm-bound with reason firm_managed', () => {
    const src = fn('create-checkout');
    expect(src).toMatch(/\.select\("id, owner_id, firm_id"\)/);
    expect(src).toContain('workspace as { firm_id: string | null }).firm_id');
    expect(src).toContain('reason: "firm_managed"');
  });

  it('customer-portal selects firm_id and rejects firm-bound with reason firm_managed', () => {
    const src = fn('customer-portal');
    expect(src).toContain('firm_id');
    expect(src).toContain('workspace as { firm_id: string | null }).firm_id');
    expect(src).toContain('reason: "firm_managed"');
  });

  it('manage-document-pack selects firm_id and blocks the charge-creating modes for firm-bound', () => {
    const src = fn('manage-document-pack');
    expect(src).toMatch(/firm_id, stripe_customer_id/);
    expect(src).toContain('reason: "firm_managed"');
    // Only the charge-creating modes are blocked (preview/cancel stay allowed).
    expect(src).toContain('(mode === "confirm" || mode === "buy_single")');
  });

  it('the firm-managed guard fires BEFORE any Stripe call in create-checkout', () => {
    const src = fn('create-checkout');
    const guardIdx = src.indexOf('reason: "firm_managed"');
    const stripeIdx = src.indexOf('new Stripe(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(stripeIdx).toBeGreaterThan(guardIdx);
  });
});
