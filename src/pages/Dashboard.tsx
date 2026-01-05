import { Link } from 'react-router-dom';
import { Plus, ArrowRight } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { UsageMeter } from '@/components/dashboard/UsageMeter';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { QuickStats } from '@/components/dashboard/QuickStats';
import { useApp } from '@/contexts/AppContext';

export default function Dashboard() {
  const { user, workspace } = useApp();

  // Determine if user is new (for onboarding display)
  const isNewUser = workspace?.documentsUsed === 0;

  return (
    <AppLayout>
      <AppHeader
        title={`Welcome back, ${user?.firstName}`}
        subtitle={workspace?.name}
        actions={
          <Button variant="accent" asChild>
            <Link to="/app/leases?action=upload">
              <Plus className="h-4 w-4 mr-2" />
              Upload Lease
            </Link>
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {/* Quick Stats */}
        <QuickStats />

        {/* Main Content Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left Column - Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Onboarding - Show for new users */}
            {isNewUser && <OnboardingChecklist />}

            {/* Primary CTA for new users */}
            {isNewUser && (
              <div className="bg-gradient-hero rounded-xl p-6 text-primary-foreground animate-fade-up">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-display font-semibold mb-2">
                      Ready to upload your first lease?
                    </h2>
                    <p className="text-primary-foreground/80 text-sm max-w-md">
                      Our AI will extract key terms, dates, and financial information 
                      automatically. Just upload a PDF and we'll do the rest.
                    </p>
                  </div>
                  <Button 
                    variant="secondary" 
                    size="lg" 
                    className="shrink-0 ml-4" 
                    asChild
                  >
                    <Link to="/app/leases?action=upload">
                      Get Started <ArrowRight className="h-4 w-4 ml-2" />
                    </Link>
                  </Button>
                </div>
              </div>
            )}

            {/* Upcoming Events */}
            <UpcomingEvents />
          </div>

          {/* Right Column - Sidebar */}
          <div className="space-y-6">
            {/* Usage Meter */}
            <UsageMeter />

            {/* System Status */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-medium mb-3">System Status</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">AI Processing</span>
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
                    Operational
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Notifications</span>
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    Active
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">QuickBooks Sync</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    Not connected
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
