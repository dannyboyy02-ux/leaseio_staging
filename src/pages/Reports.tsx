import { BarChart3, PieChart, TrendingUp, Calendar, Download, Lock } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { Link } from 'react-router-dom';

const reports = [
  {
    id: 'portfolio',
    title: 'Portfolio Overview',
    description: 'High-level summary of all active leases, total committed rent, and key metrics.',
    icon: PieChart,
  },
  {
    id: 'renewals',
    title: 'Renewal Pipeline',
    description: 'Track upcoming renewals with projected impact and action recommendations.',
    icon: Calendar,
  },
  {
    id: 'escalations',
    title: 'Escalation Calendar',
    description: 'View all scheduled rent escalations with projected increases.',
    icon: TrendingUp,
  },
  {
    id: 'projections',
    title: 'Rent Projections',
    description: 'Forecast future rent obligations based on current lease terms and escalations.',
    icon: BarChart3,
  },
];

export default function Reports() {
  const { canAccessFeature } = useApp();
  const hasAccess = canAccessFeature('business');

  if (!hasAccess) {
    return (
      <AppLayout>
        <AppHeader title="Reports" subtitle="Portfolio analytics and insights" />

        <div className="p-6">
          <Card variant="ghost" className="border-2 border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                <Lock className="h-8 w-8 text-muted-foreground" />
              </div>
              <Badge variant="business" className="mb-4">Business Plan</Badge>
              <h3 className="text-lg font-semibold mb-2">Unlock Reporting</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-6">
                Upgrade to the Business plan to access portfolio analytics, renewal pipelines, 
                escalation calendars, and rent projections.
              </p>
              <Button variant="accent" size="lg" asChild>
                <Link to="/settings/billing">
                  Upgrade to Business
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title="Reports"
        subtitle="Portfolio analytics and insights"
        actions={
          <Button variant="outline">
            <Download className="h-4 w-4 mr-2" />
            Export All
          </Button>
        }
      />

      <div className="p-6">
        <div className="grid gap-6 md:grid-cols-2">
          {reports.map((report, index) => (
            <Card
              key={report.id}
              variant="interactive"
              className="animate-fade-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <report.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{report.title}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription className="mb-4">{report.description}</CardDescription>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1">
                    View Report
                  </Button>
                  <Button variant="ghost" size="icon">
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Sample Chart Placeholder */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Monthly Rent Overview</CardTitle>
            <CardDescription>Total committed rent across all active leases</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-center justify-center bg-muted/30 rounded-lg border border-dashed border-border">
              <div className="text-center">
                <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  Charts will appear once you have finalized leases
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
