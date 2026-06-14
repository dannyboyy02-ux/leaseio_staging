import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, ExternalLink, Landmark, Layers, Lock, PieChart, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useApp } from '@/contexts/AppContext';
import { isReadOnlyRetention } from '@/config/pricing';
import { supabase } from '@/integrations/supabase/client';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';
import { computePortfolioMetrics } from '@/lib/portfolioAnalytics';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function Portfolio() {
  const { workspace, canAccessFeature } = useApp();
  // KNOWN_ISSUES #46: Portfolio Intelligence is a Business-tier feature per the
  // pricing model. Gate the page (matching the Reports / AI Assistant pattern)
  // and skip the data fetch entirely for Starter workspaces. The AppSidebar nav
  // item carries requiresBusiness:true so the route shows a lock for Starter.
  // Vault retention views Portfolio read-only under the flatten rule.
  const hasBusinessAccess = canAccessFeature('business') || isReadOnlyRetention(workspace?.plan);

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-page', workspace?.id],
    enabled: !!workspace?.id && hasBusinessAccess,
    queryFn: async () => {
      const [{ data: leases, error }, { data: workspaceSettings, error: workspaceError }] = await Promise.all([
        supabase
          .from('leases')
          // PostgREST type narrowing requires a literal string — see note in useNeedsAction.
          .select('id, filename, request_title, asset_type, extracted_json, executed_monthly_payment, current_monthly_rent, monthly_payment, lease_start, lease_end, term_months, escalation_type, escalation_rate, calc_pv_liability, calc_total_commitment, landlord_name, property_address')
          .eq('workspace_id', workspace!.id)
          .eq('archived', false)
          // Phase 3: include chain executed equivalent (active is identical).
          .in('lifecycle_status', ['executed', 'active', 'fully_executed']),
        supabase
          .from('workspaces')
          .select('discount_rate')
          .eq('id', workspace!.id)
          .single(),
      ]);

      if (error) throw error;
      if (workspaceError) throw workspaceError;

      const activeLeases = leases || [];
      const discountRate = (workspaceSettings as any)?.discount_rate ?? null;
      const portfolio = computePortfolioMetrics(activeLeases as any[], { discountRate });

      const annualObligation = activeLeases.reduce((sum, lease) => {
        const monthly =
          Number((lease as any).executed_monthly_payment) ||
          Number((lease as any).current_monthly_rent) ||
          Number((lease as any).monthly_payment) ||
          0;
        return sum + monthly * 12;
      }, 0);

      const assetBreakdown = Object.values(
        activeLeases.reduce((acc, lease) => {
          const key = lease.asset_type || 'unclassified';
          const monthly =
            Number((lease as any).executed_monthly_payment) ||
            Number((lease as any).current_monthly_rent) ||
            Number((lease as any).monthly_payment) ||
            0;

          acc[key] = acc[key] || { label: key, count: 0, annualObligation: 0 };
          acc[key].count += 1;
          acc[key].annualObligation += monthly * 12;
          return acc;
        }, {} as Record<string, { label: string; count: number; annualObligation: number }>),
      ).sort((a, b) => b.annualObligation - a.annualObligation);

      const escalationLabels = Object.entries(
        activeLeases.reduce((acc, lease) => {
          const key = lease.escalation_type || 'none';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      )
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

      const indexLeaseNames = activeLeases
        .filter((lease) => lease.escalation_type === 'index')
        .map((lease) =>
          getPropertyDisplayName(
            lease.extracted_json as Record<string, unknown> | null,
            lease.request_title || lease.filename,
            'Property',
          ),
        );

      return {
        activeLeaseCount: activeLeases.length,
        annualObligation,
        discountRate,
        portfolio,
        assetBreakdown,
        escalationBreakdown: escalationLabels,
        indexLeaseNames,
        leases: activeLeases,
      };
    },
  });

  if (!hasBusinessAccess) {
    return (
      <AppLayout>
        <AppHeader
          title="Portfolio"
          subtitle="Live portfolio metrics, lease liability disclosure, and concentration views"
        />
        <div className="p-6">
          <Card variant="ghost" className="border-2 border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                <Lock className="h-8 w-8 text-muted-foreground" />
              </div>
              <Badge variant="business" className="mb-4">Business Plan</Badge>
              <h3 className="text-lg font-semibold mb-2">Portfolio Intelligence is a Business-plan feature</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-6">
                Upgrade to the Business plan to unlock portfolio-wide PV liability, asset and escalation
                concentration, and the index-lease disclosure view.
              </p>
              <Button variant="accent" size="lg" asChild>
                <Link to="/app/settings/account?tab=billing">Upgrade to Business</Link>
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
        title="Portfolio"
        subtitle="Live portfolio metrics, lease liability disclosure, and concentration views"
      />

      <div className="space-y-6 p-6">
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-4 w-28" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-32" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !data || data.activeLeaseCount === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Layers className="h-12 w-12 text-muted-foreground/40 mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Portfolio intelligence appears after posting leases
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Once leases are active, this page will summarize liability, escalation mix, and asset concentrations.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <Landmark className="h-4 w-4" />
                    PV Liability
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold font-display">
                    {formatCurrency(data.portfolio.totalPVLiability)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {data.discountRate
                      ? `Discounted at ${data.discountRate}%`
                      : 'Set a workspace discount rate to populate PV'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Active Leases
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold font-display">{data.activeLeaseCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatCurrency(data.annualObligation)} annualized obligation
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Index-Based Leases
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold font-display">{data.portfolio.indexBasedLeaseCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatCurrency(data.portfolio.indexBasedLeasePV)} baseline PV floor
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    Data Quality
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold font-display">{data.portfolio.excludedLeaseCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    excluded from PV because term data is incomplete
                  </p>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <PieChart className="h-4 w-4" />
                    Asset Mix
                  </CardTitle>
                  <CardDescription>Annual obligation by asset type</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {data.assetBreakdown.map((entry) => (
                    <div
                      key={entry.label}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium capitalize">{entry.label.replace('_', ' ')}</p>
                        <p className="text-xs text-muted-foreground">{entry.count} lease{entry.count !== 1 ? 's' : ''}</p>
                      </div>
                      <p className="text-sm font-semibold">{formatCurrency(entry.annualObligation)}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <TrendingUp className="h-4 w-4" />
                    Escalation Mix
                  </CardTitle>
                  <CardDescription>Current portfolio mix by escalation type</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {data.escalationBreakdown.map((entry) => (
                    <div key={entry.type} className="flex items-center justify-between">
                      <p className="text-sm capitalize">{entry.type.replace('_', ' ')}</p>
                      <Badge variant="secondary">{entry.count}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="h-4 w-4" />
                  Lease Register
                </CardTitle>
                <CardDescription>All active and executed leases included in portfolio calculations</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {(data.leases as any[]).map((lease) => {
                    const monthly =
                      Number(lease.executed_monthly_payment) ||
                      Number(lease.current_monthly_rent) ||
                      Number(lease.monthly_payment) ||
                      0;
                    const displayName =
                      lease.request_title ||
                      lease.property_address ||
                      lease.landlord_name ||
                      lease.filename ||
                      'Unnamed lease';
                    const pvLiability = Number(lease.calc_pv_liability) || null;
                    return (
                      <div key={lease.id} className="flex items-center justify-between px-4 py-3 gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{displayName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {lease.lease_start ? lease.lease_start.slice(0, 7) : '—'}
                            {' → '}
                            {lease.lease_end ? lease.lease_end.slice(0, 7) : '—'}
                            {lease.escalation_type ? ` · ${lease.escalation_type}` : ''}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold">{monthly ? formatCurrency(monthly) + '/mo' : '—'}</p>
                          {pvLiability ? (
                            <p className="text-xs text-muted-foreground">{formatCurrency(pvLiability)} PV</p>
                          ) : null}
                        </div>
                        <Link to={`/app/leases/${lease.id}/review`} className="shrink-0 text-muted-foreground hover:text-foreground">
                          <ExternalLink size={14} />
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {data.portfolio.indexBasedLeaseCount > 0 && (
              <Card className="border-l-4 border-l-amber-400">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    Index-Lease Disclosure
                  </CardTitle>
                  <CardDescription>
                    CPI and index-based leases are shown separately so the portfolio PV does not assume a future inflation curve.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.indexLeaseNames.map((name) => (
                    <div key={name} className="rounded-md bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm">
                      {name}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
