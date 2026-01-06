// Centralized pricing configuration - Single source of truth

export type SubscriptionPlan = 'free' | 'starter' | 'pro' | 'business';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanConfig {
  id: SubscriptionPlan;
  name: string;
  description: string;
  price: {
    monthly: number;
    annual: number;
  };
  documentLimit: number;
  features: string[];
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
    name: 'Free',
    description: 'Try LeaseIO with a single lease',
    price: { monthly: 0, annual: 0 },
    documentLimit: 1,
    features: [
      '1 lease document',
      'AI lease extraction',
      'Basic rent tracking',
      'Email notifications',
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
    name: 'Starter',
    description: 'Perfect for small portfolios',
    price: { monthly: 29, annual: 278 }, // ~20% annual discount
    documentLimit: 5,
    features: [
      '5 lease documents',
      'AI lease extraction',
      'Rent schedule tracking',
      'Email notifications',
      'Rent roll export',
      'Document storage',
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
    name: 'Pro',
    description: 'For growing property managers',
    price: { monthly: 79, annual: 758 },
    documentLimit: 15,
    features: [
      '15 lease documents',
      'Everything in Starter',
      'SMS notifications',
      'Risk analysis',
      'Advanced reporting',
      'Priority support',
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
    name: 'Business',
    description: 'For teams and enterprises',
    price: { monthly: 199, annual: 1910 },
    documentLimit: 50,
    features: [
      '50 lease documents',
      'Everything in Pro',
      'Team access (5 seats)',
      'Role-based permissions',
      'QuickBooks integration',
      'Custom branding',
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
