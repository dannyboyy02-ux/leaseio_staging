import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { SidebarProvider, useSidebar } from '@/contexts/SidebarContext';
import { QuotaWarningBanner } from '@/components/QuotaWarningBanner';
import { CancellationBanner, SoftDeletedWall } from '@/components/CancellationBanner';
import { VaultBanner, VaultMemberWall } from '@/components/VaultBanner';
import { useApp } from '@/contexts/AppContext';
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
  const { collapsed, width, resizing } = useSidebar();
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
  const mainPaddingLeft = collapsed ? SIDEBAR_COLLAPSED_WIDTH : width;

  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main
          className={cn(
            // overflow-x-hidden: wide content (tab strips, tables) must scroll
            // inside its own container — the page body never scrolls sideways.
            // Without this, a too-wide child let the whole workbench pan
            // horizontally, blanking the view (2026-07-17 polish walkthrough).
            'min-h-screen overflow-x-hidden',
            !resizing && 'transition-[padding] duration-200 ease-out motion-reduce:transition-none',
          )}
          style={{ paddingLeft: mainPaddingLeft }}
        >
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
