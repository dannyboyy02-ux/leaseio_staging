import { useState, useCallback, useEffect } from 'react';
import { pdf } from '@react-pdf/renderer';
import { Download, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { LeaseAnalysisDocument } from '@/components/leases/LeaseAnalysisExport';
import { type ReportLease } from '@/lib/reportGeneration';
import { buildLeaseAnalysisProse } from '@/lib/leaseAnalysisProse';

interface LeaseDocumentsTabProps {
  leaseId: string;
  filename: string | null;
  storagePath: string | null;
  executedFilename?: string | null;
  executedStoragePath?: string | null;
  isLocked: boolean;
}

type AnalysisVersion = { url: string; name: string; generatedAt: string };

function formatNow(): string {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function LeaseDocumentsTab({
  leaseId,
  filename,
  storagePath,
  executedFilename,
  executedStoragePath,
  isLocked,
}: LeaseDocumentsTabProps) {
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [analyses, setAnalyses] = useState<AnalysisVersion[]>([]);

  useEffect(() => {
    return () => {
      analyses.forEach(r => URL.revokeObjectURL(r.url));
    };
  }, [analyses]);

  const handleDownload = useCallback(async (path: string, displayName: string, bucket: string) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error('Could not generate download link');
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = displayName;
    a.target = '_blank';
    a.click();
  }, []);

  const handleGenerateAnalysis = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      const [{ data: leaseRow, error: leaseError }, { data: rentRows }, { data: riskRows }] =
        await Promise.all([
          supabase
            .from('leases')
            .select(
              'request_title, filename, asset_type, landlord_name, tenant_name, property_address, lease_start, lease_end, term_months, current_monthly_rent, executed_monthly_payment, escalation_type, escalation_rate, needs_escalation_review, renewal_options, termination_clauses, escalation_clauses, security_deposit, square_footage, calc_total_commitment, calc_pv_liability',
            )
            .eq('id', leaseId)
            .single(),
          supabase
            .from('rent_schedules')
            .select('period_start, period_end, monthly_amount, annual_amount, notes')
            .eq('lease_id', leaseId)
            .order('period_start'),
          supabase
            .from('risks')
            .select('title, severity, explanation, citation_snippet, citation_page')
            .eq('lease_id', leaseId)
            .is('dismissed_at', null)
            .order('severity'),
        ]);

      if (leaseError || !leaseRow) {
        throw new Error(leaseError?.message ?? 'Lease not found');
      }

      const l = leaseRow as Record<string, any>;
      const lease: ReportLease = {
        display_name: (l.request_title as string | null) || (l.filename as string | null) || 'Lease',
        asset_type: (l.asset_type as string | null) ?? null,
        landlord: (l.landlord_name as string | null) ?? null,
        tenant: (l.tenant_name as string | null) ?? null,
        property_address: (l.property_address as string | null) ?? null,
        lease_start: (l.lease_start as string | null) ?? null,
        lease_end: (l.lease_end as string | null) ?? null,
        term_months: (l.term_months as number | null) ?? null,
        monthly_rent:
          (l.executed_monthly_payment as number | null) ??
          (l.current_monthly_rent as number | null) ??
          null,
        escalation_type: (l.escalation_type as string | null) ?? null,
        escalation_rate: (l.escalation_rate as number | null) ?? null,
        needs_escalation_review: (l.needs_escalation_review as boolean | null) ?? null,
        renewal_options:
          typeof l.renewal_options === 'string'
            ? (l.renewal_options as string)
            : l.renewal_options
              ? JSON.stringify(l.renewal_options)
              : null,
        termination_clauses: (l.termination_clauses as string | null) ?? null,
        escalation_clauses: (l.escalation_clauses as string | null) ?? null,
        security_deposit:
          l.security_deposit == null ? null : String(l.security_deposit),
        square_footage: (l.square_footage as number | null) ?? null,
        total_commitment: (l.calc_total_commitment as number | null) ?? null,
        pv_liability: (l.calc_pv_liability as number | null) ?? null,
        rent_schedule: (rentRows ?? []).map((r: any) => ({
          period_start: r.period_start ?? null,
          period_end: r.period_end ?? null,
          monthly_amount: r.monthly_amount ?? null,
          annual_amount: r.annual_amount ?? null,
          notes: r.notes ?? null,
        })),
        risks: (riskRows ?? []).map((r: any) => ({
          title: r.title,
          severity: (r.severity ?? 'low') as 'low' | 'medium' | 'high',
          explanation: r.explanation ?? '',
          citation_snippet: r.citation_snippet ?? undefined,
          citation_page: r.citation_page ?? undefined,
        })),
      };

      const prose = buildLeaseAnalysisProse(lease);
      const generatedAt = formatNow();

      const blob = await pdf(
        <LeaseAnalysisDocument lease={lease} prose={prose} generatedAt={generatedAt} />
      ).toBlob();

      const url = URL.createObjectURL(blob);
      const version = analyses.length + 1;
      const name = `${lease.display_name} - Lease Summary v${version}.pdf`;

      setAnalyses(prev => [...prev, { url, name, generatedAt }]);
      toast.success('Lease summary ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate summary';
      toast.error(message);
    } finally {
      setGeneratingPdf(false);
    }
  }, [leaseId, analyses.length]);

  const hasDocuments =
    Boolean(storagePath && filename) ||
    Boolean(executedStoragePath && executedFilename) ||
    analyses.length > 0;

  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold">Documents</CardTitle>
        <CardDescription className="text-xs">
          Original files and on-demand summaries for this lease
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-2">
        {/* Original lease PDF */}
        {storagePath && filename && (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{filename}</p>
                <p className="text-xs text-muted-foreground">Original lease</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => handleDownload(storagePath, filename, 'leases')}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        )}

        {/* Executed copy */}
        {executedStoragePath && executedFilename && (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-green-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{executedFilename}</p>
                <p className="text-xs text-muted-foreground">Executed copy</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => handleDownload(executedStoragePath, executedFilename, 'executed-leases')}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        )}

        {/* Generated summary versions */}
        {analyses.map((report) => (
          <div key={report.url}>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{report.name}</p>
                  <p className="text-xs text-muted-foreground">Generated {report.generatedAt}</p>
                </div>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0" asChild>
                <a href={report.url} download={report.name}>
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Download
                </a>
              </Button>
            </div>
            <div className="rounded-lg border overflow-hidden mt-2 mb-2">
              <iframe src={report.url} className="w-full h-[600px]" title={report.name} />
            </div>
          </div>
        ))}

        {/* Empty state — no PDFs and no generated summary yet */}
        {!hasDocuments && (
          <p className="text-xs text-muted-foreground py-2">
            No documents uploaded for this lease yet.
          </p>
        )}

        {/* Generate Lease Summary — available once the lease is locked (finalized).
            Deterministic template, no AI call, no plan gate. */}
        {isLocked ? (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-blue-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Lease Summary</p>
                <p className="text-xs text-muted-foreground">
                  1–2 page PDF — financial summary, key clauses, risks
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={generatingPdf}
              onClick={handleGenerateAnalysis}
            >
              {generatingPdf ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <FileText className="h-3.5 w-3.5 mr-1.5" />
                  Generate Summary
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3 opacity-60">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Lease Summary</p>
                <p className="text-xs text-muted-foreground">
                  Available after the lease is finalized (model-locked)
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
