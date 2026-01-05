import { Link, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  FileText, 
  BarChart3, 
  Bell, 
  Plug, 
  Settings,
  User,
  CreditCard,
  ChevronRight,
  LogOut,
  Building2,
  HelpCircle,
  Lock
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

const mainNavItems = [
  { title: 'Dashboard', href: '/', icon: LayoutDashboard },
  { title: 'Leases', href: '/leases', icon: FileText },
  { title: 'Reports', href: '/reports', icon: BarChart3, requiresBusiness: true },
  { title: 'Notifications', href: '/notifications', icon: Bell },
  { title: 'Integrations', href: '/integrations', icon: Plug },
];

const settingsNavItems = [
  { title: 'Workspace', href: '/settings/workspace', icon: Building2 },
  { title: 'Account', href: '/settings/account', icon: User },
  { title: 'Billing', href: '/settings/billing', icon: CreditCard },
];

export function AppSidebar() {
  const location = useLocation();
  const { user, workspace, canAccessFeature } = useApp();

  const usagePercent = workspace 
    ? (workspace.documentsUsed / workspace.documentLimit) * 100 
    : 0;

  const getUsageVariant = () => {
    if (usagePercent >= 90) return 'destructive';
    if (usagePercent >= 75) return 'warning';
    return 'accent';
  };

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 bg-sidebar text-sidebar-foreground flex flex-col">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 px-6 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <FileText className="h-5 w-5" />
        </div>
        <span className="font-display text-lg font-bold text-sidebar-foreground">LeaseOS</span>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 overflow-y-auto py-6 px-3 scrollbar-thin">
        <div className="space-y-1">
          {mainNavItems.map((item) => {
            const isActive = location.pathname === item.href;
            const isLocked = item.requiresBusiness && !canAccessFeature('business');
            
            return (
              <Link
                key={item.href}
                to={isLocked ? '#' : item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                  isLocked && 'opacity-50 cursor-not-allowed'
                )}
                onClick={(e) => isLocked && e.preventDefault()}
              >
                <item.icon className="h-5 w-5" />
                <span className="flex-1">{item.title}</span>
                {isLocked && <Lock className="h-4 w-4" />}
                {item.requiresBusiness && !isLocked && (
                  <Badge variant="business" className="text-[10px] px-1.5">Business</Badge>
                )}
              </Link>
            );
          })}
        </div>

        <div className="mt-8">
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-sidebar-muted mb-2">
            Settings
          </p>
          <div className="space-y-1">
            {settingsNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  <span>{item.title}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Usage Meter */}
      <div className="px-4 py-4 border-t border-sidebar-border">
        <div className="rounded-lg bg-sidebar-accent/50 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-sidebar-foreground/80">Documents</span>
            <span className="text-xs text-sidebar-foreground/60">
              {workspace?.documentsUsed} / {workspace?.documentLimit}
            </span>
          </div>
          <Progress value={usagePercent} variant={getUsageVariant()} className="h-1.5" />
          {usagePercent >= 75 && (
            <Link 
              to="/settings/billing" 
              className="mt-2 flex items-center gap-1 text-xs text-sidebar-primary hover:underline"
            >
              Upgrade for more <ChevronRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      {/* User Menu */}
      <div className="p-3 border-t border-sidebar-border">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="ghost" 
              className="w-full justify-start gap-3 px-3 h-auto py-2 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.avatarUrl} />
                <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {user?.firstName?.[0]}{user?.lastName?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 text-left">
                <p className="text-sm font-medium truncate">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {workspace?.name}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-sidebar-foreground/40" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link to="/settings/account" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                Account Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/help" className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4" />
                Help & Support
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              <LogOut className="h-4 w-4 mr-2" />
              Log Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
