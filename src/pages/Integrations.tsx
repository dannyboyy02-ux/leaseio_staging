import { Link2, ExternalLink, Check, Lock, ArrowRight } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

interface Integration {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: 'connected' | 'disconnected' | 'locked';
  requiresPlan: 'pro' | 'business';
  lastSync?: string;
}

const integrations: Integration[] = [
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    description: 'Sync lease payments and receivables with your accounting system. Automate invoice creation and bill tracking.',
    icon: '📊',
    status: 'disconnected',
    requiresPlan: 'business',
  },
  {
    id: 'email',
    name: 'Email Notifications',
    description: 'Send automated email alerts for renewals, escalations, and expirations.',
    icon: '📧',
    status: 'connected',
    requiresPlan: 'pro',
    lastSync: new Date().toISOString(),
  },
  {
    id: 'sms',
    name: 'SMS Notifications',
    description: 'Receive critical lease alerts via SMS for time-sensitive events.',
    icon: '📱',
    status: 'connected',
    requiresPlan: 'pro',
    lastSync: new Date().toISOString(),
  },
];

export default function Integrations() {
  const { canAccessFeature } = useApp();

  const getIntegrationStatus = (integration: Integration) => {
    if (!canAccessFeature(integration.requiresPlan)) {
      return 'locked';
    }
    return integration.status;
  };

  return (
    <AppLayout>
      <AppHeader
        title="Integrations"
        subtitle="Connect LeaseIO with your other tools"
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
                    <Badge variant="business">Business</Badge>
                  </div>
                )}
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-2xl">
                      {integration.icon}
                    </div>
                    <div>
                      <CardTitle className="text-base">{integration.name}</CardTitle>
                      {isConnected && integration.lastSync && (
                        <p className="text-xs text-success flex items-center gap-1 mt-1">
                          <Check className="h-3 w-3" />
                          Connected
                        </p>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="mb-4">
                    {integration.description}
                  </CardDescription>

                  {isLocked ? (
                    <Button variant="outline" className="w-full" asChild>
                      <Link to="/app/upgrade?feature=integrations">
                        <Lock className="h-4 w-4 mr-2" />
                        Upgrade to Business
                        <ArrowRight className="h-4 w-4 ml-auto" />
                      </Link>
                    </Button>
                  ) : isConnected ? (
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1">
                        Configure
                      </Button>
                      <Button variant="ghost" className="text-destructive hover:text-destructive">
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <Button variant="accent" className="w-full">
                      <Link2 className="h-4 w-4 mr-2" />
                      Connect
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
            <CardTitle>Integration Guide</CardTitle>
            <CardDescription>
              Learn how to get the most out of your integrations
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">1. Connect Your Account</h4>
                <p className="text-sm text-muted-foreground">
                  Use OAuth to securely connect your external accounts without sharing passwords.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">2. Configure Settings</h4>
                <p className="text-sm text-muted-foreground">
                  Choose how data should flow between LeaseIO and your connected services.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-medium mb-2">3. Monitor Activity</h4>
                <p className="text-sm text-muted-foreground">
                  Review sync logs and troubleshoot any issues from the integration dashboard.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
