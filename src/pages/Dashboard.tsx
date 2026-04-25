import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { FinancialSummary } from '@/components/dashboard/FinancialSummary';
import { PendingApprovalsSection } from '@/components/dashboard/PendingApprovalsSection';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { CommitmentHistory } from '@/components/dashboard/CommitmentHistory';
import { EscalationReviewPanel } from '@/components/dashboard/EscalationReviewPanel';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import { useProcessing } from '@/contexts/ProcessingContext';

export default function Dashboard() {
  const { user, workspace } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const { jobs } = useProcessing();

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

        {/* AI Abstracting — shows in-progress jobs; hides when nothing in flight */}
        {jobs.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                AI Abstracting
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {jobs.map((job) => (
                <div key={job.leaseId} className="flex items-center justify-between py-1 text-sm">
                  <span className="truncate text-muted-foreground">{job.filename}</span>
                  <Badge variant="secondary" className="shrink-0">In Progress</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Action Required — at the top where it belongs; hides when nothing pending */}
        <PendingApprovalsSection />

        {/* Hero KPI tiles — shows empty state CTA when no lease data */}
        <FinancialSummary onNewRequest={() => setCreateDrawerOpen(true)} />

        {/* Escalation Review — hides when no leases need review */}
        <EscalationReviewPanel />

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
