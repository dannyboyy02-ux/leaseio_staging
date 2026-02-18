import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface AppHeaderProps {
  title: string;
  subtitle?: string | React.ReactNode;
  actions?: React.ReactNode;
}


function safeRender(node: unknown): React.ReactNode {
  if (node == null) {
    return null;
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return node;
  }

  if (typeof node === 'boolean') {
    return node ? 'true' : 'false';
  }

  if (Array.isArray(node)) {
    return node.map(safeRender);
  }

  if (typeof node === 'object' && '$$typeof' in node) {
    return node as React.ReactNode;
  }

  try {
    return JSON.stringify(node);
  } catch {
    return String(node);
  }
}

interface NotificationPreview {
  id: string;
  event_type: string;
  event_description: string | null;
  event_date: string;
  lease_id: string;
}

export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationPreview[]>([]);
  const navigate = useNavigate();
  const { t, language } = useLanguage();

  useEffect(() => {
    async function fetchRecentNotifications() {
      try {
        const { data } = await supabase
          .from('lease_notifications')
          .select('id, event_type, event_description, event_date, lease_id')
          .eq('is_confirmed', true)
          .eq('notify_email', true)
          .gte('event_date', new Date().toISOString().split('T')[0])
          .order('event_date', { ascending: true })
          .limit(5);
        
        setNotifications(data || []);
      } catch (error) {
        console.error('Error fetching notifications:', error);
      }
    }

    fetchRecentNotifications();
  }, []);

  const getEventTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      renewal_window: t('notifications.type.renewal_window'),
      escalation: t('notifications.type.escalation'),
      expiration: t('notifications.type.expiration'),
      commencement: t('notifications.type.commencement'),
      custom: t('notifications.type.custom'),
      new_request: 'New Request',
      status_changed: 'Status Changed',
      document_uploaded: 'Document Uploaded',
    };
    return labels[type] || type;
  };

  const getEventTypeBadgeVariant = (type: string) => {
    const variants: Record<string, 'warning' | 'info' | 'destructive' | 'default' | 'secondary'> = {
      renewal_window: 'warning',
      escalation: 'info',
      expiration: 'destructive',
      commencement: 'default',
      custom: 'secondary',
      new_request: 'default',
      status_changed: 'info',
      document_uploaded: 'warning',
    };
    return variants[type] || 'secondary';
  };

  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return t('dashboard.today');
    if (diffDays === 1) return t('dashboard.tomorrow');
    if (diffDays > 0) return `${diffDays} ${t('dashboard.days')}`;
    return t('notifications.past');
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6">
      <div className="flex-1">
        <h1 className="font-display text-xl font-semibold text-foreground">{title}</h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{safeRender(subtitle)}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Language Toggle */}
        <LanguageToggle />

        {/* Global Search */}
        <div className="relative">
          {searchOpen ? (
            <div className="animate-scale-in">
              <Input
                type="search"
                placeholder={t('common.search_placeholder')}
                className="w-80 pl-10"
                autoFocus
                onBlur={() => setSearchOpen(false)}
              />
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSearchOpen(true)}
              className="text-muted-foreground hover:text-foreground"
            >
              <Search className="h-5 w-5" />
            </Button>
          )}
        </div>

        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground">
              <Bell className="h-5 w-5" />
              {notifications.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-accent-foreground">
                  {notifications.length}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="px-4 py-3 border-b border-border">
              <p className="font-medium">{t('notifications.title')}</p>
            </div>
            <div className="py-2 max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('notifications.no_notifications')}
                </div>
              ) : (
                notifications.map((notification) => (
                  <DropdownMenuItem 
                    key={notification.id}
                    className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                    onClick={() => navigate(`/app/notifications/${notification.id}`)}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={getEventTypeBadgeVariant(notification.event_type)} className="text-[10px]">
                        {getEventTypeLabel(notification.event_type)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatTimeAgo(notification.event_date)}
                      </span>
                    </div>
                    <p className="text-sm line-clamp-1">
                      {notification.event_description || getEventTypeLabel(notification.event_type)}
                    </p>
                  </DropdownMenuItem>
                ))
              )}
            </div>
            <div className="border-t border-border p-2">
              <Button 
                variant="ghost" 
                className="w-full justify-center text-sm"
                onClick={() => navigate('/app/notifications')}
              >
                {t('notifications.view_all')}
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Custom Actions */}
        {actions}
      </div>
    </header>
  );
}
