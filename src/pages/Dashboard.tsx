import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { SummaryStrip } from '@/components/dashboard/SummaryStrip';
import { NeedsAction } from '@/components/dashboard/NeedsAction';
import { LeasePipeline } from '@/components/dashboard/LeasePipeline';
import { UpcomingRisks } from '@/components/dashboard/UpcomingRisks';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { PipelineByDepartment } from '@/components/dashboard/PipelineByDepartment';
import { IntakeTrend } from '@/components/dashboard/IntakeTrend';
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

        {/* KPI strip — monthly rent, pipeline value, awaiting approval, expiring */}
        <SummaryStrip />

        {/* Row 1: Action queue + Pipeline funnel */}
        <div className="grid grid-cols-2 gap-6">
          <NeedsAction />
          <LeasePipeline />
        </div>

        {/* Row 2: Upcoming risks + Recent activity & AI extractions */}
        <div className="grid grid-cols-2 gap-6">
          <UpcomingRisks />
          <RecentActivity />
        </div>

        {/* Row 3: Department breakdown + Intake trend */}
        <div className="grid grid-cols-2 gap-6">
          <PipelineByDepartment />
          <IntakeTrend />
        </div>
      </div>

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={handleLeaseCreated}
      />
    </AppLayout>
  );
}
