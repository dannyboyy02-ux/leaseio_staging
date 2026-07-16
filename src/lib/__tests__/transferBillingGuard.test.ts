import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P0-e (2026-07-16): transfer-workspace-ownership never moved stripe_customer_id,
// so after a transfer the prior owner kept being billed for a workspace they no
// longer owned AND the new owner's next create-workspace inherited the prior
// owner's Stripe customer/card. Fix: block transfer while an active subscription
// is attached (resolve billing first). Policy choice — flagged for owner.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#P0-e — transfer is blocked while a subscription bills the prior owner', () => {
  const fn = read('supabase/functions/transfer-workspace-ownership/index.ts');

  it('the edge function refuses transfer on an active subscription', () => {
    expect(fn).toContain('active_subscription');
    // Gated on subscription_status / stripe_subscription_id, before the RPC.
    expect(fn).toContain('subscription_status');
    expect(fn).toContain('stripe_subscription_id');
    // The guard returns before invoking transfer_workspace_ownership_locked.
    const guardIdx = fn.indexOf('active_subscription');
    const rpcIdx = fn.indexOf('transfer_workspace_ownership_locked', fn.indexOf('rpc('));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it('the dialog reads the server reason and shows a localized message', () => {
    const dlg = read('src/components/workspace/TransferOwnershipDialog.tsx');
    expect(dlg).toContain("reason === 'active_subscription'");
    expect(dlg).toContain('context?.json');
  });
});
