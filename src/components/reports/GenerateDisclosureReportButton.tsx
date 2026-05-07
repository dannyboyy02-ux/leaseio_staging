// Phase 8 — Generate ASC 842 Disclosure Report button + confirmation modal.
//
// Renders alongside the existing Lease Analysis Report button on the
// LeaseDocumentsTab. The two reports are different artifacts:
//   - Lease Analysis Report = AI narrative, executive summary
//   - ASC 842 Disclosure Report = structured data + verification audit
//     (the artifact customers actually buy LeaseIO for)
//
// The confirmation modal restates the LeaseIO/customer liability split
// per docs/PHASE_8_BUILD_SPEC.md and PRODUCT_STRATEGY.md.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGenerateLeaseReport } from '@/hooks/useGenerateLeaseReport';
import { LIABILITY_DISCLAIMER } from '@/lib/asc842Report';

interface Props {
  leaseId: string;
  isModelLocked: boolean;
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'requesting':
      return 'Assembling lease data…';
    case 'rendering':
      return 'Rendering PDF…';
    case 'uploading':
      return 'Uploading…';
    case 'finalizing':
      return 'Finalizing…';
    default:
      return 'Generating report…';
  }
}

export function GenerateDisclosureReportButton({ leaseId, isModelLocked }: Props) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { generate, stage, isWorking, reset } = useGenerateLeaseReport();

  if (!isModelLocked) {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3 opacity-60">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 text-blue-700 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">ASC 842 Disclosure Report</p>
            <p className="text-xs text-muted-foreground">
              Lease must be finalized (model-locked) before a report can be generated
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" disabled>
          Locked
        </Button>
      </div>
    );
  }

  async function handleConfirm() {
    setConfirmOpen(false);
    try {
      const result = await generate(leaseId);
      toast.success('Report generated');
      navigate(`/app/leases/${leaseId}/reports/${result.reportId}`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Report generation failed');
      reset();
    }
  }

  return (
    <>
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 text-blue-700 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">ASC 842 Disclosure Report</p>
            <p className="text-xs text-muted-foreground">
              Structured data + verification audit (PDF + JSON)
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={isWorking}
          onClick={() => setConfirmOpen(true)}
        >
          {isWorking ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {stageLabel(stage)}
            </>
          ) : (
            <>
              <FileText className="h-3.5 w-3.5 mr-1.5" />
              Generate Report
            </>
          )}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate ASC 842 Disclosure Report</DialogTitle>
            <DialogDescription>
              This generates a PDF and a JSON file capturing the lease's
              ASC 842 measurement inputs, payment schedule, key terms,
              preparer notes, and full verification audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-1">
                LeaseIO Data Report — Not a Financial Statement
              </p>
              <p className="text-xs text-amber-900 leading-relaxed">
                {LIABILITY_DISCLAIMER}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              The report is a snapshot of the lease's current verified data
              and your workspace's report settings. Regenerate anytime if
              data changes.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
