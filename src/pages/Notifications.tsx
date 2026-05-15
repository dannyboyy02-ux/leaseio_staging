import { useState, useEffect } from 'react';
import {
  Bell, Calendar, TrendingUp, AlertCircle, Check, MoreHorizontal, Loader2,
  AlertTriangle, ShieldAlert, ArrowUpDown, Clock,
} from 'lucide-react';
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
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';

// ─── In-app alert types (notifications table) ────────────────────────────────

interface InAppAlert {
  id: string;
  lease_id: string | null;
  alert_type: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

const ALERT_CONFIG: Record<
  string,
  { icon: React.ElementType; variant: 'warning' | 'destructive' | 'info' | 'default'; label: string }
> = {
  expiry_approaching: { icon: Clock,        variant: 'warning',     label: 'Expiry' },
  covenant_breach:    { icon: ShieldAlert,  variant: 'destructive', label: 'Covenant' },
  variance_high:      { icon: ArrowUpDown,  variant: 'info',        label: 'Variance' },
  approval_pending:   { icon: AlertTriangle,variant: 'default',     label: 'Approval' },
};

function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Email event scheduler types (lease_notifications table) ─────────────────

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
    extracted_json: { property_address?: string } | null;
  } | null;
}

const EVENT_CONFIG = {
  renewal_window:    { icon: Calendar,     variant: 'info' as const,        labelKey: 'notifications.type.renewal_window' },
  escalation:        { icon: TrendingUp,   variant: 'warning' as const,     labelKey: 'notifications.type.escalation' },
  expiration:        { icon: AlertCircle,  variant: 'destructive' as const, labelKey: 'notifications.type.expiration' },
  commencement:      { icon: Calendar,     variant: 'default' as const,     labelKey: 'notifications.type.commencement' },
  new_request:       { icon: Bell,         variant: 'default' as const,     labelKey: 'notifications.type.custom' },
  status_changed:    { icon: Bell,         variant: 'info' as const,        labelKey: 'notifications.type.custom' },
  document_uploaded: { icon: Bell,         variant: 'warning' as const,     labelKey: 'notifications.type.custom' },
  custom:            { icon: Bell,         variant: 'secondary' as const,   labelKey: 'notifications.type.custom' },
};

export default function Notifications() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();

  // In-app alerts state
  const [alerts, setAlerts] = useState<InAppAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);

  // Email events state
  const [eventFilter, setEventFilter] = useState<'all' | 'upcoming' | 'sent'>('all');
  const [events, setEvents] = useState<NotificationWithLease[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  // Fetch in-app alerts
  useEffect(() => {
    async function fetchAlerts() {
      try {
        const { data, error } = await supabase
          .from('notifications')
          .select('id, lease_id, alert_type, title, body, read_at, created_at')
          .order('created_at', { ascending: false });
        if (error) throw error;
        setAlerts((data as InAppAlert[]) || []);
      } catch (err) {
        console.error('Error fetching alerts:', err);
      } finally {
        setAlertsLoading(false);
      }
    }
    fetchAlerts();
  }, []);

  // Fetch email event scheduler entries
  useEffect(() => {
    async function fetchEvents() {
      try {
        const { data, error } = await supabase
          .from('lease_notifications')
          .select(`
            id, lease_id, event_type, event_date, event_description,
            notify_days_before, notify_email, is_confirmed, last_notified_at,
            leases ( filename, extracted_json )
          `)
          .eq('is_confirmed', true)
          .order('event_date', { ascending: true });
        if (error) throw error;
        setEvents((data || []) as unknown as NotificationWithLease[]);
      } catch (err) {
        console.error('Error fetching events:', err);
        toast.error(t('notifications.error_loading'));
      } finally {
        setEventsLoading(false);
      }
    }
    fetchEvents();
  }, [t]);

  const markAlertRead = async (id: string) => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, read_at: new Date().toISOString() } : a));
  };

  const handleCancelEvent = async (id: string) => {
    try {
      const { error } = await supabase
        .from('lease_notifications')
        .update({ notify_email: false })
        .eq('id', id);
      if (error) throw error;
      setEvents((prev) => prev.map((n) => n.id === id ? { ...n, notify_email: false } : n));
      toast.success(t('notifications.email_disabled'));
    } catch {
      toast.error(t('notifications.error_updating'));
    }
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const filteredEvents = events.filter((n) => {
    const d = new Date(n.event_date);
    d.setHours(0, 0, 0, 0);
    const isPast = d < today;
    if (eventFilter === 'all') return true;
    if (eventFilter === 'upcoming') return !isPast && n.notify_email;
    if (eventFilter === 'sent') return n.last_notified_at !== null;
    return true;
  });

  const getDaysUntil = (dateStr: string) => {
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
    return Math.ceil((d.getTime() - today.getTime()) / 86_400_000);
  };

  const getDaysLabel = (days: number) => {
    if (days === 0) return t('dashboard.today');
    if (days === 1) return t('dashboard.tomorrow');
    return `${days} ${t('dashboard.days')}`;
  };

  const unreadCount = alerts.filter((a) => !a.read_at).length;

  return (
    <AppLayout>
      <AppHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
      />

      <div className="p-6">
        <Tabs defaultValue="alerts">
          <TabsList className="mb-6">
            <TabsTrigger value="alerts" className="relative">
              Alerts
              {unreadCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-accent-foreground">
                  {unreadCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="all">{t('notifications.tab_all')}</TabsTrigger>
            <TabsTrigger value="upcoming">{t('notifications.tab_upcoming')}</TabsTrigger>
            <TabsTrigger value="sent">{t('notifications.tab_sent')}</TabsTrigger>
          </TabsList>

          {/* ── Alerts tab ─────────────────────────────────────────────── */}
          <TabsContent value="alerts">
            {alertsLoading ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : alerts.length === 0 ? (
              <Card variant="ghost" className="border-2 border-dashed border-border">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
                    <Bell className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">No alerts</h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    System alerts will appear here when thresholds are breached.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {alerts.map((alert, idx) => {
                  const cfg = ALERT_CONFIG[alert.alert_type] ?? {
                    icon: Bell, variant: 'default' as const, label: alert.alert_type,
                  };
                  const AlertIcon = cfg.icon;
                  const isUnread = !alert.read_at;
                  return (
                    <Card
                      key={alert.id}
                      variant="interactive"
                      className={cn('animate-fade-up cursor-pointer', isUnread && 'border-accent/40')}
                      style={{ animationDelay: `${idx * 50}ms` }}
                      onClick={() => {
                        if (isUnread) markAlertRead(alert.id);
                        if (alert.lease_id) navigate(`/app/leases/${alert.lease_id}`);
                      }}
                    >
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <div
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                              cfg.variant === 'warning'     && 'bg-warning/10 text-warning',
                              cfg.variant === 'destructive' && 'bg-destructive/10 text-destructive',
                              cfg.variant === 'info'        && 'bg-info/10 text-info',
                              cfg.variant === 'default'     && 'bg-primary/10 text-primary',
                            )}
                          >
                            <AlertIcon className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                              {isUnread && (
                                <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                              )}
                              <span className="text-xs text-muted-foreground ml-auto">{timeAgo(alert.created_at)}</span>
                            </div>
                            <h3 className="font-medium mb-1">{alert.title}</h3>
                            <p className="text-sm text-muted-foreground">{alert.body}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Email event scheduler tabs ──────────────────────────────── */}
          {(['all', 'upcoming', 'sent'] as const).map((tabVal) => (
            <TabsContent key={tabVal} value={tabVal}>
              {eventsLoading ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <EventList
                  events={filteredEvents}
                  tabVal={tabVal}
                  onFilterChange={setEventFilter}
                  onCancel={handleCancelEvent}
                  getDaysUntil={getDaysUntil}
                  getDaysLabel={getDaysLabel}
                  today={today}
                  t={t}
                  language={language}
                  navigate={navigate}
                />
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AppLayout>
  );
}

// ─── Event list sub-component ─────────────────────────────────────────────────

function EventList({
  events, tabVal, onFilterChange, onCancel, getDaysUntil, getDaysLabel, today, t, language, navigate,
}: {
  events: NotificationWithLease[];
  tabVal: 'all' | 'upcoming' | 'sent';
  onFilterChange: (v: 'all' | 'upcoming' | 'sent') => void;
  onCancel: (id: string) => void;
  getDaysUntil: (d: string) => number;
  getDaysLabel: (n: number) => string;
  today: Date;
  t: (k: string) => string;
  language: 'en' | 'es';
  navigate: (to: string) => void;
}) {
  useEffect(() => { onFilterChange(tabVal); }, [tabVal]);

  if (events.length === 0) {
    return (
      <Card variant="ghost" className="border-2 border-dashed border-border">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
            <Bell className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">{t('notifications.no_notifications')}</h3>
          <p className="text-sm text-muted-foreground max-w-md mb-4">{t('notifications.all_caught_up')}</p>
          <Button variant="outline" onClick={() => navigate('/app/leases')}>
            {t('notifications.view_leases')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((n, idx) => {
        const cfg = EVENT_CONFIG[n.event_type] ?? EVENT_CONFIG.custom;
        const Icon = cfg.icon;
        const daysUntil = getDaysUntil(n.event_date);
        const isPast = daysUntil < 0;
        const wasSent = n.last_notified_at !== null;
        const property = getPropertyDisplayName(
          n.leases?.extracted_json as Record<string, unknown> | null,
          n.leases?.filename || null,
          t('notifications.unknown_property'),
        );
        return (
          <Card
            key={n.id}
            variant="interactive"
            className={cn('animate-fade-up cursor-pointer')}
            style={{ animationDelay: `${idx * 50}ms` }}
            onClick={() => navigate(`/app/notifications/${n.id}`)}
          >
            <CardContent className="p-5">
              <div className="flex items-start gap-4">
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                    cfg.variant === 'info'        && 'bg-info/10 text-info',
                    cfg.variant === 'warning'     && 'bg-warning/10 text-warning',
                    cfg.variant === 'destructive' && 'bg-destructive/10 text-destructive',
                    cfg.variant === 'default'     && 'bg-primary/10 text-primary',
                    cfg.variant === 'secondary'   && 'bg-muted text-muted-foreground',
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge variant={cfg.variant} className="text-[10px]">{t(cfg.labelKey)}</Badge>
                    {wasSent && (
                      <Badge variant="success" className="text-[10px]">
                        <Check className="h-3 w-3 mr-1" />{t('notifications.sent')}
                      </Badge>
                    )}
                    {!wasSent && n.notify_email && !isPast && (
                      <Badge variant="muted" className="text-[10px]">{t('notifications.scheduled')}</Badge>
                    )}
                    {isPast && !wasSent && (
                      <Badge variant="secondary" className="text-[10px]">{t('notifications.past')}</Badge>
                    )}
                    {!n.notify_email && (
                      <Badge variant="outline" className="text-[10px]">{t('notifications.email_off')}</Badge>
                    )}
                  </div>
                  <h3 className="font-medium mb-1">{n.event_description || t(cfg.labelKey)}</h3>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                    <Link
                      to={`/app/leases/${n.lease_id}`}
                      className="hover:text-accent hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {property}
                    </Link>
                    <span>•</span>
                    <span>{formatLocalizedDate(n.event_date, language)}</span>
                    {!isPast && (
                      <><span>•</span><span className="font-medium">{getDaysLabel(daysUntil)}</span></>
                    )}
                    {n.notify_email && (
                      <><span>•</span><span>{t('notifications.alerts')}: {n.notify_days_before.sort((a, b) => b - a).join(', ')} {t('notifications.days_before')}</span></>
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
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigate(`/app/leases/${n.lease_id}`); }}>
                      {t('notifications.view_lease')}
                    </DropdownMenuItem>
                    {n.notify_email && !isPast && (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => { e.stopPropagation(); onCancel(n.id); }}
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
  );
}
