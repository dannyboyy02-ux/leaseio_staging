// Centralized pricing configuration - Single source of truth

export type SubscriptionPlan = 'free' | 'starter' | 'pro' | 'business';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanConfig {
  id: SubscriptionPlan;
  nameKey: string;
  descriptionKey: string;
  price: {
    monthly: number;
    annual: number;
  };
  documentLimit: number;
  featureKeys: string[];
  teamMembers: number;
  hasTeamAccess: boolean;
  hasAdvancedReports: boolean;
  hasQuickBooks: boolean;
  hasSmsNotifications: boolean;
  hasRiskAnalysis: boolean;
  hasPrioritySupport: boolean;
  popular?: boolean;
}

export const PLANS: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    id: 'free',
    nameKey: 'plan.free',
    descriptionKey: 'plan.description.free',
    price: { monthly: 0, annual: 0 },
    documentLimit: 1,
    featureKeys: [
      'plan.feature.1_lease',
      'plan.feature.ai_extraction',
      'plan.feature.basic_tracking',
      'plan.feature.email_notifications',
    ],
    teamMembers: 0,
    hasTeamAccess: false,
    hasAdvancedReports: false,
    hasQuickBooks: false,
    hasSmsNotifications: false,
    hasRiskAnalysis: false,
    hasPrioritySupport: false,
  },
  starter: {
    id: 'starter',
    nameKey: 'plan.starter',
    descriptionKey: 'plan.description.starter',
    price: { monthly: 29, annual: 278 }, // ~20% annual discount
    documentLimit: 5,
    featureKeys: [
      'plan.feature.5_leases',
      'plan.feature.ai_extraction',
      'plan.feature.rent_schedule',
      'plan.feature.email_notifications',
      'plan.feature.rent_roll',
      'plan.feature.document_storage',
    ],
    teamMembers: 0,
    hasTeamAccess: false,
    hasAdvancedReports: false,
    hasQuickBooks: false,
    hasSmsNotifications: false,
    hasRiskAnalysis: false,
    hasPrioritySupport: false,
  },
  pro: {
    id: 'pro',
    nameKey: 'plan.pro',
    descriptionKey: 'plan.description.pro',
    price: { monthly: 79, annual: 758 },
    documentLimit: 15,
    featureKeys: [
      'plan.feature.15_leases',
      'plan.feature.everything_starter',
      'plan.feature.sms',
      'plan.feature.risk_analysis',
      'plan.feature.advanced_reports',
      'plan.feature.priority_support',
    ],
    teamMembers: 0,
    hasTeamAccess: false,
    hasAdvancedReports: true,
    hasQuickBooks: false,
    hasSmsNotifications: true,
    hasRiskAnalysis: true,
    hasPrioritySupport: true,
    popular: true,
  },
  business: {
    id: 'business',
    nameKey: 'plan.business',
    descriptionKey: 'plan.description.business',
    price: { monthly: 199, annual: 1910 },
    documentLimit: 50,
    featureKeys: [
      'plan.feature.50_leases',
      'plan.feature.everything_pro',
      'plan.feature.team_access',
      'plan.feature.role_permissions',
      'plan.feature.quickbooks',
      'plan.feature.custom_branding',
    ],
    teamMembers: 5,
    hasTeamAccess: true,
    hasAdvancedReports: true,
    hasQuickBooks: true,
    hasSmsNotifications: true,
    hasRiskAnalysis: true,
    hasPrioritySupport: true,
  },
};

export const PLAN_ORDER: SubscriptionPlan[] = ['free', 'starter', 'pro', 'business'];

export const OVERAGE_PRICE_PER_DOCUMENT = 8;
export const ADDITIONAL_SEAT_PRICE = 15;
export const TRIAL_DAYS = 14;
export const ANNUAL_DISCOUNT_PERCENT = 20;

// Helper functions
export function getPlanByIndex(index: number): PlanConfig {
  return PLANS[PLAN_ORDER[index]];
}

export function getPlanIndex(planId: SubscriptionPlan): number {
  return PLAN_ORDER.indexOf(planId);
}

export function isUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
  return getPlanIndex(targetPlan) > getPlanIndex(currentPlan);
}

export function getPerLeasePrice(plan: PlanConfig, interval: BillingInterval): string {
  const totalPrice = interval === 'annual' ? plan.price.annual : plan.price.monthly * 12;
  if (plan.documentLimit === 0 || totalPrice === 0) return '$0';
  const perLease = totalPrice / plan.documentLimit / 12;
  return `$${perLease.toFixed(2)}`;
}

export function getAnnualSavings(plan: PlanConfig): number {
  return (plan.price.monthly * 12) - plan.price.annual;
}

export function canAccessFeature(
  currentPlan: SubscriptionPlan,
  feature: 'teamAccess' | 'advancedReports' | 'quickBooks' | 'smsNotifications' | 'riskAnalysis' | 'prioritySupport'
): boolean {
  const plan = PLANS[currentPlan];
  switch (feature) {
    case 'teamAccess': return plan.hasTeamAccess;
    case 'advancedReports': return plan.hasAdvancedReports;
    case 'quickBooks': return plan.hasQuickBooks;
    case 'smsNotifications': return plan.hasSmsNotifications;
    case 'riskAnalysis': return plan.hasRiskAnalysis;
    case 'prioritySupport': return plan.hasPrioritySupport;
    default: return false;
  }
}
