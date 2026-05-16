import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { PLANS } from '@/config/pricing';

export default function Upgrade() {
  const { t } = useLanguage();
  const plan = PLANS.business;

  return (
    <AppLayout>
      <AppHeader title={t('upgrade.title')} subtitle={t('upgrade.subtitle')} />
      <div className="p-6">
        <Card className="mx-auto max-w-3xl border-primary/20 shadow-lg">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-2xl">{t(plan.nameKey)}</CardTitle>
              <Badge variant="business">Recommended</Badge>
            </div>
            <p className="text-muted-foreground">{t(plan.descriptionKey)}</p>
            <p className="text-3xl font-bold">${plan.price.monthly}<span className="text-base font-normal text-muted-foreground"> / month</span></p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2">
              {plan.featureKeys.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-green-600" />
                  {t(f)}
                </li>
              ))}
            </ul>
            {/* Route into the subscription tab pre-armed with autoCheckout=1.
                AccountSettings.tsx (around line 414) reads this and fires
                proceedWithCheckout('business'). Same handoff onboarding uses
                — single source of truth for the Stripe checkout call. */}
            <Button asChild className="w-full">
              <Link to="/app/settings/account?tab=subscription&autoCheckout=1">
                Upgrade to Business
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
