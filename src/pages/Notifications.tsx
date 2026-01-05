import { useState } from 'react';
import { Bell, Calendar, TrendingUp, AlertCircle, Check, MoreHorizontal, Filter } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

interface NotificationItem {
  id: string;
  type: 'renewal' | 'escalation' | 'expiration';
  title: string;
  message: string;
  property: string;
  leaseId: string;
  scheduledFor: string;
  status: 'scheduled' | 'sent' | 'failed';
  channels: ('email' | 'sms')[];
}

const mockNotifications: NotificationItem[] = [
  {
    id: '1',
    type: 'renewal',
    title: 'Lease renewal window opens',
    message: 'The renewal window for Suite 100 opens in 90 days. Consider reviewing terms.',
    property: 'Suite 100, 123 Main St',
    leaseId: '1',
    scheduledFor: '2025-02-15T09:00:00Z',
    status: 'scheduled',
    channels: ['email', 'sms'],
  },
  {
    id: '2',
    type: 'escalation',
    title: 'Annual rent escalation',
    message: 'Rent for 456 Oak Avenue will increase by 3% on the anniversary date.',
    property: '456 Oak Avenue, Unit 2B',
    leaseId: '2',
    scheduledFor: '2025-02-01T09:00:00Z',
    status: 'scheduled',
    channels: ['email'],
  },
  {
    id: '3',
    type: 'expiration',
    title: 'Lease expiring soon',
    message: 'The lease for 789 Pine Boulevard expires in 30 days.',
    property: '789 Pine Boulevard',
    leaseId: '3',
    scheduledFor: '2025-04-01T09:00:00Z',
    status: 'sent',
    channels: ['email', 'sms'],
  },
];

const notificationConfig = {
  renewal: {
    icon: Calendar,
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

export default function Notifications() {
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'sent'>('all');

  const filteredNotifications = mockNotifications.filter((n) => {
    if (filter === 'all') return true;
    return n.status === filter;
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <AppLayout>
      <AppHeader
        title="Notifications"
        subtitle="Manage lease alerts and reminders"
        actions={
          <Button variant="outline">
            <Filter className="h-4 w-4 mr-2" />
            Configure Defaults
          </Button>
        }
      />

      <div className="p-6">
        <Tabs defaultValue="all" onValueChange={(v) => setFilter(v as 'all' | 'scheduled' | 'sent')}>
          <TabsList className="mb-6">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            <TabsTrigger value="sent">Sent</TabsTrigger>
          </TabsList>

          <TabsContent value={filter} className="mt-0">
            {filteredNotifications.length === 0 ? (
              <Card variant="ghost" className="border-2 border-dashed border-border">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                    <Bell className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">No notifications</h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    Notifications will appear here once you have finalized leases with upcoming events.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredNotifications.map((notification, index) => {
                  const config = notificationConfig[notification.type];
                  const NotificationIcon = config.icon;

                  return (
                    <Card
                      key={notification.id}
                      variant="interactive"
                      className={cn('animate-fade-up')}
                      style={{ animationDelay: `${index * 50}ms` }}
                    >
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <div
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                              config.variant === 'info' && 'bg-info/10 text-info',
                              config.variant === 'warning' && 'bg-warning/10 text-warning',
                              config.variant === 'destructive' && 'bg-destructive/10 text-destructive'
                            )}
                          >
                            <NotificationIcon className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant={config.variant} className="text-[10px]">
                                {config.label}
                              </Badge>
                              <Badge
                                variant={notification.status === 'sent' ? 'success' : 'muted'}
                                className="text-[10px]"
                              >
                                {notification.status === 'sent' ? 'Sent' : 'Scheduled'}
                              </Badge>
                            </div>
                            <h3 className="font-medium mb-1">{notification.title}</h3>
                            <p className="text-sm text-muted-foreground mb-2">
                              {notification.message}
                            </p>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              <Link
                                to={`/leases/${notification.leaseId}`}
                                className="hover:text-accent hover:underline"
                              >
                                {notification.property}
                              </Link>
                              <span>•</span>
                              <span>{formatDate(notification.scheduledFor)}</span>
                              <span>•</span>
                              <span className="capitalize">
                                {notification.channels.join(' & ')}
                              </span>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem>View Lease</DropdownMenuItem>
                              <DropdownMenuItem>Edit Notification</DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive">
                                Cancel Notification
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
