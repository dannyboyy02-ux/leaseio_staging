import type React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, Clock, FileSearch, Upload } from 'lucide-react';
import { t } from 'i18next';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';

export interface PendingApproval {
  id: string;
  title: string;
  department: string;
  daysWaiting: number;
  annualValue: number;
}

export interface UnlockedLease {
  leaseId: string;
  leaseName: string;
}

export interface ReturnedLease {
  leaseId: string;
  leaseName: string;
  rejectionReason: string | null;
}

export interface OtherFlag {
  label: string;
  count: number;
  href: string;
  icon: React.ElementType;
}

export function useNeedsAction() {
  const { workspace } = useApp();
  // Labels below are translated at query time, so the cache is per-language:
  // a language switch changes the key and refetches (cheap count queries).
  const { language } = useLanguage();

  return useQuery({
    queryKey: ['needs-action', workspace?.id, language],
    enabled: !!workspace?.id,
    refetchInterval: 30_000,
    queryFn: async () => {
      const [leasesResult, draftChangeSetsResult] = await Promise.all([
        supabase
          .from('leases')
          // PostgREST type narrowing requires a literal string. Don't split
          // this with '+' concatenation — that widens to `string` and the
          // result type collapses to GenericStringError.
          .select('id, request_title, filename, requesting_department, monthly_payment, submitted_for_approval_at, status_changed_at, status, executed_document_url, lifecycle_status, financial_returned_to_submitter, financial_rejection_reason')
          .eq('workspace_id', workspace!.id)
          // Phase 3: include chain-vocabulary equivalents for awaiting,
          // in-review, and executed-pre-active groups.
          .in('lifecycle_status', [
            'under_review', 'executed', 'submitted',
            'concept_under_review', 'fully_executed', 'concept_submitted',
            // Phase 6: chain_violation is a critical action item that admins
            // must address. Surfaced via otherFlags so the dashboard's
            // NeedsAction strip pulls in the count.
            'chain_violation',
          ]),
        (supabase as any)
          .from('lease_change_sets')
          .select('id, lease_id, leases!inner(request_title, filename, lifecycle_status, workspace_id, model_locked)')
          .eq('status', 'draft')
          // 'active' is identical in both vocabularies.
          .eq('leases.lifecycle_status', 'active')
          .eq('leases.workspace_id', workspace!.id)
          .limit(10),
      ]);

      const leases = leasesResult.data ?? [];
      const now = Date.now();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

      // Phase 3: branch on awaiting_concept_approval / in_concept_review
      // groups so chain-vocabulary leases bucket the same as legacy.
      const returnedLeases: ReturnedLease[] = leases
        .filter((l) =>
          (l.lifecycle_status === 'submitted' || l.lifecycle_status === 'concept_submitted') &&
          (l as any).financial_returned_to_submitter
        )
        .map((l) => ({
          leaseId: l.id,
          leaseName: l.request_title ?? l.filename ?? t('dashboard.unnamed_lease'),
          rejectionReason: (l as any).financial_rejection_reason ?? null,
        }));

      const pendingApprovals: PendingApproval[] = leases
        .filter((l) =>
          l.lifecycle_status === 'under_review' ||
          l.lifecycle_status === 'concept_under_review'
        )
        .map((l) => {
          const referenceDate = l.submitted_for_approval_at ?? l.status_changed_at;
          const daysWaiting = referenceDate
            ? Math.floor((now - new Date(referenceDate).getTime()) / 86400000)
            : 0;
          return {
            id: l.id,
            title: l.request_title ?? l.filename ?? t('dashboard.unnamed_lease'),
            department: l.requesting_department ?? t('dashboard.unknown_department'),
            daysWaiting,
            annualValue: (l.monthly_payment ?? 0) * 12,
          };
        })
        .sort((a, b) => b.daysWaiting - a.daysWaiting);

      const unlockedLeases: UnlockedLease[] = ((draftChangeSetsResult.data ?? []) as any[])
        .filter((cs: any) => !cs.leases?.model_locked)
        .map((cs: any) => ({
          leaseId: cs.lease_id,
          leaseName: cs.leases?.request_title || cs.leases?.filename || t('dashboard.unnamed_lease'),
        }));

      const otherFlags: OtherFlag[] = [];

      const stalledCount = leases.filter((l) => {
        // Phase 3: include chain in_concept_review.
        if (l.lifecycle_status !== 'under_review' && l.lifecycle_status !== 'concept_under_review') return false;
        if (!l.status_changed_at) return false;
        return now - new Date(l.status_changed_at).getTime() > fourteenDaysMs;
      }).length;
      if (stalledCount > 0) {
        otherFlags.push({ label: t('dashboard.flag_stalled'), count: stalledCount, href: '/app/approvals', icon: Clock });
      }

      const noAbstractionCount = leases.filter((l) => {
        // Phase 3: include chain awaiting_concept_approval + in_concept_review.
        const inLifecycle =
          l.lifecycle_status === 'submitted' ||
          l.lifecycle_status === 'under_review' ||
          l.lifecycle_status === 'concept_submitted' ||
          l.lifecycle_status === 'concept_under_review';
        const inStatus = l.status === 'Uploaded' || l.status === 'Processing';
        return inLifecycle && inStatus;
      }).length;
      if (noAbstractionCount > 0) {
        otherFlags.push({ label: t('dashboard.flag_awaiting_abstraction'), count: noAbstractionCount, href: '/app/approvals', icon: FileSearch });
      }

      // Phase 3: include chain executed equivalent (fully_executed).
      const noDocCount = leases.filter(
        (l) =>
          (l.lifecycle_status === 'executed' || l.lifecycle_status === 'fully_executed') &&
          !l.executed_document_url
      ).length;
      if (noDocCount > 0) {
        otherFlags.push({ label: t('dashboard.flag_doc_missing'), count: noDocCount, href: '/app/leases?status=active', icon: Upload });
      }

      // Phase 6: chain_violation leases are leases whose policy-required
      // approver chain was not fully consulted before execution. These
      // are the highest-priority action item \u2014 until resolved, the lease
      // is in a governance gap. Surfaced regardless of whether retroactive
      // approvers have been added; the banner on the lease detail page
      // is the resolution surface.
      const chainViolationCount = leases.filter(
        (l) => l.lifecycle_status === 'chain_violation',
      ).length;
      if (chainViolationCount > 0) {
        otherFlags.unshift({
          label: t('dashboard.flag_chain_violation'),
          count: chainViolationCount,
          // chain_violation \u2208 the Leases "active" scope; lands on the active
          // list where the violation lease is visible. The old violations-only
          // filter no longer exists post-redesign (KNOWN_ISSUES #151).
          href: '/app/leases?status=active',
          icon: AlertOctagon,
        });
      }

      return { pendingApprovals, unlockedLeases, returnedLeases, otherFlags };
    },
  });
}
