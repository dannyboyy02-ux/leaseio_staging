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
  // a stale deep link should never strand the user on an empty pane.
  const active =
    section && sections.some((s) => s.id === section) ? section : MY_WORKSPACES;

  const railItemClass = (isActive: boolean) =>
    cn(
      'w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors',
      isActive
        ? 'bg-muted text-foreground'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
    );

  return (
    <AppLayout>
      <AppHeader title={t('workspace.workspaces_title')} subtitle={t('workspace.workspaces_subtitle')} />

      <div className="p-6">
        <div className="flex flex-col md:flex-row gap-6 md:items-start">
          {/* Rail */}
          <nav className="flex flex-wrap md:flex-col md:w-56 shrink-0 gap-1 md:items-stretch">
            {/* Back to account-level Settings */}
            <Link
              to="/app/settings/account"
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
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

          {/* Content panel */}
          <div className="flex-1 min-w-0 md:min-h-[640px]">
            {active === MY_WORKSPACES ? (
              <WorkspaceManagementContent />
            ) : (
              <WorkspaceSettings embedded activeSection={active} />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
