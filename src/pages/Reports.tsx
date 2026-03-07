import { useState, useEffect } from 'react';
import { BarChart3, PieChart, TrendingUp, Calendar, Download, Lock, ClipboardList } from 'lucide-react';
import type { ComponentType } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Link } from 'react-router-dom';
import { RentRollExport } from '@/components/reports/RentRollExport';
import { supabase } from '@/integrations/supabase/client';
import {
  canAccessReportsAuditLog,
  canAccessReportsDataQuality,
  canExportReports,
} from '@/lib/authorization';

const STATUS_COLORS: Record<string, string> = {
  draft:        'hsl(var(--muted-foreground))',
  submitted:    'hsl(var(--info))',
  under_review: 'hsl(var(--warning))',
  approved:     'hsl(var(--primary))',
  rejected:     'hsl(var(--destructive))',
  executed:     'hsl(var(--success))',
  active:       'hsl(var(--success))',
  terminated:   'hsl(var(--muted-foreground))',
};

interface StatusCount { status: string; count: number; }
interface VarianceLease {
  id: string;
  filename: string | null;
  tenant_name: string | null;
  variance_monthly_payment: number | null;
  monthly_payment: number | null;
  executed_monthly_payment: number | null;
}

const reports: Array<{
  id: string;
  titleKey: string;
  descKey: string;
  icon: ComponentType<{ className?: string }>;
  href?: string;
  requiresAdmin?: boolean;
  requiresEditor?: boolean;
}> = [
  { id: 'portfolio',    titleKey: 'reports.portfolio_overview',   descKey: 'reports.portfolio_overview_desc',   icon: PieChart },
  { id: 'renewals',     titleKey: 'reports.renewal_pipeline',     descKey: 'reports.renewal_pipeline_desc',     icon: Calendar },
  { id: 'escalations',  titleKey: 'reports.escalation_calendar',  descKey: 'reports.escalation_calendar_desc',  icon: TrendingUp },
  { id: 'projections',  titleKey: 'reports.rent_projections',     descKey: 'reports.rent_projections_desc',     icon: BarChart3 },
  { id: 'audit',        titleKey: 'reports.audit_log',            descKey: 'reports.audit_log_desc',            icon: ClipboardList, href: '/app/reports/audit-log',     requiresAdmin: true },
  { id: 'data-quality', titleKey: 'reports.data_quality',         descKey: 'reports.data_quality_desc',         icon: TrendingUp,    href: '/app/reports/data-quality',  requiresEditor: true },
];

export default function Reports() {
  const { canAccessFeature, userRole, workspace } = useApp();
  const { t } = useLanguage();
  const hasAccess = canAccessFeature('business');
  const isAdmin = userRole === 'admin' || userRole === 'owner';
  const isEditor = userRole === 'editor';
  const canExport = canExportReports(userRole);

  const [statusData, setStatusData] = useState<StatusCount[]>([]);
  const [varianceLeases, setVarianceLeases] = useState<VarianceLease[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  useEffect(() => {
    if (!hasAccess || !workspace?.id) return;
    async function fetchData() {
      const [{ data: leases }, { data: variance }] = await Promise.all([
        supabase
          .from('leases')
          .select('lifecycle_status')
          .eq('workspace_id', workspace!.id)
          .filter('lifecycle_status', 'not.is', 'null'),
        supabase
          .from('leases')
          .select('id, filename, tenant_name, variance_monthly_payment, monthly_payment, executed_monthly_payment')
          .eq('workspace_id', workspace!.id)
          .filter('variance_monthly_payment', 'not.is', 'null')
          .order('variance_monthly_payment', { ascending: false })
          .limit(5),
      ]);

      if (leases) {
        const counts: Record<string, number> = {};
        leases.forEach((l) => {
          const s = l.lifecycle_status ?? 'unknown';
          counts[s] = (counts[s] || 0) + 1;
        });
        setStatusData(
          Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => ({ status, count }))
        );
      }

      setVarianceLeases((variance ?? []) as VarianceLease[]);
      setChartLoading(false);
    }
    fetchData();
  }, [hasAccess, workspace?.id]);

  if (!hasAccess) {
    return (
      <AppLayout>
        <AppHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />
        <div className="p-6">
          <div className="mb-8"><RentRollExport /></div>
          <Card variant="ghost" className="border-2 border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                <Lock className="h-8 w-8 text-muted-foreground" />
              </div>
              <Badge variant="business" className="mb-4">{t('common.business_plan')}</Badge>
              <h3 className="text-lg font-semibold mb-2">{t('reports.unlock_advanced')}</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-6">{t('reports.unlock_desc')}</p>
              <Button variant="accent" size="lg" asChild>
                <Link to="/app/upgrade?feature=reports">{t('integrations.upgrade_business')}</Link>
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
          <Button variant="outline" disabled={!canExport}>
            <Download className="h-4 w-4 mr-2" />
            {t('reports.export_all')}
          </Button>
        }
      />

      <div className="p-6">
        <div className="mb-8"><RentRollExport /></div>

        <div className="grid gap-6 md:grid-cols-2">
          {reports
            .filter((r) => {
              if (r.id === 'audit')        return canAccessReportsAuditLog(userRole);
              if (r.id === 'data-quality') return canAccessReportsDataQuality(userRole);
              if (r.requiresAdmin)         return isAdmin;
              if (r.requiresEditor)        return isEditor || isAdmin;
              return true;
            })
            .map((report, index) => (
              <Card key={report.id} variant="interactive" className="animate-fade-up" style={{ animationDelay: `${index * 50}ms` }}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <report.icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-base">{t(report.titleKey)}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="mb-4">{t(report.descKey)}</CardDescription>
                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" asChild={!!report.href}>
                      {report.href ? <Link to={report.href}>{t('reports.view_report')}</Link> : t('reports.view_report')}
                    </Button>
                    <Button variant="ghost" size="icon" disabled={!canExport}>
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>

        {/* Portfolio Breakdown Chart */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>{t('reports.monthly_overview')}</CardTitle>
            <CardDescription>Lease count by lifecycle status across your portfolio</CardDescription>
          </CardHeader>
          <CardContent>
            {chartLoading ? (
              <div className="h-64 flex items-center justify-center">
                <BarChart3 className="h-8 w-8 animate-pulse text-muted-foreground" />
              </div>
            ) : statusData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                No lease data yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={statusData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="status"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(s) => s.replace('_', ' ')}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    width={32}
                  />
                  <Tooltip
                    formatter={(val: number) => [val, 'Leases']}
                    labelFormatter={(l) => String(l).replace('_', ' ')}
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {statusData.map((entry) => (
                      <Cell
                        key={entry.status}
                        fill={STATUS_COLORS[entry.status] ?? 'hsl(var(--primary))'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Variance Outliers */}
        {varianceLeases.length > 0 && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">Variance Outliers</CardTitle>
              <CardDescription>Leases with the largest executed vs pipeline payment variance</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-0">
                {varianceLeases.map((lease) => {
                  const pipeline = Number(lease.monthly_payment) || 0;
                  const executed = Number(lease.executed_monthly_payment) || 0;
                  const pct = pipeline > 0 ? Math.abs((executed - pipeline) / pipeline) * 100 : null;
                  return (
                    <div
                      key={lease.id}
                      className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {lease.filename || lease.tenant_name || 'Unnamed lease'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Pipeline: ${Number(lease.monthly_payment || 0).toLocaleString('en-AU')}/mo
                          &nbsp;&middot;&nbsp;
                          Executed: ${Number(lease.executed_monthly_payment || 0).toLocaleString('en-AU')}/mo
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {pct !== null && (
                          <Badge variant={pct >= 10 ? 'destructive' : 'warning'} className="text-[10px]">
                            {pct.toFixed(1)}% variance
                          </Badge>
                        )}
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/app/leases/${lease.id}`}>View</Link>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
