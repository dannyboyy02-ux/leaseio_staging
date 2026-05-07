// Phase 8 — single-lease ASC 842 disclosure report generator hook.
//
// Orchestrates the four-step flow:
//   1. POST generate-lease-report → backend uploads JSON + creates
//      lease_reports row + returns sections
//   2. Client renders PDF via @react-pdf/renderer (browser-only lib)
//   3. Client uploads PDF blob to lease-reports bucket at the
//      canonical path {workspace_id}/{reportId}/report.pdf
//   4. POST finalize-report-pdf → backend records pdf_storage_path
//      and writes report_generation_completed activity
//
// On any step failure after step 1, the lease_reports row stays in
// status='ready' (JSON is good) but with pdf_storage_path NULL. That
// state is recoverable: the caller can retry by re-rendering and
// re-uploading without going through generate-lease-report again
// (idempotency guarded by finalize-report-pdf path validation).

import { useCallback, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { supabase } from '@/integrations/supabase/client';
import { LeaseDisclosureDocument } from '@/lib/reports/leaseDisclosurePdf';
import type { ReportSection } from '@/lib/asc842Report';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export type GenerateLeaseReportResult = {
  reportId: string;
  leaseLabel: string;
  organizationName: string;
  jsonStoragePath: string;
  pdfStoragePath: string;
};

type Stage =
  | 'idle'
  | 'requesting'
  | 'rendering'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'error';

export function useGenerateLeaseReport() {
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (leaseId: string): Promise<GenerateLeaseReportResult> => {
      setError(null);
      setStage('requesting');

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setStage('error');
        const msg = 'Not authenticated';
        setError(msg);
        throw new Error(msg);
      }

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_KEY,
      };

      // Step 1: kick off generation (data assembly + JSON upload + row insert)
      const genRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-lease-report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ leaseId }),
      });
      const genBody = await genRes.json().catch(() => ({}));
      if (!genRes.ok || genBody?.ok === false) {
        const msg = genBody?.error || `Report generation failed (${genRes.status})`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

      const reportId = genBody.reportId as string;
      const sections = genBody.sections as ReportSection[];
      const leaseLabel = genBody.leaseLabel as string;
      const organizationName = genBody.organizationName as string;
      const jsonStoragePath = genBody.jsonStoragePath as string;
      const expectedPdfStoragePath = genBody.expectedPdfStoragePath as string;

      // Step 2: render PDF in browser
      setStage('rendering');
      let pdfBlob: Blob;
      try {
        pdfBlob = await pdf(
          <LeaseDisclosureDocument
            organizationName={organizationName}
            leaseLabel={leaseLabel}
            generatedAtIso={new Date().toISOString()}
            reportId={reportId}
            sections={sections}
          />,
        ).toBlob();
      } catch (e: any) {
        const msg = `PDF render failed: ${e?.message ?? String(e)}`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

      // Step 3: upload PDF directly to storage
      setStage('uploading');
      const { error: uploadError } = await supabase.storage
        .from('lease-reports')
        .upload(expectedPdfStoragePath, pdfBlob, {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (uploadError) {
        const msg = `PDF upload failed: ${uploadError.message}`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

      // Step 4: tell backend we're done
      setStage('finalizing');
      const finRes = await fetch(`${SUPABASE_URL}/functions/v1/finalize-report-pdf`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reportId, pdfStoragePath: expectedPdfStoragePath }),
      });
      const finBody = await finRes.json().catch(() => ({}));
      if (!finRes.ok || finBody?.ok === false) {
        const msg = finBody?.error || `Finalize failed (${finRes.status})`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

      setStage('done');
      return {
        reportId,
        leaseLabel,
        organizationName,
        jsonStoragePath,
        pdfStoragePath: expectedPdfStoragePath,
      };
    },
    [],
  );

  const reset = useCallback(() => {
    setStage('idle');
    setError(null);
  }, []);

  return { generate, stage, error, isWorking: stage !== 'idle' && stage !== 'done' && stage !== 'error', reset };
}
