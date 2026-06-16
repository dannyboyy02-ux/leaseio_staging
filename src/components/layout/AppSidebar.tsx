import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  FileText,
  BarChart3,
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
  Languages,
  Plus,
  Inbox,
  Users,
  ArrowLeft,
  CreditCard,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useFirm } from '@/contexts/FirmContext';
import { computeFirmSidebarMode } from '@/lib/firmContext';
import { isReadOnlyRetention } from '@/config/pricing';
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
  canAccessApprovals,
  isSubmitterOnly,
} from '@/lib/authorization';
import { supabase } from '@/integrations/supabase/client';
import { trialDaysRemaining } from '@/lib/trialStatus';

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
  const firm = useFirm();

  // Phase 10 — which navigation mode the sidebar shows.
  const firmMode = computeFirmSidebarMode({
    hasFirmMembership: firm.isFirmUser,
    onFirmRoute: location.pathname.startsWith('/app/firm'),
  });

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
  const trialDaysLeft = useMemo(
    () =>
      workspace?.subscriptionStatus === 'trialing'
        ? trialDaysRemaining(workspace.subscriptionPeriodEnd)
        : null,
    [workspace?.subscriptionStatus, workspace?.subscriptionPeriodEnd],
  );

  const isAdmin = userRole === 'admin' || userRole === 'owner';
  const showApprovals = canAccessApprovals(userFunctionalRoles) || isAdmin;
  const hideApprovalsForSubmitterOnly = isSubmitterOnly(userFunctionalRoles);

  const renderNavItem = (item: { title: string; href: string; icon: React.ComponentType<{ className?: string }>; requiresBusiness?: boolean }) => {
    const isActive = location.pathname === item.href;
    const isLocked = item.requiresBusiness && !canAccessFeature('business') && !isReadOnlyRetention(workspace?.plan);
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

  // Phase 10 — a firm-context nav link (optional count badge for the inbox).
  const renderFirmLink = (href: string, label: string, Icon: React.ComponentType<{ className?: string }>, badge?: number) => {
    const isActive = location.pathname === href;
    return (
      <Link
        key={href}
        to={href}
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
        <span className="flex-1">{label}</span>
        {badge && badge > 0 ? (
          <Badge variant="destructive" className="text-[10px] h-5 min-w-[1.25rem] px-1.5 flex items-center justify-center">{badge}</Badge>
        ) : null}
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
                    {ws.firmId ? (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[6rem]">
                        {ws.firmName}
                      </span>
                    ) : null}
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
            <DropdownMenuItem onClick={() => navigate('/app/settings/workspaces')}>
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
        {firmMode === 'firm' ? (
          /* Phase 10 — firm context nav. "Back to workspace" returns to the
             active workspace's dashboard. */
          <div className="space-y-1">
            <Link
              to="/app/dashboard"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-all"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="flex-1">{t('firm.back_to_workspace')}</span>
            </Link>
            <DropdownMenuSeparator className="my-2" />
            {renderFirmLink('/app/firm', t('firm.nav.dashboard'), Building2)}
            {renderFirmLink('/app/firm/inbox', t('firm.nav.inbox'), Inbox, firm.pendingActionsCount)}
            {renderFirmLink('/app/firm/members', t('firm.nav.members'), Users)}
            {renderFirmLink('/app/firm/workspaces', t('firm.nav.workspaces'), Layers)}
            {renderFirmLink('/app/firm/billing', t('firm.nav.billing'), CreditCard)}
            {renderFirmLink('/app/firm/settings', t('firm.nav.settings'), Settings)}
          </div>
        ) : (
        <div className="space-y-1">
          {/* Dashboard, Leases */}
          {topNavItems.map(renderNavItem)}

          {/* Phase 10 — firm entry point (firm members only) */}
          {firm.isFirmUser
            ? renderFirmLink('/app/firm', t('firm.nav.firm'), Building2, firm.pendingActionsCount)
            : null}

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
        )}
      </nav>

      {/* User Menu — single bottom-left entry, Claude.ai-style. */}
      <div className="p-3 border-t border-sidebar-border">
        {trialDaysLeft !== null && (
          /* The sidebar is dark navy in BOTH themes (--sidebar-background),
             so the pill uses a single translucent-amber treatment — a light
             bg-amber-50 would render as a glaring near-white block. */
          <Link
            to="/app/settings/account?tab=billing"
            className="mb-2 flex items-center justify-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {trialDaysLeft === 0
              ? t('account.trial_pill_today')
              : t('account.trial_pill', { count: trialDaysLeft })}
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
                {/* Plan label, not workspace name — the switcher above already
                    shows the workspace (Claude shows "Pro plan" here). */}
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {t('nav.plan_label', { plan: planLabel })}
                </p>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            {/* Claude pattern: the menu header is just the email — identity
                detail lives in Settings, workspace identity in the switcher. */}
            <DropdownMenuLabel className="font-normal text-xs text-muted-foreground truncate">
              {safeText(displayUser.email)}
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            {/* Settings — single doorway. Billing, Usage, Workspaces, etc.
                all live inside the Settings surface (Claude pattern). */}
            <DropdownMenuItem asChild>
              <Link to="/app/settings/account" className="flex items-center gap-2 cursor-pointer font-medium">
                <Settings className="h-4 w-4" />
                {t('nav.settings')}
              </Link>
            </DropdownMenuItem>

            {/* Languages submenu — stays in the menu (Claude pattern);
                theme moved to Settings → Appearance only. */}
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
                {t('nav.get_help')}
              </Link>
            </DropdownMenuItem>

            {/* Upgrade plan — Starter admins/owners only (Claude shows this
                slot only when an upgrade exists). Deep-links to Billing. */}
            {currentPlan === 'starter' && isAdmin && (
              <DropdownMenuItem asChild>
                <Link
                  to="/app/settings/account?tab=billing"
                  className="flex items-center gap-2 cursor-pointer font-medium"
                >
                  <Sparkles className="h-4 w-4" />
                  {t('nav.upgrade_plan')}
                </Link>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            {/* Log out (neutral, not destructive — Claude pattern) */}
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
