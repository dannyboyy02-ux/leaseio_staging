import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { QuotaWarningBanner } from '@/components/QuotaWarningBanner';
import { CancellationBanner, SoftDeletedWall } from '@/components/CancellationBanner';
import { useApp } from '@/contexts/AppContext';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { workspace } = useApp();
  const location = useLocation();

  // Soft-deleted workspace: the page content is replaced by the access wall
  // everywhere EXCEPT settings — the Billing tab must stay reachable so an
  // admin can renew (renewal before the purge restores everything).
  const walled =
    !!workspace?.softDeletedAt && !location.pathname.startsWith('/app/settings');

  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main className="pl-64 min-h-screen">
          <CancellationBanner />
          <QuotaWarningBanner />
          {walled ? <SoftDeletedWall /> : children}
        </main>
<AiAssistant />
      </div>
    </ProcessingProvider>
  );
}
