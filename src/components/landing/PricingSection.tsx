import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { ANNUAL_DISCOUNT_PERCENT, PLAN_ORDER, PLANS, type BillingInterval } from '@/config/pricing';

export function PricingSection() {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const { t } = useLanguage();

  return (
    <section id="pricing" className="bg-muted/30 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto mb-12 max-w-3xl text-center">
          <h2 className="mb-4 font-display text-3xl font-bold text-foreground sm:text-4xl">{t('landing.pricing.title')}</h2>
          <p className="text-lg text-muted-foreground">{t('landing.pricing.subtitle')}</p>
        </div>

        <div className="mb-12 flex items-center justify-center gap-4">
          <span className={cn('text-sm font-medium', billingInterval === 'monthly' ? 'text-foreground' : 'text-muted-foreground')}>{t('landing.pricing.monthly')}</span>
          <Switch checked={billingInterval === 'annual'} onCheckedChange={(v) => setBillingInterval(v ? 'annual' : 'monthly')} />
          <span className={cn('text-sm font-medium', billingInterval === 'annual' ? 'text-foreground' : 'text-muted-foreground')}>{t('landing.pricing.annual')}</span>
          <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t('landing.pricing.save')} {ANNUAL_DISCOUNT_PERCENT}%</span>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {PLAN_ORDER.map((planId) => {
            const plan = PLANS[planId];
            const monthly = plan.price.monthly;
            const annual = plan.price.annual;
            const display = billingInterval === 'annual' ? Math.round(annual / 12) : monthly;

            return (
              <Card key={plan.id} className={cn('relative flex flex-col', plan.popular && 'ring-2 ring-primary/20 border-primary shadow-lg')}>
                {plan.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">{t('landing.pricing.most_popular')}</div>}
                <CardHeader className="pb-2 pt-6 text-center">
                  <h3 className="font-display text-xl font-bold text-foreground">{t(plan.nameKey)}</h3>
                  <div className="mt-3">
                    {display === 0 ? (
                      <span className="text-3xl font-bold text-foreground">{t('landing.pricing.free')}</span>
                    ) : (
                      <>
                        <span className="text-3xl font-bold text-foreground">${display}</span>
                        <span className="text-muted-foreground">{t('landing.pricing.per_month')}</span>
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{t(plan.descriptionKey)}</p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col pt-4">
                  <ul className="mb-6 flex-1 space-y-2.5">
                    {plan.featureKeys.map((featureKey) => (
                      <li key={featureKey} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                        <span className="text-sm text-muted-foreground">{t(featureKey)}</span>
                      </li>
                    ))}
                  </ul>
                  <Button className="w-full" variant={plan.popular ? 'default' : 'outline'} asChild>
                    <Link to={`/signup?plan=${plan.id}`}>{t('landing.pricing.start_trial')}</Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
