import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Check } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { PLANS, PLAN_ORDER, ANNUAL_DISCOUNT_PERCENT, type BillingInterval } from '@/config/pricing';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

export function PricingSection() {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const { t } = useLanguage();

  return (
    <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            {t('landing.pricing.title')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('landing.pricing.subtitle')}
          </p>
        </div>

        {/* Billing Toggle */}
        <div className="flex items-center justify-center gap-4 mb-12">
          <span className={cn(
            "text-sm font-medium transition-colors",
            billingInterval === 'monthly' ? 'text-foreground' : 'text-muted-foreground'
          )}>
            {t('landing.pricing.monthly')}
          </span>
          <Switch
            checked={billingInterval === 'annual'}
            onCheckedChange={(checked) => setBillingInterval(checked ? 'annual' : 'monthly')}
          />
          <span className={cn(
            "text-sm font-medium transition-colors",
            billingInterval === 'annual' ? 'text-foreground' : 'text-muted-foreground'
          )}>
            {t('landing.pricing.annual')}
          </span>
          <span className="ml-2 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-medium">
            {t('landing.pricing.save')} {ANNUAL_DISCOUNT_PERCENT}%
          </span>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
          {PLAN_ORDER.map((planId) => {
            const plan = PLANS[planId];
            const monthlyPrice = plan.price.monthly;
            const annualTotal = plan.price.annual;
            const annualMonthly = Math.round(annualTotal / 12);
            const annualSavings = (monthlyPrice * 12) - annualTotal;
            const isAnnual = billingInterval === 'annual';
            const displayPrice = isAnnual ? annualMonthly : monthlyPrice;
            const translatedFeatures = plan.featureKeys.map((featureKey) => t(featureKey));
            
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
                    {t('landing.pricing.most_popular')}
                  </div>
                )}
                <CardHeader className="text-center pb-2 pt-6">
                  <h3 className="font-display text-xl font-bold text-foreground">
                    {t(`plan.${plan.id}`)}
                  </h3>
                  <div className="mt-3">
                    {displayPrice === 0 ? (
                      <span className="text-3xl font-bold text-foreground">{t('landing.pricing.free')}</span>
                    ) : (
                      <div className="space-y-1">
                        <div>
                          <span className="text-3xl font-bold text-foreground">${displayPrice}</span>
                          <span className="text-muted-foreground">{t('landing.pricing.per_month')}</span>
                        </div>
                        {isAnnual && (
                          <div className="text-xs text-muted-foreground">
                            ${annualTotal}{t('landing.pricing.per_year')} · {t('landing.pricing.save')} ${annualSavings}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {t(plan.descriptionKey)}
                  </p>
                  <div className="mt-3 inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-xs font-medium">
                    {plan.documentLimit} {plan.documentLimit === 1 ? t('landing.pricing.lease') : t('landing.pricing.leases')}
                  </div>
                </CardHeader>
                <CardContent className="pt-4 flex-1 flex flex-col">
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {translatedFeatures.map((feature, idx) => (
                      <li key={idx} className="flex items-start gap-2">
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
                      {plan.id === 'free' ? t('landing.pricing.get_started') : t('landing.pricing.start_trial')}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="text-center text-sm text-muted-foreground mt-10">
          {t('landing.pricing.custom')} <Link to="mailto:support@leaseio.app" className="underline hover:text-foreground transition-colors">{t('landing.pricing.contact')}</Link> {t('landing.pricing.enterprise')}
        </p>
      </div>
    </section>
  );
}
