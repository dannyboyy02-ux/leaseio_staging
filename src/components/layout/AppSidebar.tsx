import { Link, useLocation, useNavigate } from 'react-router-dom';
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
import { useAuth } from '@/contexts/AuthContext';
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
  { title: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { title: 'Leases', href: '/app/leases', icon: FileText },
  { title: 'Reports', href: '/app/reports', icon: BarChart3, requiresBusiness: true },
  { title: 'Notifications', href: '/app/notifications', icon: Bell },
  { title: 'Integrations', href: '/app/integrations', icon: Plug },
];

const settingsNavItems = [
  { title: 'Workspace', href: '/app/settings/workspace', icon: Building2 },
  { title: 'Account', href: '/app/settings/account', icon: User },
  { title: 'Billing', href: '/app/settings/billing', icon: CreditCard },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, workspace, canAccessFeature } = useApp();
  const { signOut, user: authUser } = useAuth();

  const usagePercent = workspace 
    ? (workspace.documentsUsed / workspace.documentLimit) * 100 
    : 0;

  const getUsageVariant = () => {
    if (usagePercent >= 90) return 'destructive';
    if (usagePercent >= 75) return 'warning';
    return 'accent';
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  // Get user display info from auth or app context
  const displayUser = {
    firstName: authUser?.user_metadata?.first_name || user?.firstName || '',
    lastName: authUser?.user_metadata?.last_name || user?.lastName || '',
    email: authUser?.email || user?.email || '',
  };

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 bg-sidebar text-sidebar-foreground flex flex-col">
      {/* Logo */}
      <Link to="/app/dashboard" className="flex h-16 items-center gap-2 px-6 border-b border-sidebar-border hover:bg-sidebar-accent/30 transition-colors">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <FileText className="h-5 w-5" />
        </div>
        <span className="font-display text-lg font-bold text-sidebar-foreground">
          Lease<span className="text-primary">IO</span>
        </span>
      </Link>

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
              to="/app/settings/billing" 
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
                <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {displayUser.firstName?.[0]}{displayUser.lastName?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 text-left">
                <p className="text-sm font-medium truncate">
                  {displayUser.firstName} {displayUser.lastName}
                </p>
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {workspace?.name || displayUser.email}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-sidebar-foreground/40" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link to="/app/settings/account" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                Account Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="#" className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4" />
                Help & Support
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem 
              className="text-destructive focus:text-destructive cursor-pointer"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Log Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
