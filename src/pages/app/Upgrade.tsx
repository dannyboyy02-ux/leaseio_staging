import { useSearchParams, Link } from 'react-router-dom';
import { Check, Zap, Building2, ArrowLeft, Sparkles } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';

const plans = [
  {
    id: 'pro',
    name: 'Pro',
    price: 49,
    description: 'Perfect for small teams getting started with lease management',
    features: [
      '3 documents total',
      'AI-powered extraction',
      'Email & SMS notifications',
      'Lease review workflow',
      'Basic support',
    ],
    documentLimit: 3,
  },
  {
    id: 'business',
    name: 'Business',
    price: 149,
    description: 'For growing teams that need advanced features and integrations',
    features: [
      '20 documents included',
      'Everything in Pro',
      'CSV / Excel export',
      'Reporting dashboards',
      'QuickBooks Online integration',
      'Ownership transfer',
      'Priority support',
    ],
    documentLimit: 20,
    popular: true,
  },
];

const featureHighlights: Record<string, { title: string; description: string }> = {
  reports: {
    title: 'Unlock Reporting Dashboards',
    description: 'Get portfolio analytics, renewal pipelines, escalation calendars, and rent projections.',
  },
  integrations: {
    title: 'Unlock QuickBooks Integration',
    description: 'Sync lease payments and receivables with your accounting system automatically.',
  },
};

export default function Upgrade() {
  const [searchParams] = useSearchParams();
  const feature = searchParams.get('feature');
  const { workspace } = useApp();
  const currentPlan = workspace?.plan || 'pro';

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

      <div className="p-6 max-w-4xl mx-auto">
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

        {/* Plans Grid */}
        <div className="grid gap-6 md:grid-cols-2">
          {plans.map((plan, index) => {
            const isCurrent = currentPlan === plan.id;
            const isUpgrade = plan.id === 'business' && currentPlan === 'pro';
            const isDowngrade = plan.id === 'pro' && currentPlan === 'business';

            return (
              <Card
                key={plan.id}
                variant={plan.popular ? 'feature' : 'default'}
                className={cn(
                  'relative animate-fade-up',
                  isCurrent && 'ring-2 ring-accent'
                )}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-6">
                    <Badge variant="business">Recommended</Badge>
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute -top-3 right-6">
                    <Badge variant="secondary">Current Plan</Badge>
                  </div>
                )}
                <CardHeader className="pt-8">
                  <div className="flex items-center gap-2">
                    {plan.id === 'pro' ? (
                      <Zap className="h-5 w-5 text-primary" />
                    ) : (
                      <Building2 className="h-5 w-5 text-accent" />
                    )}
                    <CardTitle>{plan.name}</CardTitle>
                  </div>
                  <div className="flex items-baseline gap-1 mt-2">
                    <span className="text-4xl font-bold">${plan.price}</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  <CardDescription className="mt-2">{plan.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3 mb-6">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-success shrink-0" />
                        {feat}
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Button variant="secondary" className="w-full" disabled>
                      Current Plan
                    </Button>
                  ) : isUpgrade ? (
                    <Button variant="accent" className="w-full" size="lg">
                      Upgrade to Business
                    </Button>
                  ) : isDowngrade ? (
                    <Button variant="outline" className="w-full">
                      Downgrade to Pro
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
                Yes! Contact our sales team for annual billing options with up to 20% discount.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
