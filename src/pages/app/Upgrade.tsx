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
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { cn } from '@/lib/utils';
import { PLANS, PLAN_ORDER, ANNUAL_DISCOUNT_PERCENT, isUpgrade, type BillingInterval } from '@/config/pricing';
import type { SubscriptionPlan } from '@/types';
import { useToast } from '@/hooks/use-toast';

export default function Upgrade() {
  const { t } = useAppTranslation();
  const [searchParams] = useSearchParams();
  const feature = searchParams.get('feature');
  const { workspace } = useApp();
  const currentPlan = (workspace?.plan || 'free') as SubscriptionPlan;
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const { toast } = useToast();

  const featureHighlights: Record<string, { title: string; description: string }> = {
    reports: {
      title: t('upgrade.highlight_reports'),
      description: t('upgrade.highlight_reports_desc'),
    },
    integrations: {
      title: t('upgrade.highlight_integrations'),
      description: t('upgrade.highlight_integrations_desc'),
    },
    teams: {
      title: t('upgrade.highlight_teams'),
      description: t('upgrade.highlight_teams_desc'),
    },
  };

  const handlePlanAction = (planId: string, action: 'upgrade' | 'downgrade') => {
    toast({
      title: `${action === 'upgrade' ? t('upgrade.upgrade_to') : t('upgrade.downgrade_to')} ${PLANS[planId as SubscriptionPlan].name}`,
      description: t('upgrade.payment_coming'),
    });
  };

  const highlight = feature ? featureHighlights[feature] : null;

  return (
    <AppLayout>
      <AppHeader
        title={t('upgrade.title')}
        subtitle={t('upgrade.subtitle')}
        actions={
          <Button variant="ghost" asChild>
            <Link to="/app/dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t('upgrade.back_to_dashboard')}
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
            {t('upgrade.monthly')}
          </span>
          <Switch
            checked={billingInterval === 'annual'}
            onCheckedChange={(checked) => setBillingInterval(checked ? 'annual' : 'monthly')}
          />
          <span className={cn(
            "text-sm font-medium transition-colors",
            billingInterval === 'annual' ? 'text-foreground' : 'text-muted-foreground'
          )}>
            {t('upgrade.annual')}
          </span>
          <span className="ml-2 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-medium">
            {t('upgrade.save')} {ANNUAL_DISCOUNT_PERCENT}%
          </span>
        </div>

        {/* Plans Grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((planId, index) => {
            const plan = PLANS[planId];
            const isCurrent = currentPlan === planId;
            const isUpgradeOption = isUpgrade(currentPlan, planId);
            const isDowngradeOption = !isCurrent && !isUpgradeOption;
            const monthlyPrice = plan.price.monthly;
            const annualTotal = plan.price.annual;
            const annualMonthly = Math.round(annualTotal / 12);
            const annualSavings = (monthlyPrice * 12) - annualTotal;
            const isAnnual = billingInterval === 'annual';
            const displayPrice = isAnnual ? annualMonthly : monthlyPrice;

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
                    <Badge variant="pro">{t('upgrade.most_popular')}</Badge>
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute -top-3 right-4">
                    <Badge variant="secondary">{t('upgrade.current')}</Badge>
                  </div>
                )}
                <CardHeader className="pt-8 pb-4">
                  <CardTitle className="text-lg">{t(plan.nameKey)}</CardTitle>
                  <div className="mt-2">
                    {displayPrice === 0 ? (
                      <span className="text-3xl font-bold">{t('upgrade.free')}</span>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-bold">${displayPrice}</span>
                          <span className="text-muted-foreground">{t('upgrade.per_month')}</span>
                        </div>
                        {isAnnual && (
                          <div className="text-xs text-muted-foreground">
                            ${annualTotal}{t('upgrade.per_year')} · {t('upgrade.save')} ${annualSavings}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <CardDescription className="mt-2">{t(plan.descriptionKey)}</CardDescription>
                  <div className="mt-3 inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-xs font-medium">
                    {plan.documentLimit} {plan.documentLimit === 1 ? t('upgrade.lease') : t('upgrade.leases')}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {plan.featureKeys.map((featureKey) => (
                      <li key={featureKey} className="flex items-start gap-2 text-sm">
                        <Check className="h-4 w-4 text-success shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">{t(featureKey)}</span>
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Button variant="secondary" className="w-full" disabled>
                      {t('upgrade.current_plan')}
                    </Button>
                  ) : isUpgradeOption ? (
                    <Button variant="accent" className="w-full" onClick={() => handlePlanAction(planId, 'upgrade')}>
                      {t('upgrade.upgrade_to')} {t(plan.nameKey)}
                    </Button>
                  ) : isDowngradeOption && planId !== 'free' ? (
                    <Button variant="outline" className="w-full" onClick={() => handlePlanAction(planId, 'downgrade')}>
                      {t('upgrade.downgrade_to')} {t(plan.nameKey)}
                    </Button>
                  ) : planId === 'free' ? (
                    <Button variant="ghost" className="w-full" disabled>
                      {t('upgrade.free_tier')}
                    </Button>
                  ) : (
                    <Button variant="outline" className="w-full" onClick={() => handlePlanAction(planId, 'upgrade')}>
                      {t('upgrade.select_plan')}
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
            <CardTitle>{t('upgrade.faq_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="font-medium mb-1">{t('upgrade.faq1_q')}</h4>
              <p className="text-sm text-muted-foreground">
                {t('upgrade.faq1_a')}
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">{t('upgrade.faq2_q')}</h4>
              <p className="text-sm text-muted-foreground">
                {t('upgrade.faq2_a')}
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">{t('upgrade.faq3_q')}</h4>
              <p className="text-sm text-muted-foreground">
                {t('upgrade.faq3_a', { percent: ANNUAL_DISCOUNT_PERCENT })}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
