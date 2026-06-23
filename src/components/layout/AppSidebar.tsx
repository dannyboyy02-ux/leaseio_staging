import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Check,
  Languages,
  Plus,
  Inbox,
  Users,
  ArrowLeft,
  CreditCard,
} from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useFirm } from '@/contexts/FirmContext';
import { useSidebar } from '@/contexts/SidebarContext';
import { computeFirmSidebarMode } from '@/lib/firmContext';
import { isReadOnlyRetention } from '@/config/pricing';
import { applyReorder, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_DEFAULT_WIDTH } from '@/lib/sidebarPrefs';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import {
  canAccessApprovals,
  isSubmitterOnly,
} from '@/lib/authorization';
import { supabase } from '@/integrations/supabase/client';
import { trialDaysRemaining } from '@/lib/trialStatus';

// A standard (workspace-mode) nav item. `key` is a stable identifier used for
// drag-reorder persistence — never the (i18n / renameable) label.
type StandardNavItem = {
  key: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  requiresBusiness?: boolean;
  visible: boolean;
};

// A single draggable row: the nav link plus a hover/focus grip handle. The grip
// is the drag activator (setActivatorNodeRef) so clicking the link still
// navigates — only the grip (or keyboard on the grip) starts a reorder.
// The grip stays hidden until row hover/focus by product decision (reorder is
// an intentionally low-key power-user feature; KNOWN_ISSUES #149) — do not
// promote it to always-visible without revisiting that call.
function SortableNavItem({
  id,
  gripLabel,
  children,
}: {
  id: string;
  gripLabel: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('group relative', isDragging && 'z-10 opacity-90')}
    >
      {children}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        aria-label={gripLabel}
        onClick={(e) => e.preventDefault()}
        className="absolute right-3 top-1/2 -translate-y-1/2 flex h-6 w-5 cursor-grab items-center justify-center rounded text-sidebar-foreground/40 opacity-0 transition-opacity hover:text-sidebar-foreground/70 focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
    </div>
  );
}

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, workspace, canAccessFeature, userRole, userFunctionalRoles, availableWorkspaces, switchWorkspace } = useApp();
  const { signOut, user: authUser } = useAuth();
  const { t, language, setLanguage } = useLanguage();
  const firm = useFirm();
  const {
    collapsed,
    toggleCollapsed,
    width,
    setWidth,
    previewWidth,
    resizing,
    setResizing,
    navOrder,
    setNavOrder,
  } = useSidebar();

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
  const displayName = `${safeText(displayUser.firstName)} ${safeText(displayUser.lastName)}`.trim();

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
  const trialPillText =
    trialDaysLeft === 0
      ? t('account.trial_pill_today')
      : t('account.trial_pill', { count: trialDaysLeft ?? 0 });

  const isAdmin = userRole === 'admin' || userRole === 'owner';
  const showApprovals = canAccessApprovals(userFunctionalRoles) || isAdmin;
  const hideApprovalsForSubmitterOnly = isSubmitterOnly(userFunctionalRoles);

  // --- Standard (workspace-mode) nav, declarative + reorderable ---
  const standardItems: StandardNavItem[] = [
    { key: 'dashboard', label: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard, visible: true },
    { key: 'leases', label: 'Leases', href: '/app/leases', icon: FileText, visible: true },
    { key: 'firm', label: t('firm.nav.firm'), href: '/app/firm', icon: Building2, badge: firm.pendingActionsCount, visible: firm.isFirmUser },
    { key: 'approvals', label: 'Approvals', href: '/app/approvals', icon: ClipboardCheck, badge: approvalBadge, visible: showApprovals && !hideApprovalsForSubmitterOnly },
    { key: 'portfolio', label: 'Portfolio', href: '/app/portfolio', icon: Layers, requiresBusiness: true, visible: true },
    { key: 'reports', label: 'Reports', href: '/app/reports', icon: BarChart3, visible: true },
  ];
  const itemByKey = new Map(standardItems.map((i) => [i.key, i]));
  const orderedItems = navOrder
    .map((k) => itemByKey.get(k))
    .filter((i): i is StandardNavItem => !!i && i.visible);
  const visibleKeys = orderedItems.map((i) => i.key);

  const sensors = useSensors(
    // distance:6 lets a plain click through (no drag) while still arming a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Baseline keyboard operability (space to lift, arrows to move). Screen-
    // reader announcements/instructions are intentionally NOT wired — reorder
    // is an accepted power-user/pointer feature (product decision 2026-06-23,
    // KNOWN_ISSUES #149).
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setNavOrder(applyReorder(navOrder, visibleKeys, String(active.id), String(over.id)));
  }

  // Drag the right edge to resize; commit (persist) on release. previewWidth
  // updates live without writing localStorage on every frame. The teardown is
  // tracked in a ref so an unmount mid-drag (route change / workspace switch)
  // or a swallowed pointerup can't leak window listeners or leave the global
  // body cursor / user-select stuck.
  const resizeTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeTeardownRef.current?.(), []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => previewWidth(startWidth + (ev.clientX - startX));
    const finish = (commitX?: number) => {
      if (commitX !== undefined) setWidth(startWidth + (commitX - startX));
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      resizeTeardownRef.current = null;
    };
    const onUp = (ev: PointerEvent) => finish(ev.clientX);
    const onCancel = () => finish();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    resizeTeardownRef.current = () => finish();
  };

  // Shared link classes. Collapsed = a centered icon button; expanded = the
  // full-width row.
  const navLinkClass = (isActive: boolean, isLocked?: boolean) =>
    cn(
      'relative flex items-center rounded-lg text-sm font-medium transition-all',
      collapsed ? 'mx-auto h-11 w-11 justify-center px-0' : 'gap-3 px-3 py-2.5',
      isActive
        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
        : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      isLocked && 'opacity-50 cursor-not-allowed',
    );

  // Expanded standard row. Trailing content fades on hover so the grip handle
  // can occupy the same right-edge slot without overlap.
  const renderExpandedStandardLink = (item: StandardNavItem) => {
    const isActive = location.pathname === item.href;
    const isLocked = item.requiresBusiness && !canAccessFeature('business') && !isReadOnlyRetention(workspace?.plan);
    return (
      <Link
        to={isLocked ? '#' : item.href}
        className={navLinkClass(isActive, isLocked)}
        onClick={(e) => { if (isLocked) e.preventDefault(); }}
      >
        <item.icon className="h-5 w-5 shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="flex items-center gap-1.5 transition-opacity group-hover:opacity-0">
          {isLocked && <Lock className="h-4 w-4" />}
          {item.requiresBusiness && !isLocked && (
            <Badge variant="business" className="text-[10px] px-1.5">Business</Badge>
          )}
          {!item.requiresBusiness && item.badge && item.badge > 0 ? (
            <Badge variant="destructive" className="text-[10px] h-5 min-w-[1.25rem] px-1.5 flex items-center justify-center">{item.badge}</Badge>
          ) : null}
        </span>
      </Link>
    );
  };

  // Collapsed standard row — icon only, label via tooltip, badge → dot.
  const renderCollapsedStandardLink = (item: StandardNavItem) => {
    const isActive = location.pathname === item.href;
    const isLocked = item.requiresBusiness && !canAccessFeature('business') && !isReadOnlyRetention(workspace?.plan);
    return (
      <Tooltip key={item.key}>
        <TooltipTrigger asChild>
          <Link
            to={isLocked ? '#' : item.href}
            aria-label={item.label}
            className={navLinkClass(isActive, isLocked)}
            onClick={(e) => { if (isLocked) e.preventDefault(); }}
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {item.badge && item.badge > 0 ? (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive" />
            ) : null}
            {isLocked ? <Lock className="absolute bottom-1 right-1.5 h-3 w-3" /> : null}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {/* Restore the count lost to the collapsed badge-dot. */}
          {item.label}
          {item.badge && item.badge > 0 ? ` · ${item.badge}` : ''}
          {isLocked ? ' · Business' : ''}
        </TooltipContent>
      </Tooltip>
    );
  };

  // Phase 10 — a firm-context nav link (collapsed-aware; optional inbox badge).
  const renderFirmLink = (href: string, label: string, Icon: React.ComponentType<{ className?: string }>, badge?: number) => {
    const isActive = location.pathname === href;
    const linkEl = (
      <Link
        to={href}
        aria-label={collapsed ? label : undefined}
        className={navLinkClass(isActive)}
      >
        <Icon className="h-5 w-5 shrink-0" />
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {!collapsed && badge && badge > 0 ? (
          <Badge variant="destructive" className="text-[10px] h-5 min-w-[1.25rem] px-1.5 flex items-center justify-center">{badge}</Badge>
        ) : null}
        {collapsed && badge && badge > 0 ? (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive" />
        ) : null}
      </Link>
    );
    if (!collapsed) return <div key={href}>{linkEl}</div>;
    return (
      <Tooltip key={href}>
        <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
        <TooltipContent side="right">
          {label}
          {badge && badge > 0 ? ` · ${badge}` : ''}
        </TooltipContent>
      </Tooltip>
    );
  };

  const backToWorkspaceEl = (
    <Link
      to="/app/dashboard"
      aria-label={collapsed ? t('firm.back_to_workspace') : undefined}
      className={cn(
        'flex items-center rounded-lg text-xs font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-all',
        collapsed ? 'mx-auto h-11 w-11 justify-center px-0' : 'gap-3 px-3 py-2.5',
      )}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1">{t('firm.back_to_workspace')}</span>}
    </Link>
  );

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 h-screen bg-sidebar text-sidebar-foreground flex flex-col',
        !resizing && 'transition-[width] duration-200 ease-out motion-reduce:transition-none',
      )}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width }}
    >
      {/* Collapse / expand toggle — straddles the right edge. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t('nav.sidebar_expand') : t('nav.sidebar_collapse')}
            className="absolute -right-3 top-[76px] z-[60] flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {collapsed ? t('nav.sidebar_expand') : t('nav.sidebar_collapse')}
        </TooltipContent>
      </Tooltip>

      {/* Drag-to-resize handle (expanded only). Double-click resets to default.
          Starts below the collapse toggle (top-[104px]) so the two edge
          affordances don't share the same grab zone. */}
      {!collapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('nav.sidebar_resize')}
              onPointerDown={startResize}
              onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
              className="group/resize absolute right-0 top-[104px] z-50 h-[calc(100%-104px)] w-2 cursor-col-resize"
            >
              <div
                className={cn(
                  'absolute right-0 top-0 h-full w-0.5 bg-sidebar-primary transition-opacity',
                  resizing ? 'opacity-100' : 'opacity-0 group-hover/resize:opacity-100',
                )}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{t('nav.sidebar_resize')}</TooltipContent>
        </Tooltip>
      )}

      {/* Logo */}
      <Link
        to="/app/dashboard"
        className={cn(
          'flex h-16 items-center border-b border-sidebar-border hover:bg-sidebar-accent/30 transition-colors',
          collapsed ? 'justify-center px-0' : 'gap-2 px-6',
        )}
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground shrink-0">
          <FileText className="h-5 w-5" />
        </div>
        {!collapsed && (
          <span className="font-display text-lg font-bold text-sidebar-foreground">
            Lease<span className="text-sidebar-primary">IO</span>
          </span>
        )}
      </Link>

      {/* Workspace Switcher */}
      <div className={cn('border-b border-sidebar-border', collapsed ? 'flex justify-center px-2 py-2' : 'px-3 py-2')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {collapsed ? (
              <button
                aria-label={workspace?.name ?? 'Workspace'}
                className="mx-auto flex h-11 w-11 items-center justify-center rounded-md hover:bg-sidebar-accent transition-colors"
              >
                {workspace ? (
                  <WorkspaceAvatar id={workspace.id} name={workspace.name} size="sm" />
                ) : (
                  <Building2 className="h-4 w-4 text-sidebar-foreground/60" />
                )}
              </button>
            ) : (
              <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
                {workspace ? (
                  <WorkspaceAvatar id={workspace.id} name={workspace.name} size="sm" />
                ) : (
                  <Building2 className="h-3.5 w-3.5 text-sidebar-foreground/60 shrink-0" />
                )}
                <span className="flex-1 text-left truncate font-medium">{workspace?.name}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />
              </button>
            )}
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
      <nav className={cn('flex-1 py-6', collapsed ? 'px-2' : 'px-3')}>
        {firmMode === 'firm' ? (
          /* Phase 10 — firm context nav. "Back to workspace" returns to the
             active workspace's dashboard. Not reorderable. */
          <div className="space-y-1">
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>{backToWorkspaceEl}</TooltipTrigger>
                <TooltipContent side="right">{t('firm.back_to_workspace')}</TooltipContent>
              </Tooltip>
            ) : (
              backToWorkspaceEl
            )}
            <DropdownMenuSeparator className={cn('my-2', collapsed && 'mx-auto w-8')} />
            {renderFirmLink('/app/firm', t('firm.nav.dashboard'), Building2)}
            {renderFirmLink('/app/firm/inbox', t('firm.nav.inbox'), Inbox, firm.pendingActionsCount)}
            {renderFirmLink('/app/firm/members', t('firm.nav.members'), Users)}
            {renderFirmLink('/app/firm/workspaces', t('firm.nav.workspaces'), Layers)}
            {renderFirmLink('/app/firm/billing', t('firm.nav.billing'), CreditCard)}
            {renderFirmLink('/app/firm/settings', t('firm.nav.settings'), Settings)}
          </div>
        ) : collapsed ? (
          /* Collapsed workspace nav — icon rail, persisted order, no drag. */
          <div className="space-y-1">
            {orderedItems.map(renderCollapsedStandardLink)}
          </div>
        ) : (
          /* Expanded workspace nav — drag-to-reorder. */
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={visibleKeys} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {orderedItems.map((item) => (
                  <SortableNavItem key={item.key} id={item.key} gripLabel={t('nav.sidebar_reorder')}>
                    {renderExpandedStandardLink(item)}
                  </SortableNavItem>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </nav>

      {/* User Menu — single bottom-left entry, Claude.ai-style. */}
      <div className="p-3 border-t border-sidebar-border">
        {trialDaysLeft !== null && (
          /* The sidebar is dark navy in BOTH themes (--sidebar-background),
             so the pill uses a single translucent-amber treatment — a light
             bg-amber-50 would render as a glaring near-white block. */
          collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/app/settings/account?tab=billing"
                  aria-label={trialPillText}
                  className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-md border border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
                >
                  <Sparkles className="h-4 w-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{trialPillText}</TooltipContent>
            </Tooltip>
          ) : (
            <Link
              to="/app/settings/account?tab=billing"
              className="mb-2 flex items-center justify-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {trialPillText}
            </Link>
          )
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label={collapsed ? displayName : undefined}
              className={cn(
                'h-auto text-sidebar-foreground hover:bg-sidebar-accent',
                collapsed ? 'w-full justify-center px-0 py-2' : 'w-full justify-start gap-3 px-3 py-2',
              )}
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {safeText(displayUser.firstName)?.[0]}{safeText(displayUser.lastName)?.[0]}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
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
              )}
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
