import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Check } from 'lucide-react';

const plans = [
  {
    name: 'Pro',
    price: '$49',
    period: '/month',
    description: 'Perfect for small portfolios and getting started.',
    documents: '3 leases',
    features: [
      'AI lease extraction',
      'Rent schedule tracking',
      'Email notifications',
      'Renewal & expiration alerts',
      'One-click rent roll export',
      'Document storage',
    ],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Business',
    price: '$149',
    period: '/month',
    description: 'For growing portfolios that need more.',
    documents: 'Up to 20 leases',
    features: [
      'Everything in Pro',
      'Advanced reporting',
      'Portfolio analytics',
      'Priority support',
      'Team access (coming soon)',
      'QuickBooks sync (coming soon)',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Simple pricing, no surprises
          </h2>
          <p className="text-lg text-muted-foreground">
            Start with a 14-day free trial. No credit card required. Upgrade as your portfolio grows.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {plans.map((plan) => (
            <Card 
              key={plan.name} 
              className={`relative ${plan.popular ? 'border-primary shadow-lg scale-105' : ''}`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-primary text-primary-foreground text-sm font-medium">
                  Most Popular
                </div>
              )}
              <CardHeader className="text-center pb-2">
                <h3 className="font-display text-2xl font-bold text-foreground">{plan.name}</h3>
                <div className="mt-4">
                  <span className="text-4xl font-bold text-foreground">{plan.price}</span>
                  <span className="text-muted-foreground">{plan.period}</span>
                </div>
                <p className="text-muted-foreground mt-2">{plan.description}</p>
                <div className="mt-4 inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-sm font-medium">
                  {plan.documents}
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-accent shrink-0 mt-0.5" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Button 
                  className="w-full" 
                  variant={plan.popular ? 'default' : 'outline'}
                  asChild
                >
                  <Link to={`/signup?plan=${plan.name.toLowerCase()}`}>{plan.cta}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-center text-sm text-muted-foreground mt-8">
          Questions? <Link to="mailto:support@leaseio.app" className="underline">Contact us</Link> for custom enterprise pricing.
        </p>
      </div>
    </section>
  );
}