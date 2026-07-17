import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { SummaryStrip } from '@/components/dashboard/SummaryStrip';
import { NeedsAction } from '@/components/dashboard/NeedsAction';
import { useNeedsAction } from '@/hooks/useNeedsAction';
import { LeasePipeline } from '@/components/dashboard/LeasePipeline';
import { UpcomingRisks } from '@/components/dashboard/UpcomingRisks';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { PipelineByDepartment } from '@/components/dashboard/PipelineByDepartment';
import { IntakeTrend } from '@/components/dashboard/IntakeTrend';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { EscalationReviewPanel } from '@/components/dashboard/EscalationReviewPanel';
import { PendingCounterSignatureCard } from '@/components/dashboard/PendingCounterSignatureCard';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { LimitReachedDialog } from '@/components/leases/LimitReachedDialog';
import { useApp } from '@/contexts/AppContext';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';

export default function Dashboard() {
  const { user, workspace } = useApp();
  // #136/#137: hide intake entry points for ANY read-only workspace — Vault OR
  // a cancellation-grace/soft-deleted one (the server also blocks the write).
  const isReadOnly = isWorkspaceReadOnly(workspace);
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const quota = useWorkspaceQuota();
  // Shared react-query cache with the NeedsAction card — no extra fetch.
  const { data: needsActionData, isPending: needsActionLoading } = useNeedsAction();
  const hasNeedsActionItems =
    needsActionLoading ||
    ((needsActionData?.pendingApprovals?.length ?? 0) +
      (needsActionData?.returnedLeases?.length ?? 0) +
      (needsActionData?.unlockedLeases?.length ?? 0) +
      (needsActionData?.otherFlags?.filter((f) => f.count > 0).length ?? 0)) > 0;
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [limitWallOpen, setLimitWallOpen] = useState(false);

  // Limit wall gate — don't let a user build a request the workspace can't
  // fulfill. The server re-checks at extraction time; this is UX, not
  // enforcement.
  const handleNewRequest = () => {
    if (quota.blocked) {
      setLimitWallOpen(true);
    } else {
      setCreateDrawerOpen(true);
    }
  };

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
          isReadOnly ? undefined : (
            <div className="flex items-center gap-2">
              <Button variant="accent" onClick={handleNewRequest}>
                <Plus className="h-4 w-4 mr-2" />
                {t('dashboard.new_request')}
              </Button>
            </div>
          )
        }
      />

      <PageLayout width="wide">
        {/* Onboarding — auto-hides when all steps complete or dismissed */}
        <OnboardingChecklist />

        {/* KPI strip — monthly rent, pipeline value, awaiting approval, expiring */}
        <SummaryStrip />

        {/* Escalation alerts — only renders when needs_escalation_review leases exist */}
        <EscalationReviewPanel />

        {/* Phase 5 — auto-hides when nothing is in pending_counter_signature */}
        <PendingCounterSignatureCard />

        {/* Row 1: Action queue (wide) + Pipeline funnel (narrow) — stacks
            below lg. The action card exists only when there ARE actions (the
            KPI tile already says "all clear" once); with no actions the
            pipeline takes the full row instead of stranding in a third. */}
        {hasNeedsActionItems ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2"><NeedsAction /></div>
            <div className="lg:col-span-1"><LeasePipeline /></div>
          </div>
        ) : (
          <LeasePipeline />
        )}

        {/* Row 2: Upcoming risks + Recent activity & AI extractions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <UpcomingRisks />
          <RecentActivity />
        </div>

        {/* Upcoming lease events — renewals, expirations, payments */}
        <UpcomingEvents />

        {/* Row 3: Department breakdown + Intake trend */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PipelineByDepartment />
          <IntakeTrend />
        </div>
      </PageLayout>

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={handleLeaseCreated}
      />

      <LimitReachedDialog open={limitWallOpen} onOpenChange={setLimitWallOpen} />
    </AppLayout>
  );
}
