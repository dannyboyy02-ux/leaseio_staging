import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, FileText } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { SidebarProvider, useSidebar } from '@/contexts/SidebarContext';
import { QuotaWarningBanner } from '@/components/QuotaWarningBanner';
import { CancellationBanner, SoftDeletedWall } from '@/components/CancellationBanner';
import { VaultBanner, VaultMemberWall } from '@/components/VaultBanner';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { isReadOnlyRetention } from '@/config/pricing';
import { SIDEBAR_COLLAPSED_WIDTH } from '@/lib/sidebarPrefs';
import { cn } from '@/lib/utils';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <SidebarProvider>
      <AppLayoutInner>{children}</AppLayoutInner>
    </SidebarProvider>
  );
}

function AppLayoutInner({ children }: AppLayoutProps) {
  const { workspace, userRole } = useApp();
  const { collapsed, width, resizing, isMobile, setMobileOpen } = useSidebar();
  const { t } = useLanguage();
  const location = useLocation();

  const inSettings = location.pathname.startsWith('/app/settings');

  // Soft-deleted workspace: the page content is replaced by the access wall
  // everywhere EXCEPT settings — the Billing tab must stay reachable so an
  // admin can renew (renewal before the purge restores everything).
  const walled = !!workspace?.softDeletedAt && !inSettings;

  // Vault (V4): owner-only read-only repository. A NON-owner member is walled
  // (except settings, so they can still reach their personal account / switch
  // workspaces); the owner keeps the full read-only repository plus the Vault
  // banner. The AI assistant is unmounted entirely on a Vault workspace
  // (zero-AI-spend invariant) — gating the mount is the cleanest "unmounted".
  const isVault = isReadOnlyRetention(workspace?.plan);
  const isOwner = userRole === 'owner';
  const vaultWalled = isVault && !isOwner && !inSettings;

  // The sidebar is a fixed overlay; <main> reserves space for it via padding.
  // Width tracks the collapse/resize state. The transition is suppressed while
  // the user is actively dragging the resize handle (so the offset follows the
  // pointer 1:1) and under reduced-motion preferences.
  // FS-1: below md the sidebar is an off-canvas drawer, so <main> reserves NO
  // space for it and content spans the full width.
  const mainPaddingLeft = isMobile ? 0 : collapsed ? SIDEBAR_COLLAPSED_WIDTH : width;

  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main
          className={cn(
            // overflow-x-CLIP (not hidden): wide content (tab strips, tables)
            // must scroll inside its own container — the page body never
            // scrolls sideways. `hidden` would make <main> a scroll container
            // and kill position:sticky on every window-scrolled page (app
            // header, save bars); `clip` clips without doing that, and even
            // blocks programmatic sideways scroll (2026-07-17 walkthrough).
            'min-h-screen overflow-x-clip',
            !resizing && 'transition-[padding] duration-200 ease-out motion-reduce:transition-none',
          )}
          style={{ paddingLeft: mainPaddingLeft }}
        >
          {/* FS-1: mobile top bar — the only way to reach the nav when the
              sidebar is off-canvas. Sticky so it's always reachable. */}
          {isMobile && (
            <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label={t('nav.open_menu')}
                className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                  <FileText className="h-4 w-4 text-primary-foreground" />
                </div>
                <span className="font-display text-lg font-bold text-foreground">
                  Lease<span className="text-primary">IO</span>
                </span>
              </div>
            </header>
          )}
          <CancellationBanner />
          <VaultBanner />
          <QuotaWarningBanner />
          {walled ? (
            <SoftDeletedWall />
          ) : vaultWalled ? (
            <VaultMemberWall />
          ) : (
            children
          )}
        </main>
        {!isVault && <AiAssistant />}
      </div>
    </ProcessingProvider>
  );
}
