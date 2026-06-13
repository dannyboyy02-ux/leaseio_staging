// Shared source of truth for per-plan workspace ownership caps.
//
// Mirrors `maxWorkspaces` in src/config/pricing.ts. The client reads the config
// value for display (Settings → Usage, the "+ New workspace" affordance); the
// server enforces the cap in create-workspace under a per-owner advisory lock.
// Keep the two in sync — a divergence would let the UI offer a creation the
// server then rejects (or vice-versa).
//
// Multi-workspace is Business-only by product decision; Starter is pinned to 1.
export const WORKSPACE_LIMITS: Record<string, number> = {
  starter: 1,
  business: 10,
  // Vault is a read-only retention state, not a growth plan — a Vault owner
  // cannot create additional workspaces on it (VAULT_TIER_SPEC.md V2).
  vault: 0,
};

// Business monthly price — must match stripe-webhook PRICE_IDS.business and the
// create-checkout business monthly price. Hardcoded (existing production value).
export const BUSINESS_MONTHLY_PRICE_ID = "price_1SntqQH03PByDjY3MrvOjOsu";

// Per-workspace Business price in USD, for honest consent copy ("$499 today").
export const BUSINESS_MONTHLY_PRICE_USD = 499;
