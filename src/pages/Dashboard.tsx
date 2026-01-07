import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { QuickStats } from '@/components/dashboard/QuickStats';
import { FinancialSummary } from '@/components/dashboard/FinancialSummary';
import { useApp } from '@/contexts/AppContext';

export default function Dashboard() {
  const { user, workspace } = useApp();

  // Determine if user is new (for onboarding display)
  const isNewUser = workspace?.documentsUsed === 0;

  return (
    <AppLayout>
      <AppHeader
        title={`Welcome back${user?.firstName ? `, ${user.firstName}` : ''}`}
        subtitle={workspace?.name || user?.companyName}
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
        {/* Financial Summary - Top Priority */}
        <FinancialSummary />

        {/* Quick Stats */}
        <QuickStats />

        {/* Onboarding - Show for new users */}
        {isNewUser && <OnboardingChecklist />}

        {/* Upcoming Events */}
        <UpcomingEvents />
      </div>
    </AppLayout>
  );
}
