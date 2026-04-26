import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, AlertCircle, TrendingUp, Clock, DollarSign, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { differenceInDays, format } from 'date-fns';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';
import { getCurrentMonthlyRent } from '@/lib/leaseCalculations';

interface UpcomingEvent {
  id: string;
  type: 'renewal' | 'escalation' | 'expiration' | 'payment';
  titleKey: string;
  property: string;
  date: Date;
  daysUntil: number;
  leaseId: string;
  amount?: number;
}

function formatCurrency(amount: number, language: string): string {
  return new Intl.NumberFormat(language === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function UpcomingEvents() {
  const { t, language } = useLanguage();
  const { workspace, user } = useApp();
  const queryClient = useQueryClient();

  const eventConfig = {
    renewal:    { icon: Clock,        variant: 'info' as const,        labelKey: 'dashboard.renewal' },
    escalation: { icon: TrendingUp,   variant: 'warning' as const,     labelKey: 'dashboard.escalation' },
    expiration: { icon: AlertCircle,  variant: 'destructive' as const, labelKey: 'dashboard.expiration' },
    payment:    { icon: DollarSign,   variant: 'default' as const,     labelKey: 'dashboard.payment' },
  };

  const { data: dismissedIds = [] } = useQuery({
    queryKey: ['dismissed-events', workspace?.id, user?.id],
    enabled: !!workspace?.id && !!user?.id,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await (supabase as any)
        .from('dismissed_events')
        .select('event_key')
        .eq('workspace_id', workspace!.id)
        .eq('user_id', user!.id);

      if (error) throw error;
      return (data || []).map((row: { event_key: string }) => row.event_key);
    },
  });

  const dismissEvent = async (eventKey: string) => {
    if (!workspace?.id || !user?.id) return;
    const { error } = await (supabase as any)
      .from('dismissed_events')
      .upsert({
        user_id: user.id,
        workspace_id: workspace.id,
        event_key: eventKey,
        dismissed_at: new Date().toISOString(),
      }, { onConflict: 'user_id,workspace_id,event_key' });

    if (!error) {
      await queryClient.invalidateQueries({ queryKey: ['dismissed-events', workspace.id, user.id] });
      await refetchEvents();
    }
  };

  const { data: events, isLoading, refetch: refetchEvents } = useQuery({
    queryKey: ['upcoming-events', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<UpcomingEvent[]> => {
      const now = new Date();

      const { data: leases, error } = await supabase
        .from('leases')
        .select(
          'id, filename, lease_end, executed_expiry_date, ' +
          'current_monthly_rent, monthly_payment, executed_monthly_payment, extracted_json, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace!.id)
        .in('lifecycle_status', ['executed', 'active']);

      if (error) throw error;

      const upcomingEvents: UpcomingEvent[] = [];

      for (const lease of leases || []) {
        const property = getPropertyDisplayName(
          lease.extracted_json as Record<string, unknown> | null,
          lease.filename,
        );

        const monthlyRent = getCurrentMonthlyRent(
          (lease as any).rent_schedules,
          (lease as any).executed_monthly_payment,
          lease.current_monthly_rent,
          (lease as any).monthly_payment,
        );

        // Prefer executed_expiry_date, fall back to lease_end
        const expiryRaw = (lease as any).executed_expiry_date || lease.lease_end;

        if (expiryRaw) {
          const endDate = new Date(expiryRaw);
          const daysUntil = differenceInDays(endDate, now);

          if (daysUntil >= 0 && daysUntil <= 90) {
            upcomingEvents.push({
              id: `expiry:${lease.id}:${expiryRaw}`,
              type: 'expiration',
              titleKey: 'dashboard.lease_expires',
              property,
              date: endDate,
              daysUntil,
              leaseId: lease.id,
            });
          } else if (daysUntil >= 30 && daysUntil <= 180) {
            upcomingEvents.push({
              id: `renewal:${lease.id}:${expiryRaw}`,
              type: 'renewal',
              titleKey: 'dashboard.renewal_window_opens',
              property,
              date: new Date(endDate.getTime() - 60 * 24 * 60 * 60 * 1000),
              daysUntil: Math.max(0, daysUntil - 60),
              leaseId: lease.id,
            });
          }
        }

        if (monthlyRent > 0) {
          const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const daysUntilPayment = differenceInDays(nextMonth, now);
          upcomingEvents.push({
            id: `payment:${lease.id}:${nextMonth.toISOString().slice(0, 10)}`,
            type: 'payment',
            titleKey: 'dashboard.rent_payment_due',
            property,
            date: nextMonth,
            daysUntil: daysUntilPayment,
            leaseId: lease.id,
            amount: monthlyRent,
          });
        }
      }

      return upcomingEvents.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 5);
    },
  });

  const visibleEvents = useMemo(
    () => (events || []).filter((e) => !dismissedIds.includes(e.id)),
    [dismissedIds, events],
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            {t('dashboard.upcoming_events')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-start gap-4 p-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-48" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Hide entirely when there are no events — don't show an empty card to new users
  if (visibleEvents.length === 0) return null;

  const getDaysLabel = (days: number) => {
    if (days === 0) return t('dashboard.today');
    if (days === 1) return t('dashboard.tomorrow');
    return `${days} ${t('dashboard.days')}`;
  };

  return (
    <Card className="animate-fade-up" style={{ animationDelay: '50ms' }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            {t('dashboard.upcoming_events')}
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/notifications">
              {t('dashboard.view_all')} <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {visibleEvents.map((event, index) => {
            const config = eventConfig[event.type];
            const EventIcon = config.icon;
            const isUrgent = event.daysUntil <= 7;
            const isWarning = event.daysUntil <= 30;

            return (
              <div
                key={event.id}
                className={cn(
                  'flex items-center rounded-lg transition-all animate-fade-up group',
                  isUrgent && 'bg-destructive/5',
                )}
                style={{ animationDelay: `${(index + 1) * 50}ms` }}
              >
                <Link
                  to={`/app/leases/${event.leaseId}`}
                  className={cn(
                    'flex items-start gap-4 p-3 flex-1 min-w-0 rounded-lg hover:bg-muted/50 transition-all',
                    isUrgent && 'hover:bg-destructive/10',
                  )}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      config.variant === 'info'        && 'bg-info/10 text-info',
                      config.variant === 'warning'     && 'bg-warning/10 text-warning',
                      config.variant === 'destructive' && 'bg-destructive/10 text-destructive',
                      config.variant === 'default'     && 'bg-primary/10 text-primary',
                    )}
                  >
                    <EventIcon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={config.variant} className="text-[10px]">
                        {t(config.labelKey)}
                      </Badge>
                      <span
                        className={cn(
                          'text-xs',
                          isUrgent  ? 'text-destructive font-medium' :
                          isWarning ? 'text-warning' :
                                      'text-muted-foreground',
                        )}
                      >
                        {getDaysLabel(event.daysUntil)}
                      </span>
                    </div>
                    <p className="text-sm font-medium truncate">{t(event.titleKey)}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{event.property}</span>
                      {event.amount && (
                        <><span>·</span><span className="font-medium text-foreground">{formatCurrency(event.amount, language)}</span></>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {format(event.date, 'MMM d')}
                  </span>
                </Link>
                <button
                  onClick={() => dismissEvent(event.id)}
                  className="p-2 mr-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
