import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Check } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { PLANS, PLAN_ORDER, ANNUAL_DISCOUNT_PERCENT, type BillingInterval } from '@/config/pricing';
import { cn } from '@/lib/utils';

export function PricingSection() {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');

  return (
    <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Simple pricing, no surprises
          </h2>
          <p className="text-lg text-muted-foreground">
            Start with a 14-day free trial. No credit card required. Upgrade as your portfolio grows.
          </p>
        </div>

        {/* Billing Toggle */}
        <div className="flex items-center justify-center gap-4 mb-12">
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

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
          {PLAN_ORDER.map((planId) => {
            const plan = PLANS[planId];
            const price = billingInterval === 'annual' 
              ? Math.round(plan.price.annual / 12) 
              : plan.price.monthly;
            
            return (
              <Card 
                key={plan.id} 
                className={cn(
                  "relative flex flex-col",
                  plan.popular && 'border-primary shadow-lg ring-2 ring-primary/20'
                )}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                    Most Popular
                  </div>
                )}
                <CardHeader className="text-center pb-2 pt-6">
                  <h3 className="font-display text-xl font-bold text-foreground">{plan.name}</h3>
                  <div className="mt-3">
                    {price === 0 ? (
                      <span className="text-3xl font-bold text-foreground">Free</span>
                    ) : (
                      <>
                        <span className="text-3xl font-bold text-foreground">${price}</span>
                        <span className="text-muted-foreground">/mo</span>
                      </>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">{plan.description}</p>
                  <div className="mt-3 inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-xs font-medium">
                    {plan.documentLimit} {plan.documentLimit === 1 ? 'lease' : 'leases'}
                  </div>
                </CardHeader>
                <CardContent className="pt-4 flex-1 flex flex-col">
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                        <span className="text-sm text-muted-foreground">{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Button 
                    className="w-full" 
                    variant={plan.popular ? 'default' : plan.id === 'free' ? 'secondary' : 'outline'}
                    asChild
                  >
                    <Link to={`/signup?plan=${plan.id}`}>
                      {plan.id === 'free' ? 'Get Started' : 'Start Free Trial'}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="text-center text-sm text-muted-foreground mt-10">
          Need more? <Link to="mailto:support@leaseio.app" className="underline hover:text-foreground transition-colors">Contact us</Link> for custom enterprise pricing.
        </p>
      </div>
    </section>
  );
}
