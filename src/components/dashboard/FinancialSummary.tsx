import { DollarSign, CalendarClock, AlertTriangle, Building2, FileText, Plus, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { format, differenceInDays } from 'date-fns';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';
import { computePortfolioMetrics, type PortfolioMetrics } from '@/lib/portfolioAnalytics';
import { getCurrentMonthlyRent } from '@/lib/leaseCalculations';

interface PipelineData {
  pendingCount: number;
  totalCashCommitment: number;
  covenantFlaggedCount: number;
}

interface FinancialData {
  totalMonthlyRent: number;
  annualObligation: number;
  activeLeaseCount: number;
  expiringCount: number;
  expiring91to120Count: number;
  rentIncreaseNext90: number;
  rentExpiringNext90: number;
  avgRemainingTermMonths: number;
  workspaceDiscountRate: number | null;
  nextPayment: {
    amount: number;
    property: string;
    dueDate: Date;
    daysUntil: number;
  } | null;
  portfolio: PortfolioMetrics;
  indexLeaseNames: string[];
}

function formatCurrency(amount: number, language: string): string {
  return new Intl.NumberFormat(language === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function FinancialSummary({ onNewRequest }: { onNewRequest?: () => void }) {
  const { t, language } = useLanguage();
  const { workspace } = useApp();

  // Pipeline: submitted, under_review, approved
  const { data: pipeline, isLoading: pipelineLoading } = useQuery({
    queryKey: ['pipeline-summary', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<PipelineData> => {
      const { data: leases, error } = await (supabase as any)
        .from('leases')
        .select('id, calc_total_commitment, covenant_flagged')
        .eq('workspace_id', workspace!.id)
        .eq('archived', false)
        .in('lifecycle_status', ['submitted', 'under_review', 'approved']);

      if (error) throw error;

      const rows = leases || [];
      return {
        pendingCount: rows.length,
        totalCashCommitment: rows.reduce(
          (sum, l) => sum + (Number((l as any).calc_total_commitment) || 0),
          0,
        ),
        covenantFlaggedCount: rows.filter((l) => (l as any).covenant_flagged).length,
      };
    },
  });

  // Active portfolio: executed + active leases
  // Note: discount_rate is on workspaces, not leases — not selected here
  const { data, isLoading } = useQuery({
    queryKey: ['financial-summary', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<FinancialData> => {
      const [{ data: leases, error }, { data: workspaceSettings, error: workspaceError }] = await Promise.all([
        (supabase as any)
          .from('leases')
          .select(
            'id, filename, executed_monthly_payment, current_monthly_rent, monthly_payment, ' +
            'lease_start, lease_end, executed_expiry_date, extracted_json, ' +
            'term_months, escalation_rate, escalation_type, needs_escalation_review, ' +
            'rent_schedules(period_start, period_end, monthly_amount)'
          )
          .eq('workspace_id', workspace!.id)
          .eq('archived', false)
          .in('lifecycle_status', ['executed', 'active']),
        supabase
          .from('workspaces')
          .select('discount_rate')
          .eq('id', workspace!.id)
          .single(),
      ]);

      if (error) throw error;
      if (workspaceError) throw workspaceError;

      const activeLeases = leases || [];
      const workspaceDiscountRate = (workspaceSettings as any)?.discount_rate ?? null;
      const now = new Date();
      const in90Days  = new Date(now.getTime() + 90  * 86_400_000);
      const in120Days = new Date(now.getTime() + 120 * 86_400_000);

      const totalMonthlyRent = activeLeases.reduce((sum, lease) => {
        return sum + getCurrentMonthlyRent(
          (lease as any).rent_schedules,
          (lease as any).executed_monthly_payment,
          lease.current_monthly_rent,
          (lease as any).monthly_payment,
        );
      }, 0);

      // Rent increasing next 90 days: sum of upcoming escalations within 90 days
      let rentIncreaseNext90 = 0;
      for (const lease of activeLeases) {
        const schedules: any[] = (lease as any).rent_schedules ?? [];
        if (schedules.length === 0) continue;
        const currentPeriod = schedules.find((p: any) => {
          const start = new Date(p.period_start);
          const end = p.period_end ? new Date(p.period_end) : null;
          return start <= now && (!end || end >= now);
        });
        const nextPeriod = schedules.find((p: any) => {
          const start = new Date(p.period_start);
          return start > now && start <= in90Days;
        });
        if (nextPeriod && currentPeriod) {
          const diff = nextPeriod.monthly_amount - currentPeriod.monthly_amount;
          if (diff > 0) rentIncreaseNext90 += diff;
        }
      }

      // Rent expiring next 90 days: monthly rent of leases ending within 90 days
      let rentExpiringNext90 = 0;
      const expiringCount = activeLeases.filter((lease) => {
        const raw = (lease as any).executed_expiry_date || lease.lease_end;
        if (!raw) return false;
        const d = new Date(raw);
        return d >= now && d <= in90Days;
      });
      expiringCount.forEach((lease) => {
        rentExpiringNext90 += getCurrentMonthlyRent(
          (lease as any).rent_schedules,
          (lease as any).executed_monthly_payment,
          lease.current_monthly_rent,
          (lease as any).monthly_payment,
        );
      });
      const expiringLeasesCount = expiringCount.length;

      // Leases expiring 91–120 days
      const expiring91to120 = activeLeases.filter((lease) => {
        const raw = (lease as any).executed_expiry_date || lease.lease_end;
        if (!raw) return false;
        const d = new Date(raw);
        return d > in90Days && d <= in120Days;
      });
      const expiring91to120Count = expiring91to120.length;

      // Average remaining term in months across active portfolio
      const avgRemainingTermMonths =
        activeLeases.length > 0
          ? Math.round(
              activeLeases.reduce((sum, lease) => {
                const raw = (lease as any).executed_expiry_date || lease.lease_end;
                if (!raw) return sum;
                const endDate = new Date(raw);
                const remainingMs = Math.max(0, endDate.getTime() - now.getTime());
                return sum + remainingMs / ((365.25 / 12) * 24 * 60 * 60 * 1000);
              }, 0) / activeLeases.length,
            )
          : 0;

      let nextPayment: FinancialData['nextPayment'] = null;
      if (activeLeases.length > 0 && totalMonthlyRent > 0) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const daysUntil = differenceInDays(nextMonth, now);

        const highestRentLease = activeLeases.reduce((max, lease) => {
          const rent = getCurrentMonthlyRent(
            (lease as any).rent_schedules,
            (lease as any).executed_monthly_payment,
            lease.current_monthly_rent,
            (lease as any).monthly_payment,
          );
          const maxRent = getCurrentMonthlyRent(
            (max as any).rent_schedules,
            (max as any).executed_monthly_payment,
            max.current_monthly_rent,
            (max as any).monthly_payment,
          );
          return rent > maxRent ? lease : max;
        }, activeLeases[0]);

        const propertyName = getPropertyDisplayName(
          highestRentLease.extracted_json as Record<string, unknown> | null,
          highestRentLease.filename,
          'Property',
        );

        nextPayment = {
          amount: totalMonthlyRent,
          property:
            activeLeases.length === 1
              ? propertyName
              : `${activeLeases.length} ${t('dashboard.properties')}`,
          dueDate: nextMonth,
          daysUntil,
        };
      }

      // Portfolio PV analytics — delegated to pure module
      const portfolio = computePortfolioMetrics(activeLeases as any[], {
        discountRate: workspaceDiscountRate,
      });

      // Index lease display names — UI concern, stays here
      const indexLeaseNames = activeLeases
        .filter(l => (l as any).escalation_type === 'index')
        .map(l =>
          getPropertyDisplayName(
            l.extracted_json as Record<string, unknown> | null,
            l.filename,
            'Property',
          )
        );

      return {
        totalMonthlyRent,
        annualObligation: totalMonthlyRent * 12,
        activeLeaseCount: activeLeases.length,
        expiringCount: expiringLeasesCount,
        expiring91to120Count,
        rentIncreaseNext90,
        rentExpiringNext90,
        avgRemainingTermMonths,
        workspaceDiscountRate,
        nextPayment,
        portfolio,
        indexLeaseNames,
      };
    },
  });

  if (pipelineLoading || isLoading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-6">
            <div className="grid gap-6 sm:grid-cols-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-32" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-32" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Empty state: no leases in any stage
  if ((pipeline?.pendingCount ?? 0) === 0 && (data?.activeLeaseCount ?? 0) === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Building2 className="h-8 w-8 text-primary/60" />
          </div>
          <div>
            <p className="text-base font-semibold">Your portfolio is empty</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
              Submit your first lease request to start tracking commitments, approvals, and key dates.
            </p>
          </div>
          {onNewRequest && (
            <Button onClick={onNewRequest} className="mt-2">
              <Plus className="h-4 w-4 mr-2" />
              New Request
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const leaseCount = data?.activeLeaseCount || 0;
  const leaseLabel = leaseCount === 1
    ? t('dashboard.active_lease')
    : t('dashboard.active_leases_count');

  const rentMovementLines: string[] = [];
  if ((data?.rentIncreaseNext90 ?? 0) > 0) {
    rentMovementLines.push(`+${formatCurrency(data!.rentIncreaseNext90, language)}/mo increasing next 90d`);
  }
  if ((data?.rentExpiringNext90 ?? 0) > 0) {
    rentMovementLines.push(`-${formatCurrency(data!.rentExpiringNext90, language)}/mo expiring next 90d`);
  }

  const activeStats = [
    {
      label: t('dashboard.total_monthly_rent'),
      value: formatCurrency(data?.totalMonthlyRent || 0, language),
      icon: DollarSign,
      description: `${leaseCount} ${leaseLabel}`,
      movement: rentMovementLines,
      highlight: false,
    },
    {
      label: t('dashboard.next_payment_due'),
      value: data?.nextPayment ? formatCurrency(data.nextPayment.amount, language) : '—',
      icon: CalendarClock,
      description: data?.nextPayment
        ? `${format(data.nextPayment.dueDate, 'MMM d')} · ${data.nextPayment.daysUntil} ${t('dashboard.days')}`
        : t('dashboard.no_upcoming_payments'),
      highlight: !!(data?.nextPayment && data.nextPayment.daysUntil <= 7),
    },
    {
      label: 'Active Leases',
      value: String(leaseCount),
      icon: Building2,
      description: 'in portfolio',
      highlight: false,
    },
    {
      label: 'Expiring \u2264 90 Days',
      value: String(data?.expiringCount || 0),
      icon: AlertTriangle,
      description: (data?.expiringCount || 0) > 0 ? 'require attention' : 'all clear',
      highlight: (data?.expiringCount || 0) > 0,
    },
    {
      label: 'Expiring 91\u2013120 Days',
      value: String(data?.expiring91to120Count || 0),
      icon: CalendarClock,
      description: (data?.expiring91to120Count || 0) > 0 ? 'on the horizon' : 'all clear',
      highlight: false,
    },
  ];

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Pipeline card */}
      {(pipeline?.pendingCount ?? 0) > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-warning">
              <FileText className="h-4 w-4" />
              Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Pending Commitments</p>
                  <p className="text-2xl font-bold font-display">{pipeline?.pendingCount ?? 0}</p>
                  <p className="text-xs text-muted-foreground">awaiting review</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                  <DollarSign className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Estimated Commitment</p>
                  <p className="text-2xl font-bold font-display">
                    {formatCurrency(pipeline?.totalCashCommitment ?? 0, language)}
                  </p>
                  <p className="text-xs text-muted-foreground">total cash over terms</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Covenant Flagged</p>
                  <p className="text-2xl font-bold font-display">
                    {pipeline?.covenantFlaggedCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">require financial review</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hero KPI tiles */}
      <Card className="bg-gradient-to-br from-primary/5 via-background to-accent/5 border-primary/10">
        <CardContent className="p-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {activeStats.map((stat, index) => (
              <div
                key={stat.label}
                className="flex items-start gap-4 animate-fade-up"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                    stat.highlight
                      ? 'bg-warning/10 text-warning'
                      : 'bg-primary/10 text-primary'
                  }`}
                >
                  <stat.icon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p
                    className={`text-2xl font-bold font-display truncate ${
                      stat.highlight ? 'text-warning' : ''
                    }`}
                  >
                    {stat.value}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{stat.description}</p>
                  {(stat as any).movement?.map((line: string, i: number) => (
                    <p key={i} className="text-xs text-muted-foreground truncate mt-0.5">{line}</p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Portfolio Health */}
      {(data?.activeLeaseCount ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-foreground/80">
              <TrendingUp className="h-4 w-4" />
              Portfolio Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-3">
              <div>
                <p className="text-sm text-muted-foreground">Present Value Liability</p>
                <p className="text-2xl font-bold font-display">
                  {formatCurrency(data!.portfolio.totalPVLiability, language)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data?.workspaceDiscountRate
                    ? `discounted at ${data.workspaceDiscountRate}%`
                    : 'set a workspace discount rate to calculate PV'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Avg Remaining Term</p>
                <p className="text-2xl font-bold font-display">
                  {data!.avgRemainingTermMonths}{' '}
                  <span className="text-base font-normal text-muted-foreground">mo</span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">across active portfolio</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Annual Obligation</p>
                <p className="text-2xl font-bold font-display">
                  {formatCurrency(data!.annualObligation, language)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">current annualized rent run rate</p>
              </div>
            </div>
            {(data?.portfolio.excludedLeaseCount ?? 0) > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-4">
                {data!.portfolio.excludedLeaseCount} lease{data!.portfolio.excludedLeaseCount !== 1 ? 's' : ''} excluded from PV analytics because term data is incomplete.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* PV Liability Disclosure */}
      {(data?.portfolio.indexBasedLeaseCount ?? 0) > 0 && (
        <Card className="border-l-4 border-l-amber-400 bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Index-Based Escalation &mdash; Review Required
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-8 sm:grid-cols-2 mb-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Projected PV liability</p>
                <p className="text-2xl font-bold font-display">
                  {formatCurrency(data!.portfolio.totalPVLiability, language)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">fixed-rate leases only</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">Index-based leases (not projected)</p>
                <p className="text-2xl font-bold font-display text-amber-600 dark:text-amber-400">
                  {formatCurrency(data!.portfolio.indexBasedLeasePV, language)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">baseline rent &middot; CPI projection not applied</p>
              </div>
            </div>
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-2">
              {data!.portfolio.indexBasedLeaseCount} lease{data!.portfolio.indexBasedLeaseCount !== 1 ? 's' : ''} with index-based escalation require manual review:
            </p>
            <ul className="space-y-1">
              {data!.indexLeaseNames.map((name, i) => (
                <li key={i} className="text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                  {name}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
