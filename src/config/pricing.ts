export type SubscriptionPlan = 'free' | 'business';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanConfig {
  id: SubscriptionPlan;
  nameKey: string;
  descriptionKey: string;
  price: {
    monthly: number;
    annual: number;
  };
  maxUsers: number;
  maxActiveLeases: number;
  abstractionsIncluded: number;
  featureKeys: string[];
  hasTeamAccess: boolean;
  hasAdvancedReports: boolean;
  hasRoleBasedAccess: boolean;
  hasBulkUpload: boolean;
  hasExportIntegrations: boolean;
  hasPrioritySupport: boolean;
  popular?: boolean;
}

export const PLANS: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    id: 'free',
    nameKey: 'plan.free',
    descriptionKey: 'plan.description.free',
    price: { monthly: 0, annual: 0 },
    maxUsers: 3,
    maxActiveLeases: 5,
    abstractionsIncluded: 1,
    featureKeys: [
      'plan.feature.lease_request_intake',
      'plan.feature.pipeline_visibility',
      'plan.feature.basic_notifications',
      'plan.feature.status_tracking',
      'plan.feature.1_abstraction',
    ],
    hasTeamAccess: false,
    hasAdvancedReports: false,
    hasRoleBasedAccess: false,
    hasBulkUpload: false,
    hasExportIntegrations: false,
    hasPrioritySupport: false,
  },
  business: {
    id: 'business',
    nameKey: 'plan.business',
    descriptionKey: 'plan.description.business',
    price: { monthly: 299, annual: 2870 },
    maxUsers: -1,
    maxActiveLeases: -1,
    abstractionsIncluded: -1,
    featureKeys: [
      'plan.feature.everything_free',
      'plan.feature.unlimited_users',
      'plan.feature.unlimited_leases',
      'plan.feature.unlimited_abstraction',
      'plan.feature.audit_package',
      'plan.feature.role_based_access',
      'plan.feature.bulk_upload',
      'plan.feature.export_integrations',
      'plan.feature.priority_support',
    ],
    hasTeamAccess: true,
    hasAdvancedReports: true,
    hasRoleBasedAccess: true,
    hasBulkUpload: true,
    hasExportIntegrations: true,
    hasPrioritySupport: true,
    popular: true,
  },
};

export const PLAN_ORDER: SubscriptionPlan[] = ['free', 'business'];

export const PER_DOCUMENT_ABSTRACTION_PRICE = 25;
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
