import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { QuotaWarningBanner } from '@/components/QuotaWarningBanner';
import { CancellationBanner, SoftDeletedWall } from '@/components/CancellationBanner';
import { VaultBanner, VaultMemberWall } from '@/components/VaultBanner';
import { useApp } from '@/contexts/AppContext';
import { isReadOnlyRetention } from '@/config/pricing';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { workspace, userRole } = useApp();
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

  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main className="pl-64 min-h-screen">
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
