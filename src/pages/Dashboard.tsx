import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { QuickStats } from '@/components/dashboard/QuickStats';
import { FinancialSummary } from '@/components/dashboard/FinancialSummary';
import { PendingApprovalsSection } from '@/components/dashboard/PendingApprovalsSection';
import { CreateLeaseDrawer } from '@/components/workflow/CreateLeaseDrawer';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';

export default function Dashboard() {
  const { user, workspace } = useApp();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  const handleLeaseCreated = (leaseId: string) => {
    navigate(`/app/leases/${leaseId}`);
  };

  return (
    <AppLayout>
      <AppHeader
        title={`${t('dashboard.welcome_back')}${user?.firstName ? `, ${user.firstName}` : ''}`}
        subtitle={workspace?.name || user?.companyName}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create New Lease
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Pending Approvals - Business Plan Only */}
        <PendingApprovalsSection />

        {/* Financial Summary - Top Priority */}
        <FinancialSummary />

        {/* Quick Stats */}
        <QuickStats />

        {/* Upcoming Events */}
        <UpcomingEvents />
      </div>

      <CreateLeaseDrawer
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={handleLeaseCreated}
      />
    </AppLayout>
  );
}
