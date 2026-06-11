export type SubscriptionPlan = 'starter' | 'business';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanConfig {
  id: SubscriptionPlan;
  name: string;
  nameKey: string;
  descriptionKey: string;
  price: {
    monthly: number;
    annual: number;
  };
  maxUsers: number;
  maxActiveLeases: number;
  maxArchivedLeases: number;
  /**
   * Maximum workspaces a single account holder may OWN on this plan.
   * Starter is single-workspace; Business enables owner-level multi-workspace
   * (each additional workspace is its own Business subscription). The cap is
   * enforced server-side in the create-workspace edge function under an advisory
   * lock — this value is the shared source of truth (mirrored in
   * supabase/functions/_shared/workspace_limits.ts).
   */
  maxWorkspaces: number;
  abstractionsIncluded: number;
  overagePerDoc: number;
  featureKeys: string[];
  hasTeamAccess: boolean;
  hasAdvancedReports: boolean;
  hasRoleBasedAccess: boolean;
  hasBulkUpload: boolean;
  hasExportIntegrations: boolean;
  hasPrioritySupport: boolean;
  hasAiAssistant: boolean;
  popular?: boolean;
}

export const PLANS: Record<SubscriptionPlan, PlanConfig> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    nameKey: 'plan.starter',
    descriptionKey: 'plan.description.starter',
    price: { monthly: 249, annual: 2390 },
    maxUsers: 3,
    maxActiveLeases: 15,
    maxArchivedLeases: 50,
    maxWorkspaces: 1,
    abstractionsIncluded: 15,
    overagePerDoc: 12,
    featureKeys: [
      'plan.feature.lease_request_intake',
      'plan.feature.ai_extraction',
      'plan.feature.pipeline_visibility',
      'plan.feature.audit_package',
      'plan.feature.15_abstractions_mo',
      'plan.feature.3_users',
    ],
    hasTeamAccess: true,
    hasAdvancedReports: false,
    hasRoleBasedAccess: false,
    hasBulkUpload: false,
    hasExportIntegrations: false,
    hasPrioritySupport: false,
    hasAiAssistant: false,
  },
  business: {
    id: 'business',
    name: 'Business',
    nameKey: 'plan.business',
    descriptionKey: 'plan.description.business',
    price: { monthly: 499, annual: 4790 },
    maxUsers: -1,
    maxActiveLeases: 50,
    maxArchivedLeases: 250,
    maxWorkspaces: 10,
    abstractionsIncluded: 50,
    overagePerDoc: 10,
    featureKeys: [
      'plan.feature.everything_starter',
      'plan.feature.50_abstractions_mo',
      'plan.feature.ai_assistant',
      'plan.feature.portfolio_intelligence',
      'plan.feature.amendment_comparison',
      'plan.feature.unlimited_users',
      'plan.feature.priority_support',
    ],
    hasTeamAccess: true,
    hasAdvancedReports: true,
    hasRoleBasedAccess: true,
    hasBulkUpload: true,
    hasExportIntegrations: true,
    hasPrioritySupport: true,
    hasAiAssistant: true,
    popular: true,
  },
};

export const PLAN_ORDER: SubscriptionPlan[] = ['starter', 'business'];

export const PER_DOCUMENT_ABSTRACTION_PRICE = 12;
export const ANNUAL_DISCOUNT_PERCENT = 20;

// ── Document capacity packs (monthly add-on subscriptions) ──────────────────
//
// A workspace at/near its monthly abstraction limit can buy a recurring pack
// that raises BOTH its monthly-abstraction allowance AND its active-lease cap
// by `size`, while the pack is active. Each pack is its own Stripe subscription
// (full price charged on purchase, no proration, cancel-at-period-end), tagged
// metadata.addon_type='document_pack' so the webhook never confuses it with a
// plan subscription. Capacity is additive — multiple/larger packs stack.
//
// Pricing rationale (ratified 2026-06-11, see PRODUCT_STRATEGY.md):
//   - Every pack's per-lease price beats BOTH overage rates ($12 starter /
//     $10 business), so a pack is always the cheaper relief valve vs overage.
//   - Worst case $7/lease clears the 75% margin floor (~$4.80/lease at 2x AI
//     cost) with wide headroom.
//   - Per-lease price falls with size (9 → 8 → 7) to reward larger commitment
//     without cannibalizing the Starter→Business upgrade path.
//
// Stripe Price IDs are NOT hardcoded — they come from env vars at deploy time
// (operator creates the recurring Prices first), mirroring the annual-price
// pattern. The purchase path fails closed if a pack's price id is unset.
export interface DocumentPackConfig {
  id: 'pack_10' | 'pack_20' | 'pack_50';
  /** Additional leases/abstractions per month this pack grants. */
  size: number;
  /** Monthly price in USD (whole dollars). */
  priceMonthly: number;
  /** i18n key for the pack's display name. */
  nameKey: string;
  /** Env var holding the Stripe recurring Price ID (server-side). */
  stripePriceEnvVar: string;
}

export const DOCUMENT_PACKS: DocumentPackConfig[] = [
  { id: 'pack_10', size: 10, priceMonthly: 90,  nameKey: 'packs.pack_10', stripePriceEnvVar: 'STRIPE_PRICE_PACK_10' },
  { id: 'pack_20', size: 20, priceMonthly: 160, nameKey: 'packs.pack_20', stripePriceEnvVar: 'STRIPE_PRICE_PACK_20' },
  { id: 'pack_50', size: 50, priceMonthly: 350, nameKey: 'packs.pack_50', stripePriceEnvVar: 'STRIPE_PRICE_PACK_50' },
];

/** Per-lease price of a pack, rounded to the nearest cent. */
export function packPerLeasePrice(pack: DocumentPackConfig): number {
  return Math.round((pack.priceMonthly / pack.size) * 100) / 100;
}

export function getPlanByIndex(index: number): PlanConfig {
  return PLANS[PLAN_ORDER[index]];
}

export function getPlanIndex(planId: SubscriptionPlan): number {
  return PLAN_ORDER.indexOf(planId);
}

export function isUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
  return getPlanIndex(targetPlan) > getPlanIndex(currentPlan);
}

/** Normalise legacy plan IDs from DB to the canonical SubscriptionPlan type. */
export function normalizePlanId(raw: string | null | undefined): SubscriptionPlan {
  if (raw === 'business') return 'business';
  return 'starter'; // treats 'free', 'pro', null, or unknown as starter
}
