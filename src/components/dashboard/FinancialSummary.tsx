import { DollarSign, CalendarClock, AlertTriangle, Building2, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { format, differenceInDays } from 'date-fns';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';

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
  nextPayment: {
    amount: number;
    property: string;
    dueDate: Date;
    daysUntil: number;
  } | null;
}

function formatCurrency(amount: number, language: string): string {
  return new Intl.NumberFormat(language === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function FinancialSummary() {
  const { t, language } = useLanguage();
  const { workspace } = useApp();

  // Pipeline: submitted, under_review, approved
  const { data: pipeline, isLoading: pipelineLoading } = useQuery({
    queryKey: ['pipeline-summary', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<PipelineData> => {
      const { data: leases, error } = await supabase
        .from('leases')
        .select('id, calc_total_commitment, covenant_flagged')
        .eq('workspace_id', workspace!.id)
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
  const { data, isLoading } = useQuery({
    queryKey: ['financial-summary', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<FinancialData> => {
      const { data: leases, error } = await supabase
        .from('leases')
        .select(
          'id, filename, executed_monthly_payment, current_monthly_rent, monthly_payment, ' +
          'lease_start, lease_end, executed_expiry_date, extracted_json'
        )
        .eq('workspace_id', workspace!.id)
        .in('lifecycle_status', ['executed', 'active']);

      if (error) throw error;

      const activeLeases = leases || [];
      const now = new Date();
      const in90Days = new Date(now.getTime() + 90 * 86_400_000);

      const totalMonthlyRent = activeLeases.reduce((sum, lease) => {
        const rent =
          Number((lease as any).executed_monthly_payment) ||
          Number(lease.current_monthly_rent) ||
          Number((lease as any).monthly_payment) ||
          0;
        return sum + rent;
      }, 0);

      const expiringCount = activeLeases.filter((lease) => {
        const raw = (lease as any).executed_expiry_date || lease.lease_end;
        if (!raw) return false;
        const d = new Date(raw);
        return d >= now && d <= in90Days;
      }).length;

      let nextPayment: FinancialData['nextPayment'] = null;
      if (activeLeases.length > 0 && totalMonthlyRent > 0) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const daysUntil = differenceInDays(nextMonth, now);

        const highestRentLease = activeLeases.reduce((max, lease) => {
          const rent =
            Number((lease as any).executed_monthly_payment) ||
            Number(lease.current_monthly_rent) ||
            Number((lease as any).monthly_payment) ||
            0;
          const maxRent =
            Number((max as any).executed_monthly_payment) ||
            Number(max.current_monthly_rent) ||
            Number((max as any).monthly_payment) ||
            0;
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

      return {
        totalMonthlyRent,
        annualObligation: totalMonthlyRent * 12,
        activeLeaseCount: activeLeases.length,
        expiringCount,
        nextPayment,
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
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[...Array(4)].map((_, i) => (
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

  const leaseCount = data?.activeLeaseCount || 0;
  const leaseLabel = leaseCount === 1
    ? t('dashboard.active_lease')
    : t('dashboard.active_leases_count');

  const activeStats = [
    {
      label: t('dashboard.total_monthly_rent'),
      value: formatCurrency(data?.totalMonthlyRent || 0, language),
      icon: DollarSign,
      description: `${leaseCount} ${leaseLabel}`,
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
      label: 'Expiring ≤ 90 Days',
      value: String(data?.expiringCount || 0),
      icon: AlertTriangle,
      description: (data?.expiringCount || 0) > 0 ? 'require attention' : 'all clear',
      highlight: (data?.expiringCount || 0) > 0,
    },
  ];

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Pipeline warning — only shown when there are pending leases */}
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
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
