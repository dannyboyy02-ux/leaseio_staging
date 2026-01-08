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
      labelKey: 'dashboard.renewal',
    },
    escalation: {
      icon: TrendingUp,
      variant: 'warning' as const,
      labelKey: 'dashboard.escalation',
    },
    expiration: {
      icon: AlertCircle,
      variant: 'destructive' as const,
      labelKey: 'dashboard.expiration',
    },
    commencement: {
      icon: Calendar,
      variant: 'default' as const,
      labelKey: 'lease.commencement_date',
    },
    custom: {
      icon: Bell,
      variant: 'secondary' as const,
      labelKey: 'notifications.custom',
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
        toast.error('Failed to load notifications');
      } finally {
        setLoading(false);
      }
    }

    fetchNotifications();
  }, []);

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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(language === 'es' ? 'es-MX' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

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
      toast.success('Notification disabled');
    } catch (error) {
      console.error('Error canceling notification:', error);
      toast.error('Failed to cancel notification');
    }
  };

  // Translation labels
  const tabLabels = {
    all: language === 'es' ? 'Todas Confirmadas' : 'All Confirmed',
    upcoming: language === 'es' ? 'Alertas Próximas' : 'Upcoming Alerts',
    sent: language === 'es' ? 'Ya Enviadas' : 'Already Sent',
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
            <TabsTrigger value="all">{tabLabels.all}</TabsTrigger>
            <TabsTrigger value="upcoming">{tabLabels.upcoming}</TabsTrigger>
            <TabsTrigger value="sent">{tabLabels.sent}</TabsTrigger>
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
                    {language === 'es' ? 'Ver Arrendamientos' : 'View Leases'}
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
                    (language === 'es' ? 'Propiedad Desconocida' : 'Unknown Property');

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
                                  {language === 'es' ? 'Enviado' : 'Sent'}
                                </Badge>
                              )}
                              {!wasSent && notification.notify_email && !isPast && (
                                <Badge variant="muted" className="text-[10px]">
                                  {language === 'es' ? 'Programado' : 'Scheduled'}
                                </Badge>
                              )}
                              {isPast && !wasSent && (
                                <Badge variant="secondary" className="text-[10px]">
                                  {language === 'es' ? 'Pasado' : 'Past'}
                                </Badge>
                              )}
                              {!notification.notify_email && (
                                <Badge variant="outline" className="text-[10px]">
                                  {language === 'es' ? 'Email Desactivado' : 'Email Off'}
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
                              >
                                {property}
                              </Link>
                              <span>•</span>
                              <span>{formatDate(notification.event_date)}</span>
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
                                    {language === 'es' ? 'Alertas' : 'Alerts'}: {notification.notify_days_before.sort((a, b) => b - a).join(', ')} {language === 'es' ? 'días antes' : 'days before'}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => navigate(`/app/leases/${notification.lease_id}`)}
                              >
                                {language === 'es' ? 'Ver Arrendamiento' : 'View Lease'}
                              </DropdownMenuItem>
                              {notification.notify_email && !isPast && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleCancelNotification(notification.id)}
                                >
                                  {language === 'es' ? 'Desactivar Notificaciones' : 'Disable Notifications'}
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
