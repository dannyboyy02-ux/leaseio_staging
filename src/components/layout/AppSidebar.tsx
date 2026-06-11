import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  FileText,
  BarChart3,
  User,
  LogOut,
  HelpCircle,
  Lock,
  Sparkles,
  Layers,
  Settings,
  ClipboardCheck,
  Building2,
  ChevronsUpDown,
  Check,
  Sun,
  Moon,
  Monitor,
  Languages,
  Plus,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { shouldOpenCommandPalette } from '@/lib/cmdKHandler';
import { NewWorkspaceDialog } from '@/components/workspace/NewWorkspaceDialog';
import {
  WorkspaceCommandPalette,
  pushRecentWorkspace,
} from '@/components/workspace/WorkspaceCommandPalette';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  { title: 'Portfolio', href: '/app/portfolio', icon: Layers, requiresBusiness: true },
  { title: 'Reports',   href: '/app/reports',   icon: BarChart3 },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, workspace, canAccessFeature, userRole, userFunctionalRoles, availableWorkspaces, switchWorkspace } = useApp();
  const { signOut, user: authUser } = useAuth();
  const { t, language, setLanguage } = useLanguage();

  // --- Phase 2: multi-workspace switcher state ---
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // When set, opening NewWorkspaceDialog enters resume mode — it re-fetches the
  // existing PaymentIntent for this pending workspace and lets the user finish
  // the 3DS flow (spec §P2.11 mitigation for the orphan-after-tab-close trap).
  const [resumeWorkspaceId, setResumeWorkspaceId] = useState<string | null>(null);

  // The "+ New workspace" entry is always rendered (regardless of plan/cap).
  // The dialog enforces eligibility on click via the server preview and
  // routes ineligible users into a contextual upgrade / cap_reached /
  // no_card prompt. Hiding the entry stranded users with no signal that the
  // feature exists.
  const showPalette = availableWorkspaces.length > 5;

  // Cmd/Ctrl+K → open palette. Suppress when any other modal (Dialog/Sheet) is
  // open or when focus is in an input/textarea/contenteditable. The decision
  // logic lives in shouldOpenCommandPalette() so it can be unit-tested.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const focused = document.activeElement as HTMLElement | null;
      const shouldOpen = shouldOpenCommandPalette({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        // Radix Dialog and Sheet both lock scroll on the body via the
        // data-scroll-locked attribute — the portable check.
        dialogOpen: document.body.getAttribute('data-scroll-locked') !== null,
        newWorkspaceOpen,
        focusedTag: focused?.tagName ?? null,
        focusedContentEditable: !!focused?.isContentEditable,
      });
      if (!shouldOpen) return;
      e.preventDefault();
      setPaletteOpen(true);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [newWorkspaceOpen]);

  function handleSwitchWithRecent(workspaceId: string) {
    switchWorkspace(workspaceId);
    pushRecentWorkspace(workspaceId);
  }

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
            // Phase 3: include chain awaiting_concept_approval equivalent.
            .in('lifecycle_status', ['submitted', 'concept_submitted'])
            .or('financial_returned_to_submitter.is.null,financial_returned_to_submitter.eq.false')
            .is('manager_approved_by', null) as any;
          count += mc || 0;
        }
        if (userFunctionalRoles.includes('financial_approver')) {
          const { count: fc } = await supabase
            .from('leases')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspace.id)
            // Phase 3: include chain in_concept_review equivalent.
            .in('lifecycle_status', ['under_review', 'concept_under_review'])
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

  const { theme, setTheme } = useTheme();

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

  const currentPlan = workspace?.plan || 'starter';
  const planLabel = t(`plan.${currentPlan}`);

  // Trial countdown pill — rendered above the user menu while the
  // workspace subscription is in Stripe's trial window. Clicking it
  // deep-links to the subscription tab.
  const trialDaysLeft = useMemo(() => {
    if (workspace?.subscriptionStatus !== 'trialing' || !workspace.subscriptionPeriodEnd) return null;
    const end = new Date(workspace.subscriptionPeriodEnd).getTime();
    if (Number.isNaN(end)) return null;
    return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
  }, [workspace?.subscriptionStatus, workspace?.subscriptionPeriodEnd]);

  const getPlanBadgeVariant = () => {
    switch (currentPlan) {
      case 'business':
        return 'business';
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

      {/* Workspace Switcher */}
      <div className="px-3 py-2 border-b border-sidebar-border">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
              {workspace ? (
                <WorkspaceAvatar id={workspace.id} name={workspace.name} size="sm" />
              ) : (
                <Building2 className="h-3.5 w-3.5 text-sidebar-foreground/60 shrink-0" />
              )}
              <span className="flex-1 text-left truncate font-medium">{workspace?.name}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {showPalette ? (
              <>
                <DropdownMenuItem onClick={() => setPaletteOpen(true)} className="text-xs text-muted-foreground">
                  {t('workspace.create.search_hint')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Switch workspace
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(() => {
              // When the palette is the primary navigation, we still surface the
              // active workspace + a small slice (current + 3 alpha others) so the
              // dropdown isn't a dead end. Otherwise we list everything.
              const listed = showPalette
                ? [
                    ...availableWorkspaces.filter((w) => w.id === workspace?.id),
                    ...availableWorkspaces
                      .filter((w) => w.id !== workspace?.id)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .slice(0, 3),
                  ]
                : availableWorkspaces;
              return listed.map((ws) => {
                const isPending =
                  ws.role === 'owner' &&
                  (ws.subscription_status === 'incomplete' ||
                    ws.subscription_status === 'incomplete_expired');
                // Spec §P2.11: pending-creation rows open the dialog in resume
                // mode (re-fetches the existing PaymentIntent so the user can
                // finish 3DS), instead of switching INTO an unactivated
                // workspace and trapping them there.
                const onSelect = isPending
                  ? () => {
                      setResumeWorkspaceId(ws.id);
                      setNewWorkspaceOpen(true);
                    }
                  : () => handleSwitchWithRecent(ws.id);
                return (
                  <DropdownMenuItem
                    key={ws.id}
                    onClick={onSelect}
                    className="flex items-center gap-2"
                    aria-label={
                      isPending
                        ? t('workspace.create.pending_workspace_aria', { name: ws.name })
                        : undefined
                    }
                  >
                    <WorkspaceAvatar id={ws.id} name={ws.name} size="sm" />
                    <span className="flex-1 truncate">{ws.name}</span>
                    {isPending ? (
                      <span className="text-[10px] text-primary font-medium">
                        {t('workspace.create.pending_resume_label')}
                      </span>
                    ) : (
                      <Check
                        className={cn(
                          'h-3.5 w-3.5',
                          ws.id === workspace?.id ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                    )}
                  </DropdownMenuItem>
                );
              });
            })()}
            <DropdownMenuSeparator />
            {/* Always-render pattern: the "+ New workspace" entry is visible to
                every user regardless of plan/cap. Eligibility is enforced when
                the dialog opens — non-Business users get an upgrade prompt,
                at-cap Business users get a cap_reached message. Hiding the
                entry stranded users with no path forward (e.g. a Starter user
                with no obvious upgrade signal). */}
            <DropdownMenuItem
              onClick={() => {
                setResumeWorkspaceId(null);
                setNewWorkspaceOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('workspace.create.cta')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/app/account/workspaces')}>
              {t('workspace.create.manage_link')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Phase 2 dialogs */}
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={(o) => {
          setNewWorkspaceOpen(o);
          if (!o) setResumeWorkspaceId(null);
        }}
        resumeWorkspaceId={resumeWorkspaceId}
      />
      <WorkspaceCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onCreate={() => {
          setResumeWorkspaceId(null);
          setNewWorkspaceOpen(true);
        }}
      />
      {/* /Phase 2 */}

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

        </div>
      </nav>

      {/* User Menu — single bottom-left entry, Claude.ai-style. */}
      <div className="p-3 border-t border-sidebar-border">
        {trialDaysLeft !== null && (
          <Link
            to="/app/settings/account?tab=subscription"
            className="mb-2 flex items-center justify-center gap-1.5 rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('account.trial_pill', { count: trialDaysLeft })}
          </Link>
        )}
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
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium truncate">
                  {safeText(displayUser.firstName)} {safeText(displayUser.lastName)}
                </p>
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {safeText(workspace?.name) || safeText(displayUser.email)}
                </p>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-72">
            {/* Header card — larger avatar, name + email stacked, plan + workspace beneath */}
            <DropdownMenuLabel className="font-normal py-3">
              <div className="flex items-start gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-sm">
                    {safeText(displayUser.firstName)?.[0]}{safeText(displayUser.lastName)?.[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground truncate">
                    {safeText(displayUser.firstName)} {safeText(displayUser.lastName)}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {safeText(displayUser.email)}
                  </span>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    <Badge variant={getPlanBadgeVariant()} className="text-[10px] px-1.5 self-start">
                      {planLabel}
                    </Badge>
                    {workspace?.name && (
                      <span className="text-[10px] text-muted-foreground truncate">
                        {safeText(workspace.name)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            {/* Settings — single entry. Usage, Workspace, Subscription, etc.
                all live inside the Settings page now (Claude pattern). */}
            <DropdownMenuItem asChild>
              <Link to="/app/settings/account" className="flex items-center gap-2 cursor-pointer font-medium">
                <Settings className="h-4 w-4" />
                {t('nav.settings')}
              </Link>
            </DropdownMenuItem>

            {/* Workspaces — account-level management of every workspace
                the user owns or belongs to (Owner Workspace Management) */}
            <DropdownMenuItem asChild>
              <Link to="/app/account/workspaces" className="flex items-center gap-2 cursor-pointer font-medium">
                <Building2 className="h-4 w-4" />
                Workspaces
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Theme + help */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 font-medium">
                {theme === 'dark' ? (
                  <Moon className="h-4 w-4" />
                ) : theme === 'system' ? (
                  <Monitor className="h-4 w-4" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
                {t('nav.theme')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <Sun className="h-4 w-4 mr-2" />
                    {t('nav.theme_light')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon className="h-4 w-4 mr-2" />
                    {t('nav.theme_dark')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor className="h-4 w-4 mr-2" />
                    {t('nav.theme_system')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Languages submenu — Claude pattern */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 font-medium">
                <Languages className="h-4 w-4" />
                {t('nav.language')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={language} onValueChange={(v) => setLanguage(v as 'en' | 'es')}>
                  <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="es">Español</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem asChild>
              <Link to="/app/support" className="flex items-center gap-2 cursor-pointer font-medium">
                <HelpCircle className="h-4 w-4" />
                {t('nav.help_support')}
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Group 4 — log out (neutral, not destructive — Claude pattern) */}
            <DropdownMenuItem
              className="cursor-pointer font-medium text-muted-foreground focus:text-foreground"
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
