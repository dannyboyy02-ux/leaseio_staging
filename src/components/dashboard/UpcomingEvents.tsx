import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, ChevronDown, AlertCircle, TrendingUp, Clock, DollarSign, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { differenceInDays } from 'date-fns';
import { formatLocalizedCurrency, formatLocalizedDate, formatLocalizedDateLong, formatLocalizedMonthYear, type SupportedLocale } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';
import { getMonthlyRent } from '@/lib/leaseCalculations';

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
  return formatLocalizedCurrency(amount, language as SupportedLocale);
}

const DOT_COLORS: Record<string, string> = {
  payment:    'bg-blue-500',
  expiration: 'bg-red-500',
  renewal:    'bg-indigo-500',
  escalation: 'bg-amber-500',
};

export function UpcomingEvents() {
  const { t, language } = useLanguage();
  const { workspace, user } = useApp();
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    expiration: true,
    renewal: true,
    payment: true,
    escalation: true,
  });
  const [drawerGroup, setDrawerGroup] = useState<UpcomingEvent['type'] | null>(null);

  const toggleGroup = (type: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [type]: !prev[type] }));

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

  const dismissEvents = async (eventKeys: string[]) => {
    if (!workspace?.id || !user?.id || eventKeys.length === 0) return;
    const rows = eventKeys.map((k) => ({
      user_id: user!.id,
      workspace_id: workspace!.id,
      event_key: k,
      dismissed_at: new Date().toISOString(),
    }));
    const { error } = await (supabase as any)
      .from('dismissed_events')
      .upsert(rows, { onConflict: 'user_id,workspace_id,event_key' });
    if (!error) {
      await queryClient.invalidateQueries({ queryKey: ['dismissed-events', workspace!.id, user!.id] });
      await refetchEvents();
    }
  };

  const { data: events, isLoading, refetch: refetchEvents } = useQuery({
    queryKey: ['upcoming-events', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<UpcomingEvent[]> => {
      const now = new Date();

      const { data: leases, error } = await (supabase as any)
        .from('leases')
        .select(
          'id, filename, lease_end, executed_expiry_date, escalation_type, rent_escalation_type, needs_escalation_review, executed_commencement_date, rent_commencement_date, lease_start, ' +
          'current_monthly_rent, monthly_payment, executed_monthly_payment, extracted_json, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace!.id)
        .eq('archived', false)
        // Phase 3: include chain executed equivalent (active is identical).
        .in('lifecycle_status', ['executed', 'active', 'fully_executed']);

      if (error) throw error;

      const upcomingEvents: UpcomingEvent[] = [];

      for (const lease of leases || []) {
        const property = getPropertyDisplayName(
          lease.extracted_json as Record<string, unknown> | null,
          lease.filename,
        );

        const monthlyRent = getMonthlyRent(lease as any);

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

        // Escalation: CPI/index leases — next anniversary of commencement date
        const escType = ((lease as any).escalation_type ?? '').toLowerCase();
        const rentEscType = ((lease as any).rent_escalation_type ?? '').toLowerCase();
        // Trust the confirmed escalation_type once reviewed; only fall back to
        // the raw extracted hint while it still needs review (see EscalationReviewPanel).
        const isCpi =
          ['index', 'cpi'].includes(escType) ||
          ((lease as any).needs_escalation_review === true && ['index', 'cpi'].includes(rentEscType));
        if (isCpi) {
          const commencementRaw =
            (lease as any).executed_commencement_date ||
            (lease as any).rent_commencement_date ||
            (lease as any).lease_start;
          if (commencementRaw) {
            const commencement = new Date(commencementRaw);
            const thisYear = now.getFullYear();
            let nextAnniversary = new Date(thisYear, commencement.getMonth(), commencement.getDate());
            if (nextAnniversary <= now) {
              nextAnniversary = new Date(thisYear + 1, commencement.getMonth(), commencement.getDate());
            }
            const daysUntil = differenceInDays(nextAnniversary, now);
            if (daysUntil <= 365) {
              upcomingEvents.push({
                id: `escalation:${lease.id}:${nextAnniversary.toISOString().slice(0, 10)}`,
                type: 'escalation',
                titleKey: 'dashboard.cpi_adjustment_due',
                property,
                date: nextAnniversary,
                daysUntil,
                leaseId: lease.id,
              });
            }
          }
        }
      }

      return upcomingEvents.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 50);
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
          <CardTitle className="text-sm font-medium flex items-center gap-2">
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

  const GROUP_ORDER: UpcomingEvent['type'][] = ['expiration', 'renewal', 'payment', 'escalation'];
  const GROUP_META: Record<string, { label: string; subtotal: (evs: UpcomingEvent[]) => string }> = {
    expiration: { label: t('dashboard.expirations'), subtotal: (evs) => t('dashboard.leases_count', { count: evs.length }) },
    renewal:    { label: t('dashboard.renewals'),    subtotal: (evs) => t('dashboard.leases_count', { count: evs.length }) },
    payment: {
      label: t('dashboard.payments'),
      subtotal: (evs) => {
        const total = evs.reduce((s, e) => s + (e.amount ?? 0), 0);
        return `${t('dashboard.leases_count', { count: evs.length })} · ${formatCurrency(total, language)}/${t('common.per_month_short')}`;
      },
    },
    escalation: { label: t('dashboard.escalations'), subtotal: (evs) => t('dashboard.leases_count', { count: evs.length }) },
  };

  const groups = GROUP_ORDER
    .map((type) => ({ type, events: visibleEvents.filter((e) => e.type === type) }))
    .filter((g) => g.events.length > 0);

  // Hide entirely when there are no events — don't show an empty card to new users
  if (groups.length === 0) return null;

  const getDaysLabel = (days: number) => {
    if (days === 0) return t('dashboard.today');
    if (days === 1) return t('dashboard.tomorrow');
    return `${days} ${t('dashboard.days')}`;
  };

  const drawerEvents = drawerGroup ? visibleEvents.filter((e) => e.type === drawerGroup) : [];

  return (
    <>
    <Card className="animate-fade-up" style={{ animationDelay: '50ms' }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            {t('dashboard.upcoming_events')}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setViewMode('list')}
            >
              {t('dashboard.list_view')}
            </Button>
            <Button
              variant={viewMode === 'calendar' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => { setViewMode('calendar'); setSelectedDay(null); }}
            >
              <Calendar className="h-3.5 w-3.5 mr-1" />
              {t('dashboard.calendar_short')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {viewMode === 'calendar' ? (() => {
          const year = calendarMonth.getFullYear();
          const month = calendarMonth.getMonth();
          const firstDay = new Date(year, month, 1).getDay();
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          const cells: (number | null)[] = [
            ...Array(firstDay).fill(null),
            ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
          ];
          const today = new Date();

          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => { setCalendarMonth(new Date(year, month - 1, 1)); setSelectedDay(null); }}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium">{formatLocalizedMonthYear(calendarMonth, language as SupportedLocale)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => { setCalendarMonth(new Date(year, month + 1, 1)); setSelectedDay(null); }}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {[
                  t('dashboard.wd_sun'), t('dashboard.wd_mon'), t('dashboard.wd_tue'), t('dashboard.wd_wed'),
                  t('dashboard.wd_thu'), t('dashboard.wd_fri'), t('dashboard.wd_sat'),
                ].map((d) => (
                  <div key={d} className="text-[10px] font-medium text-muted-foreground text-center py-1">{d}</div>
                ))}
                {cells.map((day, i) => {
                  if (day === null) return <div key={`e-${i}`} />;
                  const eventsOnDay = visibleEvents.filter((e) => {
                    const d = e.date;
                    return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
                  });
                  const isSelected =
                    selectedDay?.getFullYear() === year &&
                    selectedDay?.getMonth() === month &&
                    selectedDay?.getDate() === day;
                  const isToday =
                    today.getFullYear() === year &&
                    today.getMonth() === month &&
                    today.getDate() === day;
                  return (
                    <div
                      key={day}
                      onClick={() => eventsOnDay.length > 0 ? setSelectedDay(isSelected ? null : new Date(year, month, day)) : undefined}
                      className={cn(
                        'flex flex-col items-center py-1 rounded text-xs',
                        eventsOnDay.length > 0 ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
                        isSelected && 'bg-muted',
                        isToday && 'font-semibold',
                      )}
                    >
                      <span>{day}</span>
                      {eventsOnDay.length > 0 && (
                        <div className="flex gap-0.5 mt-0.5 flex-wrap justify-center">
                          {eventsOnDay.slice(0, 3).map((e, ei) => (
                            <span key={ei} className={cn('w-1.5 h-1.5 rounded-full', DOT_COLORS[e.type])} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex gap-3 flex-wrap pt-1 border-t">
                {[
                  { type: 'payment',    label: t('dashboard.payment'),    color: 'bg-blue-500' },
                  { type: 'expiration', label: t('dashboard.expiry'),     color: 'bg-red-500' },
                  { type: 'renewal',    label: t('dashboard.renewal'),    color: 'bg-indigo-500' },
                  { type: 'escalation', label: t('dashboard.escalation'), color: 'bg-amber-500' },
                ].map(({ type, label, color }) => (
                  <div key={type} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className={cn('w-2 h-2 rounded-full', color)} />
                    {label}
                  </div>
                ))}
              </div>

              {selectedDay && (() => {
                const dayEvents = visibleEvents.filter((e) => {
                  const d = e.date;
                  return (
                    d.getFullYear() === selectedDay.getFullYear() &&
                    d.getMonth() === selectedDay.getMonth() &&
                    d.getDate() === selectedDay.getDate()
                  );
                });
                return (
                  <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                    <p className="text-xs font-medium">{formatLocalizedDateLong(selectedDay, language as SupportedLocale)}</p>
                    {dayEvents.map((event) => {
                      const config = eventConfig[event.type];
                      const EventIcon = config.icon;
                      return (
                        <Link
                          key={event.id}
                          to={`/app/leases/${event.leaseId}`}
                          className="flex items-center gap-2 text-sm hover:bg-muted/50 rounded px-1 py-0.5"
                        >
                          <EventIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">{event.property}</span>
                          <Badge variant={config.variant} className="text-[10px]">
                            {t(config.labelKey)}
                          </Badge>
                        </Link>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          );
        })() : (
        <div className="space-y-2">
          {groups.map(({ type, events }) => {
            const groupConfig = eventConfig[type];
            const GroupIcon = groupConfig.icon;
            const isCollapsed = !!collapsedGroups[type];
            return (
              <div key={type} className="rounded-lg border overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                  <button
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    onClick={() => toggleGroup(type)}
                  >
                    <GroupIcon className={cn(
                      'h-4 w-4 shrink-0',
                      groupConfig.variant === 'destructive' && 'text-destructive',
                      groupConfig.variant === 'info'        && 'text-info',
                      groupConfig.variant === 'warning'     && 'text-warning',
                      groupConfig.variant === 'default'     && 'text-primary',
                    )} />
                    <span className="text-sm font-medium">{GROUP_META[type].label}</span>
                    <span className="text-xs text-muted-foreground flex-1 truncate ml-1">{GROUP_META[type].subtotal(events)}</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isCollapsed && 'rotate-180')} />
                  </button>
                  <button
                    onClick={() => dismissEvents(events.map((e) => e.id))}
                    className="text-xs text-muted-foreground hover:text-foreground shrink-0 ml-1"
                  >
                    {t('dashboard.dismiss_all')}
                  </button>
                </div>
                {!isCollapsed && (() => {
                  const ITEMS_PER_GROUP = 5;
                  const displayedEvents = events.slice(0, ITEMS_PER_GROUP);
                  const hasMore = events.length > ITEMS_PER_GROUP;
                  return (
                    <div>
                      {displayedEvents.map((event) => {
                        const isUrgent = event.daysUntil <= 7;
                        const isWarning = event.daysUntil <= 30;
                        return (
                          <div
                            key={event.id}
                            className={cn(
                              'flex items-center border-t transition-all group',
                              isUrgent && 'bg-destructive/5',
                            )}
                          >
                            <Link
                              to={`/app/leases/${event.leaseId}`}
                              className={cn(
                                'flex items-center gap-3 p-3 flex-1 min-w-0 hover:bg-muted/50 transition-all',
                                isUrgent && 'hover:bg-destructive/10',
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{event.property}</p>
                                <div className="flex items-center gap-2 text-xs">
                                  <span className={cn(
                                    isUrgent  ? 'text-destructive font-medium' :
                                    isWarning ? 'text-warning' :
                                                'text-muted-foreground',
                                  )}>
                                    {getDaysLabel(event.daysUntil)}
                                  </span>
                                  {event.amount && (
                                    <><span className="text-muted-foreground">·</span><span className="font-medium text-foreground">{formatCurrency(event.amount, language)}/{t('common.per_month_short')}</span></>
                                  )}
                                </div>
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {formatLocalizedDate(event.date, language as SupportedLocale, { month: 'short', day: 'numeric' })}
                              </span>
                            </Link>
                            <button
                              onClick={() => dismissEvents([event.id])}
                              className="p-2 mr-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                              title={t('quota_banner.dismiss')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                      {hasMore && (
                        <button
                          onClick={() => setDrawerGroup(type)}
                          className="w-full py-2 text-xs text-center text-muted-foreground hover:text-foreground border-t transition-colors"
                        >
                          {t('dashboard.show_all_arrow', { count: events.length })}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
        )}
      </CardContent>
    </Card>

    <Sheet open={!!drawerGroup} onOpenChange={(open) => !open && setDrawerGroup(null)}>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {drawerGroup ? GROUP_META[drawerGroup].label : ''} ({drawerEvents.length})
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-1">
          {drawerEvents.map((event) => {
            const isUrgent = event.daysUntil <= 7;
            const isWarning = event.daysUntil <= 30;
            return (
              <Link
                key={event.id}
                to={`/app/leases/${event.leaseId}`}
                onClick={() => setDrawerGroup(null)}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-all',
                  isUrgent && 'bg-destructive/5 hover:bg-destructive/10',
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{event.property}</p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={cn(
                      isUrgent  ? 'text-destructive font-medium' :
                      isWarning ? 'text-warning' :
                                  'text-muted-foreground',
                    )}>
                      {getDaysLabel(event.daysUntil)}
                    </span>
                    {event.amount && (
                      <><span className="text-muted-foreground">·</span>
                      <span className="font-medium text-foreground">{formatCurrency(event.amount, language)}/{t('common.per_month_short')}</span></>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{formatLocalizedDate(event.date, language as SupportedLocale, { month: 'short', day: 'numeric' })}</span>
              </Link>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
