import { ReactNode } from 'react';
import { AppSidebar } from './AppSidebar';
import { AiAssistant } from '@/components/ai/AiAssistant';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />
      <main className="pl-64 min-h-screen">
        {children}
      </main>
      <AiAssistant />
    </div>
  );
}
