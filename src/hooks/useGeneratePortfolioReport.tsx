// Phase 8 — portfolio-period ASC 842 disclosure report generator hook.
//
// Mirror of useGenerateLeaseReport for the portfolio scope. The
// backend returns the full PortfolioReport object (already aggregated
// + grouped exclusions + preparer notes); the client renders the
// portfolio PDF and uploads + finalizes.

import { useCallback, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { supabase } from '@/integrations/supabase/client';
import { PortfolioReportDocument } from '@/lib/reports/portfolioReportPdf';
import type { PortfolioReport } from '@/lib/asc842Report';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export type ReportScope = 'monthly' | 'quarterly' | 'annual' | 'custom_range';

export type GeneratePortfolioInputs = {
  workspaceId: string;
  reportScope: ReportScope;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
};

export type GeneratePortfolioResult = {
  reportId: string;
  leaseCount: number;
  excludedCount: number;
  organizationName: string;
  pdfStoragePath: string;
  jsonStoragePath: string;
  portfolioReport: PortfolioReport;
};

type Stage =
  | 'idle'
  | 'requesting'
  | 'rendering'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'error';

export function useGeneratePortfolioReport() {
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (inputs: GeneratePortfolioInputs): Promise<GeneratePortfolioResult> => {
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

      const genRes = await fetch(
        `${SUPABASE_URL}/functions/v1/generate-portfolio-report`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(inputs),
        },
      );
      const genBody = await genRes.json().catch(() => ({}));
      if (!genRes.ok || genBody?.ok === false) {
        const msg = genBody?.error || `Portfolio report failed (${genRes.status})`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

      const reportId = genBody.reportId as string;
      const portfolioReport = genBody.portfolioReport as PortfolioReport;
      const expectedPdfStoragePath = genBody.expectedPdfStoragePath as string;

      setStage('rendering');
      let pdfBlob: Blob;
      try {
        pdfBlob = await pdf(
          <PortfolioReportDocument report={portfolioReport} reportId={reportId} />,
        ).toBlob();
      } catch (e: any) {
        const msg = `PDF render failed: ${e?.message ?? String(e)}`;
        setStage('error');
        setError(msg);
        throw new Error(msg);
      }

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

      setStage('finalizing');
      const finRes = await fetch(
        `${SUPABASE_URL}/functions/v1/finalize-report-pdf`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            reportId,
            pdfStoragePath: expectedPdfStoragePath,
          }),
        },
      );
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
        leaseCount: genBody.leaseCount as number,
        excludedCount: genBody.excludedCount as number,
        organizationName: genBody.organizationName as string,
        pdfStoragePath: expectedPdfStoragePath,
        jsonStoragePath: genBody.jsonStoragePath as string,
        portfolioReport,
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
