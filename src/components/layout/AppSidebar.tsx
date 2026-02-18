import { Link, useLocation, useNavigate } from 'react-router-dom';
import { 
  LayoutDashboard, 
  FileText, 
  BarChart3, 
  Bell, 
  Plug, 
  User,
  ChevronRight,
  LogOut,
  Building2,
  HelpCircle,
  Lock,
  Upload,
  Sparkles,
  Activity,
  ClipboardList
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import {
  canAccessIntegrationsPage,
  canAccessReportsDataQuality,
  canAccessWorkspaceSettings,
} from '@/lib/authorization';

// Portfolio section items
const portfolioItems = [
  { title: 'nav.dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { title: 'nav.leases', href: '/app/leases', icon: FileText },
  { title: 'nav.imports', href: '/app/imports', icon: Upload },
];

// Reports & Analytics section items
const reportsItems = [
  { title: 'nav.reports', href: '/app/reports', icon: BarChart3, requiresBusiness: true },
  { title: 'nav.data_quality', href: '/app/reports/data-quality', icon: Activity },
];

// Tools section items
const toolsItems = [
  { title: 'nav.notifications', href: '/app/notifications', icon: Bell },
  { title: 'nav.integrations', href: '/app/integrations', icon: Plug },
];

const settingsNavItems = [
  { title: 'nav.workspace', href: '/app/settings/workspace', icon: Building2 },
  { title: 'nav.account', href: '/app/settings/account', icon: User },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, workspace, canAccessFeature, userRole } = useApp();
  const { signOut, user: authUser } = useAuth();
  const { t } = useLanguage();

  const usagePercent = workspace 
    ? (workspace.activeLeasesUsed / (workspace.maxActiveLeases === -1 ? Math.max(workspace.activeLeasesUsed,1) : workspace.maxActiveLeases)) * 100 
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

  const safeText = (v: unknown) => getExtractedFieldValue(v) ?? (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

  const displayUser = {
    firstName: authUser?.user_metadata?.first_name || user?.firstName || '',
    lastName: authUser?.user_metadata?.last_name || user?.lastName || '',
    email: authUser?.email || user?.email || '',
  };

  const currentPlan = workspace?.plan || 'free';
  const planLabel = t(`plan.${currentPlan}`);

  const getPlanBadgeVariant = () => {
    switch (currentPlan) {
      case 'business':
        return 'business';
      case 'pro':
        return 'default';
      case 'starter':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const renderNavItem = (item: typeof portfolioItems[0] & { requiresBusiness?: boolean; requiresAdmin?: boolean }) => {
    const isActive = location.pathname === item.href;
    const isLocked = item.requiresBusiness && !canAccessFeature('business');
    const isAdminOnly = item.requiresAdmin;
    const translatedTitle = t(item.title);
    
    // Hide admin-only items from non-admins
    if (isAdminOnly && !isAdmin) return null;
    
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
        <span className="flex-1">{translatedTitle}</span>
        {isLocked && <Lock className="h-4 w-4" />}
        {item.requiresBusiness && !isLocked && (
          <Badge variant="business" className="text-[10px] px-1.5">Business</Badge>
        )}
      </Link>
    );
  };

  const filteredReportsItems = reportsItems.filter((item) => {
    if (item.title === 'nav.data_quality') {
      return canAccessReportsDataQuality(userRole);
    }
    return true;
  });

  const filteredToolsItems = toolsItems.filter((item) => {
    if (item.title === 'nav.integrations') {
      return canAccessIntegrationsPage(userRole);
    }
    return true;
  });

  const filteredSettingsNavItems = settingsNavItems.filter((item) => {
    if (item.title === 'nav.workspace') {
      return canAccessWorkspaceSettings(userRole);
    }
    return true;
  });

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 bg-sidebar text-sidebar-foreground flex flex-col">
      {/* Logo */}
      <Link to="/app/dashboard" className="flex h-16 items-center gap-2 px-6 border-b border-sidebar-border hover:bg-sidebar-accent/30 transition-colors">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <FileText className="h-5 w-5" />
        </div>
        <span className="font-display text-lg font-bold text-sidebar-foreground">
          Lease<span className="text-sidebar-primary">IO</span>
        </span>
      </Link>

      {/* Main Navigation */}
      <nav className="flex-1 overflow-y-auto py-6 px-3 scrollbar-thin">
        {/* Portfolio Section */}
        <div className="mb-6">
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-sidebar-muted mb-2">
            {t('nav.portfolio')}
          </p>
          <div className="space-y-1">
            {portfolioItems.map(renderNavItem)}
          </div>
        </div>

        {/* Reports & Analytics Section */}
        <div className="mb-6">
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-sidebar-muted mb-2">
            {t('nav.reports_analytics')}
          </p>
          <div className="space-y-1">
            {filteredReportsItems.map(renderNavItem)}
          </div>
        </div>

        {/* Tools Section */}
        <div className="mb-6">
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-sidebar-muted mb-2">
            {t('nav.tools')}
          </p>
          <div className="space-y-1">
            {filteredToolsItems.map(renderNavItem)}
          </div>
        </div>

        {/* Settings Section */}
        <div>
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-sidebar-muted mb-2">
            {t('nav.settings')}
          </p>
          <div className="space-y-1">
            {filteredSettingsNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              const translatedTitle = t(item.title);
              
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
                  <span>{translatedTitle}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Plan & Billing */}
      <div className="px-4 py-2 border-t border-sidebar-border">
        <Link
          to="/app/upgrade"
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        >
          <Sparkles className="h-5 w-5" />
          <span className="flex-1">{planLabel} Plan</span>
          <Badge variant={getPlanBadgeVariant()} className="text-[10px] px-1.5">
            {currentPlan === 'free' ? 'Upgrade' : planLabel}
          </Badge>
        </Link>
      </div>

      {/* Usage Meter */}
      <div className="px-4 py-4 border-t border-sidebar-border">
        <div className="rounded-lg bg-sidebar-accent/50 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-sidebar-foreground/80">Active Leases</span>
            <span className="text-xs text-sidebar-foreground/60">
              {workspace?.activeLeasesUsed} / {workspace?.maxActiveLeases === -1 ? '∞' : workspace?.maxActiveLeases}
            </span>
          </div>
          <Progress value={usagePercent} variant={getUsageVariant()} className="h-1.5" />
          {usagePercent >= 75 && (
            <Link 
              to="/app/upgrade" 
              className="mt-2 flex items-center gap-1 text-xs text-sidebar-primary hover:underline"
            >
              {t('nav.upgrade_for_more')} <ChevronRight className="h-3 w-3" />
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
                  {safeText(displayUser.firstName)?.[0]}{safeText(displayUser.lastName)?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 text-left">
                <p className="text-sm font-medium truncate">
                  {safeText(displayUser.firstName)} {safeText(displayUser.lastName)}
                </p>
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {safeText(workspace?.name) || safeText(displayUser.email)}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-sidebar-foreground/40" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link to="/app/settings/account" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('nav.account_settings')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/app/support" className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4" />
                {t('nav.help_support')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem 
              className="text-destructive focus:text-destructive cursor-pointer"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              {t('nav.log_out')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
