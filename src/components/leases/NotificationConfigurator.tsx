import { useState, useEffect } from 'react';
import { Bell, BellOff, Calendar, Check, Plus, Trash2, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDateWithWeekday, formatLocalizedCurrency } from '@/lib/dateFormatters';

interface NotificationEvent {
  id?: string;
  event_type: 'expiration' | 'escalation' | 'renewal_window' | 'commencement' | 'custom';
  event_date: string;
  event_description: string;
  notify_days_before: number[];
  notify_email: boolean;
  is_confirmed: boolean;
}

interface NotificationConfiguratorProps {
  leaseId: string;
  leaseStart: string | null;
  leaseEnd: string | null;
  rentSchedule: Array<{ period_start: string; monthly_amount?: number | null }>;
  onNotificationsChange?: (notifications: NotificationEvent[]) => void;
}

export function NotificationConfigurator({
  leaseId,
  leaseStart,
  leaseEnd,
  rentSchedule,
  onNotificationsChange,
}: NotificationConfiguratorProps) {
  const { t, language } = useLanguage();
  const [notifications, setNotifications] = useState<NotificationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [customDescription, setCustomDescription] = useState('');

  const EVENT_TYPE_CONFIG = {
    commencement: { 
      labelKey: 'notifications.config.lease_commencement', 
      icon: Calendar, 
      color: 'bg-info/10 text-info' 
    },
    expiration: { 
      labelKey: 'notifications.config.lease_expiration', 
      icon: AlertCircle, 
      color: 'bg-destructive/10 text-destructive' 
    },
    renewal_window: { 
      labelKey: 'notifications.config.renewal_window', 
      icon: Calendar, 
      color: 'bg-warning/10 text-warning' 
    },
    escalation: { 
      labelKey: 'notifications.config.rent_escalation', 
      icon: Calendar, 
      color: 'bg-accent/10 text-accent' 
    },
    custom: { 
      labelKey: 'notifications.config.custom_date', 
      icon: Calendar, 
      color: 'bg-muted text-muted-foreground' 
    },
  };

  const NOTIFICATION_SCHEDULES = [
    { value: 90, labelKey: 'notifications.config.90_days' },
    { value: 60, labelKey: 'notifications.config.60_days' },
    { value: 30, labelKey: 'notifications.config.30_days' },
    { value: 14, labelKey: 'notifications.config.14_days' },
    { value: 7, labelKey: 'notifications.config.7_days' },
  ];

  // Generate initial notifications from lease data
  useEffect(() => {
    async function loadNotifications() {
      try {
        // First, try to load existing notifications
        const { data: existingNotifications, error } = await supabase
          .from('lease_notifications')
          .select('*')
          .eq('lease_id', leaseId);

        if (error) throw error;

        if (existingNotifications && existingNotifications.length > 0) {
          // Map database records to our interface
          const mapped = existingNotifications.map((n) => ({
            id: n.id,
            event_type: n.event_type as NotificationEvent['event_type'],
            event_date: n.event_date,
            event_description: n.event_description || '',
            notify_days_before: n.notify_days_before || [90, 60, 30, 14, 7],
            notify_email: n.notify_email,
            is_confirmed: n.is_confirmed,
          }));
          setNotifications(mapped);
        } else {
          // Generate from lease data
          const generated: NotificationEvent[] = [];

          if (leaseStart) {
            generated.push({
              event_type: 'commencement',
              event_date: leaseStart,
              event_description: t('notifications.config.commencement_desc'),
              notify_days_before: [30, 14, 7],
              notify_email: false,
              is_confirmed: false,
            });
          }

          if (leaseEnd) {
            generated.push({
              event_type: 'expiration',
              event_date: leaseEnd,
              event_description: t('notifications.config.expiration_desc'),
              notify_days_before: [90, 60, 30, 14, 7],
              notify_email: false,
              is_confirmed: false,
            });

            // Add renewal window (90 days before expiration)
            const expirationDate = new Date(leaseEnd);
            const renewalWindow = new Date(expirationDate);
            renewalWindow.setDate(renewalWindow.getDate() - 90);
            generated.push({
              event_type: 'renewal_window',
              event_date: renewalWindow.toISOString().split('T')[0],
              event_description: t('notifications.config.renewal_desc'),
              notify_days_before: [14, 7],
              notify_email: false,
              is_confirmed: false,
            });
          }

          // Add escalation dates from rent schedule
          if (rentSchedule && rentSchedule.length > 1) {
            for (let i = 1; i < rentSchedule.length; i++) {
              const schedule = rentSchedule[i];
              if (schedule.period_start) {
                const amount = schedule.monthly_amount 
                  ? formatLocalizedCurrency(schedule.monthly_amount, language)
                  : 'TBD';
                generated.push({
                  event_type: 'escalation',
                  event_date: schedule.period_start,
                  event_description: `${t('notifications.config.escalation_desc')} ${amount}${t('notifications.config.per_month')}`,
                  notify_days_before: [30, 14, 7],
                  notify_email: false,
                  is_confirmed: false,
                });
              }
            }
          }

          setNotifications(generated);
        }
      } catch (error) {
        console.error('Error loading notifications:', error);
      } finally {
        setLoading(false);
      }
    }

    loadNotifications();
  }, [leaseId, leaseStart, leaseEnd, rentSchedule, t, language]);

  // Notify parent of changes
  useEffect(() => {
    onNotificationsChange?.(notifications);
  }, [notifications, onNotificationsChange]);

  const handleConfirmToggle = (index: number) => {
    setNotifications((prev) =>
      prev.map((n, i) => (i === index ? { ...n, is_confirmed: !n.is_confirmed } : n))
    );
  };

  const handleEmailToggle = (index: number) => {
    setNotifications((prev) =>
      prev.map((n, i) => (i === index ? { ...n, notify_email: !n.notify_email } : n))
    );
  };

  const handleScheduleChange = (index: number, days: number, checked: boolean) => {
    setNotifications((prev) =>
      prev.map((n, i) => {
        if (i !== index) return n;
        const newDays = checked
          ? [...n.notify_days_before, days].sort((a, b) => b - a)
          : n.notify_days_before.filter((d) => d !== days);
        return { ...n, notify_days_before: newDays };
      })
    );
  };

  const handleAddCustomDate = () => {
    if (!customDate || !customDescription) {
      toast.error(t('notifications.config.missing_date_description'));
      return;
    }

    setNotifications((prev) => [
      ...prev,
      {
        event_type: 'custom',
        event_date: customDate,
        event_description: customDescription,
        notify_days_before: [30, 14, 7],
        notify_email: false,
        is_confirmed: false,
      },
    ]);

    setCustomDate('');
    setCustomDescription('');
    setShowAddCustom(false);
  };

  const handleRemoveCustomDate = (index: number) => {
    setNotifications((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveNotifications = async () => {
    setSaving(true);
    try {
      // Delete existing notifications for this lease
      await supabase.from('lease_notifications').delete().eq('lease_id', leaseId);

      // Insert new notifications
      const toInsert = notifications.map((n) => ({
        lease_id: leaseId,
        event_type: n.event_type,
        event_date: n.event_date,
        event_description: n.event_description,
        notify_days_before: n.notify_days_before,
        notify_email: n.notify_email,
        is_confirmed: n.is_confirmed,
      }));

      const { error } = await supabase.from('lease_notifications').insert(toInsert);

      if (error) throw error;

      toast.success(t('notifications.config.save_success'));
    } catch (error) {
      console.error('Error saving notifications:', error);
      toast.error(t('notifications.config.save_error'));
    } finally {
      setSaving(false);
    }
  };

  const confirmedCount = notifications.filter((n) => n.is_confirmed).length;
  const enabledCount = notifications.filter((n) => n.notify_email && n.is_confirmed).length;

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Bell className="h-5 w-5" />
              {t('notifications.config.title')}
            </CardTitle>
            <CardDescription>
              {t('notifications.config.description')}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {confirmedCount}/{notifications.length} {t('notifications.config.confirmed_count')}
            </Badge>
            <Badge variant={enabledCount > 0 ? 'default' : 'secondary'}>
              {enabledCount} {t('notifications.config.active_alerts')}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {notifications.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>{t('notifications.config.no_dates')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notifications.map((notification, index) => {
              const config = EVENT_TYPE_CONFIG[notification.event_type];
              const Icon = config.icon;
              const isPast = new Date(notification.event_date) < new Date();

              return (
                <div
                  key={index}
                  className={cn(
                    'border rounded-lg p-4 transition-all',
                    notification.is_confirmed
                      ? 'border-green-500/30 bg-green-500/5'
                      : 'border-yellow-500/30 bg-yellow-500/5'
                  )}
                >
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={cn('p-2 rounded-lg', config.color)}>
                      <Icon className="h-4 w-4" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium">{t(config.labelKey)}</span>
                        {!notification.is_confirmed && (
                          <Badge variant="warning" className="text-[10px]">
                            {t('notifications.config.unconfirmed')}
                          </Badge>
                        )}
                        {notification.is_confirmed && (
                          <Badge variant="success" className="text-[10px]">
                            <Check className="h-3 w-3 mr-1" />
                            {t('notifications.confirmed')}
                          </Badge>
                        )}
                        {isPast && (
                          <Badge variant="muted" className="text-[10px]">
                            {t('notifications.past')}
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-muted-foreground">
                          {formatLocalizedDateWithWeekday(notification.event_date, language)}
                        </span>
                        {notification.event_description && (
                          <>
                            <span className="text-muted-foreground">•</span>
                            <span className="text-muted-foreground">
                              {notification.event_description}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Notification Schedule */}
                      {notification.is_confirmed && !isPast && (
                        <div className="mt-3 pt-3 border-t border-border/50">
                          <div className="flex items-center justify-between mb-2">
                            <Label className="text-xs font-medium">{t('notifications.config.notify_me')}</Label>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={notification.notify_email}
                                onCheckedChange={() => handleEmailToggle(index)}
                              />
                              <span className="text-xs text-muted-foreground">
                                {notification.notify_email ? t('notifications.config.email_enabled') : t('notifications.config.off')}
                              </span>
                            </div>
                          </div>
                          {notification.notify_email && (
                            <div className="flex flex-wrap gap-2">
                              {NOTIFICATION_SCHEDULES.map((schedule) => (
                                <label
                                  key={schedule.value}
                                  className="flex items-center gap-1.5 text-xs"
                                >
                                  <Checkbox
                                    checked={notification.notify_days_before.includes(schedule.value)}
                                    onCheckedChange={(checked) =>
                                      handleScheduleChange(index, schedule.value, checked as boolean)
                                    }
                                  />
                                  {schedule.value} {t('notifications.config.days_before')}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <Button
                        variant={notification.is_confirmed ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => handleConfirmToggle(index)}
                      >
                        {notification.is_confirmed ? (
                          <>{t('notifications.config.unconfirm')}</>
                        ) : (
                          <>
                            <Check className="h-4 w-4 mr-1" />
                            {t('common.confirm')}
                          </>
                        )}
                      </Button>
                      {notification.event_type === 'custom' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleRemoveCustomDate(index)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add Custom Date */}
        {showAddCustom ? (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="custom-date">{t('notifications.config.date')}</Label>
                <Input
                  id="custom-date"
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="custom-description">{t('notifications.config.description_label')}</Label>
                <Input
                  id="custom-description"
                  value={customDescription}
                  onChange={(e) => setCustomDescription(e.target.value)}
                  placeholder={t('notifications.config.description_placeholder')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAddCustom(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleAddCustomDate}>
                {t('notifications.config.add_date')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="w-full" onClick={() => setShowAddCustom(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('notifications.config.add_custom')}
          </Button>
        )}

        {/* Save Button */}
        <div className="pt-4 border-t">
          <Button onClick={handleSaveNotifications} disabled={saving} className="w-full">
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Bell className="h-4 w-4 mr-2" />
            )}
            {t('notifications.config.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
