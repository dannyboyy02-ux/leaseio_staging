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
