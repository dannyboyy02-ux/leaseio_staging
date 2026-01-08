import { FileText, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { differenceInDays } from 'date-fns';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';

interface StatCard {
  titleKey: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  variant: 'default' | 'accent' | 'warning' | 'success';
  href?: string;
}

const variantStyles = {
  default: 'bg-primary/10 text-primary',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  success: 'bg-success/10 text-success',
};

export function QuickStats() {
  const { t } = useLanguage();
  
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: leases, error } = await supabase
        .from('leases')
        .select('id, status, lease_end')
        .eq('user_id', user.id);

      if (error) throw error;

      const allLeases = leases || [];
      const now = new Date();

      const activeLeases = allLeases.filter(l => 
        l.status === 'Ready' || l.status === 'final' || l.status === 'review' || l.status === 'Approved'
      ).length;

      const pendingReview = allLeases.filter(l => 
        l.status === 'review' || l.status === 'processing' || l.status === 'Processing' || l.status === 'Ready'
      ).length;

      const expiringIn90Days = allLeases.filter(l => {
        if (!l.lease_end || l.status === 'archived') return false;
        const endDate = new Date(l.lease_end);
        const days = differenceInDays(endDate, now);
        return days >= 0 && days <= 90;
      }).length;

      const finalized = allLeases.filter(l => l.status === 'final' || l.status === 'Approved').length;

      return {
        activeLeases,
        pendingReview,
        expiringIn90Days,
        finalized,
      };
    },
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} variant="interactive">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-10 w-10 rounded-lg" />
              </div>
              <div className="mt-4 space-y-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const stats: StatCard[] = [
    {
      titleKey: 'dashboard.active_leases',
      value: data?.activeLeases ?? 0,
      icon: FileText,
      variant: 'default',
      href: '/app/leases',
    },
    {
      titleKey: 'dashboard.action_required',
      value: data?.pendingReview ?? 0,
      icon: Clock,
      variant: 'accent',
      href: '/app/leases?status=review',
    },
    {
      titleKey: 'dashboard.expiring_90_days',
      value: data?.expiringIn90Days ?? 0,
      icon: AlertTriangle,
      variant: 'warning',
      href: '/app/leases?expiring=90',
    },
    {
      titleKey: 'dashboard.finalized',
      value: data?.finalized ?? 0,
      icon: CheckCircle2,
      variant: 'success',
      href: '/app/leases?status=final',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat, index) => {
        const content = (
          <Card
            variant="interactive"
            className={cn('animate-fade-up h-full')}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    variantStyles[stat.variant]
                  )}
                >
                  <stat.icon className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-4">
                <p className="text-2xl font-bold font-display">{stat.value}</p>
                <p className="text-sm text-muted-foreground">{t(stat.titleKey)}</p>
              </div>
            </CardContent>
          </Card>
        );

        if (stat.href) {
          return (
            <Link key={stat.titleKey} to={stat.href} className="block">
              {content}
            </Link>
          );
        }

        return <div key={stat.titleKey}>{content}</div>;
      })}
    </div>
  );
}
