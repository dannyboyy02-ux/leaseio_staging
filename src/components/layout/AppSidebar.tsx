import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  FileText,
  BarChart3,
  User,
  ChevronRight,
  LogOut,
  HelpCircle,
  Lock,
  Sparkles,
  Layers,
  Settings,
  ClipboardCheck,
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
  canAccessWorkspaceSettings,
  canAccessApprovals,
  isSubmitterOnly,
} from '@/lib/authorization';
import { supabase } from '@/integrations/supabase/client';

// Top nav items — rendered before Approvals
const topNavItems = [
  { title: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { title: 'Leases',    href: '/app/leases',     icon: FileText },
];

// Bottom nav items — rendered after Approvals
const bottomNavItems = [
  { title: 'Portfolio', href: '/app/portfolio', icon: Layers },
  { title: 'Reports',   href: '/app/reports',   icon: BarChart3, requiresBusiness: true },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, workspace, canAccessFeature, userRole, userFunctionalRoles } = useApp();
  const { signOut, user: authUser } = useAuth();
  const { t } = useLanguage();

  // Phase 2 — approval badge count (pending items needing current user's action)
  const [approvalBadge, setApprovalBadge] = useState(0);

  useEffect(() => {
    if (!workspace?.id || !userFunctionalRoles.length) return;

    const fetchBadge = async () => {
      try {
        let count = 0;
        if (userFunctionalRoles.includes('manager_approver')) {
          const { count: mc } = await supabase
            .from('leases')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspace.id)
            .eq('lifecycle_status', 'submitted')
            .or('financial_returned_to_submitter.is.null,financial_returned_to_submitter.eq.false')
            .is('manager_approved_by', null) as any;
          count += mc || 0;
        }
        if (userFunctionalRoles.includes('financial_approver')) {
          const { count: fc } = await supabase
            .from('leases')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspace.id)
            .eq('lifecycle_status', 'under_review')
            .is('financial_approved_by', null) as any;
          count += fc || 0;
        }
        setApprovalBadge(count);
      } catch {
        // table may not exist yet
      }
    };

    fetchBadge();
    const interval = setInterval(fetchBadge, 30_000);
    const handleFocus = () => fetchBadge();
    window.addEventListener('focus', handleFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [workspace?.id, userFunctionalRoles]);

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
  const showApprovals = canAccessApprovals(userFunctionalRoles) || isAdmin;
  const hideApprovalsForSubmitterOnly = isSubmitterOnly(userFunctionalRoles);

  const renderNavItem = (item: { title: string; href: string; icon: React.ComponentType<{ className?: string }>; requiresBusiness?: boolean }) => {
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
  };

  const settingsHref = canAccessWorkspaceSettings(userRole)
    ? '/app/settings/workspace'
    : '/app/settings/account';

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

      {/* Main Navigation — flat list, no section labels */}
      <nav className="flex-1 py-6 px-3">
        <div className="space-y-1">
          {/* Dashboard, Leases */}
          {topNavItems.map(renderNavItem)}

          {/* Approvals — hidden for submitter-only users; badge unchanged */}
          {showApprovals && !hideApprovalsForSubmitterOnly && (
            <Link
              to="/app/approvals"
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                location.pathname === '/app/approvals'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <ClipboardCheck className="h-5 w-5" />
              <span className="flex-1">Approvals</span>
              {approvalBadge > 0 && (
                <Badge
                  variant="destructive"
                  className="text-[10px] h-5 min-w-[1.25rem] px-1.5 flex items-center justify-center"
                >
                  {approvalBadge}
                </Badge>
              )}
            </Link>
          )}

          {/* Portfolio, Reports */}
          {bottomNavItems.map(renderNavItem)}

          {/* Settings — single entry point */}
          <Link
            to={settingsHref}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
              location.pathname.startsWith('/app/settings')
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            )}
          >
            <Settings className="h-5 w-5" />
            <span className="flex-1">Settings</span>
          </Link>
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
              {workspace?.activeLeasesUsed} / {workspace?.maxActiveLeases === -1 ? '\u221e' : workspace?.maxActiveLeases}
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
