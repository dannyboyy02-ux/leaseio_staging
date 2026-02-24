import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { FinancialSummary } from '@/components/dashboard/FinancialSummary';
import { PendingApprovalsSection } from '@/components/dashboard/PendingApprovalsSection';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { CommitmentHistory } from '@/components/dashboard/CommitmentHistory';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';

export default function Dashboard() {
  const { user, workspace } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  const safeText = (v: unknown) =>
    getExtractedFieldValue(v) ??
    (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

  const handleLeaseCreated = (leaseId: string) => {
    navigate(`/app/leases/${leaseId}`);
  };

  return (
    <AppLayout>
      <AppHeader
        title={`${t('dashboard.welcome_back')}${safeText(user?.firstName) ? `, ${safeText(user?.firstName)}` : ''}`}
        subtitle={safeText(workspace?.name) || safeText(user?.companyName)}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Request
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Onboarding — auto-hides when all steps complete or dismissed */}
        <OnboardingChecklist />

        {/* Hero KPI tiles — shows empty state CTA when no lease data */}
        <FinancialSummary onNewRequest={() => setCreateDrawerOpen(true)} />

        {/* Action Required — only renders when there are pending items */}
        <PendingApprovalsSection />

        {/* Commitment trend — hides when no data */}
        <CommitmentHistory />

        {/* Upcoming Events — hides when no events */}
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
