import { Link2, ExternalLink, Check, Lock, ArrowRight } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

interface Integration {
  id: string;
  nameKey: string;
  descKey: string;
  icon: string;
  status: 'connected' | 'disconnected' | 'locked';
  requiresPlan: 'pro' | 'business';
  lastSync?: string;
}

const integrations: Integration[] = [
  {
    id: 'quickbooks',
    nameKey: 'integrations.quickbooks',
    descKey: 'integrations.quickbooks_desc',
    icon: '📊',
    status: 'disconnected',
    requiresPlan: 'business',
  },
  {
    id: 'email',
    nameKey: 'integrations.email',
    descKey: 'integrations.email_desc',
    icon: '📧',
    status: 'connected',
    requiresPlan: 'pro',
    lastSync: new Date().toISOString(),
  },
  {
    id: 'sms',
    nameKey: 'integrations.sms',
    descKey: 'integrations.sms_desc',
    icon: '📱',
    status: 'connected',
    requiresPlan: 'pro',
    lastSync: new Date().toISOString(),
  },
];

export default function Integrations() {
  const { canAccessFeature } = useApp();
  const { t } = useLanguage();

  const getIntegrationStatus = (integration: Integration) => {
    if (!canAccessFeature(integration.requiresPlan)) {
      return 'locked';
    }
    return integration.status;
  };

  return (
    <AppLayout>
      <AppHeader
        title={t('integrations.title')}
        subtitle={t('integrations.subtitle')}
      />

      <div className="p-6">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration, index) => {
            const status = getIntegrationStatus(integration);
            const isLocked = status === 'locked';
            const isConnected = status === 'connected';

            return (
              <Card
                key={integration.id}
                variant={isLocked ? 'outline' : 'default'}
                className={cn(
                  'animate-fade-up relative',
                  isLocked && 'opacity-75'
                )}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {integration.requiresPlan === 'business' && (
                  <div className="absolute top-4 right-4">
                    <Badge variant="business">{t('plan.business')}</Badge>
                  </div>
                )}
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-2xl">
                      {integration.icon}
                    </div>
                    <div>
                      <CardTitle className="text-base">{t(integration.nameKey)}</CardTitle>
                      {isConnected && integration.lastSync && (
                        <p className="text-xs text-success flex items-center gap-1 mt-1">
                          <Check className="h-3 w-3" />
                          {t('integrations.connected')}
                        </p>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="mb-4">
                    {t(integration.descKey)}
                  </CardDescription>

                  {isLocked ? (
                    <Button variant="outline" className="w-full" asChild>
                      <Link to="/app/upgrade?feature=integrations">
                        <Lock className="h-4 w-4 mr-2" />
                        {t('integrations.upgrade_business')}
                        <ArrowRight className="h-4 w-4 ml-auto" />
                      </Link>
                    </Button>
                  ) : isConnected ? (
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1">
                        {t('integrations.configure')}
                      </Button>
                      <Button variant="ghost" className="text-destructive hover:text-destructive">
                        {t('integrations.disconnect')}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="accent" className="w-full">
                      <Link2 className="h-4 w-4 mr-2" />
                      {t('integrations.connect')}
                      <ExternalLink className="h-4 w-4 ml-auto" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Integration Guide */}
        <Card variant="feature" className="mt-8">
          <CardHeader>
            <CardTitle>{t('integrations.guide')}</CardTitle>
            <CardDescription>
              {t('integrations.guide_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">{t('integrations.step1')}</h4>
                <p className="text-sm text-muted-foreground">
                  {t('integrations.step1_desc')}
                </p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">{t('integrations.step2')}</h4>
                <p className="text-sm text-muted-foreground">
                  {t('integrations.step2_desc')}
                </p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">{t('integrations.step3')}</h4>
                <p className="text-sm text-muted-foreground">
                  {t('integrations.step3_desc')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
