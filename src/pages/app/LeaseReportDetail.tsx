// Phase 8 — Single-lease ASC 842 disclosure report detail page.
//
// Route: /app/leases/:leaseId/reports/:reportId
//
// Surfaces the lease_reports row metadata + signed download URLs for
// the PDF and JSON artifacts. Polling is in place for status='generating'
// (forward-compatible with the future background-queue migration noted
// in KNOWN_ISSUES #13). For C4 the synchronous client-side flow already
// flips the row to status='ready' before this page loads.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileJson, FileText, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useGenerateLeaseReport } from '@/hooks/useGenerateLeaseReport';

interface LeaseReportRow {
  id: string;
  workspace_id: string;
  report_type: string;
  report_scope: string;
  lease_id: string | null;
  generated_at: string;
  generated_by: string;
  pdf_storage_path: string | null;
  json_storage_path: string | null;
  status: string;
  organization_name_at_gen: string | null;
  discount_rate_method_at_gen: string | null;
  expires_at: string | null;
  error_message: string | null;
  workspace_settings_snapshot: Record<string, unknown> | null;
}

function statusBadgeVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'ready':
      return 'default';
    case 'generating':
    case 'pending':
      return 'secondary';
    case 'failed':
      return 'destructive';
    case 'expired':
    default:
      return 'outline';
  }
}

export default function LeaseReportDetail() {
  const { leaseId, reportId } = useParams<{ leaseId: string; reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<LeaseReportRow | null>(null);
  const [loading, setLoading] = useState(true);
  const { generate: regenerate, isWorking: regenerating } = useGenerateLeaseReport();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!reportId) return;
      const { data, error } = await supabase
        .from('lease_reports')
        .select('*')
        .eq('id', reportId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error(error.message);
        setLoading(false);
        return;
      }
      setReport(data as LeaseReportRow | null);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  // Poll while generating (forward-compatible with KNOWN_ISSUES #13)
  useEffect(() => {
    if (!report || (report.status !== 'generating' && report.status !== 'pending')) {
      return;
    }
    const id = setInterval(async () => {
      const { data } = await supabase
        .from('lease_reports')
        .select('*')
        .eq('id', report.id)
        .maybeSingle();
      if (data) setReport(data as LeaseReportRow);
    }, 2500);
    return () => clearInterval(id);
  }, [report]);

  const generatedAtDisplay = useMemo(
    () => (report ? new Date(report.generated_at).toLocaleString() : ''),
    [report],
  );

  async function handleDownload(path: string | null, kind: 'pdf' | 'json') {
    if (!path) {
      toast.error(`${kind.toUpperCase()} not yet available`);
      return;
    }
    const { data, error } = await supabase.storage
      .from('lease-reports')
      .createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error('Could not generate download link');
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = path.split('/').pop() || `report.${kind}`;
    a.target = '_blank';
    a.click();
  }

  async function handleRegenerate() {
    if (!leaseId) return;
    try {
      const result = await regenerate(leaseId);
      toast.success('New report generated');
      navigate(`/app/leases/${leaseId}/reports/${result.reportId}`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Regeneration failed');
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title="Report" />
        <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>
      </AppLayout>
    );
  }

  if (!report) {
    return (
      <AppLayout>
        <AppHeader title="Report not found" />
        <div className="px-6 py-8 space-y-3">
          <p className="text-sm text-muted-foreground">
            The requested report does not exist or you do not have access.
          </p>
          <Button asChild variant="outline">
            <Link to={`/app/leases/${leaseId ?? ''}`}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to lease
            </Link>
          </Button>
        </div>
      </AppLayout>
    );
  }

  const isReady = report.status === 'ready' && !!report.pdf_storage_path;
  const isProcessing =
    report.status === 'generating' || report.status === 'pending' || !report.pdf_storage_path;

  return (
    <AppLayout>
      <AppHeader
        title="ASC 842 Disclosure Report"
        subtitle={`${report.organization_name_at_gen ?? ''} · Generated ${generatedAtDisplay}`}
      />
      <div className="px-6 py-6 space-y-6 max-w-5xl">
        <div className="flex items-center justify-between">
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/leases/${report.lease_id ?? leaseId ?? ''}`}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to lease
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Badge variant={statusBadgeVariant(report.status)}>{report.status}</Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Regenerate
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Liability disclaimer</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-1">
                LeaseIO Data Report — Not a Financial Statement
              </p>
              <p className="text-xs text-amber-900 leading-relaxed">
                This report contains structured lease data extracted, verified,
                and audited inside LeaseIO. It is NOT a financial statement and
                does not constitute accounting, legal, or tax advice. The
                customer is solely responsible for using this data correctly in
                their accounting and reporting.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Artifacts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-700" />
                <div>
                  <p className="text-sm font-medium">PDF</p>
                  <p className="text-xs text-muted-foreground">
                    {report.pdf_storage_path ?? (isProcessing ? 'Pending…' : 'Not available')}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!isReady}
                onClick={() => handleDownload(report.pdf_storage_path, 'pdf')}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" /> Download PDF
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-emerald-700" />
                <div>
                  <p className="text-sm font-medium">JSON (structured data)</p>
                  <p className="text-xs text-muted-foreground">
                    {report.json_storage_path ?? 'Pending…'}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!report.json_storage_path}
                onClick={() => handleDownload(report.json_storage_path, 'json')}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" /> Download JSON
              </Button>
            </div>
          </CardContent>
        </Card>

        {report.error_message && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-red-700">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-red-700">{report.error_message}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Forensic snapshot</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-1">
            <p>
              <span className="text-muted-foreground">Report ID:</span>{' '}
              <code className="font-mono">{report.id}</code>
            </p>
            <p>
              <span className="text-muted-foreground">Discount rate methodology:</span>{' '}
              {report.discount_rate_method_at_gen ?? 'workspace_default'}
            </p>
            {report.expires_at && (
              <p>
                <span className="text-muted-foreground">Expires:</span>{' '}
                {new Date(report.expires_at).toLocaleDateString()}
              </p>
            )}
            <p className="text-muted-foreground pt-2">
              Workspace report settings at the moment of generation are
              captured in the row's <code>workspace_settings_snapshot</code>{' '}
              JSON for full reproducibility.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
