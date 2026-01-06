import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, AlertCircle, TrendingUp, Clock, DollarSign } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { differenceInDays, format } from 'date-fns';

interface UpcomingEvent {
  id: string;
  type: 'renewal' | 'escalation' | 'expiration' | 'payment';
  title: string;
  property: string;
  date: Date;
  daysUntil: number;
  leaseId: string;
  amount?: number;
}

const eventConfig = {
  renewal: {
    icon: Clock,
    variant: 'info' as const,
    label: 'Renewal',
  },
  escalation: {
    icon: TrendingUp,
    variant: 'warning' as const,
    label: 'Escalation',
  },
  expiration: {
    icon: AlertCircle,
    variant: 'destructive' as const,
    label: 'Expiration',
  },
  payment: {
    icon: DollarSign,
    variant: 'default' as const,
    label: 'Payment',
  },
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function UpcomingEvents() {
  const { data: events, isLoading } = useQuery({
    queryKey: ['upcoming-events'],
    queryFn: async (): Promise<UpcomingEvent[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const now = new Date();
      const ninetyDaysFromNow = new Date(now);
      ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);

      // Get leases that expire within 90 days or have upcoming escalations
      const { data: leases, error } = await supabase
        .from('leases')
        .select('id, filename, lease_end, current_monthly_rent, status, extracted_json')
        .eq('user_id', user.id)
        .in('status', ['final', 'review']);

      if (error) throw error;

      const upcomingEvents: UpcomingEvent[] = [];

      for (const lease of leases || []) {
        const propertyAddress = lease.extracted_json 
          ? (lease.extracted_json as Record<string, unknown>)?.property_address as string
          : null;
        const property = propertyAddress || lease.filename || 'Unknown Property';

        // Check for expiring leases
        if (lease.lease_end) {
          const endDate = new Date(lease.lease_end);
          const daysUntil = differenceInDays(endDate, now);

          if (daysUntil >= 0 && daysUntil <= 90) {
            upcomingEvents.push({
              id: `exp-${lease.id}`,
              type: 'expiration',
              title: 'Lease expires',
              property,
              date: endDate,
              daysUntil,
              leaseId: lease.id,
            });
          }

          // Add renewal window event (60 days before expiration)
          if (daysUntil >= 30 && daysUntil <= 60) {
            upcomingEvents.push({
              id: `ren-${lease.id}`,
              type: 'renewal',
              title: 'Renewal window opens',
              property,
              date: new Date(endDate.getTime() - 60 * 24 * 60 * 60 * 1000),
              daysUntil: daysUntil - 60,
              leaseId: lease.id,
            });
          }
        }

        // Add next month's payment
        if (lease.current_monthly_rent && Number(lease.current_monthly_rent) > 0) {
          const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const daysUntilPayment = differenceInDays(nextMonth, now);
          
          upcomingEvents.push({
            id: `pay-${lease.id}`,
            type: 'payment',
            title: 'Rent payment due',
            property,
            date: nextMonth,
            daysUntil: daysUntilPayment,
            leaseId: lease.id,
            amount: Number(lease.current_monthly_rent),
          });
        }
      }

      // Sort by days until event
      return upcomingEvents
        .sort((a, b) => a.daysUntil - b.daysUntil)
        .slice(0, 5);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Upcoming Events
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

  return (
    <Card className="animate-fade-up" style={{ animationDelay: '50ms' }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Upcoming Events
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/notifications">
              View all <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!events || events.length === 0 ? (
          <div className="text-center py-8">
            <Calendar className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No upcoming events</p>
            <p className="text-xs text-muted-foreground mt-1">
              Events will appear here as your leases approach key dates
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((event, index) => {
              const config = eventConfig[event.type];
              const EventIcon = config.icon;
              const isUrgent = event.daysUntil <= 7;
              const isWarning = event.daysUntil <= 30;
              
              return (
                <Link
                  key={event.id}
                  to={`/app/leases/${event.leaseId}`}
                  className={cn(
                    'flex items-start gap-4 p-3 rounded-lg transition-all hover:bg-muted/50 animate-fade-up',
                    isUrgent && 'bg-destructive/5 hover:bg-destructive/10'
                  )}
                  style={{ animationDelay: `${(index + 1) * 50}ms` }}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      config.variant === 'info' && 'bg-info/10 text-info',
                      config.variant === 'warning' && 'bg-warning/10 text-warning',
                      config.variant === 'destructive' && 'bg-destructive/10 text-destructive',
                      config.variant === 'default' && 'bg-primary/10 text-primary'
                    )}
                  >
                    <EventIcon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={config.variant} className="text-[10px]">
                        {config.label}
                      </Badge>
                      <span className={cn(
                        'text-xs',
                        isUrgent ? 'text-destructive font-medium' : 
                        isWarning ? 'text-warning' : 'text-muted-foreground'
                      )}>
                        {event.daysUntil === 0 ? 'Today' : 
                         event.daysUntil === 1 ? 'Tomorrow' : 
                         `${event.daysUntil} days`}
                      </span>
                    </div>
                    <p className="text-sm font-medium truncate">{event.title}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{event.property}</span>
                      {event.amount && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-foreground">
                            {formatCurrency(event.amount)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {format(event.date, 'MMM d')}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground mt-2" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
