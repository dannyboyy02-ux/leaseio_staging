import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, AlertCircle, TrendingUp, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface UpcomingEvent {
  id: string;
  type: 'renewal' | 'escalation' | 'expiration';
  title: string;
  property: string;
  date: string;
  daysUntil: number;
  leaseId: string;
}

const mockEvents: UpcomingEvent[] = [
  {
    id: '1',
    type: 'renewal',
    title: 'Lease renewal window opens',
    property: 'Suite 100, 123 Main St',
    date: '2025-02-15',
    daysUntil: 41,
    leaseId: '1',
  },
  {
    id: '2',
    type: 'escalation',
    title: 'Annual rent escalation',
    property: '456 Oak Avenue, Unit 2B',
    date: '2025-02-01',
    daysUntil: 27,
    leaseId: '2',
  },
  {
    id: '3',
    type: 'expiration',
    title: 'Lease expires',
    property: '789 Pine Boulevard',
    date: '2025-04-30',
    daysUntil: 115,
    leaseId: '3',
  },
];

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
};

export function UpcomingEvents() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Upcoming Events
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/notifications">
              View all <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {mockEvents.length === 0 ? (
          <div className="text-center py-8">
            <Calendar className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No upcoming events</p>
          </div>
        ) : (
          <div className="space-y-3">
            {mockEvents.map((event, index) => {
              const config = eventConfig[event.type];
              const EventIcon = config.icon;
              
              return (
                <Link
                  key={event.id}
                  to={`/leases/${event.leaseId}`}
                  className={cn(
                    'flex items-start gap-4 p-3 rounded-lg transition-all hover:bg-muted/50 animate-fade-up'
                  )}
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      config.variant === 'info' && 'bg-info/10 text-info',
                      config.variant === 'warning' && 'bg-warning/10 text-warning',
                      config.variant === 'destructive' && 'bg-destructive/10 text-destructive'
                    )}
                  >
                    <EventIcon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={config.variant} className="text-[10px]">
                        {config.label}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {event.daysUntil} days
                      </span>
                    </div>
                    <p className="text-sm font-medium truncate">{event.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {event.property}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-3" />
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
