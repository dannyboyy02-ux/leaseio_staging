import { ReactNode } from 'react';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { QuotaWarningBanner } from '@/components/QuotaWarningBanner';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main className="pl-64 min-h-screen">
          <QuotaWarningBanner />
          {children}
        </main>
<AiAssistant />
      </div>
    </ProcessingProvider>
  );
}
