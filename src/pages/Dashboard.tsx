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
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function Dashboard() {
  const { user, workspace } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  const safeText = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object' && v !== null && 'value' in v) {
      return String((v as any).value ?? '');
    }
    return '';
  };

  const firstName = safeText(user?.firstName);

  const handleLeaseCreated = (leaseId: string) => {
    navigate(`/app/leases/${leaseId}`);
  };

  return (
    <AppLayout>
      <AppHeader
        title={`${t('dashboard.welcome_back')}${firstName ? `, ${firstName}` : ''}`}
        subtitle={workspace?.name || user?.companyName}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('dashboard.create_new_lease')}
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Onboarding Checklist */}
        <OnboardingChecklist />

        {/* Pending Approvals - Business Plan Only */}
        <PendingApprovalsSection />

        {/* Financial Summary - Top Priority */}
        <FinancialSummary />

        {/* Quick Stats */}
        <QuickStats />

        {/* Upcoming Events */}
        <UpcomingEvents />
      </div>

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={handleLeaseCreated}
      />
    </AppLayout>
  );
}
