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
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate, formatLocalizedDateTime } from '@/lib/dateFormatters';
import { mapSupabaseError } from '@/lib/userFacingError';
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

// Mirrors DISCOUNT_METHODS in ReportSettingsCard.tsx — the writer of
// workspaces.report_default_discount_method, which generate-lease-report
// snapshots into lease_reports.discount_rate_method_at_gen.
const DISCOUNT_METHOD_LABEL_KEYS: Record<string, string> = {
  workspace_default: 'workspace.report_settings.method_workspace_default',
  risk_free_rate: 'workspace.report_settings.method_risk_free',
  incremental_borrowing_rate: 'workspace.report_settings.method_ibr',
  custom: 'workspace.report_settings.method_custom',
};

export default function LeaseReportDetail() {
  const { t } = useAppTranslation();
  const { language } = useLanguage();
  const { leaseId, reportId } = useParams<{ leaseId: string; reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<LeaseReportRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { generate: regenerate, isWorking: regenerating } = useGenerateLeaseReport();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Always settle the loading state, even when reportId is
      // missing or the supabase call throws — otherwise the page
      // hangs on "Loading…" with no visible error.
      try {
        if (!reportId) {
          if (!cancelled) {
            setLoadError(t('reports.missing_report_id'));
            setLoading(false);
          }
          return;
        }
        const { data, error } = await supabase
          .from('lease_reports')
          .select('*')
          .eq('id', reportId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          const msg = mapSupabaseError(error, t, 'reports.load_failed', '[LeaseReportDetail] load error');
          setLoadError(msg);
          toast.error(msg);
          setLoading(false);
          return;
        }
        setReport(data as LeaseReportRow | null);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(mapSupabaseError(e, t, 'reports.load_failed', '[LeaseReportDetail] load threw'));
        setLoading(false);
      }
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
    () => (report ? formatLocalizedDateTime(report.generated_at, language) : ''),
    [report, language],
  );

  async function handleDownload(path: string | null, kind: 'pdf' | 'json') {
    if (!path) {
      toast.error(t('reports.kind_not_available', { kind: kind.toUpperCase() }));
      return;
    }
    const { data, error } = await supabase.storage
      .from('lease-reports')
      .createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error(t('reports.download_link_failed'));
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
      toast.success(t('reports.new_report_generated'));
      navigate(`/app/leases/${leaseId}/reports/${result.reportId}`);
    } catch (e) {
      toast.error(mapSupabaseError(e, t, 'reports.regeneration_failed'));
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <AppHeader title={t('reports.report_title')} />
        <div className="px-6 py-8 text-sm text-muted-foreground">{t('workspace.watchlist.loading')}</div>
      </AppLayout>
    );
  }

  if (!report) {
    return (
      <AppLayout>
        <AppHeader title={t('reports.report_not_found')} />
        <div className="px-6 py-8 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('reports.report_not_found_desc')}
          </p>
          {loadError && (
            <p className="text-xs text-red-700">
              {loadError}
            </p>
          )}
          <Button asChild variant="outline">
            <Link to={`/app/leases/${leaseId ?? ''}`}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> {t('reports.back_to_lease')}
            </Link>
          </Button>
        </div>
      </AppLayout>
    );
  }

  const isReady = report.status === 'ready' && !!report.pdf_storage_path;
  const isProcessing =
    report.status === 'generating' || report.status === 'pending' || !report.pdf_storage_path;

  // Localize the snapshotted discount-method token; unknown/free-text tokens
  // fall through untranslated (repo convention for custom/user data).
  const discountMethodToken = report.discount_rate_method_at_gen ?? 'workspace_default';
  const discountMethodLabel = DISCOUNT_METHOD_LABEL_KEYS[discountMethodToken]
    ? t(DISCOUNT_METHOD_LABEL_KEYS[discountMethodToken])
    : discountMethodToken;

  return (
    <AppLayout>
      <AppHeader
        title={t('reports.asc842_report_title')}
        subtitle={`${report.organization_name_at_gen ?? ''} · ${t('reports.generated_on', { date: generatedAtDisplay })}`}
      />
      <div className="px-6 py-6 space-y-6 max-w-5xl">
        <div className="flex items-center justify-between">
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/leases/${report.lease_id ?? leaseId ?? ''}`}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> {t('reports.back_to_lease')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Badge variant={statusBadgeVariant(report.status)}>{t(`reports.status.${report.status}`, { defaultValue: report.status })}</Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              {t('reports.regenerate')}
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.liability_disclaimer')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-1">
                {t('reports.not_financial_statement')}
              </p>
              <p className="text-xs text-amber-900 leading-relaxed">
                {t('reports.disclaimer_body')}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.artifacts')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-700" />
                <div>
                  <p className="text-sm font-medium">PDF</p>
                  <p className="text-xs text-muted-foreground">
                    {report.pdf_storage_path ?? (isProcessing ? t('reports.pending_ellipsis') : t('reports.not_available'))}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!isReady}
                onClick={() => handleDownload(report.pdf_storage_path, 'pdf')}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" /> {t('reports.download_pdf')}
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-emerald-700" />
                <div>
                  <p className="text-sm font-medium">{t('reports.json_structured')}</p>
                  <p className="text-xs text-muted-foreground">
                    {report.json_storage_path ?? t('reports.pending_ellipsis')}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!report.json_storage_path}
                onClick={() => handleDownload(report.json_storage_path, 'json')}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" /> {t('reports.download_json')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {report.error_message && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-red-700">{t('reports.error_title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-red-700">{report.error_message}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.forensic_snapshot')}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-1">
            <p>
              <span className="text-muted-foreground">{t('reports.report_id_label')}</span>{' '}
              <code className="font-mono">{report.id}</code>
            </p>
            <p>
              <span className="text-muted-foreground">{t('reports.discount_rate_method_label')}</span>{' '}
              {discountMethodLabel}
            </p>
            {report.expires_at && (
              <p>
                <span className="text-muted-foreground">{t('reports.expires_label')}</span>{' '}
                {formatLocalizedDate(report.expires_at, language)}
              </p>
            )}
            <p className="text-muted-foreground pt-2">
              {t('reports.snapshot_note_prefix')} <code>workspace_settings_snapshot</code>{' '}
              {t('reports.snapshot_note_suffix')}
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
