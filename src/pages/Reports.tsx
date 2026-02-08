import { BarChart3, PieChart, TrendingUp, Calendar, Download, Lock, ClipboardList } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Link } from 'react-router-dom';
import { RentRollExport } from '@/components/reports/RentRollExport';

const reports = [
  {
    id: 'portfolio',
    titleKey: 'reports.portfolio_overview',
    descKey: 'reports.portfolio_overview_desc',
    icon: PieChart,
  },
  {
    id: 'renewals',
    titleKey: 'reports.renewal_pipeline',
    descKey: 'reports.renewal_pipeline_desc',
    icon: Calendar,
  },
  {
    id: 'escalations',
    titleKey: 'reports.escalation_calendar',
    descKey: 'reports.escalation_calendar_desc',
    icon: TrendingUp,
  },
  {
    id: 'projections',
    titleKey: 'reports.rent_projections',
    descKey: 'reports.rent_projections_desc',
    icon: BarChart3,
  },
  {
    id: 'audit',
    titleKey: 'reports.audit_log',
    descKey: 'reports.audit_log_desc',
    icon: ClipboardList,
    href: '/app/reports/audit-log',
    requiresAdmin: true,
  },
];

export default function Reports() {
  const { canAccessFeature, userRole } = useApp();
  const { t } = useLanguage();
  const hasAccess = canAccessFeature('business');
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  if (!hasAccess) {
    return (
      <AppLayout>
        <AppHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />

        <div className="p-6">
          {/* Rent Roll Export is available to all users */}
          <div className="mb-8">
            <RentRollExport />
          </div>

          <Card variant="ghost" className="border-2 border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                <Lock className="h-8 w-8 text-muted-foreground" />
              </div>
              <Badge variant="business" className="mb-4">{t('common.business_plan')}</Badge>
              <h3 className="text-lg font-semibold mb-2">{t('reports.unlock_advanced')}</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-6">
                {t('reports.unlock_desc')}
              </p>
              <Button variant="accent" size="lg" asChild>
                <Link to="/app/upgrade?feature=reports">
                  {t('integrations.upgrade_business')}
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
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={
          <Button variant="outline">
            <Download className="h-4 w-4 mr-2" />
            {t('reports.export_all')}
          </Button>
        }
      />

      <div className="p-6">
        {/* Rent Roll Export */}
        <div className="mb-8">
          <RentRollExport />
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {reports
            .filter((report) => !report.requiresAdmin || isAdmin)
            .map((report, index) => (
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
                    <CardTitle className="text-base">{t(report.titleKey)}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription className="mb-4">{t(report.descKey)}</CardDescription>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" asChild={!!report.href}>
                    {report.href ? (
                      <Link to={report.href}>{t('reports.view_report')}</Link>
                    ) : (
                      t('reports.view_report')
                    )}
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
            <CardTitle>{t('reports.monthly_overview')}</CardTitle>
            <CardDescription>{t('reports.monthly_overview_desc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-center justify-center bg-muted/30 rounded-lg border border-dashed border-border">
              <div className="text-center">
                <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('reports.charts_appear')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
