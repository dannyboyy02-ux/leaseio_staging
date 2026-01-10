import { useState, useEffect } from 'react';
import { Bell, Calendar, TrendingUp, AlertCircle, Check, MoreHorizontal, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate } from '@/lib/dateFormatters';

interface NotificationWithLease {
  id: string;
  lease_id: string;
  event_type: 'renewal_window' | 'escalation' | 'expiration' | 'commencement' | 'custom';
  event_date: string;
  event_description: string | null;
  notify_days_before: number[];
  notify_email: boolean;
  is_confirmed: boolean;
  last_notified_at: string | null;
  leases: {
    filename: string;
    extracted_json: { property_address?: string } | null;
  } | null;
}

export default function Notifications() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'sent'>('all');
  const [notifications, setNotifications] = useState<NotificationWithLease[]>([]);
  const [loading, setLoading] = useState(true);

  const notificationConfig = {
    renewal_window: {
      icon: Calendar,
      variant: 'info' as const,
      labelKey: 'notifications.type.renewal_window',
    },
    escalation: {
      icon: TrendingUp,
      variant: 'warning' as const,
      labelKey: 'notifications.type.escalation',
    },
    expiration: {
      icon: AlertCircle,
      variant: 'destructive' as const,
      labelKey: 'notifications.type.expiration',
    },
    commencement: {
      icon: Calendar,
      variant: 'default' as const,
      labelKey: 'notifications.type.commencement',
    },
    custom: {
      icon: Bell,
      variant: 'secondary' as const,
      labelKey: 'notifications.type.custom',
    },
  };

  useEffect(() => {
    async function fetchNotifications() {
      try {
        const { data, error } = await supabase
          .from('lease_notifications')
          .select(`
            id,
            lease_id,
            event_type,
            event_date,
            event_description,
            notify_days_before,
            notify_email,
            is_confirmed,
            last_notified_at,
            leases (
              filename,
              extracted_json
            )
          `)
          .eq('is_confirmed', true)
          .order('event_date', { ascending: true });

        if (error) throw error;

        setNotifications((data || []) as unknown as NotificationWithLease[]);
      } catch (error) {
        console.error('Error fetching notifications:', error);
        toast.error(t('notifications.error_loading'));
      } finally {
        setLoading(false);
      }
    }

    fetchNotifications();
  }, [t]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const filteredNotifications = notifications.filter((n) => {
    const eventDate = new Date(n.event_date);
    eventDate.setHours(0, 0, 0, 0);
    const isPast = eventDate < today;
    const wasSent = n.last_notified_at !== null;

    if (filter === 'all') return true;
    if (filter === 'upcoming') return !isPast && n.notify_email;
    if (filter === 'sent') return wasSent;
    return true;
  });

  const getDaysUntil = (dateString: string) => {
    const eventDate = new Date(dateString);
    eventDate.setHours(0, 0, 0, 0);
    return Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  const getDaysLabel = (days: number) => {
    if (days === 0) return t('dashboard.today');
    if (days === 1) return t('dashboard.tomorrow');
    return `${days} ${t('dashboard.days')}`;
  };

  const handleCancelNotification = async (id: string) => {
    try {
      const { error } = await supabase
        .from('lease_notifications')
        .update({ notify_email: false })
        .eq('id', id);

      if (error) throw error;

      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, notify_email: false } : n))
      );
      toast.success(t('notifications.email_disabled'));
    } catch (error) {
      console.error('Error canceling notification:', error);
      toast.error(t('notifications.error_updating'));
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title={t('notifications.title')} subtitle={t('notifications.subtitle')} />
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
      />

      <div className="p-6">
        <Tabs defaultValue="all" onValueChange={(v) => setFilter(v as 'all' | 'upcoming' | 'sent')}>
          <TabsList className="mb-6">
            <TabsTrigger value="all">{t('notifications.tab_all')}</TabsTrigger>
            <TabsTrigger value="upcoming">{t('notifications.tab_upcoming')}</TabsTrigger>
            <TabsTrigger value="sent">{t('notifications.tab_sent')}</TabsTrigger>
          </TabsList>

          <TabsContent value={filter} className="mt-0">
            {filteredNotifications.length === 0 ? (
              <Card variant="ghost" className="border-2 border-dashed border-border">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                    <Bell className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{t('notifications.no_notifications')}</h3>
                  <p className="text-sm text-muted-foreground max-w-md mb-4">
                    {t('notifications.all_caught_up')}
                  </p>
                  <Button variant="outline" onClick={() => navigate('/app/leases')}>
                    {t('notifications.view_leases')}
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredNotifications.map((notification, index) => {
                  const config = notificationConfig[notification.event_type] || notificationConfig.custom;
                  const NotificationIcon = config.icon;
                  const daysUntil = getDaysUntil(notification.event_date);
                  const isPast = daysUntil < 0;
                  const wasSent = notification.last_notified_at !== null;
                  const property =
                    (notification.leases?.extracted_json as any)?.property_address ||
                    notification.leases?.filename ||
                    t('notifications.unknown_property');

                  return (
                    <Card
                      key={notification.id}
                      variant="interactive"
                      className={cn('animate-fade-up cursor-pointer')}
                      style={{ animationDelay: `${index * 50}ms` }}
                      onClick={() => navigate(`/app/notifications/${notification.id}`)}
                    >
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <div
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                              config.variant === 'info' && 'bg-info/10 text-info',
                              config.variant === 'warning' && 'bg-warning/10 text-warning',
                              config.variant === 'destructive' && 'bg-destructive/10 text-destructive',
                              config.variant === 'default' && 'bg-primary/10 text-primary',
                              config.variant === 'secondary' && 'bg-muted text-muted-foreground'
                            )}
                          >
                            <NotificationIcon className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <Badge variant={config.variant} className="text-[10px]">
                                {t(config.labelKey)}
                              </Badge>
                              {wasSent && (
                                <Badge variant="success" className="text-[10px]">
                                  <Check className="h-3 w-3 mr-1" />
                                  {t('notifications.sent')}
                                </Badge>
                              )}
                              {!wasSent && notification.notify_email && !isPast && (
                                <Badge variant="muted" className="text-[10px]">
                                  {t('notifications.scheduled')}
                                </Badge>
                              )}
                              {isPast && !wasSent && (
                                <Badge variant="secondary" className="text-[10px]">
                                  {t('notifications.past')}
                                </Badge>
                              )}
                              {!notification.notify_email && (
                                <Badge variant="outline" className="text-[10px]">
                                  {t('notifications.email_off')}
                                </Badge>
                              )}
                            </div>
                            <h3 className="font-medium mb-1">
                              {notification.event_description || t(config.labelKey)}
                            </h3>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                              <Link
                                to={`/app/leases/${notification.lease_id}`}
                                className="hover:text-accent hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {property}
                              </Link>
                              <span>•</span>
                              <span>{formatLocalizedDate(notification.event_date, language)}</span>
                              {!isPast && (
                                <>
                                  <span>•</span>
                                  <span className="font-medium">
                                    {getDaysLabel(daysUntil)}
                                  </span>
                                </>
                              )}
                              {notification.notify_email && (
                                <>
                                  <span>•</span>
                                  <span>
                                    {t('notifications.alerts')}: {notification.notify_days_before.sort((a, b) => b - a).join(', ')} {t('notifications.days_before')}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon-sm">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/app/leases/${notification.lease_id}`);
                                }}
                              >
                                {t('notifications.view_lease')}
                              </DropdownMenuItem>
                              {notification.notify_email && !isPast && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCancelNotification(notification.id);
                                  }}
                                >
                                  {t('notifications.disable')}
                                </DropdownMenuItem>
                              )}
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
