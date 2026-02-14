import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { 
  ArrowLeft, 
  Bell, 
  Calendar, 
  TrendingUp, 
  AlertCircle, 
  Check, 
  Loader2,
  Building2,
  Clock,
  Mail,
  BellOff
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate, formatLocalizedDateWithWeekday } from '@/lib/dateFormatters';
import { cn } from '@/lib/utils';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';

interface NotificationWithLease {
  id: string;
  lease_id: string;
  event_type: 'renewal_window' | 'escalation' | 'expiration' | 'commencement' | 'custom' | 'new_request' | 'status_changed' | 'document_uploaded';
  event_date: string;
  event_description: string | null;
  notify_days_before: number[];
  notify_email: boolean;
  is_confirmed: boolean;
  last_notified_at: string | null;
  leases: {
    filename: string;
    landlord_name: string | null;
    tenant_name: string | null;
    extracted_json: { property_address?: string } | null;
  } | null;
}

export default function NotificationDetail() {
  const { notificationId } = useParams<{ notificationId: string }>();
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const [notification, setNotification] = useState<NotificationWithLease | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const notificationConfig = {
    renewal_window: {
      icon: Calendar,
      variant: 'info' as const,
      labelKey: 'notifications.type.renewal_window',
      color: 'bg-info/10 text-info border-info/20',
    },
    escalation: {
      icon: TrendingUp,
      variant: 'warning' as const,
      labelKey: 'notifications.type.escalation',
      color: 'bg-warning/10 text-warning border-warning/20',
    },
    expiration: {
      icon: AlertCircle,
      variant: 'destructive' as const,
      labelKey: 'notifications.type.expiration',
      color: 'bg-destructive/10 text-destructive border-destructive/20',
    },
    commencement: {
      icon: Calendar,
      variant: 'default' as const,
      labelKey: 'notifications.type.commencement',
      color: 'bg-primary/10 text-primary border-primary/20',
    },
    new_request: {
      icon: Bell,
      variant: 'default' as const,
      labelKey: 'notifications.type.custom',
      color: 'bg-primary/10 text-primary border-primary/20',
    },
    status_changed: {
      icon: Bell,
      variant: 'info' as const,
      labelKey: 'notifications.type.custom',
      color: 'bg-info/10 text-info border-info/20',
    },
    document_uploaded: {
      icon: Bell,
      variant: 'warning' as const,
      labelKey: 'notifications.type.custom',
      color: 'bg-warning/10 text-warning border-warning/20',
    },
    custom: {
      icon: Bell,
      variant: 'secondary' as const,
      labelKey: 'notifications.type.custom',
      color: 'bg-muted text-muted-foreground border-border',
    },
  };

  useEffect(() => {
    async function fetchNotification() {
      if (!notificationId) return;

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
              landlord_name,
              tenant_name,
              extracted_json
            )
          `)
          .eq('id', notificationId)
          .single();

        if (error) throw error;

        setNotification(data as unknown as NotificationWithLease);
      } catch (error) {
        console.error('Error fetching notification:', error);
        toast.error(t('notifications.error_loading'));
      } finally {
        setLoading(false);
      }
    }

    fetchNotification();
  }, [notificationId, t]);

  const handleToggleEmail = async () => {
    if (!notification) return;

    setUpdating(true);
    try {
      const { error } = await supabase
        .from('lease_notifications')
        .update({ notify_email: !notification.notify_email })
        .eq('id', notification.id);

      if (error) throw error;

      setNotification({ ...notification, notify_email: !notification.notify_email });
      toast.success(
        notification.notify_email 
          ? t('notifications.email_disabled') 
          : t('notifications.email_enabled')
      );
    } catch (error) {
      console.error('Error updating notification:', error);
      toast.error(t('notifications.error_updating'));
    } finally {
      setUpdating(false);
    }
  };

  const getDaysUntil = (dateString: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(dateString);
    eventDate.setHours(0, 0, 0, 0);
    return Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  const getDaysLabel = (days: number) => {
    if (days === 0) return t('dashboard.today');
    if (days === 1) return t('dashboard.tomorrow');
    if (days < 0) return t('notifications.days_ago', { count: Math.abs(days) });
    return t('notifications.days_remaining', { count: days });
  };

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title={t('notifications.detail_title')} />
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!notification) {
    return (
      <AppLayout>
        <AppHeader title={t('notifications.detail_title')} />
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
          <Bell className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">{t('notifications.not_found')}</p>
          <Button variant="outline" onClick={() => navigate('/app/notifications')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('notifications.back_to_list')}
          </Button>
        </div>
      </AppLayout>
    );
  }

  const config = notificationConfig[notification.event_type] || notificationConfig.custom;
  const NotificationIcon = config.icon;
  const daysUntil = getDaysUntil(notification.event_date);
  const isPast = daysUntil < 0;
  const property = getPropertyDisplayName(
    notification.leases?.extracted_json as Record<string, unknown> | null,
    notification.leases?.filename || null,
    t('notifications.unknown_property')
  );

  return (
    <AppLayout>
      <AppHeader
        title={t('notifications.detail_title')}
        actions={
          <Button variant="outline" onClick={() => navigate('/app/notifications')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-3xl mx-auto space-y-6">
        {/* Main Card */}
        <Card>
          <CardHeader>
            <div className="flex items-start gap-4">
              <div className={cn('p-3 rounded-xl border', config.color)}>
                <NotificationIcon className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <Badge variant={config.variant}>
                    {t(config.labelKey)}
                  </Badge>
                  {notification.is_confirmed && (
                    <Badge variant="success" className="text-xs">
                      <Check className="h-3 w-3 mr-1" />
                      {t('notifications.confirmed')}
                    </Badge>
                  )}
                  {notification.last_notified_at && (
                    <Badge variant="outline" className="text-xs">
                      {t('notifications.sent')}
                    </Badge>
                  )}
                  {isPast && (
                    <Badge variant="muted" className="text-xs">
                      {t('notifications.past')}
                    </Badge>
                  )}
                </div>
                <CardTitle className="text-xl">
                  {notification.event_description || t(config.labelKey)}
                </CardTitle>
                <CardDescription className="mt-1">
                  {formatLocalizedDateWithWeekday(notification.event_date, language)}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Days Remaining */}
            <div className={cn(
              'p-4 rounded-lg border text-center',
              isPast ? 'bg-muted/50' : 'bg-primary/5 border-primary/20'
            )}>
              <div className="flex items-center justify-center gap-2 mb-1">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {isPast ? t('notifications.event_passed') : t('notifications.time_remaining')}
                </span>
              </div>
              <p className={cn(
                'text-2xl font-bold',
                isPast ? 'text-muted-foreground' : 'text-primary'
              )}>
                {getDaysLabel(daysUntil)}
              </p>
            </div>

            <Separator />

            {/* Property Info */}
            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                {t('notifications.associated_lease')}
              </h3>
              <div className="bg-muted/50 rounded-lg p-4">
                <Link 
                  to={`/app/leases/${notification.lease_id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {property}
                </Link>
                {notification.leases?.tenant_name && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('lease.tenant')}: {notification.leases.tenant_name}
                  </p>
                )}
                {notification.leases?.landlord_name && (
                  <p className="text-sm text-muted-foreground">
                    {t('lease.landlord')}: {notification.leases.landlord_name}
                  </p>
                )}
              </div>
            </div>

            <Separator />

            {/* Email Settings */}
            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2">
              {notification.notify_email ? (
                  <Mail className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <BellOff className="h-4 w-4 text-muted-foreground" />
                )}
                {t('notifications.email_settings')}
              </h3>
              <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium">
                    {notification.notify_email 
                      ? t('notifications.email_on') 
                      : t('notifications.email_off')}
                  </p>
                  {notification.notify_email && notification.notify_days_before.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t('notifications.alert_schedule')}: {notification.notify_days_before.sort((a, b) => b - a).join(', ')} {t('notifications.days_before')}
                    </p>
                  )}
                </div>
                <Button
                  variant={notification.notify_email ? 'outline' : 'default'}
                  size="sm"
                  onClick={handleToggleEmail}
                  disabled={updating || isPast}
                >
                  {updating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : notification.notify_email ? (
                    t('notifications.disable')
                  ) : (
                    t('notifications.enable')
                  )}
                </Button>
              </div>
            </div>

            {/* Last Notified */}
            {notification.last_notified_at && (
              <>
                <Separator />
                <div className="text-sm text-muted-foreground">
                  {t('notifications.last_sent')}: {formatLocalizedDate(notification.last_notified_at, language)}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex gap-3">
          <Button 
            variant="outline" 
            className="flex-1"
            onClick={() => navigate(`/app/leases/${notification.lease_id}`)}
          >
            {t('notifications.view_lease')}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
