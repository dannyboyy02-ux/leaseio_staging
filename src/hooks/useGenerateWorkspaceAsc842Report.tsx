// Workspace-wide ASC 842 disclosure-report generator hook.
//
// Calls generate-workspace-asc842-report → receives all locked-lease
// section payloads → renders one consolidated PDF via WorkspaceDisclosureDocument
// → triggers a browser download. No storage write, no library row.

import { useCallback, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { supabase } from '@/integrations/supabase/client';
import { WorkspaceDisclosureDocument } from '@/lib/reports/workspaceDisclosurePdf';
import type { ReportSection } from '@/lib/asc842Report';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

type Stage = 'idle' | 'requesting' | 'rendering' | 'downloading' | 'done' | 'error';

interface LeasePayload {
  leaseId: string;
  leaseLabel: string;
  sections: ReportSection[];
}

interface GenerateResult {
  organizationName: string;
  leaseCount: number;
}

export function useGenerateWorkspaceAsc842Report() {
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (workspaceId: string): Promise<GenerateResult> => {
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

    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-workspace-asc842-report`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const msg = body?.error || `Report generation failed (${res.status})`;
      setStage('error');
      setError(msg);
      throw new Error(msg);
    }

    const organizationName = body.organizationName as string;
    const leaseCount = body.leaseCount as number;
    const leases = body.leases as LeasePayload[];

    if (leaseCount === 0) {
      setStage('done');
      return { organizationName, leaseCount: 0 };
    }

    setStage('rendering');
    let pdfBlob: Blob;
    try {
      pdfBlob = await pdf(
        <WorkspaceDisclosureDocument
          organizationName={organizationName}
          generatedAtIso={new Date().toISOString()}
          leases={leases}
        />,
      ).toBlob();
    } catch (e: any) {
      const msg = `PDF render failed: ${e?.message ?? String(e)}`;
      setStage('error');
      setError(msg);
      throw new Error(msg);
    }

    setStage('downloading');
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ASC842-Disclosure-${organizationName.replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStage('done');
    return { organizationName, leaseCount };
  }, []);

  const reset = useCallback(() => {
    setStage('idle');
    setError(null);
  }, []);

  return {
    generate,
    stage,
    error,
    isWorking: stage !== 'idle' && stage !== 'done' && stage !== 'error',
    reset,
  };
}
