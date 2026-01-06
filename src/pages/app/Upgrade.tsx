import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Check, ArrowLeft, Sparkles } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { PLANS, PLAN_ORDER, ANNUAL_DISCOUNT_PERCENT, isUpgrade, type BillingInterval } from '@/config/pricing';
import type { SubscriptionPlan } from '@/types';

const featureHighlights: Record<string, { title: string; description: string }> = {
  reports: {
    title: 'Unlock Reporting Dashboards',
    description: 'Get portfolio analytics, renewal pipelines, escalation calendars, and rent projections.',
  },
  integrations: {
    title: 'Unlock QuickBooks Integration',
    description: 'Sync lease payments and receivables with your accounting system automatically.',
  },
  teams: {
    title: 'Unlock Team Access',
    description: 'Invite team members with role-based permissions to collaborate on leases.',
  },
};

export default function Upgrade() {
  const [searchParams] = useSearchParams();
  const feature = searchParams.get('feature');
  const { workspace } = useApp();
  const currentPlan = (workspace?.plan || 'free') as SubscriptionPlan;
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');

  const highlight = feature ? featureHighlights[feature] : null;

  return (
    <AppLayout>
      <AppHeader
        title="Upgrade Your Plan"
        subtitle="Unlock more features and scale your lease management"
        actions={
          <Button variant="ghost" asChild>
            <Link to="/app/dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
        }
      />

      <div className="p-6 max-w-6xl mx-auto">
        {/* Feature Highlight Banner */}
        {highlight && (
          <Card variant="feature" className="mb-8 animate-fade-up">
            <CardContent className="flex items-center gap-4 py-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent">
                <Sparkles className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">{highlight.title}</h3>
                <p className="text-muted-foreground">{highlight.description}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Billing Toggle */}
        <div className="flex items-center justify-center gap-4 mb-8">
          <span className={cn(
            "text-sm font-medium transition-colors",
            billingInterval === 'monthly' ? 'text-foreground' : 'text-muted-foreground'
          )}>
            Monthly
          </span>
          <Switch
            checked={billingInterval === 'annual'}
            onCheckedChange={(checked) => setBillingInterval(checked ? 'annual' : 'monthly')}
          />
          <span className={cn(
            "text-sm font-medium transition-colors",
            billingInterval === 'annual' ? 'text-foreground' : 'text-muted-foreground'
          )}>
            Annual
          </span>
          <span className="ml-2 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-medium">
            Save {ANNUAL_DISCOUNT_PERCENT}%
          </span>
        </div>

        {/* Plans Grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((planId, index) => {
            const plan = PLANS[planId];
            const isCurrent = currentPlan === planId;
            const isUpgradeOption = isUpgrade(currentPlan, planId);
            const isDowngradeOption = !isCurrent && !isUpgradeOption;
            const price = billingInterval === 'annual' 
              ? Math.round(plan.price.annual / 12) 
              : plan.price.monthly;

            return (
              <Card
                key={plan.id}
                variant={plan.popular ? 'feature' : 'default'}
                className={cn(
                  'relative flex flex-col animate-fade-up',
                  isCurrent && 'ring-2 ring-accent',
                  plan.popular && 'ring-2 ring-primary/50'
                )}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="pro">Most Popular</Badge>
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute -top-3 right-4">
                    <Badge variant="secondary">Current</Badge>
                  </div>
                )}
                <CardHeader className="pt-8 pb-4">
                  <CardTitle className="text-lg">{plan.name}</CardTitle>
                  <div className="flex items-baseline gap-1 mt-2">
                    {price === 0 ? (
                      <span className="text-3xl font-bold">Free</span>
                    ) : (
                      <>
                        <span className="text-3xl font-bold">${price}</span>
                        <span className="text-muted-foreground">/mo</span>
                      </>
                    )}
                  </div>
                  <CardDescription className="mt-2">{plan.description}</CardDescription>
                  <div className="mt-3 inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-xs font-medium">
                    {plan.documentLimit} {plan.documentLimit === 1 ? 'lease' : 'leases'}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-start gap-2 text-sm">
                        <Check className="h-4 w-4 text-success shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">{feat}</span>
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Button variant="secondary" className="w-full" disabled>
                      Current Plan
                    </Button>
                  ) : isUpgradeOption ? (
                    <Button variant="accent" className="w-full">
                      Upgrade to {plan.name}
                    </Button>
                  ) : isDowngradeOption && planId !== 'free' ? (
                    <Button variant="outline" className="w-full">
                      Downgrade to {plan.name}
                    </Button>
                  ) : planId === 'free' ? (
                    <Button variant="ghost" className="w-full" disabled>
                      Free Tier
                    </Button>
                  ) : (
                    <Button variant="outline" className="w-full">
                      Select Plan
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* FAQ Section */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Frequently Asked Questions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="font-medium mb-1">Can I upgrade or downgrade anytime?</h4>
              <p className="text-sm text-muted-foreground">
                Yes! You can change your plan at any time. When upgrading, you'll be charged a prorated amount. When downgrading, changes take effect at your next billing cycle.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">What happens to my data if I downgrade?</h4>
              <p className="text-sm text-muted-foreground">
                Your data remains safe. However, if you exceed the document limit of your new plan, you won't be able to add new documents until you're within the limit.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">Do you offer annual billing?</h4>
              <p className="text-sm text-muted-foreground">
                Yes! Toggle to annual billing above to save {ANNUAL_DISCOUNT_PERCENT}% on any paid plan.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
