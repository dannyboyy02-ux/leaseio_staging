import { ReactNode } from 'react';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { ProcessingProvider } from '@/contexts/ProcessingContext';
import { BackgroundProcessingIndicator } from './BackgroundProcessingIndicator';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <ProcessingProvider>
      <div className="min-h-screen bg-background">
        <AppSidebar />
        <main className="pl-64 min-h-screen">
          {children}
        </main>
        <BackgroundProcessingIndicator />
        <AiAssistant />
      </div>
    </ProcessingProvider>
  );
}
