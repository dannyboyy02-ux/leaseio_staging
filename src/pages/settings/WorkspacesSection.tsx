// WorkspacesSection — /app/settings/workspaces[/:section]
//
// The workspace-scoped half of the Claude-style settings split. The main
// Settings page (/app/settings/account) holds account-level tabs and links
// here; this page owns a second-level rail with a back arrow at the top:
//
//   ← Settings
//   My Workspaces            (owned + member-of inventory; default landing)
//   ── Current workspace ──
//   Company Profile / Members / Notifications / Lease Configuration /
//   Risk Watchlist / Approval Rules / Onboarding   (role-gated)
//
// Section content for the current workspace renders WorkspaceSettings with
// a controlled activeSection (its own tab strip hidden); "My Workspaces"
// renders the inventory panel that used to live at /app/account/workspaces
// (that route and /app/settings/workspace now redirect here).

import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Building2,
  GitBranch,
  Layers,
  Package,
  Settings2,
  Users,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import WorkspaceSettings from '@/pages/settings/WorkspaceSettings';
import { WorkspaceManagementContent } from '@/pages/account/WorkspaceManagement';
import {
  canAccessWorkspaceDefaults,
  canAccessWorkspaceProfile,
  canEditWorkspaceSettings,
  canManageWorkspaceMembers,
} from '@/lib/authorization';

const MY_WORKSPACES = 'my-workspaces';

export default function WorkspacesSection() {
  const { workspace, userRole } = useApp();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { section } = useParams<{ section?: string }>();

  const isAdmin = canEditWorkspaceSettings(userRole);

  // Same ids + visibility gates as WorkspaceSettings' internal tabs — the
  // rail must never offer a section the embedded page would render empty.
  const sections = useMemo(
    () =>
      [
        { id: 'profile',           label: t('workspace.section_profile'),        icon: Building2,     visible: canAccessWorkspaceProfile(userRole) },
        { id: 'users',             label: t('workspace.section_members'),        icon: Users,         visible: canManageWorkspaceMembers(userRole) },
        { id: 'notifications',     label: t('workspace.section_notifications'),  icon: Bell,          visible: canAccessWorkspaceDefaults(userRole) },
        { id: 'lease_config',      label: t('workspace.section_lease_config'),   icon: Settings2,     visible: isAdmin },
        { id: 'risk_watchlist',    label: t('workspace.section_risk_watchlist'), icon: AlertTriangle, visible: isAdmin },
        { id: 'approval_policies', label: t('workspace.section_approval_rules'), icon: GitBranch,     visible: isAdmin },
        { id: 'onboarding',        label: t('workspace.section_onboarding'),     icon: Package,       visible: isAdmin },
      ].filter((s) => s.visible),
    [userRole, isAdmin, t],
  );

  // Unknown or role-invisible section falls back to the inventory panel —
  // a stale deep link should never strand the user on an empty pane. When a
  // section WAS requested but isn't visible for this role, say so instead of
  // silently substituting different content (the recipient of a shared admin
  // link should learn permission was the reason).
  const requestedDenied = !!section && !sections.some((s) => s.id === section);
  const active = requestedDenied || !section ? MY_WORKSPACES : section;

  // Orientation: deep in a tall section the sticky header still just said
  // "Workspaces" — append the active section so the top of the screen always
  // answers "where am I".
  const activeLabel =
    active === MY_WORKSPACES
      ? t('workspace.my_workspaces')
      : sections.find((s) => s.id === active)?.label ?? '';
  const headerTitle = activeLabel
    ? `${t('workspace.workspaces_title')} · ${activeLabel}`
    : t('workspace.workspaces_title');

  const railItemClass = (isActive: boolean) =>
    cn(
      'md:w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0',
      isActive
        ? 'bg-muted text-foreground'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
    );

  return (
    <AppLayout>
      <AppHeader title={headerTitle} subtitle={t('workspace.workspaces_subtitle')} />

      <div className="p-6">
        <div className="flex flex-col md:flex-row gap-6 md:items-start">
          {/* Rail — sticky on desktop so the section nav stays visible while a
              tall section (Lease Configuration, Members) scrolls. top-20 clears
              the 64px sticky AppHeader with a 16px gap; self-start + a max-height
              on the rail itself keep it from stretching or overflowing. On mobile
              it stays a horizontally-scrollable strip (no wrap pile). */}
          <nav className="flex md:flex-col md:w-56 shrink-0 gap-1 md:items-stretch overflow-x-auto md:overflow-x-visible md:sticky md:top-20 md:self-start md:max-h-[calc(100vh-6rem)] md:overflow-y-auto pb-1 md:pb-0">
            {/* Back to account-level Settings */}
            <Link
              to="/app/settings/account"
              className="md:w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('workspace.back_to_settings')}
            </Link>

            <div className="hidden md:block h-px bg-border my-2" />

            <button
              type="button"
              onClick={() => navigate('/app/settings/workspaces')}
              className={railItemClass(active === MY_WORKSPACES)}
            >
              <Layers className="h-4 w-4" />
              {t('workspace.my_workspaces')}
            </button>

            {sections.length > 0 && (
              <>
                <div className="hidden md:flex items-center gap-2 px-3 pt-3 pb-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">
                    {workspace?.name ?? t('workspace.current_workspace')}
                  </span>
                </div>
                {sections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => navigate(`/app/settings/workspaces/${s.id}`)}
                    className={railItemClass(active === s.id)}
                  >
                    <s.icon className="h-4 w-4" />
                    {s.label}
                  </button>
                ))}
              </>
            )}
          </nav>

          {/* Content panel — one shared max-width for EVERY section so the
              content edge doesn't jump when switching rail items (My Workspaces
              used to cap at max-w-5xl while the config sections were uncapped
              and stretched full-width). */}
          <div className="flex-1 min-w-0 max-w-4xl md:min-h-[32rem]">
            {requestedDenied && (
              <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:border-amber-700 dark:text-amber-300">
                {t('workspace.section_no_access')}
              </p>
            )}
            {active === MY_WORKSPACES ? (
              <WorkspaceManagementContent />
            ) : (
              <WorkspaceSettings activeSection={active} />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
