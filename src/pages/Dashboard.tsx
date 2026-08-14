import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
import { AddLeaseDialog } from '@/components/leases/AddLeaseDialog';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { LimitReachedDialog } from '@/components/leases/LimitReachedDialog';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';

export default function Dashboard() {
  const { user, workspace, userRole } = useApp();
  // #136/#137: hide intake entry points for ANY read-only workspace — Vault OR
  // a cancellation-grace/soft-deleted one (the server also blocks the write).
  // Wave 5: VIEWER-role members are read-only too — the server now rejects
  // their lease creation (INSERT policy + process_lease role gate), so the
  // intake CTAs must not render for them.
  const isReadOnly = isWorkspaceReadOnly(workspace) || userRole === 'viewer' || !userRole;
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  // Wave 5: RequireRole bounces denied deep-links here with the path in
  // location.state — explain the bounce instead of looking like a broken link.
  const location = useLocation();
  // One-shot (Wave 5b): history.state survives refresh, so without clearing
  // it the notice re-renders on every reload. Capture into state, then strip.
  const [deniedPath] = useState(
    () => (location.state as { deniedPath?: string } | null)?.deniedPath,
  );
  useEffect(() => {
    if ((location.state as { deniedPath?: string } | null)?.deniedPath) {
      navigate('.', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const quota = useWorkspaceQuota();
  // Shared react-query cache with the NeedsAction card — no extra fetch.
  // Defaults to the empty-state layout during load (not the 3-col grid) so a
  // low-activity/trial workspace — the common evaluation case — doesn't
  // reflow when the count settles at zero (layout review).
  const { data: needsActionData } = useNeedsAction();
  const hasNeedsActionItems =
    ((needsActionData?.pendingApprovals?.length ?? 0) +
      (needsActionData?.returnedLeases?.length ?? 0) +
      (needsActionData?.unlockedLeases?.length ?? 0) +
      (needsActionData?.otherFlags?.filter((f) => f.count > 0).length ?? 0)) > 0;
  const [addLeaseDialogOpen, setAddLeaseDialogOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [limitWallOpen, setLimitWallOpen] = useState(false);

  // FS-9: a brand-new workspace used to render the checklist PLUS ~7 empty
  // analytics widgets — a wall that diluted the one gesture that matters
  // (add the first lease). Layout resolution, tuned so NEITHER cohort gets a
  // wrong-layout flash (layout review):
  //   1. activeLeasesUsed > 0 (already on the workspace object, synchronous)
  //      → definitely not a first run → full grid immediately, no query.
  //   2. Otherwise (0 active — could still have drafts/archived) a cheap
  //      head-count decides; while it loads we render the checklist alone (a
  //      calm frame that's plausible for both outcomes) instead of the
  //      7-widget skeleton wall morphing into the hero.
  // Archived/draft leases count as "not a first run"; soft-deleted rows are
  // already hidden from authenticated reads by RLS.
  const definitelyHasLeases = (workspace?.activeLeasesUsed ?? 0) > 0;
  const { data: leaseCount } = useQuery({
    queryKey: ['dashboard-any-lease', workspace?.id],
    enabled: !!workspace?.id && !definitelyHasLeases,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('leases')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace!.id);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const firstRun = !definitelyHasLeases && leaseCount === 0;
  const firstRunUndetermined = !definitelyHasLeases && leaseCount === undefined;

  // FS-2: the Dashboard's primary CTA now opens the SAME two-path chooser as
  // the Leases page (Request approval / Upload document) instead of jumping
  // straight to the approval-request form — so a user holding an already-signed
  // lease can reach the upload path from the default screen. Limit wall gate:
  // at the cap, open the wall instead of the chooser (server re-checks in
  // process_lease; this is UX, not enforcement).
  const handleAddLease = () => {
    if (quota.blocked) {
      setLimitWallOpen(true);
    } else {
      setAddLeaseDialogOpen(true);
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
              <Button variant="accent" onClick={handleAddLease}>
                <Plus className="h-4 w-4 mr-2" />
                {t('leases.add_lease')}
              </Button>
            </div>
          )
        }
      />

      <PageLayout width="wide">
        {deniedPath && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            {t('dashboard.access_denied_notice')}
          </div>
        )}
        {firstRun ? (
          // First run (0 leases): ONE hero with the Add-Lease chooser, FIRST —
          // the screen's primary gesture renders above the fold; the checklist
          // (which auto-hides when complete/dismissed) follows. The analytics
          // widgets stay hidden until there's a lease to describe (FS-9).
          <>
            <EmptyLeaseState
              onAddLease={handleAddLease}
              readOnly={isReadOnly}
              // Read-only variants (Wave 5b): an imperative "Add your first
              // lease" over a suppressed CTA is copy that lies — viewers and
              // read-only workspaces get a descriptive title + who-can-act note.
              title={isReadOnly ? t('dashboard.first_run_title_readonly') : t('dashboard.first_run_title')}
              description={isReadOnly ? t('dashboard.first_run_desc_readonly') : t('dashboard.first_run_desc')}
            />
            <OnboardingChecklist onAddLease={isReadOnly ? undefined : handleAddLease} readOnly={isReadOnly} />
          </>
        ) : firstRunUndetermined ? (
          // 0 active leases and the head-count hasn't settled: hold a calm
          // checklist-only frame instead of flashing the wrong layout.
          <OnboardingChecklist onAddLease={isReadOnly ? undefined : handleAddLease} readOnly={isReadOnly} />
        ) : (
          <>
        {/* Onboarding — auto-hides when all steps complete or dismissed */}
        <OnboardingChecklist onAddLease={isReadOnly ? undefined : handleAddLease} readOnly={isReadOnly} />

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
          // Constrained, not full-bleed: the pipeline's thin funnel bars
          // stretched edge-to-edge read as stranded/empty (layout + polish).
          <div className="lg:max-w-2xl"><LeasePipeline /></div>
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
          </>
        )}
      </PageLayout>

      <AddLeaseDialog
        open={addLeaseDialogOpen}
        onOpenChange={setAddLeaseDialogOpen}
        onRequestApproval={() => setCreateDrawerOpen(true)}
        onUploadDocument={() => setUploadModalOpen(true)}
      />

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={handleLeaseCreated}
      />

      <LeaseUploadModal
        open={uploadModalOpen}
        onOpenChange={setUploadModalOpen}
        onSuccess={handleLeaseCreated}
        onQuotaExceeded={() => {
          setUploadModalOpen(false);
          setLimitWallOpen(true);
        }}
      />

      <LimitReachedDialog open={limitWallOpen} onOpenChange={setLimitWallOpen} />
    </AppLayout>
  );
}
