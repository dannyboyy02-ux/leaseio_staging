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
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node === 'boolean') return node ? 'true' : 'false';
  if (Array.isArray(node)) return node.map(safeRender);
  if (typeof node === 'object' && '$$typeof' in node) return node as React.ReactNode;
  try { return JSON.stringify(node); } catch { return String(node); }
}

interface InAppNotification {
  id: string;
  lease_id: string | null;
  alert_type: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

const ALERT_CONFIG: Record<string, { variant: 'warning' | 'destructive' | 'info' | 'default'; label: string }> = {
  expiry_approaching: { variant: 'warning', label: 'Expiry' },
  covenant_breach:    { variant: 'destructive', label: 'Covenant' },
  variance_high:      { variant: 'info', label: 'Variance' },
  approval_pending:   { variant: 'default', label: 'Approval' },
};

function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const navigate = useNavigate();
  const { t } = useLanguage();

  useEffect(() => {
    async function fetchUnread() {
      try {
        const { data } = await supabase
          .from('notifications')
          .select('id, lease_id, alert_type, title, body, read_at, created_at')
          .is('read_at', null)
          .order('created_at', { ascending: false })
          .limit(5);
        setNotifications((data as InAppNotification[]) || []);
      } catch (err) {
        console.error('Error fetching notifications:', err);
      }
    }
    fetchUnread();
  }, []);

  const handleClick = async (n: InAppNotification) => {
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', n.id);
    setNotifications((prev) => prev.filter((x) => x.id !== n.id));
    setDropdownOpen(false);
    navigate(n.lease_id ? `/app/leases/${n.lease_id}` : '/app/notifications');
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

        {/* In-App Notifications Bell */}
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
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
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="font-medium">{t('notifications.title')}</p>
              {notifications.length > 0 && (
                <span className="text-xs text-muted-foreground">{notifications.length} unread</span>
              )}
            </div>
            <div className="py-2 max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('notifications.no_notifications')}
                </div>
              ) : (
                notifications.map((n) => {
                  const cfg = ALERT_CONFIG[n.alert_type] ?? { variant: 'default' as const, label: n.alert_type };
                  return (
                    <DropdownMenuItem
                      key={n.id}
                      className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                      onClick={() => handleClick(n)}
                    >
                      <div className="flex items-center justify-between w-full gap-2">
                        <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                        <span className="text-xs text-muted-foreground">{timeAgo(n.created_at)}</span>
                      </div>
                      <p className="text-sm font-medium line-clamp-1">{n.title}</p>
                      <p className="text-xs text-muted-foreground line-clamp-1">{n.body}</p>
                    </DropdownMenuItem>
                  );
                })
              )}
            </div>
            <div className="border-t border-border p-2">
              <Button
                variant="ghost"
                className="w-full justify-center text-sm"
                onClick={() => { setDropdownOpen(false); navigate('/app/notifications'); }}
              >
                {t('notifications.view_all')}
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {actions}
      </div>
    </header>
  );
}
