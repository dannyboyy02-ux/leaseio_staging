import { DollarSign, CalendarClock, TrendingUp, Wallet } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { format, differenceInDays } from 'date-fns';
import { useLanguage } from '@/contexts/LanguageContext';

interface FinancialData {
  totalMonthlyRent: number;
  annualObligation: number;
  nextPayment: {
    amount: number;
    property: string;
    dueDate: Date;
    daysUntil: number;
  } | null;
  activeLeaseCount: number;
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
  
  const { data, isLoading } = useQuery({
    queryKey: ['financial-summary'],
    queryFn: async (): Promise<FinancialData> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: leases, error } = await supabase
        .from('leases')
        .select('id, filename, current_monthly_rent, lease_start, lease_end, status, extracted_json')
        .eq('user_id', user.id)
        .in('status', ['Ready', 'final', 'review', 'Approved']);

      if (error) throw error;

      const activeLeases = leases || [];
      const totalMonthlyRent = activeLeases.reduce(
        (sum, lease) => sum + (lease.current_monthly_rent || 0),
        0
      );
      const annualObligation = totalMonthlyRent * 12;

      let nextPayment: FinancialData['nextPayment'] = null;
      if (activeLeases.length > 0 && totalMonthlyRent > 0) {
        const now = new Date();
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const daysUntil = differenceInDays(nextMonth, now);
        
        const highestRentLease = activeLeases.reduce((max, lease) => 
          (Number(lease.current_monthly_rent) || 0) > (Number(max.current_monthly_rent) || 0) ? lease : max
        , activeLeases[0]);

        const propertyAddress = highestRentLease.extracted_json 
          ? (highestRentLease.extracted_json as Record<string, unknown>)?.property_address as string
          : null;

        nextPayment = {
          amount: totalMonthlyRent,
          property: activeLeases.length === 1 
            ? (propertyAddress || highestRentLease.filename || 'Property')
            : `${activeLeases.length} ${t('dashboard.properties')}`,
          dueDate: nextMonth,
          daysUntil,
        };
      }

      return {
        totalMonthlyRent,
        annualObligation,
        nextPayment,
        activeLeaseCount: activeLeases.length,
      };
    },
  });

  if (isLoading) {
    return (
      <Card className="bg-gradient-to-br from-primary/5 via-background to-accent/5 border-primary/10">
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
    );
  }

  const leaseCount = data?.activeLeaseCount || 0;
  const leaseLabel = leaseCount === 1 
    ? t('dashboard.active_lease') 
    : t('dashboard.active_leases_count');

  const stats = [
    {
      label: t('dashboard.total_monthly_rent'),
      value: formatCurrency(data?.totalMonthlyRent || 0, language),
      icon: DollarSign,
      description: `${leaseCount} ${leaseLabel}`,
    },
    {
      label: t('dashboard.annual_obligation'),
      value: formatCurrency(data?.annualObligation || 0, language),
      icon: TrendingUp,
      description: t('dashboard.total_for_year'),
    },
    {
      label: t('dashboard.next_payment_due'),
      value: data?.nextPayment ? formatCurrency(data.nextPayment.amount, language) : '—',
      icon: CalendarClock,
      description: data?.nextPayment
        ? `${format(data.nextPayment.dueDate, 'MMM d')} · ${data.nextPayment.daysUntil} ${t('dashboard.days')}`
        : t('dashboard.no_upcoming_payments'),
      highlight: data?.nextPayment && data.nextPayment.daysUntil <= 7,
    },
    {
      label: t('dashboard.rent_per_lease'),
      value: data?.activeLeaseCount 
        ? formatCurrency((data?.totalMonthlyRent || 0) / data.activeLeaseCount, language)
        : '—',
      icon: Wallet,
      description: t('dashboard.average_monthly'),
    },
  ];

  return (
    <Card className="bg-gradient-to-br from-primary/5 via-background to-accent/5 border-primary/10 animate-fade-up">
      <CardContent className="p-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className="flex items-start gap-4 animate-fade-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <stat.icon className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className={`text-2xl font-bold font-display truncate ${stat.highlight ? 'text-warning' : ''}`}>
                  {stat.value}
                </p>
                <p className="text-xs text-muted-foreground truncate">{stat.description}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
