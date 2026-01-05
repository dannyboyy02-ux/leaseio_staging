import { Check, Zap, Building2, CreditCard, Download, ExternalLink } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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

const invoices = [
  { id: '1', date: '2025-01-01', amount: 149, status: 'paid' },
  { id: '2', date: '2024-12-01', amount: 149, status: 'paid' },
  { id: '3', date: '2024-11-01', amount: 149, status: 'paid' },
];

export default function BillingSettings() {
  const { workspace } = useApp();
  const currentPlan = workspace?.plan || 'pro';
  const usagePercent = workspace
    ? (workspace.documentsUsed / workspace.documentLimit) * 100
    : 0;

  return (
    <AppLayout>
      <AppHeader title="Billing" subtitle="Manage your subscription and payments" />

      <div className="p-6 space-y-8">
        {/* Current Plan & Usage */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Current Plan
                <Badge variant={currentPlan === 'business' ? 'business' : 'pro'}>
                  {currentPlan === 'business' ? 'Business' : 'Pro'}
                </Badge>
              </CardTitle>
              <CardDescription>
                Your subscription renews on{' '}
                {new Date(workspace?.renewalDate || '').toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-sm font-medium">Document Usage</span>
                    <span className="text-sm text-muted-foreground">
                      {workspace?.documentsUsed} / {workspace?.documentLimit}
                    </span>
                  </div>
                  <Progress
                    value={usagePercent}
                    variant={usagePercent >= 90 ? 'destructive' : usagePercent >= 75 ? 'warning' : 'accent'}
                    className="h-2"
                  />
                </div>
                <Button variant="outline" className="w-full">
                  <CreditCard className="h-4 w-4 mr-2" />
                  Manage Payment Method
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Billing Contact</CardTitle>
              <CardDescription>Invoices are sent to this email</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">{workspace?.name}</p>
                  <p className="text-sm text-muted-foreground">billing@acme.com</p>
                </div>
                <Button variant="outline" size="sm">
                  Update Billing Contact
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Plans */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Available Plans</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            {plans.map((plan, index) => {
              const isCurrent = currentPlan === plan.id;

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
                      <Badge variant="business">Most Popular</Badge>
                    </div>
                  )}
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      {plan.id === 'pro' ? (
                        <Zap className="h-5 w-5 text-primary" />
                      ) : (
                        <Building2 className="h-5 w-5 text-accent" />
                      )}
                      <CardTitle>{plan.name}</CardTitle>
                    </div>
                    <div className="flex items-baseline gap-1 mt-2">
                      <span className="text-3xl font-bold">${plan.price}</span>
                      <span className="text-muted-foreground">/month</span>
                    </div>
                    <CardDescription>{plan.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 mb-6">
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex items-center gap-2 text-sm">
                          <Check className="h-4 w-4 text-success shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                    {isCurrent ? (
                      <Button variant="secondary" className="w-full" disabled>
                        Current Plan
                      </Button>
                    ) : plan.id === 'business' ? (
                      <Button variant="accent" className="w-full">
                        Upgrade to Business
                      </Button>
                    ) : (
                      <Button variant="outline" className="w-full">
                        Downgrade to Pro
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Invoices */}
        <Card>
          <CardHeader>
            <CardTitle>Invoice History</CardTitle>
            <CardDescription>Download past invoices for your records</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {invoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="flex items-center justify-between py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {new Date(invoice.date).toLocaleDateString('en-US', {
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      ${invoice.amount}.00
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="success">{invoice.status}</Badge>
                    <Button variant="ghost" size="icon-sm">
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
